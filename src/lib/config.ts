/**
 * Configuration loader.
 *
 * SECURITY (see .kiro/steering/security.md):
 *   - Environment variables are reserved for values that change PER forms-app
 *     ENVIRONMENT (tenant, forms-app ids, form ids). They must NOT be used for
 *     common operational parameters (limit, offset, search terms, etc.) —
 *     those belong in the individual workflow tool inputs instead.
 *   - CREDENTIALS ARE NOT ENV VARS. This is an HTTP-only server: the caller
 *     supplies its OneBlink Developer Key per session via request headers
 *     (src/lib/auth/header-credentials.ts). Nothing here reads a key.
 *
 * The OneBlink SDK authenticates every service class with a Developer Key
 * access/secret pair, e.g. `new OneBlink.Forms({ accessKey, secretKey })`.
 * Developer Keys carry role permissions and app associations — see the SDK
 * docs (https://oneblink.github.io/sdk-node-js/) and security rule 1.
 */
import { z } from 'zod'

/**
 * The OneBlink SDK is multi-tenant. The tenant selects the import path /
 * instance (OneBlink Console, OneBlink US, or CivicOptimize). Which tenant you
 * target legitimately changes per environment, so it is configured here.
 */
export const TENANTS = ['oneblink', 'oneblink-us', 'civicplus'] as const
export type Tenant = (typeof TENANTS)[number]

/**
 * The resolved client config: the caller's per-session key pair plus the
 * server's tenant selection. Built in oneblink-client.ts from the request's
 * header credentials — NOT read from the environment.
 */
export interface Config {
  /** OneBlink Developer Key — access key id (from the request header). */
  accessKey: string
  /** OneBlink Developer Key — secret access key (from the request header). */
  secretKey: string
  /** OneBlink tenant / instance. Per-environment, non-secret. */
  tenant: Tenant
}

/**
 * Tenant selection WITHOUT credentials. HTTP-only: the accessKey/secretKey come
 * from the caller's request headers, so this reads only which OneBlink SDK
 * entry point (Console / US / CivicPlus) to target — a per-environment,
 * non-secret value.
 */
export function loadTenant(env: NodeJS.ProcessEnv = process.env): Tenant {
  const parsed = z.enum(TENANTS).default('oneblink').safeParse(env.ONEBLINK_TENANT)
  if (!parsed.success) {
    throw new Error('Invalid OneBlink configuration: tenant')
  }
  return parsed.data
}

/**
 * HTTP transport config (remote transport).
 *
 * Only bind/port are server settings now. The OneBlink keys are NOT here and
 * NOT in any server-held store: the caller supplies its own key pair per
 * session via request headers (src/lib/auth/header-credentials.ts). Both
 * bind/port legitimately differ per environment, so they are env vars
 * (security rule 3).
 */
const HttpConfigSchema = z.object({
  /** Bind address. PoC MUST stay loopback. */
  bind: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().min(1).max(65535).default(3000),
})

export type HttpConfig = z.infer<typeof HttpConfigSchema>

/** Loads + validates HTTP config. Throws with variable NAMES only. */
export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const parsed = HttpConfigSchema.safeParse({
    bind: env.HTTP_BIND,
    port: env.HTTP_PORT,
  })
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(`Invalid HTTP configuration: ${names}`)
  }
  return parsed.data
}
