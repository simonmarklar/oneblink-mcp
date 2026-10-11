/**
 * Credential-source tests — no network, no live SDK.
 * Covers: header credential extraction (SDK + CLI, fail-closed), per-request
 * client context fallback, and buildClientFromCredentials from a header pair.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  sdkCredentialsFromHeaders,
  cliCredentialsFromHeaders,
  MissingCredentialsError,
  SDK_ACCESS_KEY_HEADER,
  SDK_SECRET_KEY_HEADER,
  CLI_ACCESS_KEY_HEADER,
  CLI_SECRET_KEY_HEADER,
  type RequestHeaders,
} from '../src/lib/auth/header-credentials.js'
import { currentClient, runWithClient } from '../src/lib/request-context.js'
import {
  getClient,
  buildClientFromCredentials,
  type OneBlinkClient,
} from '../src/lib/oneblink-client.js'

describe('sdkCredentialsFromHeaders', () => {
  it('reads the SDK key pair from the request headers', () => {
    const headers: RequestHeaders = {
      [SDK_ACCESS_KEY_HEADER]: 'AK',
      [SDK_SECRET_KEY_HEADER]: 'SK',
    }
    assert.deepEqual(sdkCredentialsFromHeaders(headers), { accessKey: 'AK', secretKey: 'SK' })
  })

  it('trims surrounding whitespace', () => {
    const headers: RequestHeaders = {
      [SDK_ACCESS_KEY_HEADER]: '  AK  ',
      [SDK_SECRET_KEY_HEADER]: '\tSK\n',
    }
    assert.deepEqual(sdkCredentialsFromHeaders(headers), { accessKey: 'AK', secretKey: 'SK' })
  })

  it('collapses an array-valued header to its first entry', () => {
    const headers: RequestHeaders = {
      [SDK_ACCESS_KEY_HEADER]: ['AK', 'other'],
      [SDK_SECRET_KEY_HEADER]: 'SK',
    }
    assert.deepEqual(sdkCredentialsFromHeaders(headers), { accessKey: 'AK', secretKey: 'SK' })
  })

  it('fails closed when the access-key header is missing, naming the header', () => {
    const headers: RequestHeaders = { [SDK_SECRET_KEY_HEADER]: 'SK' }
    try {
      sdkCredentialsFromHeaders(headers)
      assert.fail('should have thrown')
    } catch (err) {
      assert.ok(err instanceof MissingCredentialsError)
      assert.ok(err.message.includes(SDK_ACCESS_KEY_HEADER))
      assert.ok(!err.message.includes('SK')) // never echo the value
    }
  })

  it('fails closed when both headers are missing', () => {
    assert.throws(() => sdkCredentialsFromHeaders({}), MissingCredentialsError)
  })

  it('treats an empty-string header as missing', () => {
    const headers: RequestHeaders = { [SDK_ACCESS_KEY_HEADER]: '  ', [SDK_SECRET_KEY_HEADER]: 'SK' }
    assert.throws(() => sdkCredentialsFromHeaders(headers), MissingCredentialsError)
  })
})

describe('cliCredentialsFromHeaders', () => {
  const sdk = { accessKey: 'SDK-AK', secretKey: 'SDK-SK' }

  it('reuses the SDK pair when no CLI headers are present', () => {
    assert.deepEqual(cliCredentialsFromHeaders({}, sdk), { accessKey: 'SDK-AK', secretKey: 'SDK-SK' })
  })

  it('reads a dedicated CLI deploy pair when both CLI headers are present', () => {
    const headers: RequestHeaders = {
      [CLI_ACCESS_KEY_HEADER]: 'CLI-AK',
      [CLI_SECRET_KEY_HEADER]: 'CLI-SK',
    }
    assert.deepEqual(cliCredentialsFromHeaders(headers, sdk), {
      accessKey: 'CLI-AK',
      secretKey: 'CLI-SK',
    })
  })

  it('fails closed when only one CLI header is present (no silent mixing)', () => {
    const headers: RequestHeaders = { [CLI_ACCESS_KEY_HEADER]: 'CLI-AK' }
    assert.throws(() => cliCredentialsFromHeaders(headers, sdk), MissingCredentialsError)
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
    assert.equal(currentClient(), undefined)
  })

  it('getClient throws when called outside a request context (HTTP-only)', () => {
    assert.throws(() => getClient(), /outside an authenticated HTTP request/)
  })
})

describe('buildClientFromCredentials', () => {
  it('builds a client whose sdkOptions are the supplied header pair', () => {
    const client = buildClientFromCredentials({ accessKey: 'ak-session', secretKey: 'sk-session' })
    assert.equal(client.sdkOptions.accessKey, 'ak-session')
    assert.equal(client.sdkOptions.secretKey, 'sk-session')
  })

  it('builds a distinct client per session (no shared cache)', () => {
    const a = buildClientFromCredentials({ accessKey: 'ak-a', secretKey: 'sk-a' })
    const b = buildClientFromCredentials({ accessKey: 'ak-b', secretKey: 'sk-b' })
    assert.notEqual(a, b)
    assert.notEqual(a.sdkOptions.secretKey, b.sdkOptions.secretKey)
  })
})
