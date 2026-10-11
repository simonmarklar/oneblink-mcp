/**
 * Workflow: deploy_hosted_api
 *
 * Create/update (deploy) a OneBlink HOSTED API via the `oneblink` CLI, as a
 * subprocess. The `@oneblink/sdk` (v13) has NO api-hosting surface — `oneblink
 * api scope` / `oneblink api deploy` live ONLY in the CLI — so this tool shells
 * out through the shared, reviewed runner (`src/lib/cli-runner.ts`), which is
 * the single place credentials ever touch a child process.
 *
 * Task-oriented (not a 1:1 CLI mirror): one call optionally sets the API scope
 * then deploys the project in `projectDir` to the requested environment.
 *
 * SECURITY (see .kiro/steering/security.md):
 *   - PROD GATE: deploying to `prod` requires an explicit `confirmProduction:
 *     true`. Without it the tool FAILS CLOSED before any subprocess spawns — the
 *     real guard against an accidental/model-driven prod deploy. `--force` only
 *     makes the CLI non-interactive; it is NOT the prod guard.
 *   - A03 Injection: argv is a discrete ARRAY handed to runCli (execFile, no
 *     shell). Nothing here builds a command-line string.
 *   - A09 Logging: credentials live in the child env via the runner, never in
 *     argv/logs. We log the REDACTED arg shape (redactArgs) + exit codes only.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runCli, redactArgs, type RunCliOptions, type RunCliResult } from '../lib/cli-runner.js'
import { getCliCredentials } from '../lib/cli-credentials.js'
import { logger } from '../lib/logger.js'

/** Deploy environments the CLI accepts. */
export const DEPLOY_ENVS = ['dev', 'test', 'prod'] as const

const baseShape = {
  projectDir: z
    .string()
    .min(1)
    .describe('Absolute path to the API codebase (contains .blinkmrc.json). Used as the CLI cwd.'),
  scope: z
    .string()
    .min(1)
    .optional()
    .describe('API scope domain e.g. "customer-project.api.oneblink.io". When set, `oneblink api scope <scope>` runs before deploy.'),
  env: z.enum(DEPLOY_ENVS).default('dev').describe('Target environment. First deploy to a new env auto-provisions it.'),
  confirmProduction: z
    .boolean()
    .default(false)
    .describe('Required true to deploy to prod. Without it a prod deploy fails closed before any subprocess runs.'),
} as const

const inputSchema = z.object(baseShape)

/** Exported for unit tests. */
export const deployHostedApiInputSchema = inputSchema
export type DeployHostedApiInput = z.infer<typeof inputSchema>

/** Tool result shape (MCP-compatible: open index signature). */
export type ToolResult = {
  [x: string]: unknown
  isError?: boolean
  content: Array<{ type: 'text'; text: string }>
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] }
}

/** Keep stderr evidence bounded and non-secret-ish in error paths. */
const STDERR_TAIL = 1500

/**
 * Best-effort extraction of a deployed URL from CLI stdout. Returns null when
 * none is found — the deploy is still a success, we just have no URL to report.
 */
export function parseDeployedUrl(stdout: string): string | null {
  const match = stdout.match(/https?:\/\/[^\s"')]+/i)
  return match ? match[0] : null
}

/**
 * Build the ordered list of argv arrays for a deploy. When `scope` is provided,
 * the scope step comes first, then the deploy step; otherwise just the deploy.
 * Exported so tests can assert the exact argv without spawning anything.
 */
export function buildDeployArgvs(input: Pick<DeployHostedApiInput, 'scope' | 'env'>): string[][] {
  const steps: string[][] = []
  if (input.scope !== undefined) {
    steps.push(['api', 'scope', input.scope])
  }
  steps.push(['api', 'deploy', '--env', input.env, '--force'])
  return steps
}

/**
 * Core deploy orchestration, isolated from the MCP server wiring so it is unit
 * testable with an injected `runCli`. Enforces the prod gate, runs the scope
 * step (if any) then the deploy step, and maps the runner result to a tool
 * result. `run` defaults to the real {@link runCli}; tests pass a fake.
 */
export async function performDeploy(
  input: DeployHostedApiInput,
  run: (opts: RunCliOptions) => Promise<RunCliResult> = runCli,
): Promise<ToolResult> {
  // PROD GATE — fail closed BEFORE any subprocess spawns.
  if (input.env === 'prod' && input.confirmProduction !== true) {
    logger.warn('deploy_hosted_api: prod gate blocked deploy', { env: input.env })
    return errorResult(
      'Refusing to deploy to prod without confirmProduction: true. ' +
        'Re-run with confirmProduction: true to deploy to production.',
    )
  }

  const steps = buildDeployArgvs(input)

  // Resolve THIS caller's deploy keys from the per-caller path (request context
  // on HTTP, env fallback on stdio). Fails closed with a non-secret, tenant-
  // named message when unresolvable — before any subprocess spawns.
  let credentials
  try {
    credentials = getCliCredentials()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'deploy credentials unavailable'
    logger.error('deploy_hosted_api: credential resolution failed', { env: input.env })
    return errorResult(`deploy_hosted_api failed: ${message}`)
  }

  try {
    let lastStdout = ''
    for (const args of steps) {
      logger.info('deploy_hosted_api step', {
        env: input.env,
        args: redactArgs(args).join(' '),
      })
      const result = await run({ args, cwd: input.projectDir, credentials })
      if (result.exitCode !== 0) {
        // Surface redacted evidence (tail of stderr) — no secrets.
        const tail = (result.stderr || result.stdout || '').slice(-STDERR_TAIL).trim()
        logger.error('deploy_hosted_api step failed', {
          env: input.env,
          step: args[1] ?? args[0] ?? 'unknown',
          exitCode: result.exitCode ?? -1,
        })
        return errorResult(
          `oneblink ${args.join(' ')} failed (exit ${result.exitCode}) in env ${input.env}` +
            (tail ? `:\n${tail}` : '.'),
        )
      }
      lastStdout = result.stdout
    }

    const url = parseDeployedUrl(lastStdout)
    logger.info('deploy_hosted_api success', {
      env: input.env,
      scoped: input.scope !== undefined,
      ...(url ? { hasUrl: true } : {}),
    })
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            deployed: true,
            env: input.env,
            scope: input.scope ?? null,
            url: url ?? null,
          }),
        },
      ],
    }
  } catch (err) {
    // Spawn failure / timeout from the runner (already non-secret).
    const message = err instanceof Error ? err.message : 'Unknown error'
    logger.error('deploy_hosted_api failed', { env: input.env, message })
    return errorResult(`deploy_hosted_api failed: ${message}`)
  }
}

export function registerDeployHostedApi(server: McpServer): void {
  server.tool(
    'deploy_hosted_api',
    'Create or update a OneBlink hosted API by deploying its project via the ' +
      'oneblink CLI. Optionally sets the API scope first. Deploying to prod ' +
      'requires confirmProduction: true (fails closed otherwise).',
    baseShape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = inputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return errorResult(parsed.error.errors.map((e) => e.message).join('; '))
      }
      return performDeploy(parsed.data)
    },
  )
}
