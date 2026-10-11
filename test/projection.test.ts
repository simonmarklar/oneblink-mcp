import { test } from 'node:test'
import assert from 'node:assert/strict'
import { project, resolveFields } from '../src/lib/projection.ts'

test('project: scalar returns value', () => {
  const out = project({ id: 'f1', name: 'Form', isAuthenticated: true, n: 5 }, [
    'id',
    'name',
    'isAuthenticated',
    'n',
  ])
  assert.deepEqual(out, { id: 'f1', name: 'Form', isAuthenticated: true, n: 5 })
})

test('project: array returns element count', () => {
  const out = project({ elements: [1, 2, 3], tags: [] }, ['elements', 'tags'])
  assert.deepEqual(out, { elements: 3, tags: 0 })
})

test('project: plain object returns [Object]', () => {
  const out = project({ meta: { a: 1 } }, ['meta'])
  assert.equal(out.meta, '[Object]')
})

test('project: typed object returns its constructor name', () => {
  class PostSubmissionAction {}
  const out = project({ action: new PostSubmissionAction() }, ['action'])
  assert.equal(out.action, 'PostSubmissionAction')
})

test('project: missing/null field returns null', () => {
  const out = project({ id: 'f1' }, ['id', 'description'])
  assert.deepEqual(out, { id: 'f1', description: null })
})

test('resolveFields: falls back to defaults when none requested', () => {
  assert.deepEqual(resolveFields(undefined, ['id', 'name']), ['id', 'name'])
  assert.deepEqual(resolveFields([], ['id', 'name']), ['id', 'name'])
  assert.deepEqual(resolveFields(['name'], ['id', 'name']), ['name'])
})
