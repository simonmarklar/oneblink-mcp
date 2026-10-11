/**
 * HTTP transport integration test — boots the real server on an ephemeral port.
 *
 * Locks in the header-credential contract and, specifically, the regression
 * that caused the MCP Inspector to fail with "Dynamic Client Registration
 * rejected (HTTP 404)": a 401 MUST NOT carry a `WWW-Authenticate` header, or an
 * MCP client treats it as an OAuth challenge and attempts DCR against endpoints
 * this server does not have.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer as createNetServer } from 'node:net'

/** Grab a free localhost port by opening then closing a server on :0. */
async function freePort(): Promise<number> {
  const srv = createNetServer()
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  const addr = srv.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  await new Promise<void>((r) => srv.close(() => r()))
  return port
}

let child: ChildProcess
let base: string

before(async () => {
  const port = await freePort()
  base = `http://127.0.0.1:${port}/mcp`
  child = spawn(process.execPath, ['dist/http.js'], {
    env: { ...process.env, HTTP_PORT: String(port), HTTP_BIND: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  // Poll until the server answers (it logs to stderr; we just probe the port).
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(base, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error('server did not start in time')
})

after(() => {
  child.kill()
})

test('a 401 (missing credential headers) carries NO WWW-Authenticate header (no OAuth/DCR trigger)', async () => {
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  assert.equal(res.status, 401)
  // THE regression guard: no OAuth challenge header.
  assert.equal(res.headers.get('www-authenticate'), null)
  const body = (await res.json()) as { error: string; message: string }
  assert.equal(body.error, 'unauthorized')
  assert.match(body.message, /x-oneblink-access-key/i)
})

test('a request WITH credential headers passes the gate and reaches the MCP server', async () => {
  const res = await fetch(base, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-oneblink-access-key': 'ak-dummy',
      'x-oneblink-secret-key': 'sk-dummy',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    }),
  })
  assert.equal(res.status, 200)
  const text = await res.text()
  // Streamable HTTP returns an SSE frame; the initialize result is in it.
  assert.match(text, /"serverInfo"/)
  assert.match(text, /oneblink-mcp/)
})

test('an unknown path is 404 (and still no WWW-Authenticate)', async () => {
  const res = await fetch(`${base.replace('/mcp', '')}/nope`, { method: 'GET' })
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('www-authenticate'), null)
})
