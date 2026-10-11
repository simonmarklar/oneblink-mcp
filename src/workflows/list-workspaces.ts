/**
 * Workflow: list_workspaces
 *
 * OneBlink's Developer Key SDK has NO workspace-listing endpoint — `workspaceId`
 * is only ever an opaque search filter on forms / environments / templates.
 * This tool therefore DERIVES the set of workspace ids by scanning all
 * forms-app environments (which reliably carry a `workspaceId`) and returning
 * the distinct ids, each with the environments that reference it.
 *
 * This is a convenience/discovery helper, not a native resource. If OneBlink
 * later exposes a Workspaces API, swap the derivation for the direct call.
 *
 * Read-only. Follows steering tool-design + security.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getClient } from '../lib/oneblink-client.js'
import { logger } from '../lib/logger.js'

const SCAN_PAGE = 200
const SCAN_PAGE_CAP = 50 // safety: max environment pages to scan

const baseShape = {
  includeEnvironments: z
    .boolean()
    .default(true)
    .describe('Include the environments referencing each workspace. False = ids only.'),
} as const

const inputSchema = z.object(baseShape)
export const listWorkspacesInputSchema = inputSchema

interface EnvRef {
  id: number
  name: string | null
}

export function registerListWorkspaces(server: McpServer): void {
  server.tool(
    'list_workspaces',
    'List the distinct workspace ids in this tenant. DERIVED from forms-app ' +
      'environments (the SDK has no workspace-listing API), so each workspace is ' +
      'reported with the environments that reference it. Read-only.',
    baseShape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = inputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: 'text', text: parsed.error.errors.map((e) => e.message).join('; ') }],
        }
      }
      const input = parsed.data
      const svc = getClient().formsAppEnvironments()

      try {
        const byWorkspace = new Map<number, EnvRef[]>()
        let offset = 0
        let truncated = false
        let scanned = 0
        for (let page = 0; ; page++) {
          if (page >= SCAN_PAGE_CAP) {
            truncated = true
            break
          }
          const result = await svc.searchFormsAppEnvironments({ limit: SCAN_PAGE, offset })
          for (const env of result.formsAppEnvironments as unknown as Array<Record<string, unknown>>) {
            scanned++
            const wsId = env.workspaceId
            if (typeof wsId !== 'number') continue // null / unset -> not a workspace
            const ref: EnvRef = {
              id: typeof env.id === 'number' ? env.id : -1,
              name: typeof env.name === 'string' ? env.name : null,
            }
            const list = byWorkspace.get(wsId) ?? []
            list.push(ref)
            byWorkspace.set(wsId, list)
          }
          if (result.formsAppEnvironments.length < SCAN_PAGE) break
          offset += SCAN_PAGE
        }

        const workspaces = [...byWorkspace.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([workspaceId, envs]) =>
            input.includeEnvironments
              ? { workspaceId, environmentCount: envs.length, environments: envs }
              : { workspaceId, environmentCount: envs.length },
          )

        logger.info('list_workspaces', {
          workspaceCount: workspaces.length,
          environmentsScanned: scanned,
          truncated,
        })

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                items: workspaces,
                meta: {
                  derivedFrom: 'forms_app_environments',
                  workspaceCount: workspaces.length,
                  environmentsScanned: scanned,
                  truncated,
                },
              }),
            },
          ],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        logger.error('list_workspaces failed', { message })
        return { isError: true, content: [{ type: 'text', text: `list_workspaces failed: ${message}` }] }
      }
    },
  )
}
