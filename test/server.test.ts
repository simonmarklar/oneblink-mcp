import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../src/server.ts'
import { loadTenant } from '../src/lib/config.ts'

test('server constructs without throwing', () => {
  const server = createServer()
  assert.ok(server, 'createServer() should return a server instance')
})

test('loadTenant defaults to oneblink when unset', () => {
  assert.equal(loadTenant({} as NodeJS.ProcessEnv), 'oneblink')
})

test('loadTenant accepts a valid tenant', () => {
  assert.equal(loadTenant({ ONEBLINK_TENANT: 'oneblink-us' } as NodeJS.ProcessEnv), 'oneblink-us')
})

test('loadTenant rejects an unknown tenant', () => {
  assert.throws(() => loadTenant({ ONEBLINK_TENANT: 'not-a-tenant' } as NodeJS.ProcessEnv), /tenant/)
})
