/**
 * Configuration loader.
 *
 * SECURITY (see .kiro/steering/security.md):
 *   - Environment variables are reserved for values that change PER forms-app
 *     ENVIRONMENT (credentials, tenant, forms-app ids, form ids). They must NOT
 *     be used for common operational parameters (limit, offset, search terms,
 *     etc.) — those belong in the individual workflow tool inputs instead.
 *   - Credentials are read here once and never logged.
 *
 * The OneBlink SDK authenticates every service class with a Developer Key
 * access/secret pair, e.g. `new OneBlink.Forms({ accessKey, secretKey })`.
 * Developer Keys carry role permissions and app associations — see the SDK
 * docs (https://oneblink.github.io/sdk-node-js/) and security rule 1.
 *
 * This is scaffolding: it defines WHERE per-environment config comes from, not
 * any workflow behaviour. Extend the schema as workflows are added, but keep
 * the per-environment-only rule.
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
 * Per-environment configuration. Everything here legitimately differs between
 * OneBlink environments (dev / staging / prod, or tenant to tenant).
 *
 * NOTE: Do NOT add request-shaping options (page size, filters, sort order)
 * to this schema — they are not per-environment and must be workflow inputs.
 */
const ConfigSchema = z.object({
  /** OneBlink Developer Key — access key id. Secret: never logged. */
  accessKey: z.string().min(1, 'ONEBLINK_ACCESS_KEY is required'),
  /** OneBlink Developer Key — secret access key. Secret: never logged. */
  secretKey: z.string().min(1, 'ONEBLINK_SECRET_KEY is required'),
  /** OneBlink tenant / instance. Defaults to the OneBlink Console. */
  tenant: z.enum(TENANTS).default('oneblink'),
})

export type Config = z.infer<typeof ConfigSchema>

/**
 * Tenant selection WITHOUT credentials. The brokered HTTP path gets the
 * accessKey/secretKey from the CredentialResolver per tenant, so it must NOT
 * require the stdio env credentials — it only needs to know which OneBlink
 * SDK entry point (Console / US / CivicPlus) to target, which is a
 * per-environment, non-secret value.
 */
export function loadTenant(env: NodeJS.ProcessEnv = process.env): Tenant {
  const parsed = z.enum(TENANTS).default('oneblink').safeParse(env.ONEBLINK_TENANT)
  if (!parsed.success) {
    throw new Error('Invalid OneBlink configuration: tenant')
  }
  return parsed.data
}

/**
 * Reads per-environment config from the process environment and validates it.
 * Throws a non-sensitive error (variable NAMES only, never values) on failure.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse({
    accessKey: env.ONEBLINK_ACCESS_KEY,
    secretKey: env.ONEBLINK_SECRET_KEY,
    tenant: env.ONEBLINK_TENANT,
  })

  if (!parsed.success) {
    // Report missing/invalid variable NAMES only — never echo their values.
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(`Invalid OneBlink configuration: ${names}`)
  }

  return parsed.data
}

/**
 * HTTP + OAuth config (remote transport).
 *
 * All per-environment: issuer / audience / JWKS / bind / port legitimately
 * differ per environment (local Keycloak vs a deployed Cognito pool), so they
 * are env vars (security rule 3). The OneBlink keys themselves are NOT here —
 * they live in the credential resolver's store (gitignored file / secrets
 * manager), keyed by tenant.
 */
const HttpConfigSchema = z.object({
  /** Bind address. PoC MUST stay loopback. */
  bind: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  /**
   * Externally-reachable base URL a client uses to reach THIS server
   * (no trailing slash), e.g. http://127.0.0.1:3000 for the PoC or
   * https://mcp.example.com behind a proxy. Distinct from `bind`: the server
   * may bind 0.0.0.0 in a container but is reached at a different address.
   * Used to build the RFC 9728 resource identifier and the metadata URL in
   * WWW-Authenticate. Per-environment -> env var (security rule 3).
   */
  publicUrl: z
    .string()
    .url('HTTP_PUBLIC_URL must be a URL')
    .optional()
    .transform((u) => (u ? u.replace(/\/+$/, '') : u)),
  /** OAuth issuer (`iss`). Keycloak realm URL now, Cognito pool issuer later. */
  issuer: z.string().url('HTTP_OAUTH_ISSUER must be a URL'),
  /** JWKS endpoint for token signature verification. */
  jwksUri: z.string().url('HTTP_OAUTH_JWKS_URI must be a URL'),
  /** Required token audience — MUST equal this server's identifier. */
  audience: z.string().min(1, 'HTTP_OAUTH_AUDIENCE is required'),
  /** Token claim carrying the tenant key. */
  tenantClaim: z.string().default('tenant'),
  /** Path to the gitignored local OneBlink keys file (PoC resolver). */
  keyFile: z.string().default('oneblink-keys.local.json'),
})

export type HttpConfig = z.infer<typeof HttpConfigSchema> & {
  /**
   * Concrete externally-reachable base URL, always set. Uses `publicUrl` when
   * provided, else derives a reachable loopback URL from the port. NEVER the
   * bind address, which may be 0.0.0.0 (not reachable by a client).
   */
  resolvedPublicUrl: string
}

/** Loads + validates HTTP/OAuth config. Throws with variable NAMES only. */
export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const parsed = HttpConfigSchema.safeParse({
    bind: env.HTTP_BIND,
    port: env.HTTP_PORT,
    publicUrl: env.HTTP_PUBLIC_URL,
    issuer: env.HTTP_OAUTH_ISSUER,
    jwksUri: env.HTTP_OAUTH_JWKS_URI,
    audience: env.HTTP_OAUTH_AUDIENCE,
    tenantClaim: env.HTTP_OAUTH_TENANT_CLAIM,
    keyFile: env.HTTP_KEY_FILE,
  })
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(`Invalid HTTP/OAuth configuration: ${names}`)
  }
  const resolvedPublicUrl = parsed.data.publicUrl ?? `http://127.0.0.1:${parsed.data.port}`
  return { ...parsed.data, resolvedPublicUrl }
}
