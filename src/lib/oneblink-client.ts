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
 * request only — the caller supplies its own key pair per session via request
 * headers (auth/header-credentials.ts); http.ts builds a client with
 * buildClientFromCredentials() and binds it with runWithClient(). getClient()
 * reads it from that context. There is no server-held key and no env fallback.
 */
import { loadTenant, type Config } from './config.js'
import { Forms, FormsAppEnvironments, EmailTemplates, FormElementLists, FormElementLookups } from '@oneblink/sdk'
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
  /** FormsAppEnvironments service, scoped to the resolved Developer Key. */
  formsAppEnvironments(): FormsAppEnvironments
  /** EmailTemplates service, scoped to the resolved Developer Key. */
  emailTemplates(): EmailTemplates
  /** FormElementLists service, scoped to the resolved Developer Key. */
  formElementLists(): FormElementLists
  /** FormElementLookups service, scoped to the resolved Developer Key. */
  formElementLookups(): FormElementLookups
}

/** Build a client around an explicit set of SDK options (key already resolved). */
function buildClient(sdkOptions: SdkConstructorOptions, config: Config): OneBlinkClient {
  let formsService: Forms | undefined
  let envService: FormsAppEnvironments | undefined
  let emailTemplateService: EmailTemplates | undefined
  let formElementListsService: FormElementLists | undefined
  let formElementLookupsService: FormElementLookups | undefined
  return {
    config,
    sdkOptions,
    forms() {
      // Default tenant (Console). Tenant-specific entry points are wired here
      // when a non-default tenant is configured.
      formsService ??= new Forms(sdkOptions)
      return formsService
    },
    formsAppEnvironments() {
      envService ??= new FormsAppEnvironments(sdkOptions)
      return envService
    },
    emailTemplates() {
      emailTemplateService ??= new EmailTemplates(sdkOptions)
      return emailTemplateService
    },
    formElementLists() {
      formElementListsService ??= new FormElementLists(sdkOptions)
      return formElementListsService
    },
    formElementLookups() {
      formElementLookupsService ??= new FormElementLookups(sdkOptions)
      return formElementLookupsService
    },
  }
}

// --- HTTP-only: the client comes from the per-request context ---------------

/**
 * Returns the OneBlink client for the current call. HTTP-only: the client is
 * built from the caller's own header-supplied key pair and bound in the
 * per-request context by http.ts (runWithClient). There is no server-held key
 * and no process-global fallback.
 *
 * Throws when called outside a request context — a workflow must only run
 * inside runWithClient. Credentials are never logged.
 */
export function getClient(): OneBlinkClient {
  const reqClient = currentClient()
  if (!reqClient) {
    throw new Error('no OneBlink client in context: a tool ran outside an authenticated HTTP request')
  }
  return reqClient
}

// --- HTTP path: per-session credentials from the request --------------------

/**
 * Build a client from a key pair the CALLER supplied on this HTTP session (via
 * request headers; see auth/header-credentials.ts). There is no tenant broker
 * and no server-held key: the credential IS the request's header pair, so each
 * session gets its own client built from its own keys.
 *
 * Not cached across requests: different sessions carry different keys, and the
 * key pair is the identity here. (A per-key-pair cache would key the cache on
 * the secret itself — avoided; client construction is cheap.)
 *
 * The SDK tenant (Console / US / CivicPlus) is still a per-environment,
 * non-secret server setting (loadTenant), unchanged by the credential source.
 */
export function buildClientFromCredentials(sdkOptions: SdkConstructorOptions): OneBlinkClient {
  const config: Config = {
    accessKey: sdkOptions.accessKey,
    secretKey: sdkOptions.secretKey,
    tenant: loadTenant(),
  }
  return buildClient(sdkOptions, config)
}
