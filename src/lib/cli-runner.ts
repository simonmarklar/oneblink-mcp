/**
 * OneBlink CLI subprocess runner — the single auditable place that spawns the
 * `oneblink` CLI.
 *
 * WHY THIS EXISTS: the `@oneblink/sdk` (v13) has NO api-hosting or CDN surface
 * (confirmed). `oneblink api deploy` and `oneblink cdn deploy` live ONLY in the
 * `oneblink` CLI, so the two sibling deploy tools must shell out. Centralising
 * that here keeps the dangerous bit — spawning a process with credentials — in
 * one reviewed module instead of scattered across tools.
 *
 * SECURITY (see .kiro/steering/security.md):
 *   - A03 Injection: ALWAYS an argv ARRAY via `execFile` — never a shell
 *     string, never `shell: true`, never string-interpolated args. There is no
 *     code path here that builds a command line, so a malicious arg is passed
 *     as one opaque argv element and cannot break out into the shell.
 *   - A09 Logging: the deploy key pair is injected into the child env and is
 *     NEVER logged. Callers log the REDACTED arg shape via `redactArgs()`;
 *     stdout/stderr returned to callers may contain CLI output, so callers must
 *     not blindly log it — the runner itself logs only argv length + exit code.
 *   - Fail closed: a missing deploy credential throws a non-secret error before
 *     any process is spawned (via the per-caller resolver `getCliCredentials`).
 *
 * CREDENTIALS ARE PER-CALLER (not per-server): `runCli` receives the resolved
 * deploy key pair in `opts.credentials` (resolved upstream from the request
 * context), or resolves it via `getCliCredentials()` — the per-request context
 * on HTTP, the env fallback on stdio. It NO LONGER reads process.env for the
 * key pair, so one server serves many callers with no cross-caller leak
 * (OWASP A01). Only `cliBin` (a per-host install detail) stays config/env.
 */
import { execFile } from 'node:child_process'
import process from 'node:process'
import { type CliConfig } from './cli-config.js'
import { getCliCredentials, type CliCredentials } from './cli-credentials.js'
import { logger } from './logger.js'

/** Default subprocess timeout. Deploys can be slow; 120s is a sane ceiling. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Max bytes captured from each of stdout/stderr. Guards against runaway output. */
export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024 // 10 MiB

/** Env var names whose VALUES must never appear in a log, redacted or not. */
const SECRET_ENV_KEYS = ['ONEBLINK_ACCESS_KEY', 'ONEBLINK_SECRET_KEY'] as const

export interface RunCliOptions {
  /** CLI arguments as an ARGV ARRAY (never a shell string). e.g. ['api','deploy']. */
  args: string[]
  /** Working directory the CLI runs in (the project to deploy). */
  cwd: string
  /**
   * The RESOLVED deploy key pair for THIS caller, injected into the child env.
   * REQUIRED and PER-CALLER: the runner no longer reads process.env for the key
   * pair, so one MCP server can serve many callers each with their own keys
   * without any cross-caller leak (OWASP A01). Omit it to fall back to the
   * request-context / stdio-env resolution via {@link getCliCredentials}.
   */
  credentials?: CliCredentials
  /**
   * Extra env for the child, merged over the inherited env and the injected
   * deploy key pair. Use for per-call, non-secret values. Do NOT pass secrets
   * here expecting redaction — only the two known key vars are auth-injected.
   */
  env?: Record<string, string>
  /** Per-call timeout override. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
  /**
   * Override the loaded CLI config (currently only `cliBin`, a per-HOST install
   * detail — NOT the credential source). Test-only seam.
   */
  config?: CliConfig
  /** Override the spawn primitive. Test-only seam; prod uses {@link defaultExecutor}. */
  _exec?: SpawnExecutor
}

export interface RunCliResult {
  /** Process exit code. `null` only if the process was signalled/killed. */
  exitCode: number | null
  stdout: string
  stderr: string
}

/**
 * The low-level spawn primitive, factored out as a seam so tests can mock the
 * subprocess WITHOUT invoking the real `oneblink` CLI. Production uses
 * {@link defaultExecutor} (a thin `execFile` wrapper); nothing else sets it.
 *
 * It is handed the already-resolved `file`, full `argv`, and child `env`, and
 * must resolve/reject exactly as `execFile`'s callback would — i.e. an
 * `ErrnoException` whose numeric `code` is a non-zero exit, else a spawn/timeout
 * error. Keeping the contract identical means the mock and the real path share
 * the SAME exit/timeout-handling code below.
 */
export interface ExecOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeout: number
  maxBuffer: number
}
export type SpawnExecutor = (
  file: string,
  argv: string[],
  options: ExecOptions,
) => Promise<{ stdout: string; stderr: string }>

/** Production executor: `execFile`, no shell, discrete argv (A03). */
export const defaultExecutor: SpawnExecutor = (file, argv, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      argv,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        windowsHide: true,
        // CRITICAL: no `shell` option. execFile never spawns a shell, so args
        // are passed to the OS exec as discrete elements (A03). Do not add it.
      },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }))
        else resolve({ stdout, stderr })
      },
    )
  })

/**
 * Values that look secret, replaced with a stable placeholder for logging.
 * We never log arg VALUES verbatim; this is defence-in-depth for the arg SHAPE.
 */
const REDACTED = '***REDACTED***'

/**
 * Patterns that mark an arg (or its following value) as secret-bearing, so a
 * caller can log the command SHAPE without leaking a token. Matches the auth
 * flags the CLI accepts plus anything carrying `key`/`secret`/`token`/`password`.
 */
const SECRET_FLAG = /^(--?)(access[-_]?key|secret[-_]?key|secret|token|password|auth)$/i
const SECRET_INLINE = /^(--?[^=]*(?:key|secret|token|password|auth)[^=]*)=(.*)$/i

/**
 * Redact a copy of an argv array for logging. Does NOT mutate the input.
 *   - `--secret-key VALUE`  -> `--secret-key ***REDACTED***`  (value swapped)
 *   - `--secret-key=VALUE`  -> `--secret-key=***REDACTED***`  (inline value swapped)
 *   - a bare value equal to a known secret value               -> `***REDACTED***`
 *
 * The second arg supplies the known secret VALUES to catch as bare args. Pass
 * an array of the resolved per-caller credentials (preferred — the keys are no
 * longer in process.env). For backward compatibility a `ProcessEnv` is also
 * accepted and its ONEBLINK_ACCESS_KEY/ONEBLINK_SECRET_KEY values are used;
 * omitted, it reads process.env (the stdio-fallback case).
 *
 * This never promises to catch an arbitrary unlabelled secret — the real
 * control is that we inject auth via ENV, not argv (see runCli). redactArgs is
 * the safety net for a caller that logs the shape anyway.
 */
export function redactArgs(
  args: readonly string[],
  secretSource: readonly string[] | NodeJS.ProcessEnv = process.env,
): string[] {
  const secretValues = new Set(
    (Array.isArray(secretSource)
      ? (secretSource as readonly string[])
      : SECRET_ENV_KEYS.map((k) => (secretSource as NodeJS.ProcessEnv)[k])
    ).filter((v): v is string => !!v && v.length > 0),
  )
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    // 1) inline form: --token=abc
    const inline = SECRET_INLINE.exec(arg)
    if (inline) {
      out.push(`${inline[1]}=${REDACTED}`)
      continue
    }
    // 2) a bare value matching a known secret env value
    if (secretValues.has(arg)) {
      out.push(REDACTED)
      continue
    }
    out.push(arg)
    // 3) separated form: --token abc  -> redact the NEXT token as the value
    if (SECRET_FLAG.test(arg) && i + 1 < args.length) {
      out.push(REDACTED)
      i++ // consume the value we just redacted
    }
  }
  return out
}

/**
 * Resolve how to invoke the `oneblink` CLI, cross-platform.
 *
 * On Windows an npm-installed CLI is a `.cmd` shim. Under Node >= 24,
 * `child_process.execFile`/`spawn` will NOT run a `.cmd` without a shell,
 * which we refuse (A03). So on Windows we invoke the shim THROUGH `cmd.exe /c`
 * with the shim as its FIRST ARGV ELEMENT — still an argv array, still no shell
 * string, still no interpolation — rather than setting `shell: true`.
 *
 * Resolution order for the binary itself:
 *   1. explicit `cliBin` (config / ONEBLINK_CLI_BIN) — absolute path or name
 *   2. `oneblink.cmd` on Windows, else `oneblink` on PATH
 *
 * Returns the actual `file` to exec plus the argv PREFIX to prepend to the
 * caller's args.
 */
export function resolveCliInvocation(
  cliBin: string | undefined,
  platform: NodeJS.Platform = process.platform,
): { file: string; prefixArgs: string[] } {
  const isWindows = platform === 'win32'
  // The binary name/path to run. An explicit override wins; it may already be
  // a .cmd/.exe/absolute path, in which case we respect it verbatim.
  const bin = cliBin ?? (isWindows ? 'oneblink.cmd' : 'oneblink')

  if (isWindows) {
    // Run the shim via cmd.exe without a shell string. `/d /s /c` then the
    // shim path as a distinct argv element. execFile with these argv elements
    // does not spawn a shell that re-parses the caller's args.
    const comspec = process.env.ComSpec ?? 'cmd.exe'
    return { file: comspec, prefixArgs: ['/d', '/s', '/c', bin] }
  }
  return { file: bin, prefixArgs: [] }
}

/**
 * Spawn the `oneblink` CLI with an argv array and the deploy key pair injected
 * into the child env. Resolves with { exitCode, stdout, stderr } — a non-zero
 * exit is NOT thrown; the caller inspects exitCode (the CLI's own failure is
 * data, not an exception). An inability to spawn, a timeout, or a buffer
 * overrun rejects.
 *
 * Credentials: the PER-CALLER deploy key pair comes from `opts.credentials`
 * (resolved upstream from the request context). When omitted, it is resolved
 * via {@link getCliCredentials} — the per-request context (HTTP) or the env
 * fallback (stdio). Either way it fails CLOSED (rejects, non-secret message)
 * when no credential is available, BEFORE any process is spawned. The pair is
 * placed in the child's env, NEVER in argv and NEVER logged.
 *
 * `cliBin` (the CLI binary path) is a per-HOST install detail, not per-caller,
 * so it stays config/env — read via `opts.config` (test seam) else the loaded
 * CLI config, WITHOUT requiring the env key pair.
 */
export async function runCli(opts: RunCliOptions): Promise<RunCliResult> {
  // Resolve the PER-CALLER credentials first. Fail closed BEFORE spawning:
  // because this function is async, a missing-credential throw surfaces as a
  // REJECTED promise — a uniform contract for callers.
  const credentials = opts.credentials ?? getCliCredentials()
  // cliBin only. Prefer an explicit test-config; otherwise read it from the env
  // WITHOUT the key pair (it is a per-host detail, not the credential source).
  const cliBin = opts.config?.cliBin ?? process.env.ONEBLINK_CLI_BIN
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const exec = opts._exec ?? defaultExecutor

  const { file, prefixArgs } = resolveCliInvocation(cliBin)
  const argv = [...prefixArgs, ...opts.args]

  // Child env: inherit, then inject the PER-CALLER deploy key pair, then caller
  // extras. The key pair goes in the ENVIRONMENT, not argv — so it never
  // touches a command line and is covered by the no-secret-in-logs rule by
  // construction.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ONEBLINK_ACCESS_KEY: credentials.accessKey,
    ONEBLINK_SECRET_KEY: credentials.secretKey,
    ...opts.env,
  }

  // Log only the SHAPE: redacted args + arg count + timeout. Redact against the
  // resolved per-caller key VALUES (not process.env, which no longer holds the
  // authoritative pair). Never the key pair, never raw argv.
  logger.info('cli_runner spawn', {
    file,
    argc: opts.args.length,
    args: redactArgs(opts.args, [credentials.accessKey, credentials.secretKey]).join(' '),
    timeoutMs: timeout,
  })

  try {
    const { stdout, stderr } = await exec(file, argv, {
      cwd: opts.cwd,
      env: childEnv,
      timeout,
      maxBuffer: DEFAULT_MAX_BUFFER,
    })
    logger.info('cli_runner exit', { exitCode: 0 })
    return { exitCode: 0, stdout, stderr }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      code?: string | number
      killed?: boolean
      stdout?: string
      stderr?: string
    }
    // A non-zero EXIT (err.code is a number) is normal CLI failure: resolve with
    // the captured streams so the caller can read exitCode/stderr. The CLI's own
    // failure is DATA, not an exception.
    if (typeof err.code === 'number') {
      logger.info('cli_runner exit', { exitCode: err.code })
      return { exitCode: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
    }
    // Spawn failure, timeout (ETIMEDOUT), or buffer overrun: reject with a
    // non-secret message. Do NOT include argv/env in the error.
    const reason =
      err.killed || err.code === 'ETIMEDOUT'
        ? `oneblink CLI timed out after ${timeout}ms`
        : `failed to run oneblink CLI: ${err.code ?? err.message}`
    logger.error('cli_runner spawn failed', { reason: String(err.code ?? 'spawn-error') })
    throw new Error(reason)
  }
}
