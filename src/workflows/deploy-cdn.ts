/**
 * Workflow: deploy_cdn
 *
 * Create/configure CDN hosting and deploy a static asset directory to the
 * OneBlink CDN via the `oneblink` CLI (`cdn scope` + `cdn deploy`), as a
 * subprocess. The SDK (v13) has NO CDN surface, so this shells out through the
 * shared, reviewed runner — it does NOT spawn anything itself.
 *
 * Follows: steering tool-design + security (A01/A03/A09), the subprocess
 * pattern of list-forms.ts / upsert-email-submission-event.ts, and the
 * cli-runner.ts contract (argv ARRAY, deploy keys injected into child env,
 * fail-closed, redacted logging).
 *
 * SECURITY:
 *   - A03 Injection: every CLI arg is a discrete argv element handed to runCli;
 *     no shell string, no interpolation.
 *   - PROD GATE: env==='prod' requires confirmProduction===true or we fail
 *     closed BEFORE any subprocess runs. `--prune` on prod is destructive
 *     (removes remote files absent locally); the gate covers it.
 *   - A09 Logging: only ids, exit codes, and the REDACTED arg shape are logged
 *     — never the deploy key pair (which lives in the child env, not argv).
 *
 * CLI facts:
 *   oneblink cdn scope <domain>
 *   oneblink cdn deploy <dir> [--env dev|test|prod] [--prune]
 *   <dir> contents map to CDN root.
 *   .blinkmrc.json `cdn` knobs: isSinglePageApplication,
 *   disableSecurityResponseHeaders, waf{prod,test}.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { runCli, redactArgs, type RunCliResult } from '../lib/cli-runner.js'
import { getCliCredentials } from '../lib/cli-credentials.js'
import { logger } from '../lib/logger.js'

/** Optional `.blinkmrc.json` `cdn` config knobs the caller may author/patch. */
const cdnConfigShape = z
  .object({
    scope: z.string().min(1).optional(),
    isSinglePageApplication: z.boolean().optional(),
    disableSecurityResponseHeaders: z.boolean().optional(),
    waf: z
      .object({
        prod: z.object({}).passthrough().optional().describe('Free-form WAF config object for prod.'),
        test: z.object({}).passthrough().optional().describe('Free-form WAF config object for test.'),
      })
      .optional(),
  })
  .optional()

const baseShape = {
  projectDir: z
    .string()
    .min(1)
    .describe('Absolute path to the CDN project directory (contains .blinkmrc.json).'),
  deployDir: z
    .string()
    .min(1)
    .describe('Folder whose contents map to CDN root (e.g. "public" or "www").'),
  scope: z
    .string()
    .min(1)
    .optional()
    .describe('CDN scope/domain e.g. "customer-project.cdn.oneblink.io". When set, runs `cdn scope <scope>` first.'),
  env: z.enum(['dev', 'test', 'prod']).default('dev'),
  prune: z
    .boolean()
    .default(false)
    .describe('Add --prune: remove CDN files no longer present locally (destructive).'),
  confirmProduction: z
    .boolean()
    .default(false)
    .describe('Required true to deploy when env==="prod". Fails closed otherwise.'),
  cdnConfig: cdnConfigShape.describe(
    'Optional .blinkmrc.json `cdn` config to patch before deploy. Omit to leave the file as-is.',
  ),
} as const

const inputSchema = z.object(baseShape)

/** Exported for unit tests. */
export const deployCdnInputSchema = inputSchema

type Input = z.infer<typeof inputSchema>

function errorResult(text: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text }] }
}

/** Keep only the trailing lines of CLI stderr for a non-secret error message. */
function tail(text: string, lines = 10): string {
  const parts = text.split(/\r?\n/).filter((l) => l.length > 0)
  return parts.slice(-lines).join('\n')
}

/**
 * Best-effort public-URL extraction from CLI stdout. The CLI prints the origin
 * URL on success; we surface it when parseable, else null. Never throws.
 */
export function parsePublicUrl(stdout: string): string | null {
  const match = stdout.match(/https?:\/\/[^\s"'<>]+/i)
  return match ? match[0] : null
}

/**
 * Patch the `cdn` block of `.blinkmrc.json` in projectDir with the supplied
 * config (shallow-merge over any existing `cdn`), leaving the rest untouched.
 * Only called when `cdnConfig` is supplied.
 */
async function patchBlinkmrc(projectDir: string, cdnConfig: NonNullable<Input['cdnConfig']>): Promise<void> {
  const file = path.join(projectDir, '.blinkmrc.json')
  const raw = await fs.readFile(file, 'utf8')
  const json = JSON.parse(raw) as Record<string, unknown>
  const existingCdn = (json.cdn as Record<string, unknown> | undefined) ?? {}
  json.cdn = { ...existingCdn, ...cdnConfig }
  await fs.writeFile(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
}

/**
 * Core handler, decoupled from the MCP server so unit tests can drive it with a
 * mocked `runCli` (the `_runCli` seam) WITHOUT spawning the real CLI. Mirrors
 * the cli-runner.ts test-seam convention.
 */
export async function deployCdnHandler(
  rawArgs: Record<string, unknown>,
  deps: { _runCli?: typeof runCli } = {},
) {
  const run = deps._runCli ?? runCli

  const parsed = inputSchema.safeParse(rawArgs)
  if (!parsed.success) {
    return errorResult(parsed.error.errors.map((e) => e.message).join('; '))
  }
  const input = parsed.data

  // PROD GATE — fail closed BEFORE any subprocess. Covers destructive --prune.
  if (input.env === 'prod' && input.confirmProduction !== true) {
    logger.warn('deploy_cdn blocked: prod without confirmProduction', { env: input.env })
    return errorResult(
      'Refusing to deploy to prod without confirmProduction: true. ' +
        'Production deploys (especially with --prune) are destructive — re-run with confirmProduction: true.',
    )
  }

  try {
    // Resolve THIS caller's deploy keys from the per-caller request context.
    // Fails closed with a non-secret message (e.g. called outside an HTTP
    // request) before any subprocess spawns.
    let credentials
    try {
      credentials = getCliCredentials()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'deploy credentials unavailable'
      logger.error('deploy_cdn: credential resolution failed', { env: input.env })
      return errorResult(`deploy_cdn failed: ${message}`)
    }

    // Optional: author/patch .blinkmrc.json cdn config before deploying.
    if (input.cdnConfig) {
      try {
        await patchBlinkmrc(input.projectDir, input.cdnConfig)
        logger.info('deploy_cdn patched .blinkmrc.json', { env: input.env })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'failed to patch .blinkmrc.json'
        logger.error('deploy_cdn: blinkmrc patch failed', { message })
        return errorResult(`failed to update .blinkmrc.json (no deploy run): ${message}`)
      }
    }

    // Optional scope step first.
    if (input.scope) {
      const scopeArgs = ['cdn', 'scope', input.scope]
      logger.info('deploy_cdn scope', { args: redactArgs(scopeArgs).join(' ') })
      const scopeRes: RunCliResult = await run({ args: scopeArgs, cwd: input.projectDir, credentials })
      if (scopeRes.exitCode !== 0) {
        logger.error('deploy_cdn scope failed', { exitCode: scopeRes.exitCode ?? -1 })
        return errorResult(
          `oneblink cdn scope failed (exit ${scopeRes.exitCode}): ${tail(scopeRes.stderr)}`,
        )
      }
    }

    // Deploy step.
    const deployArgs = ['cdn', 'deploy', input.deployDir, '--env', input.env]
    if (input.prune) deployArgs.push('--prune')
    logger.info('deploy_cdn deploy', { env: input.env, args: redactArgs(deployArgs).join(' ') })

    const res: RunCliResult = await run({ args: deployArgs, cwd: input.projectDir, credentials })
    if (res.exitCode !== 0) {
      logger.error('deploy_cdn deploy failed', { env: input.env, exitCode: res.exitCode ?? -1 })
      return errorResult(
        `oneblink cdn deploy failed (exit ${res.exitCode}): ${tail(res.stderr)}`,
      )
    }

    const publicUrl = parsePublicUrl(res.stdout)
    logger.info('deploy_cdn succeeded', { env: input.env, pruned: input.prune, hasUrl: publicUrl !== null })
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            deployed: true,
            env: input.env,
            deployDir: input.deployDir,
            scopeApplied: input.scope ?? null,
            pruned: input.prune,
            publicUrl,
          }),
        },
      ],
    }
  } catch (err) {
    // A09: message only, never argv/env/secrets.
    const message = err instanceof Error ? err.message : 'Unknown error'
    logger.error('deploy_cdn failed', { env: input.env, message })
    return errorResult(`deploy_cdn failed: ${message}`)
  }
}

export function registerDeployCdn(server: McpServer): void {
  server.tool(
    'deploy_cdn',
    'Create CDN hosting and deploy a static asset directory to the OneBlink CDN ' +
      'via the oneblink CLI. Optionally sets the CDN scope first and patches ' +
      '.blinkmrc.json cdn config. Production deploys fail closed unless ' +
      'confirmProduction is explicitly set.',
    baseShape,
    async (rawArgs: Record<string, unknown>) => deployCdnHandler(rawArgs),
  )
}
