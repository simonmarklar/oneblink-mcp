/**
 * Auth seam tests — no Keycloak, no live SDK.
 * Covers: credential resolver (resolve / fail-closed / malformed), per-request
 * client context fallback, and getClientFor per-tenant caching.
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileCredentialResolver } from '../src/lib/auth/file-resolver.js'
import { currentClient, runWithClient } from '../src/lib/request-context.js'
import {
  getClient,
  getClientFor,
  _resetClient,
  _resetTenantClients,
  type OneBlinkClient,
} from '../src/lib/oneblink-client.js'
import type { AuthContext, CredentialResolver } from '../src/lib/auth/types.js'

function tmpKeyFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ob-keys-'))
  const path = join(dir, 'keys.json')
  writeFileSync(path, contents)
  return path
}

describe('FileCredentialResolver', () => {
  it('resolves a configured tenant key', async () => {
    const path = tmpKeyFile(JSON.stringify({ acme: { accessKey: 'AK', secretKey: 'SK' } }))
    const r = new FileCredentialResolver(path)
    const key = await r.resolve('acme')
    assert.deepEqual(key, { accessKey: 'AK', secretKey: 'SK' })
  })

  it('fails closed for an unknown tenant', async () => {
    const path = tmpKeyFile(JSON.stringify({ acme: { accessKey: 'AK', secretKey: 'SK' } }))
    const r = new FileCredentialResolver(path)
    await assert.rejects(() => r.resolve('ghost'), /no OneBlink key configured for tenant 'ghost'/)
  })

  it('rejects a malformed key file', async () => {
    const path = tmpKeyFile(JSON.stringify({ acme: { accessKey: 'AK' } })) // missing secretKey
    const r = new FileCredentialResolver(path)
    await assert.rejects(() => r.resolve('acme'), /malformed/)
  })

  it('reports an unreadable file without echoing fs internals', async () => {
    const r = new FileCredentialResolver(join(tmpdir(), 'does-not-exist-xyz.json'))
    await assert.rejects(() => r.resolve('acme'), /credential file not readable/)
  })

  it('never includes the secret in the thrown message', async () => {
    const path = tmpKeyFile(JSON.stringify({ acme: { accessKey: 'AK', secretKey: 'TOPSECRET' } }))
    const r = new FileCredentialResolver(path)
    try {
      await r.resolve('ghost')
      assert.fail('should have thrown')
    } catch (err) {
      assert.ok(err instanceof Error)
      assert.ok(!err.message.includes('TOPSECRET'))
    }
  })
})

describe('request context', () => {
  it('currentClient is undefined outside runWithClient', () => {
    assert.equal(currentClient(), undefined)
  })

  it('getClient returns the context client inside runWithClient', async () => {
    const fake = { marker: 'ctx' } as unknown as OneBlinkClient
    await runWithClient(fake, async () => {
      assert.equal(getClient(), fake)
    })
    // and falls back outside the context (to the env singleton path)
    assert.equal(currentClient(), undefined)
  })
})

describe('getClientFor', () => {
  beforeEach(() => {
    _resetClient()
    _resetTenantClients()
    process.env.ONEBLINK_ACCESS_KEY = 'env-ak'
    process.env.ONEBLINK_SECRET_KEY = 'env-sk'
  })

  const resolver: CredentialResolver = {
    async resolve(tenant: string) {
      return { accessKey: `ak-${tenant}`, secretKey: `sk-${tenant}` }
    },
  }
  const auth = (tenant: string): AuthContext => ({ tenant, subject: 'sub', scopes: [] })

  it('resolves per-tenant SDK options', async () => {
    const client = await getClientFor(auth('acme'), resolver)
    assert.equal(client.sdkOptions.accessKey, 'ak-acme')
    assert.equal(client.sdkOptions.secretKey, 'sk-acme')
  })

  it('caches per tenant (same instance for repeat tenant)', async () => {
    const a1 = await getClientFor(auth('acme'), resolver)
    const a2 = await getClientFor(auth('acme'), resolver)
    const b = await getClientFor(auth('other'), resolver)
    assert.equal(a1, a2)
    assert.notEqual(a1, b)
  })
})
