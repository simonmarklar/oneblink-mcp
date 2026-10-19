import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createElementListInputSchema as schema,
  performCreateElementList,
  validateEnvironments,
  type FormElementListsLike,
  type CreateElementListInput,
} from '../src/workflows/create-element-list.ts'

// ------------------------------------------------------------------------
// Fakes. We MOCK the FormElementLists SDK + org derivation — no network.
// ------------------------------------------------------------------------

/** Recording fake lists service: records the created list, echoes back {id, ...}. */
function fakeLists(created: Record<string, unknown> = { id: 123 }): {
  lists: FormElementListsLike
  calls: unknown[]
} {
  const calls: unknown[] = []
  const lists: FormElementListsLike = {
    async createFormElementList(newList: unknown) {
      calls.push(newList)
      return { ...created, ...(created.name ? {} : { name: (newList as { name: string }).name }) }
    },
  }
  return { lists, calls }
}

const okOrg = async (): Promise<string> => 'org-123'

const input = (o: Partial<CreateElementListInput> = {}): CreateElementListInput =>
  schema.parse({
    name: 'States',
    workspaceIds: [70],
    environments: [{ formsAppEnvironmentId: 457, options: 'NSW:nsw|VIC:vic|QLD' }],
    ...o,
  })

// ========================================================================
// zod validation — fail closed
// ========================================================================
test('schema defaults type to STATIC', () => {
  const v = input()
  assert.equal(v.type, 'STATIC')
})

test('schema rejects a missing name', () => {
  assert.equal(schema.safeParse({ environments: [{ formsAppEnvironmentId: 1, options: 'A' }] }).success, false)
})

test('schema rejects empty environments', () => {
  assert.equal(schema.safeParse({ name: 'X', environments: [] }).success, false)
})

test('schema rejects a non-STATIC type', () => {
  assert.equal(
    schema.safeParse({ name: 'X', environments: [{ formsAppEnvironmentId: 1, options: 'A' }], type: 'URL' }).success,
    false,
  )
})

test('schema rejects a non-positive formsAppEnvironmentId', () => {
  assert.equal(schema.safeParse({ name: 'X', environments: [{ formsAppEnvironmentId: 0, options: 'A' }] }).success, false)
})

// ========================================================================
// validateEnvironments — fail-fast, collects ALL errors
// ========================================================================
test('validateEnvironments parses pipe-separated options', () => {
  const r = validateEnvironments([{ formsAppEnvironmentId: 1, options: 'NSW:nsw|VIC:vic' }])
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.parsed[0]!.options.length, 2)
    assert.deepEqual(r.parsed[0]!.options[0], { label: 'NSW', value: 'nsw' })
  }
})

test('validateEnvironments rejects a duplicate formsAppEnvironmentId', () => {
  const r = validateEnvironments([
    { formsAppEnvironmentId: 1, options: 'A' },
    { formsAppEnvironmentId: 1, options: 'B' },
  ])
  assert.equal(r.ok, false)
  if (!r.ok) assert.ok(r.errors.some((e) => e.column === 'formsAppEnvironmentId'))
})

// ========================================================================
// perform core
// ========================================================================
test('valid STATIC create returns the projection (mocked SDK)', async () => {
  const { lists, calls } = fakeLists({ id: 123, name: 'States' })
  const res = await performCreateElementList(input(), { lists, resolveOrganisationId: okOrg })
  assert.notEqual(res.isError, true)
  const body = JSON.parse(res.content[0]!.text)
  assert.deepEqual(body, { id: 123, name: 'States', type: 'STATIC', environmentCount: 1 })
  // org derived, not an input; options mapped to {label,value}
  const sent = calls[0] as { organisationId: string; workspaceIds: number[]; environments: Array<{ options: unknown[] }> }
  assert.equal(sent.organisationId, 'org-123')
  assert.deepEqual(sent.workspaceIds, [70])
  assert.equal(sent.environments[0]!.options.length, 3)
})

test('schema rejects missing workspaceIds (API requires it)', () => {
  assert.equal(
    schema.safeParse({ name: 'X', environments: [{ formsAppEnvironmentId: 1, options: 'A' }] }).success,
    false,
  )
})

test('schema rejects empty workspaceIds (empty [] 500s live)', () => {
  assert.equal(
    schema.safeParse({ name: 'X', workspaceIds: [], environments: [{ formsAppEnvironmentId: 1, options: 'A' }] }).success,
    false,
  )
})

test('empty environments is rejected before any API call', async () => {
  const { lists, calls } = fakeLists()
  // bypass zod (which also rejects) to exercise the core's own guard path:
  // an env whose options parse to nothing is the fail-fast case.
  const res = await performCreateElementList(
    { name: 'X', type: 'STATIC', workspaceIds: [70], environments: [{ formsAppEnvironmentId: 1, options: '' }] } as CreateElementListInput,
    { lists, resolveOrganisationId: okOrg },
  )
  assert.equal(res.isError, true)
  assert.equal(calls.length, 0)
})

test('duplicate env rejected, no API call', async () => {
  const { lists, calls } = fakeLists()
  const res = await performCreateElementList(
    {
      name: 'X',
      type: 'STATIC',
      workspaceIds: [70],
      environments: [
        { formsAppEnvironmentId: 1, options: 'A' },
        { formsAppEnvironmentId: 1, options: 'B' },
      ],
    } as CreateElementListInput,
    { lists, resolveOrganisationId: okOrg },
  )
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /Duplicate/)
  assert.equal(calls.length, 0)
})

test('bad options cell (no valid options) rejected, no API call', async () => {
  const { lists, calls } = fakeLists()
  const res = await performCreateElementList(
    { name: 'X', type: 'STATIC', workspaceIds: [70], environments: [{ formsAppEnvironmentId: 1, options: '  ' }] } as CreateElementListInput,
    { lists, resolveOrganisationId: okOrg },
  )
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /options/)
  assert.equal(calls.length, 0)
})

test('org-derivation failure path fails closed, no API call', async () => {
  const { lists, calls } = fakeLists()
  const failOrg = async (): Promise<string> => {
    throw new Error('no existing form')
  }
  const res = await performCreateElementList(input(), { lists, resolveOrganisationId: failOrg })
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /organisationId/)
  assert.equal(calls.length, 0)
})

test('an SDK create failure surfaces as isError (no secret leak)', async () => {
  const lists: FormElementListsLike = {
    async createFormElementList() {
      throw new Error('API rejected')
    },
  }
  const res = await performCreateElementList(input(), { lists, resolveOrganisationId: okOrg })
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /API rejected/)
})
