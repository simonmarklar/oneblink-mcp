import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setFormPersonalisationInputSchema as schema } from '../src/workflows/set-form-personalisation.ts'

const valid = {
  formId: 37280,
  apiId: 'oneblink-mcp-test.api.oneblink.io',
  apiEnvironment: 'dev',
  apiEnvironmentRoute: '/test',
}

test('schema accepts valid input and defaults overrideLock=false', () => {
  const v = schema.parse(valid)
  assert.equal(v.formId, 37280)
  assert.equal(v.apiId, 'oneblink-mcp-test.api.oneblink.io')
  assert.equal(v.apiEnvironment, 'dev')
  assert.equal(v.apiEnvironmentRoute, '/test')
  assert.equal(v.overrideLock, false)
})

test('schema rejects a route without a leading slash', () => {
  assert.throws(() => schema.parse({ ...valid, apiEnvironmentRoute: 'test' }))
})

test('schema rejects a missing formId', () => {
  const { formId: _omit, ...rest } = valid
  assert.throws(() => schema.parse(rest))
})

test('schema rejects a non-positive formId', () => {
  assert.throws(() => schema.parse({ ...valid, formId: 0 }))
})

test('schema rejects an empty apiId', () => {
  assert.throws(() => schema.parse({ ...valid, apiId: '' }))
})

test('schema rejects an empty apiEnvironment', () => {
  assert.throws(() => schema.parse({ ...valid, apiEnvironment: '' }))
})

test('schema rejects an empty apiEnvironmentRoute', () => {
  assert.throws(() => schema.parse({ ...valid, apiEnvironmentRoute: '' }))
})
