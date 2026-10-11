import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadCliConfig, getCliConfig, _resetCliConfig, CLI_CONFIG_ENV_VARS } from '../src/lib/cli-config.ts'

const KEYS = { ONEBLINK_ACCESS_KEY: 'ak-123', ONEBLINK_SECRET_KEY: 'sk-top-secret' }

test('loads the deploy key pair from env', () => {
  const cfg = loadCliConfig({ ...KEYS } as NodeJS.ProcessEnv)
  assert.equal(cfg.accessKey, 'ak-123')
  assert.equal(cfg.secretKey, 'sk-top-secret')
  assert.equal(cfg.cliBin, undefined)
})

test('cliBin is optional and read from ONEBLINK_CLI_BIN', () => {
  const cfg = loadCliConfig({ ...KEYS, ONEBLINK_CLI_BIN: '/usr/local/bin/oneblink' } as NodeJS.ProcessEnv)
  assert.equal(cfg.cliBin, '/usr/local/bin/oneblink')
})

test('fails closed when the access key is missing', () => {
  assert.throws(
    () => loadCliConfig({ ONEBLINK_SECRET_KEY: 'sk' } as NodeJS.ProcessEnv),
    /ONEBLINK_ACCESS_KEY/,
  )
})

test('fails closed when the secret key is missing', () => {
  assert.throws(
    () => loadCliConfig({ ONEBLINK_ACCESS_KEY: 'ak' } as NodeJS.ProcessEnv),
    /ONEBLINK_SECRET_KEY/,
  )
})

test('error names the env vars, never their values', () => {
  try {
    loadCliConfig({} as NodeJS.ProcessEnv)
    assert.fail('expected a throw')
  } catch (err) {
    const msg = (err as Error).message
    assert.match(msg, /ONEBLINK_ACCESS_KEY/)
    assert.match(msg, /ONEBLINK_SECRET_KEY/)
    // A secret value would never be here (none supplied), but assert the shape:
    // the message is NAMES only.
    assert.doesNotMatch(msg, /sk-top-secret/)
  }
})

test('getCliConfig caches and _resetCliConfig clears it', () => {
  _resetCliConfig()
  const a = getCliConfig({ ...KEYS } as NodeJS.ProcessEnv)
  // Second call with DIFFERENT env returns the cached first value.
  const b = getCliConfig({ ...KEYS, ONEBLINK_ACCESS_KEY: 'different' } as NodeJS.ProcessEnv)
  assert.equal(b.accessKey, a.accessKey)
  assert.equal(b.accessKey, 'ak-123')
  _resetCliConfig()
  const c = getCliConfig({ ...KEYS, ONEBLINK_ACCESS_KEY: 'different' } as NodeJS.ProcessEnv)
  assert.equal(c.accessKey, 'different')
  _resetCliConfig()
})

test('CLI_CONFIG_ENV_VARS maps field names to env var names', () => {
  assert.equal(CLI_CONFIG_ENV_VARS.accessKey, 'ONEBLINK_ACCESS_KEY')
  assert.equal(CLI_CONFIG_ENV_VARS.secretKey, 'ONEBLINK_SECRET_KEY')
  assert.equal(CLI_CONFIG_ENV_VARS.cliBin, 'ONEBLINK_CLI_BIN')
})
