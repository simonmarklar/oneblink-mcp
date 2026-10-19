import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEmailTemplateInputSchema as schema, registerCreateEmailTemplate } from '../src/workflows/create-email-template.ts'
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
  registerCreateEmailTemplate(fakeServer as any)
  if (!handler) throw new Error('handler was not registered')
  return handler
}

interface MockOpts {
  org?: string | null
  searchThrows?: Error
  createImpl?: (data: unknown) => unknown
  createThrows?: Error
}

/** Build a mocked OneBlinkClient: forms().searchForms derives org; emailTemplates().createEmailTemplate records the call. */
function mockClient(opts: MockOpts): { client: OneBlinkClient; calls: { create: unknown[] } } {
  const calls = { create: [] as unknown[] }
  const client = {
    forms: () => ({
      searchForms: async () => {
        if (opts.searchThrows) throw opts.searchThrows
        return opts.org === undefined ? { forms: [{ organisationId: 'org-123' }] } : { forms: opts.org === null ? [] : [{ organisationId: opts.org }] }
      },
    }),
    emailTemplates: () => ({
      createEmailTemplate: async (data: unknown) => {
        calls.create.push(data)
        if (opts.createThrows) throw opts.createThrows
        if (opts.createImpl) return opts.createImpl(data)
        return { id: 42, name: (data as { name: string }).name, type: (data as { type: string }).type, environments: (data as { environments: unknown[] }).environments }
      },
    }),
  } as unknown as OneBlinkClient
  return { client, calls }
}

function run(handler: ToolHandler, client: OneBlinkClient, args: Record<string, unknown>) {
  return runWithClient(client, () => handler(args))
}

const validArgs = {
  name: 'Receipt PDF',
  type: 'FORM_SUBMISSION_EVENT_PDF',
  workspaceIds: [70],
  environments: [{ formsAppEnvironmentId: 1, template: 'Hello {{custom:name}}' }],
}

// --- Schema tests ----------------------------------------------------------

test('schema accepts a valid template', () => {
  const v = schema.parse(validArgs)
  assert.equal(v.name, 'Receipt PDF')
  assert.equal(v.type, 'FORM_SUBMISSION_EVENT_PDF')
  assert.equal(v.environments.length, 1)
})

test('schema requires a name', () => {
  assert.throws(() => schema.parse({ type: 'FORM_SUBMISSION_EVENT_PDF', environments: validArgs.environments }))
})

test('schema rejects an unknown type (SDK-authoritative enum)', () => {
  assert.throws(() => schema.parse({ ...validArgs, type: 'NOT_A_REAL_TYPE' }))
})

test('schema accepts every SDK-pinned type value', () => {
  for (const type of [
    'FORM_SUBMISSION_EVENT_PDF',
    'FORMS_APP_WELCOME_EMAIL',
    'APPROVAL_CLARIFICATION_REQUEST',
    'APPROVAL_APPROVED',
    'APPROVAL_DENIED',
    'TO_APPROVER_APPROVAL_CREATED',
    'FORM_SUBMISSION_EVENT_EMAIL',
  ]) {
    const v = schema.parse({ ...validArgs, type })
    assert.equal(v.type, type)
  }
})

test('schema rejects empty environments', () => {
  assert.throws(() => schema.parse({ ...validArgs, environments: [] }))
})

test('schema rejects an empty template body', () => {
  assert.throws(() => schema.parse({ ...validArgs, environments: [{ formsAppEnvironmentId: 1, template: '' }] }))
})

// --- Handler behaviour tests -----------------------------------------------

test('valid create returns the projection and derives org server-side', async () => {
  const handler = captureHandler()
  const { client, calls } = mockClient({ org: 'org-abc' })
  const res = await run(handler, client, validArgs)
  assert.notEqual(res.isError, true)
  const payload = JSON.parse(res.content[0].text)
  assert.deepEqual(payload, { id: 42, name: 'Receipt PDF', type: 'FORM_SUBMISSION_EVENT_PDF', environmentCount: 1 })
  // org was derived and stamped; never a tool input.
  assert.equal((calls.create[0] as { organisationId: string }).organisationId, 'org-abc')
  // workspaceIds passed through to the SDK (required, non-empty — empty [] 500s live).
  assert.deepEqual((calls.create[0] as { workspaceIds: number[] }).workspaceIds, [70])
})

test('schema rejects missing workspaceIds (API requires it)', () => {
  assert.throws(() => schema.parse({ name: 'X', type: 'FORM_SUBMISSION_EVENT_PDF', environments: validArgs.environments }))
})

test('schema rejects empty workspaceIds (empty [] 500s live)', () => {
  assert.throws(() => schema.parse({ ...validArgs, workspaceIds: [] }))
})

test('duplicate formsAppEnvironmentId is rejected before any API call', async () => {
  const handler = captureHandler()
  const { client, calls } = mockClient({ org: 'org-abc' })
  const res = await run(handler, client, {
    ...validArgs,
    environments: [
      { formsAppEnvironmentId: 1, template: 'a' },
      { formsAppEnvironmentId: 1, template: 'b' },
    ],
  })
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /Duplicate formsAppEnvironmentId/)
  assert.equal(calls.create.length, 0)
})

test('unknown type is rejected by the handler (schema) before any API call', async () => {
  const handler = captureHandler()
  const { client, calls } = mockClient({ org: 'org-abc' })
  const res = await run(handler, client, { ...validArgs, type: 'BOGUS' })
  assert.equal(res.isError, true)
  assert.equal(calls.create.length, 0)
})

test('org-derivation failure (no existing form) fails closed, no create', async () => {
  const handler = captureHandler()
  const { client, calls } = mockClient({ org: null })
  const res = await run(handler, client, validArgs)
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /Could not derive organisationId/)
  assert.equal(calls.create.length, 0)
})

test('searchForms throwing surfaces as a fail-closed error, no create', async () => {
  const handler = captureHandler()
  const { client, calls } = mockClient({ searchThrows: new Error('403 forbidden') })
  const res = await run(handler, client, validArgs)
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /Could not resolve organisationId/)
  assert.equal(calls.create.length, 0)
})

test('createEmailTemplate failure is reported, no partial success', async () => {
  const handler = captureHandler()
  const { client } = mockClient({ org: 'org-abc', createThrows: new Error('500 boom') })
  const res = await run(handler, client, validArgs)
  assert.equal(res.isError, true)
  assert.match(res.content[0].text, /create_email_template failed/)
})
