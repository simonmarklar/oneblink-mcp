import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFormInputSchema as schema } from '../src/workflows/create-form.ts'

test('schema defaults scaffold fields', () => {
  const v = schema.parse({ name: 'My Form', formsAppEnvironmentId: 457, elementsCsv: 'label,type\nA,text\n' })
  assert.equal(v.description, '')
  assert.deepEqual(v.formsAppIds, [])
  assert.equal(v.isAuthenticated, false)
  assert.equal(v.postSubmissionAction, 'FORMS_LIBRARY')
  assert.equal(v.cancelAction, 'FORMS_LIBRARY')
})

test('schema requires a name', () => {
  assert.throws(() => schema.parse({ formsAppEnvironmentId: 457, elementsCsv: 'label,type\nA,text\n' }))
})

test('schema requires formsAppEnvironmentId', () => {
  assert.throws(() => schema.parse({ name: 'F', elementsCsv: 'label,type\nA,text\n' }))
})

test('schema accepts a definition-mode elements array', () => {
  const v = schema.parse({ name: 'F', formsAppEnvironmentId: 457, elements: [{ type: 'text', label: 'A' }] })
  assert.ok(Array.isArray(v.elements))
})

test('schema accepts isMultiPage override', () => {
  const v = schema.parse({ name: 'F', formsAppEnvironmentId: 457, elementsCsv: 'label,type\nA,text\n', isMultiPage: true })
  assert.equal(v.isMultiPage, true)
})

test('schema rejects an invalid redirectUrl', () => {
  assert.throws(() => schema.parse({ name: 'F', formsAppEnvironmentId: 457, elements: [], redirectUrl: 'not-a-url' }))
})
