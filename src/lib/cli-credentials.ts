/**
 * Per-caller CLI DEPLOY-key resolution — the CLI analogue of oneblink-client.ts.
 *
 * The `oneblink` CLI's `api deploy` / `cdn deploy` authenticate with a DEPLOY
 * key pair that is a DIFFERENT credential (different permissions) from the SDK
 * Developer Key (see cli-config.ts; OWASP A01). One MCP server serves many
 * callers, each with THEIR OWN deploy keys, so the key pair must be resolved
 * PER-CALLER, never a process-global singleton used for everyone.
 *
 * This mirrors getClient() exactly:
 *   - HTTP: the transport resolves the verified tenant's deploy keys via a
 *     CredentialResolver and binds them with runWithCliCredentials(); here
 *     getCliCredentials() reads them from the request context.
 *   - stdio interim: no context → fall back to the env key pair (loadCliConfig),
 *     one dev, one key — exactly as getClient() falls back to the env singleton.
 *
 * SECURITY:
 *   - No cross-caller leak: per-tenant cache (getCliCredentialsFor), never a
 *     global single key for all callers.
 *   - Fail closed on missing/unresolvable credentials with a non-secret message
 *     naming the TENANT, never the key (A01/A09). The tenant is system-derived
 *     from the verified token upstream — never a model/tool input.
 *   - Keys are returned to the runner for ENV injection; never logged, never
 *     placed in argv.
 */
import { loadCliConfig } from './cli-config.js'
import type { CredentialResolver, AuthContext } from './auth/types.js'
import { currentCliCredentials } from './request-context.js'

/** The resolved CLI deploy key pair handed to the runner for env injection. */
export interface CliCredentials {
  accessKey: string
  secretKey: string
}

/**
 * Returns the CLI deploy keys for the current call.
 *   - HTTP: the per-request, per-tenant key pair bound by the transport
 *     (runWithCliCredentials).
 *   - stdio interim: the env key pair (loadCliConfig), one process = one
 *     identity. Fails closed (throws, non-secret) when the env pair is absent.
 * Workflow code calls this with no args and is unaware which path produced the
 * key. Credentials are never logged.
 */
export function getCliCredentials(): CliCredentials {
  const fromContext = currentCliCredentials()
  if (fromContext) return fromContext
  // stdio interim fallback: env key pair. loadCliConfig fails closed on absent.
  const config = loadCliConfig()
  return { accessKey: config.accessKey, secretKey: config.secretKey }
}

// --- HTTP path: per-auth-context, tenant-keyed cache ------------------------

const perTenant = new Map<string, CliCredentials>()

/**
 * Resolve a verified caller's CLI deploy keys via the CredentialResolver,
 * cached per tenant (the SAME shape as getClientFor). The tenant is
 * system-derived from the verified token — never a tool input. Fails closed
 * (the resolver throws a non-secret, tenant-named error) when no key is
 * configured for the tenant.
 */
export async function getCliCredentialsFor(
  auth: AuthContext,
  resolver: CredentialResolver,
): Promise<CliCredentials> {
  const existing = perTenant.get(auth.tenant)
  if (existing) return existing
  const resolved = await resolver.resolve(auth.tenant)
  const creds: CliCredentials = { accessKey: resolved.accessKey, secretKey: resolved.secretKey }
  perTenant.set(auth.tenant, creds)
  return creds
}

/** Reset the per-tenant CLI-credential cache. Test-only. */
export function _resetCliCredentials(): void {
  perTenant.clear()
}
