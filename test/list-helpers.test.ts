import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listFormsAppEnvironmentsInputSchema } from '../src/workflows/list-forms-app-environments.ts'
import { ALLOWED_FIELDS } from '../src/workflows/list-forms-app-environments.ts'
import { listWorkspacesInputSchema } from '../src/workflows/list-workspaces.ts'

test('list_forms_app_environments: defaults mode/limit/offset', () => {
  const v = listFormsAppEnvironmentsInputSchema.parse({})
  assert.equal(v.mode, 'page')
  assert.equal(v.limit, 50)
  assert.equal(v.offset, 0)
})

test('list_forms_app_environments: rejects limit over the 200 cap', () => {
  assert.throws(() => listFormsAppEnvironmentsInputSchema.parse({ limit: 201 }))
})

test('list_forms_app_environments: rejects an unknown field', () => {
  assert.throws(() => listFormsAppEnvironmentsInputSchema.parse({ fields: ['bogus'] }))
})

test('list_forms_app_environments: accepts a known field + workspace filter', () => {
  const v = listFormsAppEnvironmentsInputSchema.parse({ fields: ['id', 'name'], workspaceId: 70 })
  assert.deepEqual(v.fields, ['id', 'name'])
  assert.equal(v.workspaceId, 70)
})

test('list_forms_app_environments: rejects a non-positive workspaceId', () => {
  assert.throws(() => listFormsAppEnvironmentsInputSchema.parse({ workspaceId: 0 }))
})

test('ALLOWED_FIELDS carries id, name, slug, workspaceId', () => {
  for (const f of ['id', 'name', 'slug', 'workspaceId']) {
    assert.ok((ALLOWED_FIELDS as readonly string[]).includes(f))
  }
})

test('list_workspaces: includeEnvironments defaults true', () => {
  const v = listWorkspacesInputSchema.parse({})
  assert.equal(v.includeEnvironments, true)
})

test('list_workspaces: accepts includeEnvironments=false', () => {
  const v = listWorkspacesInputSchema.parse({ includeEnvironments: false })
  assert.equal(v.includeEnvironments, false)
})
