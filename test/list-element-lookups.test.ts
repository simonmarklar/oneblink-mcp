import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  listElementLookupsInputSchema as schema,
  registerListElementLookups,
  ALLOWED_FIELDS,
} from '../src/workflows/list-element-lookups.ts'
import { runWithClient } from '../src/lib/request-context.ts'
import type { OneBlinkClient } from '../src/lib/oneblink-client.ts'

// --- Test harness ----------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean
  content: Array<{ type: string; text: string }>
}>

/** Capture the handler the workflow registers against a fake McpServer. */
function captureHandler(): ToolHandler {
  let handler: ToolHandler | undefined
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, h: ToolHandler) => {
      handler = h
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerListElementLookups(fakeServer as any)
  if (!handler) throw new Error('handler was not registered')
  return handler
}

interface Lookup {
  id: number
  name: string
  type: string
  updatedAt?: string
  environments?: unknown[]
  [k: string]: unknown
}

interface MockOpts {
  org?: string | null
  searchThrows?: Error
  /** Pages keyed by offset; search returns the page for the requested offset. */
  pages?: Record<number, { formElementLookups: Lookup[]; meta?: { nextOffset?: number } }>
}

/**
 * Build a mocked OneBlinkClient: forms().searchForms derives org;
 * formElementLookups().searchFormElementLookups returns the configured page and
 * records the scope it was called with.
 */
function mockClient(opts: MockOpts): {
  client: OneBlinkClient
  calls: { search: Array<{ organisationId: string; workspaceId?: number; limit?: number; offset?: number }> }
} {
  const calls = { search: [] as Array<{ organisationId: string; workspaceId?: number; limit?: number; offset?: number }> }
  const client = {
    forms: () => ({
      searchForms: async () => {
        if (opts.searchThrows) throw opts.searchThrows
        return opts.org === undefined
          ? { forms: [{ organisationId: 'org-123' }] }
          : { forms: opts.org === null ? [] : [{ organisationId: opts.org }] }
      },
    }),
    formElementLookups: () => ({
      searchFormElementLookups: async (scope: {
        organisationId: string
        workspaceId?: number
        limit?: number
        offset?: number
      }) => {
        calls.search.push(scope)
        const page = opts.pages?.[scope.offset ?? 0]
        return page ?? { formElementLookups: [], meta: {} }
      },
    }),
  } as unknown as OneBlinkClient
  return { client, calls }
}

function run(handler: ToolHandler, client: OneBlinkClient, args: Record<string, unknown>) {
  return runWithClient(client, () => handler(args))
}

// --- Schema tests ----------------------------------------------------------

test('schema applies defaults for mode/limit/offset', () => {
  const v = schema.parse({})
  assert.equal(v.mode, 'page')
  assert.equal(v.limit, 50)
  assert.equal(v.offset, 0)
})

test('schema accepts an optional workspaceId', () => {
  const v = schema.parse({ workspaceId: 70 })
  assert.equal(v.workspaceId, 70)
})

test('schema rejects a non-positive workspaceId', () => {
  assert.equal(schema.safeParse({ workspaceId: 0 }).success, false)
})

test('schema rejects limit over the 200 cap', () => {
  assert.equal(schema.safeParse({ limit: 500 }).success, false)
})

test('schema rejects an unknown field name', () => {
  assert.equal(schema.safeParse({ fields: ['notAField'] }).success, false)
})

test('schema accepts known field names', () => {
  const v = schema.parse({ fields: ['id', 'name', 'environments'] })
  assert.deepEqual(v.fields, ['id', 'name', 'environments'])
})

test('ALLOWED_FIELDS includes the default projection keys', () => {
  for (const k of ['id', 'name', 'type', 'updatedAt']) {
    assert.ok(ALLOWED_FIELDS.includes(k as (typeof ALLOWED_FIELDS)[number]))
  }
})

// --- Handler behaviour: page mode ------------------------------------------

test('page mode returns the default projection and the SDK nextOffset', async () => {
  const handler = captureHandler()
  const { client, calls } = mockClient({
    org: 'org-abc',
    pages: {
      0: {
        formElementLookups: [{ id: 7, name: 'Postcode', type: 'DATA', updatedAt: '2026-01-01T00:00:00.000Z', environments: [{}] }],
        meta: { nextOffset: 50 },
      },
    },
  })
  const res = await run(handler, client, {})
  assert.notEqual(res.isError, true)
  const payload = JSON.parse(res.content[0].text)
  assert.deepEqual(payload.items, [{ id: 7, name: 'Postcode', type: 'DATA', updatedAt: '2026-01-01T00:00:00.000Z' }])
  // nextOffset comes straight from the SDK's meta (rule 6), not derived.
  assert.equal(payload.meta.nextOffset, 50)
  assert.equal(payload.meta.returnedCount, 1)
  // org derived server-side and used as the mandatory scope.
  assert.equal(calls.search[0].organisationId, 'org-abc')
})

test('page mode nextOffset is null when the SDK omits it', async () => {
  const handler = captureHandler()
  const { client } = mockClient({
    org: 'org-abc',
    pages: { 0: { formElementLookups: [{ id: 1, name: 'A', type: 'DATA' }], meta: {} } },
  })
  const res = await run(handler, client, {})
  const payload = JSON.parse(res.content[0].text)
  assert.equal(payload.meta.nextOffset, null)
})

test('workspaceId is threaded through to the SDK scope', async () => {
  const handler = captureHandler()
  const { client, calls } = mockClient({ org: 'org-abc', pages: { 0: { formElementLookups: [], meta: {} } } })
  await run(handler, client, { workspaceId: 70 })
  assert.equal(calls.search[0].workspaceId, 70)
})

// --- Handler behaviour: field override -------------------------------------

test('fields override projects only the requested top-level fields', async () => {
  const handler = captureHandler()
  const { client } = mockClient({
    org: 'org-abc',
    pages: { 0: { formElementLookups: [{ id: 7, name: 'Postcode', type: 'DATA', environments: [{}, {}] }], meta: {} } },
  })
  const res = await run(handler, client, { fields: ['id', 'environments'] })
  const payload = JSON.parse(res.content[0].text)
  // array coerces to its length (projection rule); only requested keys present.
  assert.deepEqual(payload.items, [{ id: 7, environments: 2 }])
})

test('unknown field in fields is rejected (fail closed), no SDK call', async () => {
  const handler = captureHandler()
  const { client, calls } = mockClient({ org: 'org-abc' })
  const res = await run(handler, client, { fields: ['id', 'bogus'] })
  assert.equal(res.isError, true)
  assert.equal(calls.search.length, 0)
})

// --- Handler behaviour: stream mode (JSONL) --------------------------------

test('stream mode emits one JSON object per line across pages', async () => {
  const handler = captureHandler()
  // 200 items on page 0 (a full page) forces a second internal fetch at offset 200.
  const fullPage = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `n${i}`, type: 'DATA' }))
  const { client, calls } = mockClient({
    org: 'org-abc',
    pages: {
      0: { formElementLookups: fullPage, meta: { nextOffset: 200 } },
      200: { formElementLookups: [{ id: 999, name: 'last', type: 'ELEMENT' }], meta: {} },
    },
  })
  const res = await run(handler, client, { mode: 'stream' })
  assert.notEqual(res.isError, true)
  const lines = res.content[0].text.split('\n')
  assert.equal(lines.length, 201)
  const first = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(first).sort(), ['id', 'name', 'type', 'updatedAt'])
  const last = JSON.parse(lines[200])
  assert.equal(last.id, 999)
  // two internal fetches: offset 0 then 200.
  assert.deepEqual(calls.search.map((c) => c.offset), [0, 200])
})

// --- Handler behaviour: org derivation -------------------------------------

test('org-derivation failure (no existing form) fails closed, no search', async () => {
  const handler = captureHandler()
  const { client, calls } = mockClient({ org: null })
  const res = await run(handler, client, {})
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /Could not derive organisationId/)
  assert.equal(calls.search.length, 0)
})

test('searchForms throwing during org derivation fails closed, no search', async () => {
  const handler = captureHandler()
  const { client, calls } = mockClient({ searchThrows: new Error('403 forbidden') })
  const res = await run(handler, client, {})
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /Could not resolve organisationId/)
  assert.equal(calls.search.length, 0)
})
