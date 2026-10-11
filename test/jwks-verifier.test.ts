/**
 * JwksTokenVerifier tests — real tokens, no Keycloak, no network.
 *
 * Proves the security-critical paths: valid token accepted, foreign-audience
 * rejected (RFC 8707 / confused-deputy), wrong-issuer rejected, missing-tenant
 * rejected. Uses jose to generate a local key pair and inject a LocalJWKSet so
 * the verifier's remote-JWKS path is exercised against known keys.
 */
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose'
import { JwksTokenVerifier } from '../src/lib/auth/jwks-verifier.js'
import { UnauthorizedError } from '../src/lib/auth/types.js'

const ISSUER = 'http://localhost:8080/realms/oneblink-poc'
const AUDIENCE = 'oneblink-mcp'

let privateKey: KeyLike
let verifier: JwksTokenVerifier

/** Build a verifier whose JWKS is our in-memory public key (no network). */
async function makeVerifier(publicKey: KeyLike): Promise<JwksTokenVerifier> {
  const jwk = await exportJWK(publicKey)
  jwk.kid = 'test-key'
  jwk.alg = 'RS256'
  jwk.use = 'sig'
  const v = new JwksTokenVerifier({ issuer: ISSUER, jwksUri: 'http://unused.local/jwks', audience: AUDIENCE })
  // Replace the remote JWKS fetch with a local set resolving our key.
  // @ts-expect-error — override the private field for test isolation.
  v.jwks = async () => publicKey
  return v
}

async function mint(claims: Record<string, unknown>, opts: { aud?: string; iss?: string } = {}): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setExpirationTime('5m')
    .sign(privateKey)
}

describe('JwksTokenVerifier', () => {
  before(async () => {
    const kp = await generateKeyPair('RS256')
    privateKey = kp.privateKey
    verifier = await makeVerifier(kp.publicKey)
  })

  it('accepts a valid token and returns the tenant/subject', async () => {
    const token = await mint({ sub: 'user-1', tenant: 'acme', scope: 'read' })
    const ctx = await verifier.verify(`Bearer ${token}`)
    assert.equal(ctx.tenant, 'acme')
    assert.equal(ctx.subject, 'user-1')
    assert.deepEqual(ctx.scopes, ['read'])
  })

  it('rejects a foreign-audience token (RFC 8707 / confused deputy)', async () => {
    const token = await mint({ sub: 'u', tenant: 'acme' }, { aud: 'some-other-api' })
    await assert.rejects(() => verifier.verify(`Bearer ${token}`), UnauthorizedError)
  })

  it('rejects a wrong-issuer token', async () => {
    const token = await mint({ sub: 'u', tenant: 'acme' }, { iss: 'http://evil.example/realm' })
    await assert.rejects(() => verifier.verify(`Bearer ${token}`), UnauthorizedError)
  })

  it('rejects a token missing the tenant claim', async () => {
    const token = await mint({ sub: 'u' })
    await assert.rejects(() => verifier.verify(`Bearer ${token}`), /missing 'tenant' claim/)
  })

  it('rejects a missing bearer token', async () => {
    await assert.rejects(() => verifier.verify(''), /missing bearer token/)
  })
})
