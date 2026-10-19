/**
 * Workflow: create_element_lookup
 *
 * Create a URL-based element/data Lookup so a form element can reference it by
 * id (`dataLookupId` + `isDataLookup:true` for DATA, `elementLookupId` +
 * `isElementLookup:true` for ELEMENT). Scope this release: URL lookups only
 * (`type: 'ELEMENT' | 'DATA'`); STATIC_DATA is out of scope (separate shape).
 * Spec: docs/requirements/create-element-lookup.md
 * Follows: steering tool-design (rules 1, 3, 6), security (A01/A09/A10).
 *
 * SDK facts (verified against @oneblink/types forms.d.ts + SDK v13):
 *   FormElementLookups.createFormElementLookup(newLookup: NewFormElementLookup)
 *     : Promise<FormElementLookup>
 *   NewFormElementLookupUrl = { name; organisationId; environments:
 *     { formsAppEnvironmentId: number; url: string }[]; type: 'ELEMENT'|'DATA';
 *     apiId?; excludeDefinition?; ... }
 * organisationId is DERIVED from the credential (rule 1), never a tool arg.
 * The lookup `url` is stored config consumed by OneBlink at form runtime — this
 * server validates it is a well-formed URL but never fetches it (A10).
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getClient } from '../lib/oneblink-client.js'
import { logger } from '../lib/logger.js'
import { createElementLookup, type FormElementLookupsLike } from '../lib/create-element-lookup.js'

const environmentShape = z.object({
  formsAppEnvironmentId: z
    .number()
    .int()
    .positive()
    .describe('The environment this endpoint applies to.'),
  // A10: validate as a well-formed absolute URL; stored config, never fetched here.
  url: z.string().url().describe('The lookup endpoint URL for this environment.'),
})

const baseShape = {
  name: z.string().min(1).describe('Lookup name.'),
  workspaceIds: z
    .array(z.number().int().positive())
    .nonempty()
    .describe('Workspace id(s) this lookup belongs to (at least one). Discover ids with list_workspaces. REQUIRED by the API — omitting it is a 400 and an empty list is a 500.'),
  type: z
    .enum(['DATA', 'ELEMENT'])
    .describe('DATA returns updated submission data; ELEMENT injects form elements.'),
  environments: z
    .array(environmentShape)
    .nonempty()
    .describe('Per-environment endpoint; at least one required.'),
  apiId: z.string().min(1).optional().describe('Optional hosted-API id passthrough.'),
  excludeDefinition: z
    .boolean()
    .optional()
    .describe('Exclude the form definition from the dynamic lookup call (SDK passthrough).'),
} as const

const inputSchema = z.object(baseShape)
/** Exported for unit tests. */
export const createElementLookupInputSchema = inputSchema
type Input = z.infer<typeof inputSchema>

function errorResult(text: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text }] }
}

/** Reject duplicate formsAppEnvironmentId across the environments array. */
function firstDuplicateEnvId(input: Input): number | undefined {
  const seen = new Set<number>()
  for (const env of input.environments) {
    if (seen.has(env.formsAppEnvironmentId)) return env.formsAppEnvironmentId
    seen.add(env.formsAppEnvironmentId)
  }
  return undefined
}

export function registerCreateElementLookup(server: McpServer): void {
  server.tool(
    'create_element_lookup',
    'Create a URL-based element/data lookup a form element can reference by id ' +
      '(dataLookupId for DATA, elementLookupId for ELEMENT). Scope: URL lookups ' +
      '(type DATA or ELEMENT); STATIC_DATA is out of scope. Each environment URL ' +
      'is validated as a well-formed URL but never fetched by this server. The ' +
      "organisation is derived from the credential, not a tool argument. Returns the lookup's id.",
    baseShape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = inputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        // Fail closed; surface messages, no PII. (A STATIC_DATA type lands here as
        // an invalid enum — the description points callers at the in-scope types.)
        return errorResult(parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '))
      }
      const input = parsed.data

      // Fail-fast: duplicate environment ids (zod proves non-empty + url shape).
      const dupe = firstDuplicateEnvId(input)
      if (dupe !== undefined) {
        return errorResult(`Duplicate formsAppEnvironmentId ${dupe} in environments; each must be unique.`)
      }

      // Derive organisationId server-side (rule 1 — never a model input). Read it
      // from one existing form the credential can see, mirroring create_form.
      const forms = getClient().forms()
      let organisationId: string
      try {
        const probe = (await forms.searchForms({ limit: 1, offset: 0 } as never)) as unknown as {
          forms?: Array<{ organisationId?: string }>
        }
        const org = probe.forms?.[0]?.organisationId
        if (typeof org !== 'string' || org.length === 0) {
          return errorResult(
            'Could not derive organisationId from the credential (no existing form to read it from). ' +
              'Create at least one form in the console first, or supply a tenant with existing forms.',
          )
        }
        organisationId = org
      } catch (err) {
        const message = err instanceof Error ? err.message : 'org derivation failed'
        return errorResult(`Could not resolve organisationId (no lookup created): ${message}`)
      }

      // Scaffold + create via the shared lib (same copy the
      // create_form_with_resources orchestrator uses — no duplicated SDK call).
      // organisationId DERIVED (rule 1).
      try {
        const created = await createElementLookup(
          getClient().formElementLookups() as unknown as FormElementLookupsLike,
          {
            name: input.name,
            type: input.type,
            organisationId,
            workspaceIds: input.workspaceIds,
            environments: input.environments.map((e) => ({
              formsAppEnvironmentId: e.formsAppEnvironmentId,
              url: e.url,
            })),
            ...(input.apiId ? { apiId: input.apiId } : {}),
            ...(input.excludeDefinition !== undefined ? { excludeDefinition: input.excludeDefinition } : {}),
          },
        )
        const environmentCount = input.environments.length
        // A09: log id/type/count only — never the urls (may embed tokens).
        logger.info('create_element_lookup', {
          ...(created.id !== null ? { id: created.id } : {}),
          type: input.type,
          environmentCount,
        })
        // Projection (rule 3): identifiers + counts, never the raw lookup.
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                id: created.id,
                name: created.name,
                type: created.type,
                environmentCount,
              }),
            },
          ],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'createFormElementLookup failed'
        logger.error('create_element_lookup failed', { type: input.type, message })
        return errorResult(`create_element_lookup failed (no lookup created): ${message}`)
      }
    },
  )
}
