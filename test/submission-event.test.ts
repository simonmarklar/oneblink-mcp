import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSubmissionEvent,
  buildApiSubmissionEvent,
  spliceEvent,
  isFormLockedError,
} from '../src/lib/submission-event.ts'
import { upsertEmailSubmissionEventInputSchema as schema } from '../src/workflows/upsert-email-submission-event.ts'

// --- buildSubmissionEvent ---
test('PDF event = PDFConfiguration & EmailConfiguration merged', () => {
  const e = buildSubmissionEvent({
    eventType: 'PDF',
    email: { toEmail: ['a@b.com'], subjectLine: 'Hi' },
    pdf: { fileName: 'out.pdf', excludedElementIds: ['x'] },
    emailTemplateId: 7,
  }) as any
  assert.equal(e.type, 'PDF')
  assert.deepEqual(e.configuration.toEmail, ['a@b.com'])
  assert.equal(e.configuration.emailSubjectLine, 'Hi')
  assert.equal(e.configuration.pdfFileName, 'out.pdf')
  assert.deepEqual(e.configuration.excludedElementIds, ['x'])
  assert.deepEqual(e.configuration.emailTemplate, { id: 7, mapping: [] })
  assert.equal(e.isRetryable, true)
  assert.equal(e.conditionallyExecute, false)
})

test('EMAIL event nests pdfConfigurations[] only when pdf given', () => {
  const withPdf = buildSubmissionEvent({ eventType: 'EMAIL', email: { toEmail: ['a@b.com'] }, pdf: { fileName: 'p.pdf' } }) as any
  assert.ok(Array.isArray(withPdf.configuration.pdfConfigurations))
  assert.equal(withPdf.configuration.pdfConfigurations[0].pdfFileName, 'p.pdf')
  const noPdf = buildSubmissionEvent({ eventType: 'EMAIL', email: { toEmail: ['a@b.com'] } }) as any
  assert.equal(noPdf.configuration.pdfConfigurations, undefined)
})

test('never writes the deprecated email scalar', () => {
  const e = buildSubmissionEvent({ eventType: 'PDF', email: { toEmail: ['a@b.com'] } }) as any
  assert.equal('email' in e.configuration, false)
})

// --- buildApiSubmissionEvent (ONEBLINK_API) ---
test('API event has the exact ONEBLINK_API shape with FormEventBase defaults', () => {
  const e = buildApiSubmissionEvent({
    apiId: 'oneblink-api-id',
    apiEnvironment: 'test',
    apiEnvironmentRoute: '/my-route',
  }) as any
  assert.equal(e.type, 'ONEBLINK_API')
  assert.deepEqual(e.configuration, {
    apiId: 'oneblink-api-id',
    apiEnvironment: 'test',
    apiEnvironmentRoute: '/my-route',
  })
  // FormEventBase defaults mirror buildSubmissionEvent
  assert.equal(e.conditionallyExecute, false)
  assert.equal(e.requiresAllConditionallyExecutePredicates, false)
  assert.equal(e.isRetryable, true)
  // no label unless provided
  assert.equal('label' in e, false)
})

test('API event writes organisationManagedSecretId ONLY when provided', () => {
  const without = buildApiSubmissionEvent({ apiId: 'a', apiEnvironment: 'dev', apiEnvironmentRoute: '/r' }) as any
  assert.equal('organisationManagedSecretId' in without.configuration, false)
  const withSecret = buildApiSubmissionEvent({
    apiId: 'a',
    apiEnvironment: 'dev',
    apiEnvironmentRoute: '/r',
    organisationManagedSecretId: 42,
  }) as any
  assert.equal(withSecret.configuration.organisationManagedSecretId, 42)
})

test('API event honours label and FormEventBase overrides', () => {
  const e = buildApiSubmissionEvent({
    apiId: 'a',
    apiEnvironment: 'prod',
    apiEnvironmentRoute: '/r',
    label: 'My webhook',
    conditionallyExecute: true,
    isRetryable: false,
  }) as any
  assert.equal(e.label, 'My webhook')
  assert.equal(e.conditionallyExecute, true)
  assert.equal(e.isRetryable, false)
})

// --- spliceEvent (D1) ---
test('spliceEvent appends when replaceIndex omitted', () => {
  const out = spliceEvent([{ a: 1 }], { b: 2 })
  assert.equal(out.length, 2)
  assert.deepEqual(out[1], { b: 2 })
})

test('spliceEvent replaces at an explicit index', () => {
  const out = spliceEvent([{ a: 1 }, { a: 2 }], { b: 9 }, 1)
  assert.deepEqual(out, [{ a: 1 }, { b: 9 }])
})

test('spliceEvent throws on out-of-range index (fail closed, no guess)', () => {
  assert.throws(() => spliceEvent([{ a: 1 }], { b: 2 }, 5))
  assert.throws(() => spliceEvent([{ a: 1 }], { b: 2 }, -1))
})

// --- isFormLockedError (D2) ---
test('isFormLockedError detects 409/423 and lock messages', () => {
  assert.equal(isFormLockedError({ statusCode: 409 }), true)
  assert.equal(isFormLockedError({ status: 423 }), true)
  assert.equal(isFormLockedError(new Error('Form is locked by someone')), true)
  assert.equal(isFormLockedError(new Error('not found')), false)
  assert.equal(isFormLockedError({ statusCode: 500 }), false)
})

// --- input schema ---
test('schema requires at least one toEmail', () => {
  assert.throws(() => schema.parse({ formId: 1, email: { toEmail: [] } }))
})

test('schema rejects a non-email address', () => {
  assert.throws(() => schema.parse({ formId: 1, email: { toEmail: ['nope'] } }))
})

test('schema defaults eventType=PDF and overrideLock=false', () => {
  const v = schema.parse({ formId: 1, email: { toEmail: ['a@b.com'] } })
  assert.equal(v.eventType, 'PDF')
  assert.equal(v.overrideLock, false)
})

test('schema emailTemplate: id XOR create-by-name', () => {
  assert.ok(schema.parse({ formId: 1, email: { toEmail: ['a@b.com'] }, emailTemplate: { id: 5 } }))
  assert.ok(schema.parse({ formId: 1, email: { toEmail: ['a@b.com'] }, emailTemplate: { name: 'T', bodyHtml: '<p>x</p>' } }))
})
