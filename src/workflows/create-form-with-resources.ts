/**
 * Workflow: create_form_with_resources
 *
 * ONE call that creates a form whose elements reference supporting resources
 * (STATIC element lists + URL lookups) that do not exist yet. It declares the
 * resources inline, creates them in dependency order, wires the returned ids
 * into the elements, then creates the form. Removes the manual
 * "create resource -> copy id -> reference in form" dance.
 * Spec: docs/requirements/create-form-with-resources.md.
 * Follows: steering tool-design (rules 1, 3, 6), security (A01/API1, A09).
 *
 * COMPOSITION, not reimplementation:
 *   - element lists created via createElementList (src/lib/create-element-list.ts)
 *   - URL lookups created via createElementLookup (src/lib/create-element-lookup.ts)
 *     — the SAME copies create_element_list / create_element_lookup use.
 *   - the form itself via Forms.createForm (the existing create_form's SDK call).
 *   - element compile/normalize via compileCsv + normalizeElements.
 *
 * NOT ATOMIC (spec): the platform has no multi-resource transaction. If
 * createForm fails AFTER resources were created, the created resource ids are
 * returned (createdResources) with formCreated:false so the caller can clean up
 * the orphans — partial creation is REPORTED, never hidden.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getClient } from '../lib/oneblink-client.js'
import { logger } from '../lib/logger.js'
import { compileCsv, parseOptions } from '../lib/form-elements-csv.js'
import { normalizeElements, type MutableElement } from '../lib/form-normalize.js'
import { createElementList, type FormElementListsLike } from '../lib/create-element-list.js'
import { createElementLookup, type FormElementLookupsLike } from '../lib/create-element-lookup.js'

// --- element-source + scaffold fields (mirror create_form) ----------------
const postActionSchema = z
  .enum(['FORMS_LIBRARY', 'URL', 'CLOSE', 'BACK'])
  .describe('What the form does after a successful submission.')

// --- inline resource declarations ------------------------------------------
const elementListShape = z.object({
  ref: z.string().min(1).describe('Local handle elements reference via prop:dynamicOptionSetRef.'),
  name: z.string().min(1).describe('Human-readable list name.'),
  options: z
    .string()
    .min(1)
    .describe('Option tokens, same cell syntax as create_form: "Label:value|Label2".'),
})

const elementLookupShape = z.object({
  ref: z.string().min(1).describe('Local handle elements reference via prop:dataLookupRef / elementLookupRef.'),
  name: z.string().min(1).describe('Lookup name.'),
  type: z.enum(['DATA', 'ELEMENT']).describe('DATA returns submission data; ELEMENT injects elements.'),
  url: z.string().url().describe('The lookup endpoint URL (validated, never fetched by this server).'),
})

const resourcesShape = z
  .object({
    elementLists: z.array(elementListShape).default([]),
    elementLookups: z.array(elementLookupShape).default([]),
  })
  .default({ elementLists: [], elementLookups: [] })

const baseShape = {
  name: z.string().min(1).describe('Form name.'),
  description: z.string().default('').describe('Form description.'),
  formsAppEnvironmentId: z
    .number()
    .int()
    .positive()
    .describe('The single environment all inline resources AND the form are created in.'),
  formsAppIds: z.array(z.number().int().positive()).default([]).describe('Forms App ids this form belongs to.'),
  workspaceIds: z
    .array(z.number().int().positive())
    .nonempty()
    .describe('Workspace id(s) the inline element lists and lookups belong to (at least one). Discover ids with list_workspaces. REQUIRED by the API for those resources — omitting is a 400, empty is a 500.'),
  isAuthenticated: z.boolean().default(false).describe('Whether the form requires an authenticated user.'),
  postSubmissionAction: postActionSchema.default('FORMS_LIBRARY'),
  cancelAction: postActionSchema.default('FORMS_LIBRARY'),
  redirectUrl: z.string().url().optional().describe('Required when an action is URL.'),
  isMultiPage: z.boolean().optional().describe('Omit to infer from the elements.'),
  elementsCsv: z.string().min(1).optional().describe('CSV of element rows. Mutually exclusive with elements.'),
  elements: z
    .array(z.object({}).passthrough())
    .optional()
    .describe('Well-defined SDK FormElement[]. Mutually exclusive with elementsCsv.'),
  resources: resourcesShape.describe('Inline supporting resources to create first and wire into the elements.'),
} as const

const inputSchema = z.object(baseShape)
/** Exported for unit tests. */
export const createFormWithResourcesInputSchema = inputSchema
export type CreateFormWithResourcesInput = z.infer<typeof inputSchema>

export type ToolResult = {
  [x: string]: unknown
  isError?: boolean
  content: Array<{ type: 'text'; text: string }>
}

/** Minimal Forms SDK surface this orchestrator needs. */
export interface FormsLike {
  searchForms(params: unknown): Promise<unknown>
  createForm(newForm: unknown): Promise<unknown>
}

/** Dependencies the perform core needs; all injectable for tests. */
export interface CreateFormWithResourcesDeps {
  forms: FormsLike
  lists: FormElementListsLike
  lookups: FormElementLookupsLike
  /** Resolve the organisationId server-side (never a model input, rule 1). */
  resolveOrganisationId: () => Promise<string>
}

/** Props on an element that carry a resource ref -> the id prop + flag(s) they resolve to. */
const REF_PROPS = {
  dynamicOptionSetRef: { kind: 'list' as const, idProp: 'dynamicOptionSetId', apply: (el: MutableElement) => { el['optionsType'] = 'DYNAMIC' } },
  dataLookupRef: { kind: 'lookup' as const, idProp: 'dataLookupId', apply: (el: MutableElement) => { el['isDataLookup'] = true } },
  elementLookupRef: { kind: 'lookup' as const, idProp: 'elementLookupId', apply: (el: MutableElement) => { el['isElementLookup'] = true } },
} as const

type RefPropName = keyof typeof REF_PROPS

interface RefUsage {
  el: MutableElement
  propName: RefPropName
  ref: string
}

function errorResult(text: string, extra?: Record<string, unknown>): ToolResult {
  const payload = extra ? JSON.stringify({ error: text, ...extra }, null, 2) : text
  return { isError: true, content: [{ type: 'text', text: payload }] }
}

/** Collect every *Ref usage across the element tree (depth-first). */
export function collectRefUsages(elements: MutableElement[]): RefUsage[] {
  const usages: RefUsage[] = []
  const walk = (el: MutableElement): void => {
    for (const propName of Object.keys(REF_PROPS) as RefPropName[]) {
      const v = el[propName]
      if (typeof v === 'string' && v.length > 0) {
        usages.push({ el, propName, ref: v })
      }
    }
    if (Array.isArray(el.elements)) el.elements.forEach(walk)
  }
  elements.forEach(walk)
  return usages
}

/**
 * Core orchestration, dependency-injected so tests mock the SDK + org
 * derivation. Input is assumed schema-valid (the registered handler parses
 * first). Ordered + best-effort transactional (spec Behaviour).
 */
export async function performCreateFormWithResources(
  input: CreateFormWithResourcesInput,
  deps: CreateFormWithResourcesDeps,
): Promise<ToolResult> {
  // ---- 1) Validate the WHOLE input fail-fast; nothing is created until clean.
  // 1a) exactly one element source.
  const hasCsv = typeof input.elementsCsv === 'string'
  const hasDef = Array.isArray(input.elements)
  if (hasCsv === hasDef) {
    return errorResult(
      hasCsv
        ? 'Provide exactly one element source: both elementsCsv and elements were given.'
        : 'Provide exactly one element source: pass either elementsCsv or elements.',
    )
  }

  // 1b) compile the chosen source into an element tree.
  let rawElements: MutableElement[]
  if (hasCsv) {
    const compiled = compileCsv(input.elementsCsv as string)
    if (compiled.errors.length > 0) {
      return errorResult(`CSV validation failed (${compiled.errors.length} error(s)); nothing created.`, {
        errors: compiled.errors,
      })
    }
    rawElements = compiled.elements
  } else {
    rawElements = input.elements as MutableElement[]
  }

  // 1c) structural normalize + validation (ids, names, pages).
  const normalized = normalizeElements(rawElements, input.isMultiPage)
  if (normalized.errors.length > 0) {
    return errorResult(`Element validation failed (${normalized.errors.length} error(s)); nothing created.`, {
      errors: normalized.errors,
    })
  }

  // 1d) parse + validate inline list options; reject duplicate refs.
  const declaredRefs = new Set<string>()
  const dupeRefs: string[] = []
  const addRef = (ref: string): void => {
    if (declaredRefs.has(ref)) dupeRefs.push(ref)
    else declaredRefs.add(ref)
  }
  input.resources.elementLists.forEach((l) => addRef(l.ref))
  input.resources.elementLookups.forEach((l) => addRef(l.ref))
  if (dupeRefs.length > 0) {
    return errorResult(
      `Duplicate resource ref(s) [${[...new Set(dupeRefs)].join(', ')}]; each ref must be unique across lists + lookups.`,
    )
  }

  const parsedLists = input.resources.elementLists.map((l) => ({
    ref: l.ref,
    name: l.name,
    options: parseOptions(l.options),
  }))
  const emptyOptionRefs = parsedLists.filter((l) => l.options.length === 0).map((l) => l.ref)
  if (emptyOptionRefs.length > 0) {
    return errorResult(
      `Element list ref(s) [${emptyOptionRefs.join(', ')}] have a non-empty options cell that produced no valid options; nothing created.`,
    )
  }

  // 1e) every *Ref on an element must resolve to a DECLARED resource of the
  // right kind (list refs -> elementLists; lookup refs -> elementLookups).
  const usages = collectRefUsages(normalized.elements)
  const listRefs = new Set(parsedLists.map((l) => l.ref))
  const lookupRefs = new Set(input.resources.elementLookups.map((l) => l.ref))
  const unresolved: Array<{ propName: string; ref: string; expected: string }> = []
  for (const u of usages) {
    const spec = REF_PROPS[u.propName]
    const pool = spec.kind === 'list' ? listRefs : lookupRefs
    if (!pool.has(u.ref)) {
      unresolved.push({
        propName: u.propName,
        ref: u.ref,
        expected: spec.kind === 'list' ? 'resources.elementLists' : 'resources.elementLookups',
      })
    }
  }
  if (unresolved.length > 0) {
    return errorResult(
      `${unresolved.length} element reference(s) do not resolve to a declared resource; nothing created.`,
      { unresolvedRefs: unresolved },
    )
  }

  // ---- 2) Derive organisationId server-side (rule 1), THEN create resources.
  let organisationId: string
  try {
    organisationId = await deps.resolveOrganisationId()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'org derivation failed'
    return errorResult(`Could not resolve organisationId (nothing created): ${message}`)
  }

  const createdLists: Array<{ ref: string; id: number | string }> = []
  const createdLookups: Array<{ ref: string; id: number | string }> = []
  const refToId = new Map<string, number | string>()

  const createdResources = () => ({
    elementLists: createdLists.map((l) => ({ ref: l.ref, id: l.id })),
    elementLookups: createdLookups.map((l) => ({ ref: l.ref, id: l.id })),
  })

  // 2a) element lists first.
  try {
    for (const l of parsedLists) {
      const res = await createElementList(deps.lists, {
        name: l.name,
        type: 'STATIC',
        organisationId,
        workspaceIds: input.workspaceIds,
        environments: [{ formsAppEnvironmentId: input.formsAppEnvironmentId, options: l.options }],
      })
      if (res.id === null) throw new Error(`element list '${l.ref}' created but the SDK returned no id`)
      createdLists.push({ ref: l.ref, id: res.id })
      refToId.set(l.ref, res.id)
    }
    // 2b) then lookups.
    for (const l of input.resources.elementLookups) {
      const res = await createElementLookup(deps.lookups, {
        name: l.name,
        type: l.type,
        organisationId,
        workspaceIds: input.workspaceIds,
        environments: [{ formsAppEnvironmentId: input.formsAppEnvironmentId, url: l.url }],
      })
      if (res.id === null) throw new Error(`element lookup '${l.ref}' created but the SDK returned no id`)
      createdLookups.push({ ref: l.ref, id: res.id })
      refToId.set(l.ref, res.id)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'resource creation failed'
    logger.error('create_form_with_resources resource create failed', {
      message,
      listsCreated: createdLists.length,
      lookupsCreated: createdLookups.length,
    })
    // Resources already created are orphans — report them, do not hide.
    return errorResult(`Supporting-resource creation failed (form NOT created): ${message}`, {
      createdResources: createdResources(),
      formCreated: false,
    })
  }

  // ---- 3) Resolve *Ref props on elements to real ids + set the flags.
  for (const u of usages) {
    const spec = REF_PROPS[u.propName]
    const id = refToId.get(u.ref) as number | string
    u.el[spec.idProp] = id
    spec.apply(u.el)
    delete u.el[u.propName] // the ref is a local handle, not an SDK property
  }

  // ---- 4) createForm.
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
    const created = (await deps.forms.createForm(newForm)) as Record<string, unknown>
    const createdElements = (created.elements as unknown[]) ?? []
    const formId = typeof created.id === 'number' || typeof created.id === 'string' ? created.id : null
    // A09: log ids + counts only, never options/urls/labels.
    logger.info('create_form_with_resources', {
      ...(formId !== null ? { formId } : {}),
      elementCount: createdElements.length,
      listsCreated: createdLists.length,
      lookupsCreated: createdLookups.length,
    })
    // Projection (rule 3): ids + counts + ref->id map, never the raw Form.
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            formId,
            name: (created.name as string) ?? input.name,
            elementCount: createdElements.length,
            createdResources: createdResources(),
          }),
        },
      ],
    }
  } catch (err) {
    // ---- 5) Form create failed AFTER resources were created: report orphans.
    const message = err instanceof Error ? err.message : 'createForm failed'
    logger.error('create_form_with_resources form create failed (orphan resources)', {
      message,
      listsCreated: createdLists.length,
      lookupsCreated: createdLookups.length,
    })
    return errorResult(`create_form failed after supporting resources were created: ${message}`, {
      createdResources: createdResources(),
      formCreated: false,
    })
  }
}

/**
 * Derive organisationId from one existing form the credential can see (same
 * approach as create_form / create_element_*). Fails closed when none exist.
 */
async function deriveOrganisationId(forms: FormsLike): Promise<string> {
  const probe = (await forms.searchForms({ limit: 1, offset: 0 })) as {
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

export function registerCreateFormWithResources(server: McpServer): void {
  server.tool(
    'create_form_with_resources',
    'Create a OneBlink form whose elements reference supporting resources that ' +
      'do not exist yet. Declare STATIC element lists and URL lookups inline under ' +
      '"resources", each with a local "ref"; reference them on elements via ' +
      'prop:dynamicOptionSetRef (list), prop:dataLookupRef or prop:elementLookupRef ' +
      '(lookup). The tool validates the whole input fail-fast (every ref must ' +
      'resolve to a declared resource), creates the lists then lookups, wires the ' +
      'returned ids into the elements (setting optionsType:"DYNAMIC" / ' +
      'isDataLookup / isElementLookup), then creates the form. NOT atomic: if the ' +
      'form create fails after resources were created, the created resource ids are ' +
      'returned with formCreated:false so you can clean up the orphans. The ' +
      'organisation is derived from the credential, never a tool argument.',
    baseShape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = inputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return errorResult(parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '))
      }
      const forms = getClient().forms() as unknown as FormsLike
      return performCreateFormWithResources(parsed.data, {
        forms,
        lists: getClient().formElementLists() as unknown as FormElementListsLike,
        lookups: getClient().formElementLookups() as unknown as FormElementLookupsLike,
        resolveOrganisationId: () => deriveOrganisationId(forms),
      })
    },
  )
}
