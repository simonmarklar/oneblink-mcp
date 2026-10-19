/**
 * Workflow: list_element_lookups
 *
 * List element/data lookups so a create_form caller can reference an existing
 * lookup by id (dataLookupId / elementLookupId). Read-only. Pair tool to
 * create_element_lookup.
 * Spec: docs/requirements/list-element-lookups.md
 * Follows: .kiro/skills/oneblink-list-pagination, steering tool-design + security.
 *
 * SDK facts (verified against @oneblink/types + SDK v13):
 *   FormElementLookups.searchFormElementLookups(
 *     { organisationId: string; workspaceId?: number; limit?; offset? })
 *     : Promise<FormElementLookupSearchResult>
 *   FormElementLookupSearchResult = { formElementLookups: FormElementLookup[] }
 *     & BaseSearchResult   // BaseSearchResult.meta = { limit?; offset?; nextOffset? }
 * organisationId is REQUIRED by the SDK but DERIVED server-side (rule 1); the
 * derived org is the mandatory scope filter satisfying rule 2 (no org-wide
 * fan-out from an unscoped call — the credential's own org is the bound).
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
  'type',
  'updatedAt',
  // allowed adds (spec):
  'organisationId',
  'environments',
  'apiId',
  'createdAt',
] as const

const DEFAULT_FIELDS = ['id', 'name', 'type', 'updatedAt'] as const

const MAX_PAGE = 200
const STREAM_PAGE_CAP = 50 // safety cap: max internal pages in stream mode

const baseShape = {
  workspaceId: z.number().int().positive().optional().describe('SDK-supported scope filter.'),
  mode: z.enum(['page', 'stream']).default('page'),
  limit: z.number().int().min(1).max(MAX_PAGE).default(50),
  offset: z.number().int().min(0).default(0),
  fields: z
    .array(z.enum(ALLOWED_FIELDS))
    .nonempty()
    .optional()
    .describe('Top-level lookup properties to return. Defaults to a trimmed set.'),
} as const

const inputSchema = z.object(baseShape)
/** Exported for unit tests. */
export const listElementLookupsInputSchema = inputSchema

type Input = z.infer<typeof inputSchema>

/**
 * Derive organisationId server-side (rule 1 — never a model input). Read it from
 * one existing form the credential can see, mirroring create_form/create_element_lookup.
 */
async function deriveOrganisationId(): Promise<{ organisationId: string } | { error: string }> {
  const forms = getClient().forms()
  try {
    const probe = (await forms.searchForms({ limit: 1, offset: 0 } as never)) as unknown as {
      forms?: Array<{ organisationId?: string }>
    }
    const org = probe.forms?.[0]?.organisationId
    if (typeof org !== 'string' || org.length === 0) {
      return {
        error:
          'Could not derive organisationId from the credential (no existing form to read it from). ' +
          'Create at least one form in the console first, or supply a tenant with existing forms.',
      }
    }
    return { organisationId: org }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'org derivation failed'
    return { error: `Could not resolve organisationId: ${message}` }
  }
}

export function registerListElementLookups(server: McpServer): void {
  server.tool(
    'list_element_lookups',
    'List element/data lookups so a create_form caller can reference an existing ' +
      'lookup by id (dataLookupId / elementLookupId). Read-only. The organisation ' +
      'scope is derived from the credential; workspaceId is an optional narrower ' +
      'scope. Supports paging (default) or JSONL stream mode, and optional field selection.',
    baseShape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = inputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: 'text', text: parsed.error.errors.map((e) => e.message).join('; ') }],
        }
      }
      const input: Input = parsed.data
      const fields = resolveFields(input.fields, DEFAULT_FIELDS)

      const derived = await deriveOrganisationId()
      if ('error' in derived) {
        return { isError: true, content: [{ type: 'text', text: derived.error }] }
      }
      const { organisationId } = derived
      const scope: { organisationId: string; workspaceId?: number } = { organisationId }
      if (input.workspaceId !== undefined) scope.workspaceId = input.workspaceId

      const lookups = getClient().formElementLookups()

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
            const result = await lookups.searchFormElementLookups({ ...scope, limit: MAX_PAGE, offset })
            for (const lookup of result.formElementLookups) {
              lines.push(JSON.stringify(project(lookup as unknown as Record<string, unknown>, fields)))
            }
            if (result.formElementLookups.length < MAX_PAGE) break
            offset += MAX_PAGE
          }
          // A09: log mode/workspaceId?/returnedCount only.
          logger.info('list_element_lookups', {
            mode: 'stream',
            ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
            returnedCount: lines.length,
            truncated,
          })
          const body = truncated
            ? `${lines.join('\n')}\n${JSON.stringify({ truncated: true })}`
            : lines.join('\n')
          return { content: [{ type: 'text', text: body }] }
        }

        // page mode
        const result = await lookups.searchFormElementLookups({
          ...scope,
          limit: input.limit,
          offset: input.offset,
        })
        const items = result.formElementLookups.map((lookup) =>
          project(lookup as unknown as Record<string, unknown>, fields),
        )
        // Use the SDK's authoritative nextOffset (rule 6), never a derived heuristic.
        const nextOffset = result.meta?.nextOffset ?? null
        logger.info('list_element_lookups', {
          mode: 'page',
          ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
          returnedCount: items.length,
        })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                items,
                meta: {
                  limit: input.limit,
                  offset: input.offset,
                  returnedCount: items.length,
                  nextOffset,
                },
              }),
            },
          ],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        logger.error('list_element_lookups failed', { mode: input.mode, message })
        return { isError: true, content: [{ type: 'text', text: `list_element_lookups failed: ${message}` }] }
      }
    },
  )
}
