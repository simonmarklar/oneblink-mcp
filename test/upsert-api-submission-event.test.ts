import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  upsertApiSubmissionEventInputSchema as schema,
  performUpsert,
  type FormsLike,
  type UpsertApiSubmissionEventInput,
} from '../src/workflows/upsert-api-submission-event.ts'

// Build a valid parsed input (schema applies defaults like overrideLock=false).
function input(overrides: Partial<Record<string, unknown>> = {}): UpsertApiSubmissionEventInput {
  return schema.parse({
    formId: 1,
    apiId: 'oneblink-api-id',
    apiEnvironment: 'test',
    apiEnvironmentRoute: '/my-route',
    ...overrides,
  })
}

/**
 * Fake Forms service: getForm returns a form with the given events; updateForm
 * records what it was handed and echoes it back (or throws a canned error).
 */
function fakeForms(opts: {
  events?: unknown[]
  updateThrows?: unknown
}): { forms: FormsLike; calls: { update: Array<{ form: any; overrideLock?: boolean }> } } {
  const calls = { update: [] as Array<{ form: any; overrideLock?: boolean }> }
  const forms: FormsLike = {
    async getForm() {
      return { id: 1, submissionEvents: opts.events ?? [] }
    },
    async updateForm(form: unknown, overrideLock?: boolean) {
      calls.update.push({ form, overrideLock })
      if (opts.updateThrows !== undefined) throw opts.updateThrows
      return form
    },
  }
  return { forms, calls }
}

// --- zod validation (fail closed) ---------------------------------------
test('schema rejects a missing apiId', () => {
  assert.equal(schema.safeParse({ formId: 1, apiEnvironment: 'dev', apiEnvironmentRoute: '/r' }).success, false)
})

test('schema rejects a non-positive formId', () => {
  assert.equal(
    schema.safeParse({ formId: 0, apiId: 'a', apiEnvironment: 'dev', apiEnvironmentRoute: '/r' }).success,
    false,
  )
})

test('schema rejects a route not starting with /', () => {
  assert.equal(
    schema.safeParse({ formId: 1, apiId: 'a', apiEnvironment: 'dev', apiEnvironmentRoute: 'no-slash' }).success,
    false,
  )
})

test('schema does NOT restrict apiEnvironment to dev/test/prod (free string)', () => {
  const r = schema.safeParse({ formId: 1, apiId: 'a', apiEnvironment: 'staging', apiEnvironmentRoute: '/r' })
  assert.equal(r.success, true)
})

test('schema defaults overrideLock=false', () => {
  const v = input()
  assert.equal(v.overrideLock, false)
})

test('schema rejects a non-positive organisationManagedSecretId', () => {
  assert.equal(
    schema.safeParse({ formId: 1, apiId: 'a', apiEnvironment: 'dev', apiEnvironmentRoute: '/r', organisationManagedSecretId: 0 })
      .success,
    false,
  )
})

// --- append vs replaceIndex ---------------------------------------------
test('append writes exactly the ONEBLINK_API event and projects where it landed', async () => {
  const { forms, calls } = fakeForms({ events: [{ type: 'EMAIL' }] })
  const res = await performUpsert(input({ organisationManagedSecretId: 42 }), forms)
  assert.notEqual(res.isError, true)
  // written form: event appended at index 1
  const written = calls.update[0]!.form.submissionEvents
  assert.equal(written.length, 2)
  assert.deepEqual(written[1], {
    type: 'ONEBLINK_API',
    configuration: {
      apiId: 'oneblink-api-id',
      apiEnvironment: 'test',
      apiEnvironmentRoute: '/my-route',
      organisationManagedSecretId: 42,
    },
    conditionallyExecute: false,
    requiresAllConditionallyExecutePredicates: false,
    isRetryable: true,
  })
  // projection
  const body = JSON.parse(res.content[0]!.text)
  assert.equal(body.action, 'appended')
  assert.equal(body.index, 1)
  assert.equal(body.type, 'ONEBLINK_API')
  assert.equal(body.totalSubmissionEvents, 2)
  // projection carries the event but never the whole form
  assert.equal('submissionEvents' in body, false)
})

test('replaceIndex replaces at the explicit index, not append', async () => {
  const { forms, calls } = fakeForms({ events: [{ type: 'EMAIL' }, { type: 'PDF' }] })
  const res = await performUpsert(input({ replaceIndex: 0 }), forms)
  assert.notEqual(res.isError, true)
  const written = calls.update[0]!.form.submissionEvents
  assert.equal(written.length, 2) // replaced, not appended
  assert.equal(written[0].type, 'ONEBLINK_API')
  assert.equal(written[1].type, 'PDF')
  const body = JSON.parse(res.content[0]!.text)
  assert.equal(body.action, 'replaced')
  assert.equal(body.index, 0)
})

test('out-of-range replaceIndex fails closed and never writes', async () => {
  const { forms, calls } = fakeForms({ events: [{ type: 'EMAIL' }] })
  const res = await performUpsert(input({ replaceIndex: 5 }), forms)
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /out of range/)
  assert.equal(calls.update.length, 0)
})

test('event omits organisationManagedSecretId when not provided', async () => {
  const { forms, calls } = fakeForms({ events: [] })
  await performUpsert(input(), forms)
  const written = calls.update[0]!.form.submissionEvents[0]
  assert.equal('organisationManagedSecretId' in written.configuration, false)
})

// --- form lock (fail closed) --------------------------------------------
test('locked form with overrideLock=false returns the permission message and does NOT write', async () => {
  // updateForm throws a lock error; overrideLock defaults false.
  const { forms } = fakeForms({ events: [], updateThrows: { statusCode: 409 } })
  const res = await performUpsert(input(), forms)
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /locked/)
  assert.match(res.content[0]!.text, /overrideLock: true/)
})

test('overrideLock=true passes the override flag through to updateForm', async () => {
  const { forms, calls } = fakeForms({ events: [] })
  await performUpsert(input({ overrideLock: true }), forms)
  assert.equal(calls.update[0]!.overrideLock, true)
})

test('a non-lock updateForm error surfaces as isError (no event claimed written)', async () => {
  const { forms } = fakeForms({ events: [], updateThrows: new Error('server exploded') })
  const res = await performUpsert(input(), forms)
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /no event written/)
})
