import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createElementLookupInputSchema as schema,
  registerCreateElementLookup,
} from '../src/workflows/create-element-lookup.ts'
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
  registerCreateElementLookup(fakeServer as any)
  if (!handler) throw new Error('handler was not registered')
  return handler
}

interface MockOpts {
  org?: string | null
  searchThrows?: Error
  createImpl?: (data: unknown) => unknown
  createThrows?: Error
}

/**
 * Build a mocked OneBlinkClient: forms().searchForms derives org;
 * formElementLookups().createFormElementLookup records the call.
 */
function mockClient(opts: MockOpts): { client: OneBlinkClient; calls: { create: unknown[] } } {
  const calls = { create: [] as unknown[] }
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
      createFormElementLookup: async (data: unknown) => {
        calls.create.push(data)
        if (opts.createThrows) throw opts.createThrows
        if (opts.createImpl) return opts.createImpl(data)
        const d = data as { name: string; type: string }
        return { id: 7, name: d.name, type: d.type }
      },
    }),
  } as unknown as OneBlinkClient
  return { client, calls }
}

function run(handler: ToolHandler, client: OneBlinkClient, args: Record<string, unknown>) {
  return runWithClient(client, () => handler(args))
}

const validData = {
  name: 'Postcode lookup',
  type: 'DATA',
  workspaceIds: [70],
  environments: [{ formsAppEnvironmentId: 1, url: 'https://api.example.com/lookup' }],
}

// --- Schema tests ----------------------------------------------------------

test('schema accepts a valid DATA lookup', () => {
  const v = schema.parse(validData)
  assert.equal(v.name, 'Postcode lookup')
  assert.equal(v.type, 'DATA')
  assert.equal(v.environments.length, 1)
})

test('schema accepts a valid ELEMENT lookup', () => {
  const v = schema.parse({ ...validData, type: 'ELEMENT' })
  assert.equal(v.type, 'ELEMENT')
})

test('schema requires a name', () => {
  assert.throws(() => schema.parse({ type: 'DATA', environments: validData.environments }))
})

test('schema rejects STATIC_DATA (out of scope this release)', () => {
  // STATIC_DATA is not an accepted enum value here — fail closed.
  assert.equal(schema.safeParse({ ...validData, type: 'STATIC_DATA' }).success, false)
})

test('schema rejects a malformed url', () => {
  assert.equal(
    schema.safeParse({ ...validData, environments: [{ formsAppEnvironmentId: 1, url: 'not-a-url' }] }).success,
    false,
  )
})

test('schema rejects empty environments', () => {
  assert.equal(schema.safeParse({ ...validData, environments: [] }).success, false)
})

test('schema rejects missing workspaceIds (API requires it)', () => {
  const { workspaceIds, ...noWs } = validData
  void workspaceIds
  assert.equal(schema.safeParse(noWs).success, false)
})

test('schema rejects empty workspaceIds (empty [] 500s live)', () => {
  assert.equal(schema.safeParse({ ...validData, workspaceIds: [] }).success, false)
})

test('schema accepts optional apiId + excludeDefinition', () => {
  const v = schema.parse({ ...validData, apiId: 'console-api', excludeDefinition: true })
  assert.equal(v.apiId, 'console-api')
  assert.equal(v.excludeDefinition, true)
})

// --- Handler behaviour tests -----------------------------------------------

test('valid DATA create returns the projection and derives org server-side', async () => {
  const handler = captureHandler()
  const { client, calls } = mockClient({ org: 'org-abc' })
  const res = await run(handler, client, validData)
  assert.notEqual(res.isError, true)
  const payload = JSON.parse(res.content[0].text)
  assert.deepEqual(payload, { id: 7, name: 'Postcode lookup', type: 'DATA', environmentCount: 1 })
  // org was derived and stamped; never a tool input.
  assert.equal((calls.create[0] as { organisationId: string }).organisationId, 'org-abc')
  // workspaceIds passed through to the SDK (required, non-empty).
  assert.deepEqual((calls.create[0] as { workspaceIds: number[] }).workspaceIds, [70])
  // url is passed through to the SDK config (not fetched by the server).
  assert.equal(
    (calls.create[0] as { environments: Array<{ url: string }> }).environments[0].url,
    'https://api.example.com/lookup',
  )
})

test('valid ELEMENT create returns an ELEMENT-typed projection', async () => {
  const handler = captureHandler()
  const { client } = mockClient({ org: 'org-abc' })
  const res = await run(handler, client, { ...validData, type: 'ELEMENT' })
  assert.notEqual(res.isError, true)
  const payload = JSON.parse(res.content[0].text)
  assert.equal(payload.type, 'ELEMENT')
})

test('a bad url is rejected before any API call', async () => {
  const handler = captureHandler()
  const { client, calls } = mockClient({ org: 'org-abc' })
  const res = await run(handler, client, {
    ...validData,
    environments: [{ formsAppEnvironmentId: 1, url: 'ftp:// bad url' }],
  })
  assert.equal(res.isError, true)
  assert.equal(calls.create.length, 0)
})

test('empty environments is rejected before any API call', async () => {
  const handler = captureHandler()
  const { client, calls } = mockClient({ org: 'org-abc' })
  const res = await run(handler, client, { ...validData, environments: [] })
  assert.equal(res.isError, true)
  assert.equal(calls.create.length, 0)
})

test('duplicate formsAppEnvironmentId is rejected before any API call', async () => {
  const handler = captureHandler()
  const { client, calls } = mockClient({ org: 'org-abc' })
  const res = await run(handler, client, {
    ...validData,
    environments: [
      { formsAppEnvironmentId: 1, url: 'https://a.example.com' },
      { formsAppEnvironmentId: 1, url: 'https://b.example.com' },
    ],
  })
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /Duplicate formsAppEnvironmentId/)
  assert.equal(calls.create.length, 0)
})

test('STATIC_DATA type is rejected by the handler (schema) before any API call', async () => {
  const handler = captureHandler()
  const { client, calls } = mockClient({ org: 'org-abc' })
  const res = await run(handler, client, { ...validData, type: 'STATIC_DATA' })
  assert.equal(res.isError, true)
  assert.equal(calls.create.length, 0)
})

test('org-derivation failure (no existing form) fails closed, no create', async () => {
  const handler = captureHandler()
  const { client, calls } = mockClient({ org: null })
  const res = await run(handler, client, validData)
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /Could not derive organisationId/)
  assert.equal(calls.create.length, 0)
})

test('searchForms throwing surfaces as a fail-closed error, no create', async () => {
  const handler = captureHandler()
  const { client, calls } = mockClient({ searchThrows: new Error('403 forbidden') })
  const res = await run(handler, client, validData)
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /Could not resolve organisationId/)
  assert.equal(calls.create.length, 0)
})

test('createFormElementLookup failure is reported, no partial success', async () => {
  const handler = captureHandler()
  const { client } = mockClient({ org: 'org-abc', createThrows: new Error('500 boom') })
  const res = await run(handler, client, validData)
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /create_element_lookup failed/)
})
