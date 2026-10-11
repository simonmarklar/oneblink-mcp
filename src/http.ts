#!/usr/bin/env node
/**
 * OneBlink MCP server — HTTP (OAuth Resource Server) entry point.
 *
 * This is the remote transport specced in docs/requirements/auth-session.md.
 * It is the OAuth 2.1 **Resource Server**: it validates the caller's bearer
 * token (audience === this server, RFC 8707), resolves that tenant's OneBlink
 * Developer Key via a CredentialResolver, and runs the MCP tool call with a
 * per-request brokered client. The OneBlink key never leaves this process and
 * is never logged (A09) or returned to the client.
 *
 * SWAP SEAM (steering rule 5): to move to Cognito + Secrets Manager, change
 * only the TokenVerifier config and the CredentialResolver impl below. The
 * transport, routing, workflows, and server factory are untouched.
 *
 * PoC: binds loopback only; token verifier → Keycloak JWKS; resolver → local
 * gitignored JSON.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from './server.js'
import { loadHttpConfig, type HttpConfig } from './lib/config.js'
import { JwksTokenVerifier } from './lib/auth/jwks-verifier.js'
import { FileCredentialResolver } from './lib/auth/file-resolver.js'
import { UnauthorizedError, type TokenVerifier, type CredentialResolver } from './lib/auth/types.js'
import { getClientFor } from './lib/oneblink-client.js'
import { getCliCredentialsFor } from './lib/cli-credentials.js'
import { runWithClient, runWithCliCredentials } from './lib/request-context.js'
import { logger } from './lib/logger.js'

const MCP_PATH = '/mcp'
const METADATA_PATH = '/.well-known/oauth-protected-resource'

async function main(): Promise<void> {
  const cfg = loadHttpConfig()

  // --- The two swap seams. Change ONLY these for Cognito + Secrets Manager. --
  const verifier: TokenVerifier = new JwksTokenVerifier({
    issuer: cfg.issuer,
    jwksUri: cfg.jwksUri,
    audience: cfg.audience,
    tenantClaim: cfg.tenantClaim,
  })
  const resolver: CredentialResolver = new FileCredentialResolver(cfg.keyFile)
  // ---------------------------------------------------------------------------

  const http = createHttpServer((req, res) => {
    handle(req, res, cfg, verifier, resolver).catch((err: unknown) => {
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
      issuer: cfg.issuer,
      audience: cfg.audience,
    })
  })
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: HttpConfig,
  verifier: TokenVerifier,
  resolver: CredentialResolver,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${cfg.bind}:${cfg.port}`)

  // RFC 9728 Protected Resource Metadata — unauthenticated discovery.
  if (req.method === 'GET' && url.pathname === METADATA_PATH) {
    sendJson(res, 200, {
      resource: cfg.audience,
      authorization_servers: [cfg.issuer],
      bearer_methods_supported: ['header'],
    })
    return
  }

  if (url.pathname !== MCP_PATH) {
    sendJson(res, 404, { error: 'not_found' })
    return
  }

  // --- AuthN: validate the caller's bearer token (audience === this server) --
  const authHeader = req.headers.authorization
  if (!authHeader) {
    return unauthorized(res, cfg, 'missing bearer token')
  }
  let auth
  try {
    auth = await verifier.verify(authHeader)
  } catch (err) {
    const message = err instanceof UnauthorizedError ? err.message : 'invalid token'
    return unauthorized(res, cfg, message)
  }

  // --- Resolve this tenant's OneBlink key and broker the call ---------------
  let client
  let cliCredentials
  try {
    client = await getClientFor(auth, resolver)
    // CLI deploy keys resolve through the SAME resolver, keyed by the SAME
    // system-derived tenant, but via a SEPARATE accessor so SDK Developer Keys
    // and CLI deploy keys stay conceptually distinct (OWASP A01). The deploy
    // tools read these from the request context via getCliCredentials().
    cliCredentials = await getCliCredentialsFor(auth, resolver)
  } catch (err) {
    // e.g. no key configured for the tenant. Non-sensitive message, fail closed.
    const message = err instanceof Error ? err.message : 'credential resolution failed'
    logger.warn('credential resolution failed', { tenant: auth.tenant, subject: auth.subject })
    sendJson(res, 403, { error: 'forbidden', message })
    return
  }

  const body = await readJsonBody(req)

  // Fresh stateless server + transport per request; run the handler with the
  // per-tenant client bound in context so getClient() returns it.
  const server = createServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  logger.info('mcp request', { tenant: auth.tenant, subject: auth.subject })
  await runWithClient(client, async () => {
    await runWithCliCredentials(cliCredentials, async () => {
      await transport.handleRequest(req, res, body)
    })
  })
}

/** 401 with the RFC 9728 metadata pointer in WWW-Authenticate. */
function unauthorized(res: ServerResponse, cfg: HttpConfig, detail: string): void {
  const metadataUrl = `${cfg.resolvedPublicUrl}${METADATA_PATH}`
  res.setHeader(
    'WWW-Authenticate',
    `Bearer realm="oneblink-mcp", error="invalid_token", resource_metadata="${metadataUrl}"`,
  )
  // Do not log the token or the detail at info; detail is non-sensitive here.
  logger.info('unauthorized', { reason: detail })
  sendJson(res, 401, { error: 'unauthorized', message: detail })
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
