/**
 * Workflow: list_forms_app_environments
 *
 * Lists forms-app environments (e.g. "Production", "Test"), each carrying the
 * ids other tools need: its own `id` (the formsAppEnvironmentId used by
 * list_forms) and its `workspaceId`. Read-only.
 *
 * Follows: .kiro/skills/oneblink-list-pagination, steering tool-design + security.
 * SDK: FormsAppEnvironments.searchFormsAppEnvironments() -> { formsAppEnvironments, meta }.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getClient } from '../lib/oneblink-client.js'
import { project, resolveFields } from '../lib/projection.js'
import { logger } from '../lib/logger.js'

/** Allowed selectable top-level fields (the FormsAppEnvironment shape). */
export const ALLOWED_FIELDS = [
  'id',
  'name',
  'slug',
  'workspaceId',
  'organisationId',
  'description',
  'notificationEmailAddresses',
  'createdAt',
  'updatedAt',
] as const

/** Default projection: the ids/labels a caller needs to drive other tools. */
const DEFAULT_FIELDS = [
  'id',
  'name',
  'slug',
  'workspaceId',
  'organisationId',
  'description',
] as const

const MAX_PAGE = 200
const STREAM_PAGE_CAP = 50

const baseShape = {
  workspaceId: z.number().int().positive().optional().describe('Filter to one workspace id.'),
  mode: z.enum(['page', 'stream']).default('page'),
  limit: z.number().int().min(1).max(MAX_PAGE).default(50),
  offset: z.number().int().min(0).default(0),
  fields: z
    .array(z.enum(ALLOWED_FIELDS))
    .nonempty()
    .optional()
    .describe('Top-level environment properties to return. Defaults to a trimmed set.'),
} as const

const inputSchema = z.object(baseShape)
export const listFormsAppEnvironmentsInputSchema = inputSchema
type Input = z.infer<typeof inputSchema>

function toFilter(input: Input): { workspaceId?: number } {
  return input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}
}

export function registerListFormsAppEnvironments(server: McpServer): void {
  server.tool(
    'list_forms_app_environments',
    'List forms-app environments (Production, Test, ...). Each result carries ' +
      'its `id` (the formsAppEnvironmentId list_forms takes) and its `workspaceId`. ' +
      'Read-only. Supports paging (default) or JSONL stream mode, and optional field selection.',
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
      const fields = resolveFields(input.fields, DEFAULT_FIELDS)
      const filter = toFilter(input)
      const svc = getClient().formsAppEnvironments()

      try {
        if (input.mode === 'stream') {
          const lines: string[] = []
          let offset = 0
          let truncated = false
          for (let page = 0; ; page++) {
            if (page >= STREAM_PAGE_CAP) {
              truncated = true
              break
            }
            const result = await svc.searchFormsAppEnvironments({ ...filter, limit: MAX_PAGE, offset })
            for (const env of result.formsAppEnvironments) {
              lines.push(JSON.stringify(project(env as unknown as Record<string, unknown>, fields)))
            }
            if (result.formsAppEnvironments.length < MAX_PAGE) break
            offset += MAX_PAGE
          }
          logger.info('list_forms_app_environments', {
            mode: 'stream',
            ...filter,
            returnedCount: lines.length,
            truncated,
          })
          const body = truncated
            ? `${lines.join('\n')}\n${JSON.stringify({ truncated: true })}`
            : lines.join('\n')
          return { content: [{ type: 'text', text: body }] }
        }

        // page mode — use the SDK's own nextOffset (authoritative).
        const result = await svc.searchFormsAppEnvironments({
          ...filter,
          limit: input.limit,
          offset: input.offset,
        })
        const items = result.formsAppEnvironments.map((env) =>
          project(env as unknown as Record<string, unknown>, fields),
        )
        const nextOffset = result.meta?.nextOffset ?? null
        logger.info('list_forms_app_environments', {
          mode: 'page',
          ...filter,
          limit: input.limit,
          offset: input.offset,
          returnedCount: items.length,
        })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                items,
                meta: { limit: input.limit, offset: input.offset, returnedCount: items.length, nextOffset },
              }),
            },
          ],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        logger.error('list_forms_app_environments failed', { mode: input.mode, message })
        return {
          isError: true,
          content: [{ type: 'text', text: `list_forms_app_environments failed: ${message}` }],
        }
      }
    },
  )
}
