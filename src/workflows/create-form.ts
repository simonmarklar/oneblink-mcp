/**
 * Workflow: create_form
 *
 * Create a OneBlink form from EITHER a human-authored CSV of element rows
 * (`elementsCsv`) OR a well-defined SDK `FormElement[]` (`elements`). Exactly one
 * element source. Both converge on the shared normalizer and Forms.createForm.
 * Spec: docs/requirements/create-form.md (decisions D1-D7).
 * Follows: steering tool-design (rules 1, 3, 6), security (A01/A03/A09), meta-files.
 *
 * SDK facts (verified): Forms.createForm(newForm: NewForm): Promise<Form>
 * (tenants/classes/Forms.d.ts:594). NewForm requires name/description/
 * formsAppIds/elements/isAuthenticated/isMultiPage/postSubmissionAction/
 * cancelAction. Org is stamped from the Developer Key — never a tool arg (rule 1).
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getClient } from '../lib/oneblink-client.js'
import { logger } from '../lib/logger.js'
import { compileCsv } from '../lib/form-elements-csv.js'
import { normalizeElements, type FormValidationError, type MutableElement } from '../lib/form-normalize.js'

// A post-submission action is a small enum in the SDK; keep it permissive here
// and let the SDK validate the exact union, defaulting to the common case.
const postActionSchema = z
  .enum(['FORMS_LIBRARY', 'URL', 'CLOSE', 'BACK'])
  .describe('What the form does after a successful submission.')

const baseShape = {
  name: z.string().min(1).describe('Form name.'),
  description: z.string().default('').describe('Form description.'),
  formsAppEnvironmentId: z
    .number()
    .int()
    .positive()
    .describe('The environment the form is created in. Required by the API; discover ids with list_forms_app_environments.'),
  formsAppIds: z.array(z.number().int().positive()).default([]).describe('Forms App ids this form belongs to.'),
  isAuthenticated: z.boolean().default(false).describe('Whether the form requires an authenticated user.'),
  postSubmissionAction: postActionSchema.default('FORMS_LIBRARY'),
  cancelAction: postActionSchema.default('FORMS_LIBRARY'),
  redirectUrl: z.string().url().optional().describe('Required when an action is URL.'),
  isMultiPage: z.boolean().optional().describe('Omit to infer from the elements (true iff root is pages). Validated either way.'),
  elementsCsv: z.string().min(1).optional().describe('CSV of element rows (label,type,parent,required,options,prop:*). Mutually exclusive with elements.'),
  elements: z.array(z.object({}).passthrough()).optional().describe('Well-defined SDK FormElement[]. Mutually exclusive with elementsCsv.'),
} as const

const inputSchema = z.object(baseShape)
export const createFormInputSchema = inputSchema
type Input = z.infer<typeof inputSchema>

function errorResult(text: string, errors?: FormValidationError[]) {
  const payload = errors && errors.length > 0 ? JSON.stringify({ message: text, errors }, null, 2) : text
  return { isError: true as const, content: [{ type: 'text' as const, text: payload }] }
}

export function registerCreateForm(server: McpServer): void {
  server.tool(
    'create_form',
    'Create a OneBlink form from either a human-authored CSV of element rows ' +
      '(elementsCsv) or a well-defined SDK FormElement[] (elements) — exactly one. ' +
      'Element types are matched case-insensitively to the SDK type set; names are ' +
      'derived from labels (snake_case); options are "Label:value" tokens ' +
      'separated by "|" (preferred) or "," ; nesting ' +
      'uses a parent column (CSV) or nested elements (definition). The whole input ' +
      'is validated fail-fast with human- and machine-readable errors before any ' +
      'API call.',
    baseShape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = inputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return errorResult(parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '))
      }
      const input: Input = parsed.data

      // Exactly one element source (spec: element_source).
      const hasCsv = typeof input.elementsCsv === 'string'
      const hasDef = Array.isArray(input.elements)
      if (hasCsv === hasDef) {
        return errorResult(
          hasCsv
            ? 'Provide exactly one element source: both elementsCsv and elements were given.'
            : 'Provide exactly one element source: pass either elementsCsv or elements.',
        )
      }

      // 1) Produce an element array from the chosen source.
      let rawElements: MutableElement[]
      let source: 'csv' | 'definition'
      if (hasCsv) {
        source = 'csv'
        const compiled = compileCsv(input.elementsCsv as string)
        if (compiled.errors.length > 0) {
          return errorResult(`CSV validation failed (${compiled.errors.length} error(s)); no form created.`, compiled.errors)
        }
        rawElements = compiled.elements
      } else {
        source = 'definition'
        rawElements = input.elements as MutableElement[]
      }

      // 2) Shared normalize + structural validation (ids, names, pages).
      const normalized = normalizeElements(rawElements, input.isMultiPage)
      if (normalized.errors.length > 0) {
        return errorResult(`Element validation failed (${normalized.errors.length} error(s)); no form created.`, normalized.errors)
      }

      // 3) Derive organisationId server-side (steering rule 1 — never a model
      // input). The authenticated key's org is stamped on every form it can
      // see, so we read it from one existing form. The live API REQUIRES
      // organisationId on create (verified: createForm rejects without it).
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
        return errorResult(`Could not resolve organisationId (no form created): ${message}`)
      }

      // 4) Scaffold NewForm and create. organisationId is DERIVED (rule 1);
      // formsAppEnvironmentId is a legitimate per-form scope input.
      const newForm: Record<string, unknown> = {
        name: input.name,
        description: input.description,
        organisationId,
        formsAppEnvironmentId: input.formsAppEnvironmentId,
        formsAppIds: input.formsAppIds,
        isAuthenticated: input.isAuthenticated,
        isMultiPage: normalized.isMultiPage,
        postSubmissionAction: input.postSubmissionAction,
        cancelAction: input.cancelAction,
        elements: normalized.elements,
        submissionEvents: [],
        tags: [],
        ...(input.redirectUrl ? { redirectUrl: input.redirectUrl } : {}),
      }

      try {
        const created = (await forms.createForm(newForm as never)) as unknown as Record<string, unknown>
        const createdElements = (created.elements as unknown[]) ?? []
        const createdFormId = typeof created.id === 'number' || typeof created.id === 'string' ? created.id : undefined
        logger.info('create_form', {
          ...(createdFormId !== undefined ? { formId: createdFormId } : {}),
          source,
          isMultiPage: normalized.isMultiPage,
          elementCount: createdElements.length,
        })
        // Projection (rule 3): identifiers + counts, never the raw Form.
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                formId: created.id ?? null,
                name: created.name ?? input.name,
                isMultiPage: normalized.isMultiPage,
                source,
                elementCount: createdElements.length,
                rootElementIds: normalized.elements.map((e) => e.id),
              }),
            },
          ],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'createForm failed'
        logger.error('create_form failed', { source, message })
        return errorResult(`create_form failed (no form created): ${message}`)
      }
    },
  )
}
