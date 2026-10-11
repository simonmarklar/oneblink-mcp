/**
 * OneBlink SDK client factory.
 *
 * The OneBlink SDK (@oneblink/sdk) does NOT expose a single god-client.
 * Instead each service is its own class, constructed with the same Developer
 * Key options object, and imported from a tenant-specific path:
 *
 *   import * as OneBlink from '@oneblink/sdk'                   // default (Console)
 *   import * as OneBlinkUS from '@oneblink/sdk/tenants/oneblink-us.js'
 *   import * as CivicPlus from '@oneblink/sdk/tenants/civicplus.js'
 *
 *   const forms = new OneBlink.Forms({ accessKey, secretKey })
 *
 * Available service classes (SDK v13):
 *   Approvals, DataManager, EmailTemplates, FormElementLists,
 *   FormElementLookups, Forms, FormsAppEnvironments, FormsApps, Jobs, Keys,
 *   Organisations, PDF  (+ a top-level sendEmail function)
 *
 * This module is the single auditable place where credentials meet the SDK.
 * Workflows ask it for the service(s) they need rather than importing the SDK
 * directly, so auth and tenant selection stay in one place.
 *
 * CREDENTIAL SOURCE (steering rule 5): the OneBlink key comes from the current
 * auth context, resolved by a CredentialResolver.
 *   - stdio interim: getClient() with no args → env (loadConfig), one identity.
 *   - HTTP: getClientFor(auth, resolver) → per-tenant key from the resolver.
 * Workflow code calls getClient() and is unaware which path produced the key;
 * swapping the resolver (local file → Secrets Manager) never touches it.
 */
import { loadConfig, loadTenant, type Config } from './config.js'
import { Forms } from '@oneblink/sdk'
import type { AuthContext, CredentialResolver } from './auth/types.js'
import { currentClient } from './request-context.js'

/** Developer Key options object every SDK service constructor accepts. */
export interface SdkConstructorOptions {
  accessKey: string
  secretKey: string
}

export interface OneBlinkClient {
  readonly config: Config
  readonly sdkOptions: SdkConstructorOptions
  /** Forms service, scoped to the resolved Developer Key. */
  forms(): Forms
}

/** Build a client around an explicit set of SDK options (key already resolved). */
function buildClient(sdkOptions: SdkConstructorOptions, config: Config): OneBlinkClient {
  let formsService: Forms | undefined
  return {
    config,
    sdkOptions,
    forms() {
      // Default tenant (Console). Tenant-specific entry points are wired here
      // when a non-default tenant is configured.
      formsService ??= new Forms(sdkOptions)
      return formsService
    },
  }
}

// --- stdio interim path: process-global singleton from env ------------------

let cached: OneBlinkClient | undefined

/**
 * Returns the OneBlink client for the current call.
 *   - HTTP: the per-request, per-tenant client bound by the transport
 *     (runWithClient) — brokered from the resolved Developer Key.
 *   - stdio interim: a lazily-constructed process-global singleton from the
 *     env (loadConfig), one process = one identity.
 * Workflow code calls this with no args and is unaware which path produced the
 * key. Credentials are never logged.
 */
export function getClient(): OneBlinkClient {
  const reqClient = currentClient()
  if (reqClient) return reqClient
  if (cached) return cached
  const config = loadConfig()
  cached = buildClient({ accessKey: config.accessKey, secretKey: config.secretKey }, config)
  return cached
}

/** Reset the cached stdio client. Test-only. */
export function _resetClient(): void {
  cached = undefined
}

// --- HTTP path: per-auth-context, tenant-keyed cache ------------------------

const perTenant = new Map<string, OneBlinkClient>()

/**
 * Returns a client for a verified caller. The OneBlink key is resolved per
 * tenant via the CredentialResolver (local file in PoC, Secrets Manager in
 * prod). Cached per tenant. The key never leaves this module.
 */
export async function getClientFor(
  auth: AuthContext,
  resolver: CredentialResolver,
): Promise<OneBlinkClient> {
  const existing = perTenant.get(auth.tenant)
  if (existing) return existing
  const sdkOptions = await resolver.resolve(auth.tenant)
  // Credential-free tenant selection: the key came from the resolver above,
  // so we must NOT call loadConfig() (which requires the stdio env key pair
  // the brokered HTTP path doesn't have). We only need which SDK tenant to
  // target. Per-caller tenant mapping is a future enhancement.
  const config: Config = {
    accessKey: sdkOptions.accessKey,
    secretKey: sdkOptions.secretKey,
    tenant: loadTenant(),
  }
  const client = buildClient(sdkOptions, config)
  perTenant.set(auth.tenant, client)
  return client
}

/** Reset the per-tenant cache. Test-only. */
export function _resetTenantClients(): void {
  perTenant.clear()
}
