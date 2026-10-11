import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadCliConfig, getCliConfig, _resetCliConfig, CLI_CONFIG_ENV_VARS } from '../src/lib/cli-config.ts'

test('cliBin is optional — an empty env yields no cliBin and does not throw', () => {
  const cfg = loadCliConfig({} as NodeJS.ProcessEnv)
  assert.equal(cfg.cliBin, undefined)
})

test('cliBin is read from ONEBLINK_CLI_BIN', () => {
  const cfg = loadCliConfig({ ONEBLINK_CLI_BIN: '/usr/local/bin/oneblink' } as NodeJS.ProcessEnv)
  assert.equal(cfg.cliBin, '/usr/local/bin/oneblink')
})

test('no credentials are read here (key pair is per-caller, from request headers)', () => {
  const cfg = loadCliConfig({
    ONEBLINK_ACCESS_KEY: 'ak',
    ONEBLINK_SECRET_KEY: 'sk',
  } as NodeJS.ProcessEnv)
  assert.equal('accessKey' in cfg, false)
  assert.equal('secretKey' in cfg, false)
  assert.equal(cfg.cliBin, undefined)
})

test('getCliConfig caches and _resetCliConfig clears it', () => {
  _resetCliConfig()
  const a = getCliConfig({ ONEBLINK_CLI_BIN: '/bin/one' } as NodeJS.ProcessEnv)
  // Second call with DIFFERENT env returns the cached first value.
  const b = getCliConfig({ ONEBLINK_CLI_BIN: '/bin/two' } as NodeJS.ProcessEnv)
  assert.equal(b.cliBin, a.cliBin)
  assert.equal(b.cliBin, '/bin/one')
  _resetCliConfig()
  const c = getCliConfig({ ONEBLINK_CLI_BIN: '/bin/two' } as NodeJS.ProcessEnv)
  assert.equal(c.cliBin, '/bin/two')
  _resetCliConfig()
})

test('CLI_CONFIG_ENV_VARS maps cliBin to its env var name', () => {
  assert.equal(CLI_CONFIG_ENV_VARS.cliBin, 'ONEBLINK_CLI_BIN')
})
