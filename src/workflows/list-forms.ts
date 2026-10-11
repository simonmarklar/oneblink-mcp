/**
 * Workflow: list_forms
 *
 * Lists forms for a given workspace and/or environment. Read-only.
 * Spec: docs/requirements/list-forms.md
 * Follows: .kiro/skills/oneblink-list-pagination, steering tool-design + security.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getClient } from '../lib/oneblink-client.js'
import { project, resolveFields } from '../lib/projection.js'
import { logger } from '../lib/logger.js'

/** Default output projection (spec). Also the allowed-field set for `fields`. */
export const ALLOWED_FIELDS = [
  'id',
  'name',
  'formsAppEnvironmentId',
  'workspaceId',
  'isAuthenticated',
  'createdAt',
  'updatedAt',
  // other top-level Form props selectable via `fields`:
  'description',
  'formsAppIds',
  'elements',
  'submissionEvents',
  'tags',
  'postSubmissionAction',
  'isMultiPage',
  'isInfoPage',
] as const

const DEFAULT_FIELDS = [
  'id',
  'name',
  'formsAppEnvironmentId',
  'workspaceId',
  'isAuthenticated',
  'createdAt',
  'updatedAt',
] as const

const MAX_PAGE = 200
const STREAM_PAGE_CAP = 50 // safety cap: max internal pages in stream mode

const baseShape = {
  workspaceId: z.number().int().positive().optional(),
  formsAppEnvironmentId: z.number().int().positive().optional(),
  mode: z.enum(['page', 'stream']).default('page'),
  limit: z.number().int().min(1).max(MAX_PAGE).default(50),
  offset: z.number().int().min(0).default(0),
  fields: z
    .array(z.enum(ALLOWED_FIELDS))
    .nonempty()
    .optional()
    .describe('Top-level form properties to return. Defaults to a trimmed set.'),
} as const

const inputSchema = z.object(baseShape).refine(
  (v) => v.workspaceId !== undefined || v.formsAppEnvironmentId !== undefined,
  { message: 'Provide workspaceId and/or formsAppEnvironmentId — at least one is required.' },
)

/** Exported for unit tests. */
export const listFormsInputSchema = inputSchema

type Input = z.infer<typeof inputSchema>

/** Build the SDK search filter from validated input (ids only). */
function toFilter(input: Input): { workspaceId?: number; formsAppEnvironmentId?: number } {
  const f: { workspaceId?: number; formsAppEnvironmentId?: number } = {}
  if (input.workspaceId !== undefined) f.workspaceId = input.workspaceId
  if (input.formsAppEnvironmentId !== undefined) f.formsAppEnvironmentId = input.formsAppEnvironmentId
  return f
}

export function registerListForms(server: McpServer): void {
  server.tool(
    'list_forms',
    'List forms for a given workspace and/or environment. Read-only. Supports ' +
      'paging (default) or JSONL stream mode for bulk export, and optional field selection.',
    baseShape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = inputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        // Validation failure: surface the message, fail closed. No PII.
        return {
          isError: true,
          content: [{ type: 'text', text: parsed.error.errors.map((e) => e.message).join('; ') }],
        }
      }
      const input = parsed.data
      const fields = resolveFields(input.fields, DEFAULT_FIELDS)
      const filter = toFilter(input)
      const forms = getClient().forms()

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
            const result = await forms.searchForms({ ...filter, limit: MAX_PAGE, offset })
            for (const form of result.forms) {
              lines.push(JSON.stringify(project(form as Record<string, unknown>, fields)))
            }
            if (result.forms.length < MAX_PAGE) break
            offset += MAX_PAGE
          }
          logger.info('list_forms', {
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

        // page mode
        const result = await forms.searchForms({ ...filter, limit: input.limit, offset: input.offset })
        const items = result.forms.map((form: Record<string, unknown>) =>
          project(form, fields),
        )
        const nextOffset = result.forms.length === input.limit ? input.offset + input.limit : null
        logger.info('list_forms', {
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
        // A09: log message/status only, never the raw error or request.
        const message = err instanceof Error ? err.message : 'Unknown error'
        logger.error('list_forms failed', { mode: input.mode, message })
        return { isError: true, content: [{ type: 'text', text: `list_forms failed: ${message}` }] }
      }
    },
  )
}
