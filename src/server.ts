/**
 * Builds the MCP server instance and registers all workflow capabilities.
 * Keeping this separate from index.ts lets tests construct a server without
 * attaching a stdio transport.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerWorkflows } from './workflows/index.js'

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'oneblink-mcp',
    version: '0.1.0',
  })

  registerWorkflows(server)

  return server
}
