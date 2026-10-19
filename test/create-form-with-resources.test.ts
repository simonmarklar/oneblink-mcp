import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createFormWithResourcesInputSchema as schema,
  performCreateFormWithResources,
  collectRefUsages,
  type CreateFormWithResourcesInput,
  type CreateFormWithResourcesDeps,
  type FormsLike,
} from '../src/workflows/create-form-with-resources.ts'
import type { FormElementListsLike } from '../src/lib/create-element-list.ts'
import type { FormElementLookupsLike } from '../src/lib/create-element-lookup.ts'
import type { MutableElement } from '../src/lib/form-normalize.ts'

// ------------------------------------------------------------------------
// Fakes. We MOCK Forms + FormElementLists + FormElementLookups + org
// derivation — no network. Each records what it was handed.
// ------------------------------------------------------------------------

interface Harness {
  deps: CreateFormWithResourcesDeps
  listCalls: unknown[]
  lookupCalls: unknown[]
  formCalls: unknown[]
}

function harness(opts: {
  listIds?: Array<number | string | null>
  lookupIds?: Array<number | string | null>
  formThrows?: Error
  listThrowsAt?: number
  createdForm?: Record<string, unknown>
} = {}): Harness {
  const listCalls: unknown[] = []
  const lookupCalls: unknown[] = []
  const formCalls: unknown[] = []
  let listIdx = 0
  let lookupIdx = 0

  const lists: FormElementListsLike = {
    async createFormElementList(newList: unknown) {
      const i = listIdx
      listCalls.push(newList)
      if (opts.listThrowsAt === i) throw new Error('list create boom')
      const id = opts.listIds ? opts.listIds[i] ?? 100 + i : 100 + i
      listIdx += 1
      return { id, name: (newList as { name: string }).name }
    },
  }
  const lookups: FormElementLookupsLike = {
    async createFormElementLookup(newLookup: unknown) {
      const i = lookupIdx
      lookupCalls.push(newLookup)
      const id = opts.lookupIds ? opts.lookupIds[i] ?? 200 + i : 200 + i
      lookupIdx += 1
      return { id, name: (newLookup as { name: string }).name, type: (newLookup as { type: string }).type }
    },
  }
  const forms: FormsLike = {
    async searchForms() {
      return { forms: [{ organisationId: 'org-xyz' }] }
    },
    async createForm(newForm: unknown) {
      formCalls.push(newForm)
      if (opts.formThrows) throw opts.formThrows
      return opts.createdForm ?? { id: 999, name: (newForm as { name: string }).name, elements: (newForm as { elements: unknown[] }).elements }
    },
  }
  return {
    deps: { forms, lists, lookups, resolveOrganisationId: async () => 'org-xyz' },
    listCalls,
    lookupCalls,
    formCalls,
  }
}

/** A definition-mode input: one select referencing a list, one text referencing a data lookup. */
function input(o: Partial<CreateFormWithResourcesInput> = {}): CreateFormWithResourcesInput {
  return schema.parse({
    name: 'Resourceful form',
    formsAppEnvironmentId: 457,
    workspaceIds: [70],
    elements: [
      { type: 'select', label: 'State', dynamicOptionSetRef: 'statesList' },
      { type: 'text', label: 'Address', dataLookupRef: 'addrLookup' },
    ],
    resources: {
      elementLists: [{ ref: 'statesList', name: 'States', options: 'NSW:nsw|VIC:vic' }],
      elementLookups: [{ ref: 'addrLookup', name: 'Address', type: 'DATA', url: 'https://api.example.com/addr' }],
    },
    ...o,
  })
}

// ========================================================================
// schema — fail closed
// ========================================================================
test('schema defaults resources to empty arrays', () => {
  const v = schema.parse({ name: 'F', formsAppEnvironmentId: 1, workspaceIds: [70], elements: [{ type: 'text', label: 'A' }] })
  assert.deepEqual(v.resources, { elementLists: [], elementLookups: [] })
})

test('schema rejects a lookup with a malformed url', () => {
  const bad = {
    name: 'F',
    formsAppEnvironmentId: 1,
    workspaceIds: [70],
    elements: [{ type: 'text', label: 'A' }],
    resources: { elementLookups: [{ ref: 'x', name: 'X', type: 'DATA', url: 'not-a-url' }] },
  }
  assert.equal(schema.safeParse(bad).success, false)
})

// ========================================================================
// collectRefUsages — walks nested elements
// ========================================================================
test('collectRefUsages finds refs on nested elements', () => {
  const els: MutableElement[] = [
    { type: 'page', label: 'P', elements: [{ type: 'select', label: 'S', dynamicOptionSetRef: 'L' }] },
  ]
  const usages = collectRefUsages(els)
  assert.equal(usages.length, 1)
  assert.equal(usages[0]!.ref, 'L')
  assert.equal(usages[0]!.propName, 'dynamicOptionSetRef')
})

// ========================================================================
// element-source XOR
// ========================================================================
test('rejects when BOTH element sources are given, nothing created', async () => {
  const h = harness()
  const bad = schema.parse({
    name: 'F',
    formsAppEnvironmentId: 1,
    workspaceIds: [70],
    elements: [{ type: 'text', label: 'A' }],
    elementsCsv: 'label,type\nA,text',
    resources: { elementLists: [], elementLookups: [] },
  })
  const res = await performCreateFormWithResources(bad, h.deps)
  assert.equal(res.isError, true)
  assert.equal(h.listCalls.length, 0)
  assert.equal(h.formCalls.length, 0)
})

test('rejects when NEITHER element source is given', async () => {
  const h = harness()
  const bad = schema.parse({ name: 'F', formsAppEnvironmentId: 1, workspaceIds: [70], resources: { elementLists: [], elementLookups: [] } })
  const res = await performCreateFormWithResources(bad, h.deps)
  assert.equal(res.isError, true)
  assert.equal(h.formCalls.length, 0)
})

// ========================================================================
// HAPPY PATH: inline list + lookup created, refs wired, projection
// ========================================================================
test('happy path: creates list + lookup, wires ids+flags into elements, returns projection', async () => {
  const h = harness({ listIds: [11], lookupIds: [7] })
  const res = await performCreateFormWithResources(input(), h.deps)
  assert.notEqual(res.isError, true)

  // list created first, then lookup, then form.
  assert.equal(h.listCalls.length, 1)
  assert.equal(h.lookupCalls.length, 1)
  assert.equal(h.formCalls.length, 1)

  // org derived + stamped on resources (never a tool input).
  assert.equal((h.listCalls[0] as { organisationId: string }).organisationId, 'org-xyz')
  assert.equal((h.lookupCalls[0] as { organisationId: string }).organisationId, 'org-xyz')
  // workspaceIds threaded into both resource creates (required, non-empty).
  assert.deepEqual((h.listCalls[0] as { workspaceIds: number[] }).workspaceIds, [70])
  assert.deepEqual((h.lookupCalls[0] as { workspaceIds: number[] }).workspaceIds, [70])
  // resources created in the single form environment.
  assert.equal(
    (h.listCalls[0] as { environments: Array<{ formsAppEnvironmentId: number }> }).environments[0]!.formsAppEnvironmentId,
    457,
  )

  // elements handed to createForm have the ids wired + flags set + refs stripped.
  const sentForm = h.formCalls[0] as { elements: MutableElement[] }
  const select = sentForm.elements[0]!
  assert.equal(select['dynamicOptionSetId'], 11)
  assert.equal(select['optionsType'], 'DYNAMIC')
  assert.equal('dynamicOptionSetRef' in select, false)
  const textEl = sentForm.elements[1]!
  assert.equal(textEl['dataLookupId'], 7)
  assert.equal(textEl['isDataLookup'], true)
  assert.equal('dataLookupRef' in textEl, false)

  // projection: formId + createdResources ref->id map.
  const body = JSON.parse(res.content[0]!.text)
  assert.equal(body.formId, 999)
  assert.equal(body.elementCount, 2)
  assert.deepEqual(body.createdResources, {
    elementLists: [{ ref: 'statesList', id: 11 }],
    elementLookups: [{ ref: 'addrLookup', id: 7 }],
  })
})

test('happy path resolves an elementLookupRef to elementLookupId + isElementLookup', async () => {
  const h = harness({ lookupIds: [42] })
  const v = input({
    elements: [{ type: 'text', label: 'Addr', elementLookupRef: 'addrLookup' }],
    resources: {
      elementLists: [],
      elementLookups: [{ ref: 'addrLookup', name: 'Address', type: 'ELEMENT', url: 'https://api.example.com/addr' }],
    },
  })
  const res = await performCreateFormWithResources(v, h.deps)
  assert.notEqual(res.isError, true)
  const el = (h.formCalls[0] as { elements: MutableElement[] }).elements[0]!
  assert.equal(el['elementLookupId'], 42)
  assert.equal(el['isElementLookup'], true)
})

// ========================================================================
// UNKNOWN REF: rejected pre-flight, nothing created
// ========================================================================
test('unknown *Ref is rejected pre-flight — NO resource and NO form created', async () => {
  const h = harness()
  const v = input({
    elements: [{ type: 'select', label: 'State', dynamicOptionSetRef: 'doesNotExist' }],
    resources: {
      elementLists: [{ ref: 'statesList', name: 'States', options: 'NSW:nsw' }],
      elementLookups: [],
    },
  })
  const res = await performCreateFormWithResources(v, h.deps)
  assert.equal(res.isError, true)
  const body = JSON.parse(res.content[0]!.text)
  assert.match(body.error, /do not resolve/)
  assert.equal(body.unresolvedRefs[0].ref, 'doesNotExist')
  // nothing created.
  assert.equal(h.listCalls.length, 0)
  assert.equal(h.lookupCalls.length, 0)
  assert.equal(h.formCalls.length, 0)
})

test('a list ref pointed at a lookup (wrong kind) is rejected pre-flight', async () => {
  const h = harness()
  const v = input({
    elements: [{ type: 'select', label: 'State', dynamicOptionSetRef: 'addrLookup' }],
    resources: {
      elementLists: [],
      elementLookups: [{ ref: 'addrLookup', name: 'Address', type: 'DATA', url: 'https://api.example.com/addr' }],
    },
  })
  const res = await performCreateFormWithResources(v, h.deps)
  assert.equal(res.isError, true)
  assert.equal(h.listCalls.length, 0)
  assert.equal(h.formCalls.length, 0)
})

test('duplicate resource refs rejected pre-flight', async () => {
  const h = harness()
  const v = input({
    elements: [{ type: 'select', label: 'State', dynamicOptionSetRef: 'dup' }],
    resources: {
      elementLists: [{ ref: 'dup', name: 'A', options: 'X' }],
      elementLookups: [{ ref: 'dup', name: 'B', type: 'DATA', url: 'https://api.example.com' }],
    },
  })
  const res = await performCreateFormWithResources(v, h.deps)
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /Duplicate resource ref/)
  assert.equal(h.listCalls.length, 0)
})

// ========================================================================
// FORM-CREATE FAILURE after resources created: createdResources + formCreated:false
// ========================================================================
test('form create failure AFTER resources created returns createdResources + formCreated:false', async () => {
  const h = harness({ listIds: [11], lookupIds: [7], formThrows: new Error('createForm 500') })
  const res = await performCreateFormWithResources(input(), h.deps)
  assert.equal(res.isError, true)
  // resources WERE created (orphans) and the form create WAS attempted.
  assert.equal(h.listCalls.length, 1)
  assert.equal(h.lookupCalls.length, 1)
  assert.equal(h.formCalls.length, 1)
  const body = JSON.parse(res.content[0]!.text)
  assert.equal(body.formCreated, false)
  assert.match(body.error, /createForm 500/)
  assert.deepEqual(body.createdResources, {
    elementLists: [{ ref: 'statesList', id: 11 }],
    elementLookups: [{ ref: 'addrLookup', id: 7 }],
  })
})

// ========================================================================
// RESOURCE-CREATE FAILURE: report partial orphans, form NOT created
// ========================================================================
test('a resource create failure stops before createForm and reports orphans', async () => {
  // Two lists; the SECOND throws. The first is an orphan.
  const h = harness({ listThrowsAt: 1 })
  const v = input({
    elements: [
      { type: 'select', label: 'A', dynamicOptionSetRef: 'listA' },
      { type: 'select', label: 'B', dynamicOptionSetRef: 'listB' },
    ],
    resources: {
      elementLists: [
        { ref: 'listA', name: 'A', options: 'X:x' },
        { ref: 'listB', name: 'B', options: 'Y:y' },
      ],
      elementLookups: [],
    },
  })
  const res = await performCreateFormWithResources(v, h.deps)
  assert.equal(res.isError, true)
  const body = JSON.parse(res.content[0]!.text)
  assert.equal(body.formCreated, false)
  assert.equal(body.createdResources.elementLists.length, 1) // listA orphan
  assert.equal(body.createdResources.elementLists[0].ref, 'listA')
  assert.equal(h.formCalls.length, 0) // form never attempted
})

// ========================================================================
// org-derivation failure fails closed, nothing created
// ========================================================================
test('org-derivation failure fails closed, nothing created', async () => {
  const h = harness()
  const deps: CreateFormWithResourcesDeps = {
    ...h.deps,
    resolveOrganisationId: async () => {
      throw new Error('no existing form')
    },
  }
  const res = await performCreateFormWithResources(input(), deps)
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /organisationId/)
  assert.equal(h.listCalls.length, 0)
  assert.equal(h.formCalls.length, 0)
})

// ========================================================================
// CSV source works too (refs via prop: columns)
// ========================================================================
test('CSV element source: prop:dynamicOptionSetRef column wires the list id', async () => {
  const h = harness({ listIds: [55] })
  const v = schema.parse({
    name: 'CSV form',
    formsAppEnvironmentId: 457,
    workspaceIds: [70],
    elementsCsv: 'label,type,prop:dynamicOptionSetRef\nState,select,statesList',
    resources: { elementLists: [{ ref: 'statesList', name: 'States', options: 'NSW:nsw' }], elementLookups: [] },
  })
  const res = await performCreateFormWithResources(v, h.deps)
  assert.notEqual(res.isError, true)
  const el = (h.formCalls[0] as { elements: MutableElement[] }).elements[0]!
  assert.equal(el['dynamicOptionSetId'], 55)
  assert.equal(el['optionsType'], 'DYNAMIC')
})
