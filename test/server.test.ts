import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../src/server.ts'
import { loadConfig } from '../src/lib/config.ts'

test('server constructs without throwing', () => {
  const server = createServer()
  assert.ok(server, 'createServer() should return a server instance')
})

test('loadConfig reports missing credentials by NAME, never value', () => {
  assert.throws(
    () => loadConfig({} as NodeJS.ProcessEnv),
    /accessKey|secretKey/,
    'should reject empty environment and name the missing variables',
  )
})

test('loadConfig defaults tenant to oneblink and accepts valid keys', () => {
  const config = loadConfig({
    ONEBLINK_ACCESS_KEY: 'test-access',
    ONEBLINK_SECRET_KEY: 'test-secret',
  } as NodeJS.ProcessEnv)
  assert.equal(config.tenant, 'oneblink')
})

test('loadConfig rejects an unknown tenant', () => {
  assert.throws(
    () =>
      loadConfig({
        ONEBLINK_ACCESS_KEY: 'a',
        ONEBLINK_SECRET_KEY: 'b',
        ONEBLINK_TENANT: 'not-a-tenant',
      } as NodeJS.ProcessEnv),
    /tenant/,
  )
})
