/**
 * Per-request client context (HTTP path).
 *
 * The HTTP transport resolves a per-tenant OneBlink client for each
 * authenticated request and runs the tool handler inside this context.
 * getClient() reads the context first, so WORKFLOW CODE IS UNCHANGED between
 * stdio and HTTP — it always just calls getClient(). (Acceptance: the Cognito
 * swap touches only the auth adapters, never workflows.)
 *
 * stdio has no context set → getClient() falls back to the env singleton.
 *
 * It also carries a SEPARATE per-request slot for the `oneblink` CLI's DEPLOY
 * key pair (runWithCliCredentials / currentCliCredentials), consumed by
 * getCliCredentials() in cli-credentials.js. CLI deploy keys are a different
 * credential from the SDK Developer Key (OWASP A01), so they ride a parallel
 * ALS slot rather than being reused from the client's sdkOptions.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { OneBlinkClient } from './oneblink-client.js'
import type { CliCredentials } from './cli-credentials.js'

const storage = new AsyncLocalStorage<OneBlinkClient>()

/** Run `fn` with `client` bound as the current request's OneBlink client. */
export function runWithClient<T>(client: OneBlinkClient, fn: () => Promise<T>): Promise<T> {
  return storage.run(client, fn)
}

/** The current request's client, if inside runWithClient; else undefined. */
export function currentClient(): OneBlinkClient | undefined {
  return storage.getStore()
}

/**
 * Per-request CLI DEPLOY-key context — a SEPARATE credential from the SDK
 * Developer Key the client above carries.
 *
 * WHY SEPARATE (not reused from currentClient().sdkOptions): the `oneblink`
 * CLI's `api deploy` / `cdn deploy` authenticate with a DEPLOYMENT key pair,
 * a different credential with different permissions than the SDK Developer Key
 * (see cli-config.ts header; OWASP A01 — don't let one tool's authority leak
 * into another's). Keeping a parallel ALS slot keeps the two conceptually
 * separable while mirroring runWithClient/currentClient exactly.
 *
 * The HTTP transport resolves these per request (per verified tenant) and runs
 * the handler inside runWithCliCredentials. stdio has no context set →
 * getCliCredentials() falls back to the env key pair (loadCliConfig), exactly
 * as getClient() falls back to the env singleton.
 */
const cliStorage = new AsyncLocalStorage<CliCredentials>()

/** Run `fn` with `credentials` bound as the current request's CLI deploy keys. */
export function runWithCliCredentials<T>(
  credentials: CliCredentials,
  fn: () => Promise<T>,
): Promise<T> {
  return cliStorage.run(credentials, fn)
}

/** The current request's CLI deploy keys, if inside runWithCliCredentials; else undefined. */
export function currentCliCredentials(): CliCredentials | undefined {
  return cliStorage.getStore()
}
