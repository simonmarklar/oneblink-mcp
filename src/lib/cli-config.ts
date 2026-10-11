/**
 * CLI binary configuration loader.
 *
 * The `oneblink` CLI's `api deploy` / `cdn deploy` commands authenticate with a
 * DEPLOYMENT key pair — but on this HTTP-only server that pair is PER-CALLER and
 * comes from the request headers (see cli-credentials.ts / header-credentials.ts),
 * NOT from the environment. So this loader holds NO credentials: the only thing
 * left is `cliBin`, a per-HOST install detail (where the `oneblink` binary lives).
 *
 * SECURITY (see .kiro/steering/security.md):
 *   - Env vars only for per-environment / per-host values (security rule 3).
 *     `cliBin` changes per host and is non-secret. No credentials, no
 *     request-shaping params here.
 */
import { z } from 'zod'

/**
 * CLI binary configuration. `cliBin` legitimately differs per host, so it is
 * sourced from an environment variable (security rule 3). The deploy KEY PAIR
 * is NOT here — it is per-caller, from the request headers.
 */
const CliConfigSchema = z.object({
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
  cliBin: 'ONEBLINK_CLI_BIN',
} as const

/**
 * Reads + validates the CLI binary config from the process environment. There
 * are no required fields (cliBin is optional), so this never throws for a
 * missing credential — credentials are not sourced here.
 */
export function loadCliConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  const parsed = CliConfigSchema.safeParse({
    cliBin: env[CLI_CONFIG_ENV_VARS.cliBin],
  })

  if (!parsed.success) {
    const names = parsed.error.issues
      .map((i) => {
        const key = i.path[0] as keyof typeof CLI_CONFIG_ENV_VARS
        return CLI_CONFIG_ENV_VARS[key] ?? String(i.path.join('.'))
      })
      .join(', ')
    throw new Error(`Invalid OneBlink CLI configuration: ${names}`)
  }

  return parsed.data
}

// --- test-only cache reset -------------------------------------------------
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
