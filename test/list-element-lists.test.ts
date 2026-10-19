import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  listElementListsInputSchema as schema,
  performListElementLists,
  ALLOWED_FIELDS,
  type FormElementListsLike,
  type ListElementListsInput,
} from '../src/workflows/list-element-lists.ts'

// ------------------------------------------------------------------------
// Fakes. We MOCK searchFormElementLists + org derivation — no network.
// ------------------------------------------------------------------------

/** Recording fake: returns canned result(s) per call, records the opts. */
function fakeLists(
  results: Array<{ formElementLists?: Array<Record<string, unknown>>; meta?: { nextOffset?: number | null } }>,
): { lists: FormElementListsLike; calls: unknown[] } {
  const calls: unknown[] = []
  let i = 0
  const lists: FormElementListsLike = {
    async searchFormElementLists(opts) {
      calls.push(opts)
      const r = results[Math.min(i, results.length - 1)]!
      i++
      return r
    },
  }
  return { lists, calls }
}

const okOrg = async (): Promise<string> => 'org-123'

const input = (o: Partial<ListElementListsInput> = {}): ListElementListsInput => schema.parse({ ...o })

const listRow = (id: number): Record<string, unknown> => ({
  id,
  name: `list-${id}`,
  type: 'STATIC',
  updatedAt: '2026-10-12T00:00:00.000Z',
  environments: [{ formsAppEnvironmentId: 1 }],
})

// ========================================================================
// zod validation
// ========================================================================
test('applies defaults for mode/limit/offset', () => {
  const v = input()
  assert.equal(v.mode, 'page')
  assert.equal(v.limit, 50)
  assert.equal(v.offset, 0)
})

test('rejects limit over the 200 cap', () => {
  assert.equal(schema.safeParse({ limit: 500 }).success, false)
})

test('rejects a non-positive workspaceId', () => {
  assert.equal(schema.safeParse({ workspaceId: 0 }).success, false)
})

test('rejects an unknown field name', () => {
  assert.equal(schema.safeParse({ fields: ['notAField'] }).success, false)
})

test('accepts a known field name', () => {
  assert.equal(schema.safeParse({ fields: ['name', 'environments'] }).success, true)
})

test('ALLOWED_FIELDS includes the default projection keys', () => {
  for (const k of ['id', 'name', 'type', 'updatedAt']) {
    assert.ok(ALLOWED_FIELDS.includes(k as (typeof ALLOWED_FIELDS)[number]))
  }
})

// ========================================================================
// page mode — projection + nextOffset passthrough
// ========================================================================
test('page mode returns default projection and passes through SDK nextOffset', async () => {
  const { lists, calls } = fakeLists([{ formElementLists: [listRow(1), listRow(2)], meta: { nextOffset: 2 } }])
  const res = await performListElementLists(input({ limit: 2 }), { lists, resolveOrganisationId: okOrg })
  const body = JSON.parse(res.content[0]!.text)
  assert.equal(body.items.length, 2)
  assert.deepEqual(Object.keys(body.items[0]).sort(), ['id', 'name', 'type', 'updatedAt'])
  assert.equal(body.meta.nextOffset, 2) // SDK value, not re-derived
  assert.equal(body.meta.returnedCount, 2)
  // org derived and passed to the SDK
  assert.equal((calls[0] as { organisationId: string }).organisationId, 'org-123')
})

test('page mode nextOffset is null when the SDK gives none', async () => {
  const { lists } = fakeLists([{ formElementLists: [listRow(1)], meta: {} }])
  const res = await performListElementLists(input(), { lists, resolveOrganisationId: okOrg })
  const body = JSON.parse(res.content[0]!.text)
  assert.equal(body.meta.nextOffset, null)
})

test('workspaceId is forwarded to the SDK as a scope filter', async () => {
  const { lists, calls } = fakeLists([{ formElementLists: [], meta: { nextOffset: null } }])
  await performListElementLists(input({ workspaceId: 70 }), { lists, resolveOrganisationId: okOrg })
  assert.equal((calls[0] as { workspaceId?: number }).workspaceId, 70)
})

// ========================================================================
// stream mode — JSONL
// ========================================================================
test('stream mode emits one JSON object per line', async () => {
  // first page full (200), second page short -> loop stops
  const full = Array.from({ length: 200 }, (_, i) => listRow(i + 1))
  const { lists } = fakeLists([
    { formElementLists: full },
    { formElementLists: [listRow(201)] },
  ])
  const res = await performListElementLists(input({ mode: 'stream' }), { lists, resolveOrganisationId: okOrg })
  const lines = res.content[0]!.text.split('\n').filter(Boolean)
  assert.equal(lines.length, 201)
  const first = JSON.parse(lines[0]!)
  assert.deepEqual(Object.keys(first).sort(), ['id', 'name', 'type', 'updatedAt'])
})

// ========================================================================
// org-derivation path
// ========================================================================
test('org-derivation failure fails closed, no SDK call', async () => {
  const { lists, calls } = fakeLists([{ formElementLists: [] }])
  const failOrg = async (): Promise<string> => {
    throw new Error('no existing form')
  }
  const res = await performListElementLists(input(), { lists, resolveOrganisationId: failOrg })
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /organisationId/)
  assert.equal(calls.length, 0)
})

// ========================================================================
// fields override + coercion (rule 3)
// ========================================================================
test('fields override projects selected fields and coerces arrays to a count', async () => {
  const { lists } = fakeLists([{ formElementLists: [listRow(1)], meta: { nextOffset: null } }])
  const res = await performListElementLists(input({ fields: ['id', 'environments'] }), {
    lists,
    resolveOrganisationId: okOrg,
  })
  const body = JSON.parse(res.content[0]!.text)
  assert.deepEqual(Object.keys(body.items[0]).sort(), ['environments', 'id'])
  assert.equal(body.items[0].environments, 1) // array -> length
})

test('an SDK search failure surfaces as isError', async () => {
  const lists: FormElementListsLike = {
    async searchFormElementLists() {
      throw new Error('search rejected')
    },
  }
  const res = await performListElementLists(input(), { lists, resolveOrganisationId: okOrg })
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /search rejected/)
})
