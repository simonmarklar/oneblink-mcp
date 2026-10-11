/**
 * Workflow registry.
 *
 * A "workflow" is a single MCP tool that groups several common OneBlink SDK
 * operations into one task-oriented capability. We deliberately do NOT expose
 * the SDK 1:1 — each workflow should map to something a user actually wants to
 * accomplish (e.g. "publish a form and verify it renders", not "call
 * forms.updateForm then forms.getForm").
 *
 * The OneBlink SDK (v13) exposes these service classes to compose from:
 *   Approvals, DataManager, EmailTemplates, FormElementLists,
 *   FormElementLookups, Forms, FormsAppEnvironments, FormsApps, Jobs, Keys,
 *   Organisations, PDF  (+ a top-level sendEmail function).
 *
 * Each workflow lives in its own file under src/workflows/ and exports a
 * `register<Name>(server)` function. Add its call here once its requirements
 * are agreed. No workflows are implemented yet.
 *
 * The intended shape of a workflow module (for reference — not active):
 *
 *   // src/workflows/example.ts
 *   import { z } from 'zod'
 *   import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
 *   import { getClient } from '../lib/oneblink-client.js'
 *
 *   export function registerExample(server: McpServer): void {
 *     server.tool(
 *       'example_workflow',
 *       'One-line, task-oriented description shown to the model.',
 *       // limit/offset/filters are INPUTS here, never env vars (security rule 3)
 *       { formsAppId: z.number().describe('OneBlink Forms App id') },
 *       async (args) => {
 *         const client = getClient()
 *         // construct the SDK service(s) this workflow needs from client.sdkOptions,
 *         // orchestrate several calls, return a task-level result
 *         return { content: [{ type: 'text', text: 'result' }] }
 *       },
 *     )
 *   }
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerListForms } from './list-forms.js'

export function registerWorkflows(server: McpServer): void {
  registerListForms(server)
}
