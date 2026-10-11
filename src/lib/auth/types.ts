/**
 * Auth seam types — the ONLY boundary that changes going local → Cognito.
 * Spec: docs/requirements/auth-session.md (PoC section).
 *
 * Steering rule 5: caller auth and OneBlink auth are two credentials for two
 * hops. These interfaces keep workflow code ignorant of both — a workflow only
 * ever asks getClient(auth, resolver) for a service.
 */
import type { SdkConstructorOptions } from '../oneblink-client.js'

/**
 * The result of validating a caller's token (HTTP) or synthesizing identity
 * from the process env (stdio interim). Identifies which tenant's OneBlink key
 * to broker. Carries NO secret.
 */
export interface AuthContext {
  /** Tenant key used to resolve the OneBlink Developer Key. From the token claim (HTTP) or env (stdio). */
  readonly tenant: string
  /** Opaque principal id (token `sub`), for non-sensitive audit logging. */
  readonly subject: string
  /** Granted scopes/roles, if any. */
  readonly scopes: readonly string[]
}

/**
 * Validates the caller's bearer token.
 * PoC: JwksTokenVerifier → Keycloak JWKS.
 * Prod: SAME class → Cognito JWKS (config only). This interface does not change.
 */
export interface TokenVerifier {
  /**
   * Verify signature (JWKS), expiry, issuer, and audience === this server.
   * Reject (throw) on any failure → caller maps to 401. Returns the principal
   * to broker as. Never returns or logs the raw token.
   */
  verify(bearerToken: string): Promise<AuthContext>
}

/**
 * Maps a verified tenant to its OneBlink Developer Key.
 * PoC: FileCredentialResolver → gitignored local JSON.
 * Prod: SecretsManagerCredentialResolver → AWS Secrets Manager. Same interface.
 */
export interface CredentialResolver {
  /** Resolve the OneBlink key for a tenant. Throw if unknown; never log the key. */
  resolve(tenant: string): Promise<SdkConstructorOptions>
}

/** Thrown by a TokenVerifier when a token is absent/invalid → HTTP 401. */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnauthorizedError'
  }
}
