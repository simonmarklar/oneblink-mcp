/**
 * JWKS-based token verifier (jose).
 *
 * Works unchanged for Keycloak (PoC) and Cognito (prod): both publish a JWKS
 * endpoint and are standards-compliant OIDC issuers. Only the configured
 * issuer / jwksUri / audience differ — never this code. (Spec: auth-session.md,
 * steering rule 5.)
 *
 * SECURITY: enforces audience === this server (RFC 8707, confused-deputy
 * defense, OWASP API2). Never logs the token or its claims beyond a non-
 * sensitive subject/tenant for audit.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { AuthContext, TokenVerifier } from './types.js'
import { UnauthorizedError } from './types.js'

export interface JwksVerifierOptions {
  /** Expected `iss`. e.g. http://localhost:8080/realms/oneblink-poc (Keycloak) or the Cognito pool issuer. */
  issuer: string
  /** JWKS URL. Keycloak: .../protocol/openid-connect/certs ; Cognito: .../.well-known/jwks.json */
  jwksUri: string
  /** Required `aud` — MUST equal this server's identifier. Foreign audience → 401. */
  audience: string
  /** Token claim holding the tenant key. Default 'tenant'. */
  tenantClaim?: string
}

export class JwksTokenVerifier implements TokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>
  private readonly tenantClaim: string

  constructor(private readonly opts: JwksVerifierOptions) {
    this.jwks = createRemoteJWKSet(new URL(opts.jwksUri))
    this.tenantClaim = opts.tenantClaim ?? 'tenant'
  }

  async verify(bearerToken: string): Promise<AuthContext> {
    const token = stripBearer(bearerToken)
    if (!token) throw new UnauthorizedError('missing bearer token')

    let payload: Record<string, unknown>
    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer: this.opts.issuer,
        audience: this.opts.audience, // RFC 8707 — rejects foreign-audience tokens
      })
      payload = result.payload as Record<string, unknown>
    } catch (err) {
      // Do not leak token/claims. Keep the jose reason for diagnostics only.
      const reason = err instanceof Error ? err.message : 'verification failed'
      throw new UnauthorizedError(`token verification failed: ${reason}`)
    }

    const tenant = payload[this.tenantClaim]
    if (typeof tenant !== 'string' || tenant.length === 0) {
      throw new UnauthorizedError(`token missing '${this.tenantClaim}' claim`)
    }
    const subject = typeof payload.sub === 'string' ? payload.sub : 'unknown'
    const scopes = parseScopes(payload.scope)

    return { tenant, subject, scopes }
  }
}

function stripBearer(header: string): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (m && m[1]) return m[1].trim()
  // Also accept a bare token.
  return header.trim() || null
}

function parseScopes(scope: unknown): string[] {
  if (typeof scope === 'string') return scope.split(/\s+/).filter(Boolean)
  if (Array.isArray(scope)) return scope.filter((s): s is string => typeof s === 'string')
  return []
}
