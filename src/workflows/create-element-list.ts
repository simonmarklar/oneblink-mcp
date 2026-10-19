/**
 * Workflow: create_element_list
 *
 * Create a reusable STATIC element option set ("element list") so a form element
 * can reference it by id (dynamicOptionSetId + optionsType:'DYNAMIC') instead of
 * carrying inline CUSTOM options.
 * Spec: docs/requirements/create-element-list.md.
 * Follows: steering tool-design (rules 1, 3, 6), security (A01/A03/A09).
 *
 * SDK: FormElementLists.createFormElementList(newFormElementList:
 *   NewFormElementOptionSet): Promise<FormElementOptionSet>. The STATIC shape is
 *   NewFormElementOptionSetBase & { type:'STATIC'; environments:
 *   { options: DynamicChoiceElementOption[]; formsAppEnvironmentId: number }[] }.
 *   organisationId is stamped from the Developer Key — never a tool arg (rule 1).
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getClient } from '../lib/oneblink-client.js'
import { logger } from '../lib/logger.js'
import { parseOptions } from '../lib/form-elements-csv.js'
import {
  createElementList,
  type FormElementListsLike as LibFormElementListsLike,
} from '../lib/create-element-list.js'

/** Only STATIC is in scope this release (spec). */
const ELEMENT_LIST_TYPES = ['STATIC'] as const

const envShape = z.object({
  formsAppEnvironmentId: z
    .number()
    .int()
    .positive()
    .describe('Environment this option set applies to; discover ids with list_forms_app_environments.'),
  options: z
    .string()
    .min(1)
    .describe('Option tokens in the same cell syntax as create_form: "Label:value|Label2" (pipe- or comma-separated).'),
})

const baseShape = {
  name: z.string().min(1).describe('Human-readable list name.'),
  workspaceIds: z
    .array(z.number().int().positive())
    .nonempty()
    .describe('Workspace id(s) this list belongs to (at least one). Discover ids with list_workspaces. REQUIRED by the API — omitting it is a 400 and an empty list is a 500.'),
  environments: z
    .array(envShape)
    .min(1)
    .describe('Per-environment option sets (at least one).'),
  type: z
    .enum(ELEMENT_LIST_TYPES)
    .default('STATIC')
    .describe('Option-set type. Only STATIC is supported this release.'),
} as const

const inputSchema = z.object(baseShape)
/** Exported for unit tests. */
export const createElementListInputSchema = inputSchema
export type CreateElementListInput = z.infer<typeof inputSchema>

/** Shared result shape (mirrors other workflows). */
export type ToolResult = {
  [x: string]: unknown
  isError?: boolean
  content: Array<{ type: 'text'; text: string }>
}

/** A fail-fast validation error with human- + machine-readable context (D7). */
export interface ElementListValidationError {
  index?: number
  column: string
  value?: string | number
  error: string
  fixHint: string
}

/** Minimal SDK surface this tool needs — lets tests mock without the real SDK. */
export type FormElementListsLike = LibFormElementListsLike

/** Dependencies the perform core needs; all injectable for tests. */
export interface CreateElementListDeps {
  lists: FormElementListsLike
  /** Resolve the organisationId server-side (never a model input, rule 1). */
  resolveOrganisationId: () => Promise<string>
}

function errorResult(text: string, errors?: ElementListValidationError[]): ToolResult {
  const payload = errors && errors.length > 0 ? JSON.stringify({ message: text, errors }, null, 2) : text
  return { isError: true, content: [{ type: 'text', text: payload }] }
}

/**
 * Validate the environments array fail-fast, collecting ALL errors (D7).
 * Returns parsed per-environment options on success, or the error list.
 */
export function validateEnvironments(
  environments: CreateElementListInput['environments'],
): { ok: true; parsed: Array<{ formsAppEnvironmentId: number; options: Array<{ label: string; value: string }> }> } | { ok: false; errors: ElementListValidationError[] } {
  const errors: ElementListValidationError[] = []
  const parsed: Array<{ formsAppEnvironmentId: number; options: Array<{ label: string; value: string }> }> = []
  const seen = new Set<number>()

  environments.forEach((env, index) => {
    if (seen.has(env.formsAppEnvironmentId)) {
      errors.push({
        index,
        column: 'formsAppEnvironmentId',
        value: env.formsAppEnvironmentId,
        error: `Duplicate formsAppEnvironmentId ${env.formsAppEnvironmentId} across environments.`,
        fixHint: 'Give each environment entry a unique formsAppEnvironmentId.',
      })
    } else {
      seen.add(env.formsAppEnvironmentId)
    }

    const opts = parseOptions(env.options)
    if (opts.length === 0) {
      errors.push({
        index,
        column: 'options',
        value: env.options,
        error: 'options cell is non-empty but produced no valid options.',
        fixHint: 'Use "Label:value|Label2:value2" (pipe-separated) or bare "Label".',
      })
    } else {
      parsed.push({ formsAppEnvironmentId: env.formsAppEnvironmentId, options: opts })
    }
  })

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, parsed }
}

/**
 * Core logic, dependency-injected so tests can mock the SDK + org derivation.
 * Input is assumed schema-valid (the registered handler parses first).
 */
export async function performCreateElementList(
  input: CreateElementListInput,
  deps: CreateElementListDeps,
): Promise<ToolResult> {
  // 1) Fail-fast validation before any API call (collect all errors).
  const validated = validateEnvironments(input.environments)
  if (!validated.ok) {
    return errorResult(
      `Element list validation failed (${validated.errors.length} error(s)); no list created.`,
      validated.errors,
    )
  }

  // 2) Derive organisationId server-side (rule 1 — never a model input).
  let organisationId: string
  try {
    organisationId = await deps.resolveOrganisationId()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'org derivation failed'
    return errorResult(`Could not resolve organisationId (no list created): ${message}`)
  }

  // 3) Delegate the SDK scaffold + create to the shared lib (same copy the
  // create_form_with_resources orchestrator uses — no duplicated SDK call).
  try {
    const created = await createElementList(deps.lists, {
      name: input.name,
      type: input.type,
      organisationId,
      workspaceIds: input.workspaceIds,
      environments: validated.parsed,
    })
    const id = created.id
    const environmentCount = validated.parsed.length
    // A09: log identifiers + counts only, never option labels/values.
    logger.info('create_element_list', {
      ...(id !== null ? { id } : {}),
      type: input.type,
      environmentCount,
    })
    // Projection (rule 3): id + name + type + env count, never the raw set.
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            id,
            name: created.name,
            type: input.type,
            environmentCount,
          }),
        },
      ],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'createFormElementList failed'
    logger.error('create_element_list failed', { type: input.type, message })
    return errorResult(`create_element_list failed (no list created): ${message}`)
  }
}

/**
 * Derive the organisationId from the authenticated Developer Key by reading it
 * off one existing form (same approach as create_form). Fails closed when the
 * key can see no forms.
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

export function registerCreateElementList(server: McpServer): void {
  server.tool(
    'create_element_list',
    'Create a reusable STATIC element option set ("element list") so a form ' +
      'element can reference it by id (dynamicOptionSetId + optionsType:"DYNAMIC") ' +
      'instead of carrying inline CUSTOM options. Options use the same cell syntax ' +
      'as create_form ("Label:value|Label2", pipe- or comma-separated). The whole ' +
      'input is validated fail-fast before any API call; the organisation is ' +
      'derived from the credential, never a tool argument.',
    baseShape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = inputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return errorResult(parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '))
      }
      return performCreateElementList(parsed.data, {
        lists: getClient().formElementLists() as unknown as FormElementListsLike,
        resolveOrganisationId: deriveOrganisationId,
      })
    },
  )
}
