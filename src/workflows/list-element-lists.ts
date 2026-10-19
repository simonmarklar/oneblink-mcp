/**
 * Workflow: list_element_lists
 *
 * List reusable element option sets so a create_form caller can reference an
 * existing list by id (as dynamicOptionSetId). Read-only. Pair to
 * create_element_list.
 * Spec: docs/requirements/list-element-lists.md.
 * Follows: .kiro/skills/oneblink-list-pagination, steering tool-design + security.
 *
 * SDK: FormElementLists.searchFormElementLists(searchParams:
 *   FormElementListSearchOptions): Promise<FormElementListSearchResult>.
 *   SearchOptions requires organisationId (derived server-side, rule 1) and
 *   accepts an optional workspaceId plus limit/offset. The result carries
 *   formElementLists[] and (assumed, like Forms) meta.nextOffset — use the SDK's
 *   value, never a re-derived formula (rule 6).
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getClient } from '../lib/oneblink-client.js'
import { project, resolveFields } from '../lib/projection.js'
import { logger } from '../lib/logger.js'

/** Allowed `fields` set (default projection + extra selectable top-level props). */
export const ALLOWED_FIELDS = [
  'id',
  'name',
  'type',
  'updatedAt',
  // extra selectable top-level props (array/object fields coerce per rule 3):
  'organisationId',
  'environments',
  'createdAt',
] as const

const DEFAULT_FIELDS = ['id', 'name', 'type', 'updatedAt'] as const

const MAX_PAGE = 200
const STREAM_PAGE_CAP = 50 // safety cap: max internal pages in stream mode

const baseShape = {
  workspaceId: z.number().int().positive().optional().describe('Optional narrower scope filter.'),
  mode: z.enum(['page', 'stream']).default('page'),
  limit: z.number().int().min(1).max(MAX_PAGE).default(50),
  offset: z.number().int().min(0).default(0),
  fields: z
    .array(z.enum(ALLOWED_FIELDS))
    .nonempty()
    .optional()
    .describe('Top-level element-list properties to return. Defaults to a trimmed set.'),
} as const

const inputSchema = z.object(baseShape)
/** Exported for unit tests. */
export const listElementListsInputSchema = inputSchema
export type ListElementListsInput = z.infer<typeof inputSchema>

/** Shared result shape. */
export type ToolResult = {
  [x: string]: unknown
  isError?: boolean
  content: Array<{ type: 'text'; text: string }>
}

/** SDK search options this tool passes through (ids only). */
interface SearchOptions {
  organisationId: string
  workspaceId?: number
  limit: number
  offset: number
}

interface SearchResult {
  formElementLists?: Array<Record<string, unknown>>
  meta?: { nextOffset?: number | null }
}

/** Minimal SDK surface — lets tests mock without the real SDK. */
export interface FormElementListsLike {
  searchFormElementLists(opts: SearchOptions): Promise<SearchResult>
}

/** Dependencies the perform core needs; all injectable for tests. */
export interface ListElementListsDeps {
  lists: FormElementListsLike
  /** Resolve organisationId server-side (never a model input, rule 1). */
  resolveOrganisationId: () => Promise<string>
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] }
}

/**
 * Core logic, dependency-injected so tests mock the SDK + org derivation.
 * Input is assumed schema-valid (the registered handler parses first).
 */
export async function performListElementLists(
  input: ListElementListsInput,
  deps: ListElementListsDeps,
): Promise<ToolResult> {
  const fields = resolveFields(input.fields, DEFAULT_FIELDS)

  // Derive organisationId server-side (rule 1). The SDK requires it; the model
  // never supplies it.
  let organisationId: string
  try {
    organisationId = await deps.resolveOrganisationId()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'org derivation failed'
    return errorResult(`Could not resolve organisationId (no listing): ${message}`)
  }

  const scope = { organisationId, ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}) }

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
        const result = await deps.lists.searchFormElementLists({ ...scope, limit: MAX_PAGE, offset })
        const batch = result.formElementLists ?? []
        for (const list of batch) lines.push(JSON.stringify(project(list, fields)))
        if (batch.length < MAX_PAGE) break
        offset += MAX_PAGE
      }
      logger.info('list_element_lists', {
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
    const result = await deps.lists.searchFormElementLists({ ...scope, limit: input.limit, offset: input.offset })
    const batch = result.formElementLists ?? []
    const items = batch.map((list) => project(list, fields))
    // SDK-authoritative nextOffset (rule 6), never a re-derived formula.
    const nextOffset = result.meta?.nextOffset ?? null
    logger.info('list_element_lists', {
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
            meta: { limit: input.limit, offset: input.offset, returnedCount: items.length, nextOffset },
          }),
        },
      ],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'searchFormElementLists failed'
    logger.error('list_element_lists failed', { mode: input.mode, message })
    return errorResult(`list_element_lists failed: ${message}`)
  }
}

/**
 * Derive organisationId from the authenticated Developer Key by reading it off
 * one existing form (same approach as create_form). Fails closed when the key
 * can see no forms.
 */
async function deriveOrganisationId(): Promise<string> {
  const forms = getClient().forms()
  const probe = (await forms.searchForms({ limit: 1, offset: 0 } as never)) as unknown as {
    forms?: Array<{ organisationId?: string }>
  }
  const org = probe.forms?.[0]?.organisationId
  if (typeof org !== 'string' || org.length === 0) {
    throw new Error(
      'no existing form to read the organisation id from — create at least one form in the console first',
    )
  }
  return org
}

export function registerListElementLists(server: McpServer): void {
  server.tool(
    'list_element_lists',
    'List reusable element option sets ("element lists") so a caller can ' +
      'reference an existing list by id (as dynamicOptionSetId) instead of ' +
      'recreating it. Read-only. Supports paging (default) or JSONL stream mode ' +
      'for bulk export, and optional field selection. The organisation is ' +
      'derived from the credential, never a tool argument.',
    baseShape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = inputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return errorResult(parsed.error.errors.map((e) => e.message).join('; '))
      }
      return performListElementLists(parsed.data, {
        lists: getClient().formElementLists() as unknown as FormElementListsLike,
        resolveOrganisationId: deriveOrganisationId,
      })
    },
  )
}
