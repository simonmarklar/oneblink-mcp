/**
 * Per-session credential source: OneBlink keys from the HTTP request headers.
 *
 * DECISION (auth-session.md, revised 2026-10-11): the caller supplies its OWN
 * OneBlink Developer Key (and CLI deploy key) on each HTTP connection via
 * request HEADERS. The server does NOT hold keys in `.env` or
 * `oneblink-keys.local.json`, and does NOT front them with an OAuth broker.
 * "Per session" = per authenticated HTTP connection, and the credential rides
 * the connection as a header pair.
 *
 * WHY HEADERS, NOT TOOL ARGS: a credential passed as a tool-call argument lands
 * in the model's context, the chat transcript, and tool logs. Headers do not —
 * they are transport metadata the model never sees. So the one hard MCP rule we
 * keep is: the secret is NEVER a tool argument and NEVER returned to the client.
 *
 * SECURITY:
 *   - Fail closed: a request missing either header is rejected (401), with a
 *     message naming the HEADER, never the value (A09).
 *   - Keys are never logged and never placed in a tool result.
 *   - PoC binds loopback only; a hosted deployment MUST be behind TLS so the
 *     header pair is not sent in clear text.
 */
import { z } from 'zod'
import type { SdkConstructorOptions } from '../oneblink-client.js'
import type { CliCredentials } from '../cli-credentials.js'

/** Header names carrying the per-session OneBlink SDK Developer Key. */
export const SDK_ACCESS_KEY_HEADER = 'x-oneblink-access-key'
export const SDK_SECRET_KEY_HEADER = 'x-oneblink-secret-key'

/**
 * Header names carrying the per-session OneBlink CLI DEPLOY key. A different
 * credential from the SDK Developer Key (OWASP A01), so it rides its own header
 * pair. OPTIONAL: only the deploy workflows (api/cdn deploy) need it. When
 * absent, the SDK key pair is reused as the deploy key pair (common case: one
 * key does both), preserving current single-pair behaviour.
 */
export const CLI_ACCESS_KEY_HEADER = 'x-oneblink-cli-access-key'
export const CLI_SECRET_KEY_HEADER = 'x-oneblink-cli-secret-key'

/** Minimal shape of the per-request headers we read (node http lowercases keys). */
export type RequestHeaders = Record<string, string | string[] | undefined>

const NonEmpty = z.string().trim().min(1)

/** Thrown when a required credential header is absent or empty → HTTP 401. */
export class MissingCredentialsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MissingCredentialsError'
  }
}

/** Read a single-valued header, collapsing an array to its first entry. */
function headerValue(headers: RequestHeaders, name: string): string | undefined {
  const raw = headers[name]
  if (Array.isArray(raw)) return raw[0]
  return raw
}

/**
 * Extract the SDK Developer Key pair from the request headers. Fails closed
 * (throws MissingCredentialsError, header NAMES only) when either is absent.
 */
export function sdkCredentialsFromHeaders(headers: RequestHeaders): SdkConstructorOptions {
  const access = NonEmpty.safeParse(headerValue(headers, SDK_ACCESS_KEY_HEADER))
  const secret = NonEmpty.safeParse(headerValue(headers, SDK_SECRET_KEY_HEADER))
  const missing: string[] = []
  if (!access.success) missing.push(SDK_ACCESS_KEY_HEADER)
  if (!secret.success) missing.push(SDK_SECRET_KEY_HEADER)
  if (missing.length > 0) {
    throw new MissingCredentialsError(`missing OneBlink credential header(s): ${missing.join(', ')}`)
  }
  return { accessKey: access.data!, secretKey: secret.data! }
}

/**
 * Extract the CLI DEPLOY key pair from the request headers. OPTIONAL: when the
 * CLI headers are absent, falls back to the SDK key pair (one key doing both,
 * the common case). When ONE CLI header is present but not the other, fails
 * closed rather than silently mixing an SDK secret with a CLI access key.
 */
export function cliCredentialsFromHeaders(
  headers: RequestHeaders,
  sdk: SdkConstructorOptions,
): CliCredentials {
  const access = headerValue(headers, CLI_ACCESS_KEY_HEADER)
  const secret = headerValue(headers, CLI_SECRET_KEY_HEADER)
  // Neither present → reuse the SDK pair as the deploy pair.
  if (access === undefined && secret === undefined) {
    return { accessKey: sdk.accessKey, secretKey: sdk.secretKey }
  }
  // One present, one not → ambiguous, fail closed.
  const parsedAccess = NonEmpty.safeParse(access)
  const parsedSecret = NonEmpty.safeParse(secret)
  const missing: string[] = []
  if (!parsedAccess.success) missing.push(CLI_ACCESS_KEY_HEADER)
  if (!parsedSecret.success) missing.push(CLI_SECRET_KEY_HEADER)
  if (missing.length > 0) {
    throw new MissingCredentialsError(
      `incomplete OneBlink CLI deploy credential header(s): ${missing.join(', ')} ` +
        `(provide both CLI headers, or neither to reuse the SDK key)`,
    )
  }
  return { accessKey: parsedAccess.data!, secretKey: parsedSecret.data! }
}
