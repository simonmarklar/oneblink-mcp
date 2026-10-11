/**
 * Per-caller CLI DEPLOY-key resolution — the CLI analogue of oneblink-client.ts.
 *
 * The `oneblink` CLI's `api deploy` / `cdn deploy` authenticate with a DEPLOY
 * key pair that is a DIFFERENT credential (different permissions) from the SDK
 * Developer Key (see cli-config.ts; OWASP A01). One MCP server serves many
 * callers, each with THEIR OWN deploy keys, so the key pair must be resolved
 * PER-CALLER, never a process-global singleton used for everyone.
 *
 * This mirrors getClient() exactly (HTTP-only): the transport reads the
 * caller's deploy key pair from the request headers and binds it with
 * runWithCliCredentials(); here getCliCredentials() reads it from the request
 * context. There is no server-held key and no env fallback.
 *
 * SECURITY:
 *   - No cross-caller leak: the key pair is the request's own header pair,
 *     bound only for that request's async context.
 *   - Fail closed: throws (non-secret) when called outside a request context.
 *   - Keys are returned to the runner for ENV injection; never logged, never
 *     placed in argv.
 */
import { currentCliCredentials } from './request-context.js'

/** The resolved CLI deploy key pair handed to the runner for env injection. */
export interface CliCredentials {
  accessKey: string
  secretKey: string
}

/**
 * Returns the CLI deploy keys for the current call. HTTP-only: the per-session
 * key pair the caller supplied via request headers, bound in context by
 * http.ts (runWithCliCredentials). Throws when called outside a request
 * context. Credentials are never logged.
 */
export function getCliCredentials(): CliCredentials {
  const fromContext = currentCliCredentials()
  if (!fromContext) {
    throw new Error(
      'no OneBlink CLI deploy credentials in context: a deploy tool ran outside an authenticated HTTP request',
    )
  }
  return fromContext
}
