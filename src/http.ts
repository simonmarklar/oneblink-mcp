#!/usr/bin/env node
/**
 * OneBlink MCP server — HTTP transport.
 *
 * CREDENTIAL MODEL (auth-session.md, revised 2026-10-11): the CALLER supplies
 * its OWN OneBlink Developer Key on each HTTP session, via request HEADERS:
 *
 *   X-OneBlink-Access-Key: <access key>
 *   X-OneBlink-Secret-Key: <secret key>
 *
 * and, OPTIONALLY, a separate CLI deploy key pair for the deploy workflows:
 *
 *   X-OneBlink-CLI-Access-Key: <deploy access key>
 *   X-OneBlink-CLI-Secret-Key: <deploy secret key>
 *
 * The server holds NO keys: it does not read `.env` or any key file, and there
 * is no OAuth broker. Each request builds a client from that request's own
 * header pair and runs the MCP tool call inside the per-request context, so
 * getClient()/getCliCredentials() and every workflow read the key from that
 * context. HTTP-only — there is no stdio transport and no env fallback.
 *
 * SECURITY:
 *   - Credentials ride HEADERS, never tool arguments — they never enter the
 *     model's context, the transcript, or tool logs (the one hard MCP rule
 *     kept). They are never logged (A09) and never returned to the client.
 *   - Fail closed: a request missing a required credential header → 401, with a
 *     message naming the HEADER, never the value.
 *   - PoC binds loopback only. A hosted deployment MUST terminate TLS in front
 *     so the header pair is never sent in clear text.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from './server.js'
import { loadHttpConfig, type HttpConfig } from './lib/config.js'
import { buildClientFromCredentials } from './lib/oneblink-client.js'
import {
  sdkCredentialsFromHeaders,
  cliCredentialsFromHeaders,
  MissingCredentialsError,
  type RequestHeaders,
} from './lib/auth/header-credentials.js'
import { runWithClient, runWithCliCredentials } from './lib/request-context.js'
import { logger } from './lib/logger.js'

const MCP_PATH = '/mcp'

async function main(): Promise<void> {
  const cfg = loadHttpConfig()

  const http = createHttpServer((req, res) => {
    handle(req, res, cfg).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'unknown error'
      logger.error('unhandled request error', { message })
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' })
    })
  })

  http.listen(cfg.port, cfg.bind, () => {
    // Loopback-only bind is a PoC security requirement.
    logger.info('oneblink-mcp HTTP server started', {
      transport: 'streamable-http',
      bind: cfg.bind,
      port: cfg.port,
      credentials: 'per-session request headers',
    })
  })
}

async function handle(req: IncomingMessage, res: ServerResponse, cfg: HttpConfig): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${cfg.bind}:${cfg.port}`)

  if (url.pathname !== MCP_PATH) {
    sendJson(res, 404, { error: 'not_found' })
    return
  }

  // --- Per-session credentials from the request headers ---------------------
  // The caller's own OneBlink key pair rides the connection as headers. We
  // build a client from it for this request only; the key never leaves this
  // process and is never logged.
  let client
  let cliCredentials
  try {
    const headers = req.headers as RequestHeaders
    const sdk = sdkCredentialsFromHeaders(headers)
    const cli = cliCredentialsFromHeaders(headers, sdk)
    client = buildClientFromCredentials(sdk)
    cliCredentials = cli
  } catch (err) {
    if (err instanceof MissingCredentialsError) {
      // Fail closed. Non-secret message (header names only).
      logger.info('unauthorized', { reason: 'missing credential header(s)' })
      return unauthorized(res, err.message)
    }
    const message = err instanceof Error ? err.message : 'credential error'
    logger.warn('credential header error', { message })
    return unauthorized(res, 'invalid credential header(s)')
  }

  const body = await readJsonBody(req)

  // Fresh stateless server + transport per request; run the handler with the
  // per-session client bound in context so getClient() returns it.
  const server = createServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  logger.info('mcp request', { path: url.pathname })
  await runWithClient(client, async () => {
    await runWithCliCredentials(cliCredentials, async () => {
      await transport.handleRequest(req, res, body)
    })
  })
}

/**
 * 401 for a request without usable credential headers.
 *
 * Deliberately NO `WWW-Authenticate` header: per the MCP authorization spec an
 * MCP client treats a 401 carrying `WWW-Authenticate` as an OAuth challenge and
 * launches RFC 9728 metadata discovery + RFC 7591 Dynamic Client Registration.
 * This is a HEADER-CREDENTIAL server, not an OAuth resource server — advertising
 * OAuth sends the client (e.g. the MCP Inspector) down the DCR path, which 404s
 * because there are no OAuth endpoints. So we return a plain JSON 401 that tells
 * the caller which credential headers to send instead.
 */
function unauthorized(res: ServerResponse, detail: string): void {
  sendJson(res, 401, {
    error: 'unauthorized',
    message: detail,
    hint: 'Send the OneBlink credentials as request headers: X-OneBlink-Access-Key and X-OneBlink-Secret-Key (plus optional X-OneBlink-CLI-Access-Key / X-OneBlink-CLI-Secret-Key for deploy tools). This server does not use OAuth.',
  })
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const payload = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return undefined
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error'
  logger.error('fatal HTTP startup error', { message })
  process.exit(1)
})
