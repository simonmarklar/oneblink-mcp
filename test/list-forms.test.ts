import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listFormsInputSchema, ALLOWED_FIELDS } from '../src/workflows/list-forms.ts'

test('rejects when neither scope id is provided', () => {
  const r = listFormsInputSchema.safeParse({})
  assert.equal(r.success, false)
})

test('accepts workspaceId alone', () => {
  const r = listFormsInputSchema.safeParse({ workspaceId: 1 })
  assert.equal(r.success, true)
})

test('accepts formsAppEnvironmentId alone', () => {
  const r = listFormsInputSchema.safeParse({ formsAppEnvironmentId: 2 })
  assert.equal(r.success, true)
})

test('applies defaults for mode/limit/offset', () => {
  const r = listFormsInputSchema.safeParse({ workspaceId: 1 })
  assert.equal(r.success, true)
  if (r.success) {
    assert.equal(r.data.mode, 'page')
    assert.equal(r.data.limit, 50)
    assert.equal(r.data.offset, 0)
  }
})

test('rejects limit over the 200 cap', () => {
  const r = listFormsInputSchema.safeParse({ workspaceId: 1, limit: 500 })
  assert.equal(r.success, false)
})

test('rejects a non-positive id', () => {
  const r = listFormsInputSchema.safeParse({ workspaceId: 0 })
  assert.equal(r.success, false)
})

test('rejects an unknown field name', () => {
  const r = listFormsInputSchema.safeParse({ workspaceId: 1, fields: ['notAField'] })
  assert.equal(r.success, false)
})

test('accepts a known field name', () => {
  const r = listFormsInputSchema.safeParse({ workspaceId: 1, fields: ['name', 'elements'] })
  assert.equal(r.success, true)
})

test('ALLOWED_FIELDS includes the default projection keys', () => {
  for (const k of ['id', 'name', 'formsAppEnvironmentId', 'workspaceId', 'isAuthenticated']) {
    assert.ok(ALLOWED_FIELDS.includes(k as (typeof ALLOWED_FIELDS)[number]))
  }
})
