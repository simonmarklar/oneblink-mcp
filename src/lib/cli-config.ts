/**
 * CLI deploy-key configuration loader.
 *
 * SEPARATE from `config.ts` (the SDK Developer-Key config) on purpose. The
 * `oneblink` CLI's `api deploy` / `cdn deploy` commands authenticate with a
 * DEPLOYMENT key pair — a different credential from the SDK Developer Key, with
 * different permissions. Conflating them (OWASP A01) would let one tool's
 * authority leak into another's.
 *
 * SECURITY (see .kiro/steering/security.md):
 *   - Env vars only for per-environment values (security rule 3): the deploy
 *     key pair (changes per environment) and the optional CLI binary override
 *     (changes per host). No request-shaping params here.
 *   - Credentials are read here once and NEVER logged (A09). Errors report
 *     variable NAMES only, never values. Fail closed on anything missing.
 *
 * Consumed by `cli-credentials.ts` as the stdio-interim FALLBACK key pair
 * (one dev, one key) when there is no per-request context — mirroring how the
 * SDK client falls back to the env singleton. On the HTTP path the per-caller
 * deploy keys come from the CredentialResolver instead, so this is NO LONGER
 * the sole credential source. The resolved pair is injected into the spawned
 * CLI's child env by `cli-runner.ts`. `cliBin` is a per-host install detail and
 * remains env-sourced on every path.
 */
import { z } from 'zod'

/**
 * Deploy-key configuration. Every field legitimately differs per environment
 * or per host, so each is sourced from an environment variable (security
 * rule 3). Do NOT add request-shaping options (project, env name, prune flags)
 * here — those are the sibling tools' inputs.
 */
const CliConfigSchema = z.object({
  /** OneBlink CLI deploy key — access key id. Secret: never logged. */
  accessKey: z.string().min(1, 'ONEBLINK_ACCESS_KEY is required'),
  /** OneBlink CLI deploy key — secret access key. Secret: never logged. */
  secretKey: z.string().min(1, 'ONEBLINK_SECRET_KEY is required'),
  /**
   * Optional override for the `oneblink` CLI binary (absolute path or a name
   * on PATH). Per-host, non-secret. When unset the runner resolves `oneblink`
   * from PATH (`oneblink.cmd` on Windows).
   */
  cliBin: z.string().min(1).optional(),
})

export type CliConfig = z.infer<typeof CliConfigSchema>

/** The env var names this loader reads. Exported for docs/tests, not values. */
export const CLI_CONFIG_ENV_VARS = {
  accessKey: 'ONEBLINK_ACCESS_KEY',
  secretKey: 'ONEBLINK_SECRET_KEY',
  cliBin: 'ONEBLINK_CLI_BIN',
} as const

/**
 * Reads + validates the CLI deploy-key config from the process environment.
 * Throws a non-sensitive error (variable NAMES only, never values) and fails
 * closed when the deploy key pair is missing or invalid.
 */
export function loadCliConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  const parsed = CliConfigSchema.safeParse({
    accessKey: env[CLI_CONFIG_ENV_VARS.accessKey],
    secretKey: env[CLI_CONFIG_ENV_VARS.secretKey],
    cliBin: env[CLI_CONFIG_ENV_VARS.cliBin],
  })

  if (!parsed.success) {
    // Report missing/invalid variable NAMES only — never echo their values.
    // Map the schema field path back to the real env var name so the error is
    // actionable without leaking the (secret) value.
    const names = parsed.error.issues
      .map((i) => {
        const key = i.path[0] as keyof typeof CLI_CONFIG_ENV_VARS
        return CLI_CONFIG_ENV_VARS[key] ?? String(i.path.join('.'))
      })
      .join(', ')
    throw new Error(`Invalid OneBlink CLI deploy configuration: ${names}`)
  }

  return parsed.data
}

// --- test-only cache reset -------------------------------------------------
// cli-config holds no module-global cache (loadCliConfig is pure over `env`),
// but we export a no-op reset to mirror config.ts's shape so the sibling tools
// and tests can treat the two configs uniformly.
let _loaded: CliConfig | undefined

/** Load once and cache. Mirrors the memoised accessor pattern. */
export function getCliConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  _loaded ??= loadCliConfig(env)
  return _loaded
}

/** Reset the cached CLI config. Test-only. */
export function _resetCliConfig(): void {
  _loaded = undefined
}
