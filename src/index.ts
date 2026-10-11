#!/usr/bin/env node
/**
 * OneBlink MCP server — entry point.
 *
 * This server is intentionally WORKFLOW-FOCUSED: it does NOT 1:1 wrap the
 * OneBlink SDK. Each registered capability groups several common SDK calls
 * into one task an operator actually wants to perform.
 *
 * No workflow tools are implemented yet — this is scaffolding. Workflows are
 * registered in src/workflows/index.ts as we define requirements for each.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'
import { logger } from './lib/logger.js'

async function main(): Promise<void> {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // stdio transport: do NOT write anything to stdout — it is the protocol
  // channel. All diagnostics go to stderr via the logger.
  logger.info('oneblink-mcp server started', { transport: 'stdio' })
}

main().catch((err: unknown) => {
  logger.error('fatal startup error', { error: errorSummary(err) })
  process.exit(1)
})

/** Reduce an unknown error to a non-sensitive, loggable summary (OWASP A09). */
function errorSummary(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return 'unknown error'
}
