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
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { OneBlinkClient } from './oneblink-client.js'

const storage = new AsyncLocalStorage<OneBlinkClient>()

/** Run `fn` with `client` bound as the current request's OneBlink client. */
export function runWithClient<T>(client: OneBlinkClient, fn: () => Promise<T>): Promise<T> {
  return storage.run(client, fn)
}

/** The current request's client, if inside runWithClient; else undefined. */
export function currentClient(): OneBlinkClient | undefined {
  return storage.getStore()
}
