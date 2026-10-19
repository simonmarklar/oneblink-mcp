import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectResourceRefs,
  validateResourceRefs,
  idsInEnvironment,
  type ResourceRef,
} from '../src/lib/form-resource-refs.ts'
import type { MutableElement } from '../src/lib/form-normalize.ts'
import { createFormInputSchema as schema } from '../src/workflows/create-form.ts'

// ------------------------------------------------------------------------
// Element builders. These mirror a normalized element tree (post-normalize).
// ------------------------------------------------------------------------

const dynamicSelect = (id: unknown): MutableElement => ({
  type: 'select',
  label: 'Pick one',
  optionsType: 'DYNAMIC',
  dynamicOptionSetId: id,
})

const dataLookupText = (id: unknown): MutableElement => ({
  type: 'text',
  label: 'Looked up',
  isDataLookup: true,
  dataLookupId: id,
})

const elementLookupText = (id: unknown): MutableElement => ({
  type: 'text',
  label: 'El lookup',
  isElementLookup: true,
  elementLookupId: id,
})

/** A search row as the SDK returns it, scoped to one or more environments. */
const row = (id: number, envIds: number[]): Record<string, unknown> => ({
  id,
  name: `res-${id}`,
  environments: envIds.map((formsAppEnvironmentId) => ({ formsAppEnvironmentId })),
})

const ENV = 457

// ========================================================================
// collectResourceRefs — which props become refs, and when
// ========================================================================

test('collects a dynamicOptionSetId only when optionsType is DYNAMIC', () => {
  const refs = collectResourceRefs([dynamicSelect(10)])
  assert.deepEqual(refs, [
    { kind: 'list', value: 10, path: 'elements[0].dynamicOptionSetId', prop: 'dynamicOptionSetId' } as ResourceRef,
  ])
})

test('does NOT collect dynamicOptionSetId when optionsType is CUSTOM', () => {
  const el: MutableElement = { type: 'select', label: 'x', optionsType: 'CUSTOM', dynamicOptionSetId: 10 }
  assert.equal(collectResourceRefs([el]).length, 0)
})

test('collects dataLookupId only when isDataLookup is true', () => {
  assert.equal(collectResourceRefs([dataLookupText(5)]).length, 1)
  const off: MutableElement = { type: 'text', label: 'x', isDataLookup: false, dataLookupId: 5 }
  assert.equal(collectResourceRefs([off]).length, 0)
})

test('collects elementLookupId only when isElementLookup is true', () => {
  assert.equal(collectResourceRefs([elementLookupText(7)]).length, 1)
  const off: MutableElement = { type: 'text', label: 'x', isElementLookup: false, elementLookupId: 7 }
  assert.equal(collectResourceRefs([off]).length, 0)
})

test('tolerates a numeric-string id (CSV prop:* coercion)', () => {
  const refs = collectResourceRefs([dynamicSelect('10')])
  assert.equal(refs.length, 1)
  assert.equal(refs[0]!.value, 10)
})

// ========================================================================
// nested walking — refs inside containers are found with correct paths
// ========================================================================

test('walks nested elements and records the full path', () => {
  const tree: MutableElement[] = [
    {
      type: 'page',
      elements: [
        { type: 'section', label: 'S', elements: [dynamicSelect(10), dataLookupText(20)] },
      ],
    },
    elementLookupText(30),
  ]
  const refs = collectResourceRefs(tree)
  assert.deepEqual(
    refs.map((r) => ({ kind: r.kind, value: r.value, path: r.path })),
    [
      { kind: 'list', value: 10, path: 'elements[0].elements[0].elements[0].dynamicOptionSetId' },
      { kind: 'lookup', value: 20, path: 'elements[0].elements[0].elements[1].dataLookupId' },
      { kind: 'lookup', value: 30, path: 'elements[1].elementLookupId' },
    ],
  )
})

// ========================================================================
// validateResourceRefs — valid passes, missing reported, all collected
// ========================================================================

test('valid ref passes when the id exists in the environment', () => {
  const refs = collectResourceRefs([dynamicSelect(10)])
  const errs = validateResourceRefs(refs, { listIds: new Set([10]), lookupIds: new Set() }, ENV)
  assert.equal(errs.length, 0)
})

test('missing list ref yields a structured path error', () => {
  const refs = collectResourceRefs([dynamicSelect(99)])
  const errs = validateResourceRefs(refs, { listIds: new Set([10]), lookupIds: new Set() }, ENV)
  assert.equal(errs.length, 1)
  assert.equal(errs[0]!.path, 'elements[0].dynamicOptionSetId')
  assert.equal(errs[0]!.value, 99)
  assert.match(errs[0]!.error, /Element list 99 does not exist in environment 457/)
  assert.match(errs[0]!.fixHint!, /create_element_list/)
})

test('missing lookup ref names the lookup fixHint', () => {
  const refs = collectResourceRefs([dataLookupText(88)])
  const errs = validateResourceRefs(refs, { listIds: new Set(), lookupIds: new Set([1]) }, ENV)
  assert.equal(errs.length, 1)
  assert.match(errs[0]!.error, /Element lookup 88 does not exist in environment 457/)
  assert.match(errs[0]!.fixHint!, /create_element_lookup/)
})

test('multiple missing refs are ALL reported (never stops at first)', () => {
  const refs = collectResourceRefs([dynamicSelect(1), dataLookupText(2), elementLookupText(3)])
  const errs = validateResourceRefs(refs, { listIds: new Set(), lookupIds: new Set() }, ENV)
  assert.equal(errs.length, 3)
  assert.deepEqual(
    errs.map((e) => e.path),
    ['elements[0].dynamicOptionSetId', 'elements[1].dataLookupId', 'elements[2].elementLookupId'],
  )
})

test('a mix of present and missing reports only the misses', () => {
  const refs = collectResourceRefs([dynamicSelect(10), dynamicSelect(99)])
  const errs = validateResourceRefs(refs, { listIds: new Set([10]), lookupIds: new Set() }, ENV)
  assert.equal(errs.length, 1)
  assert.equal(errs[0]!.value, 99)
})

// ========================================================================
// idsInEnvironment — environment-scoped membership from org-wide rows
// ========================================================================

test('idsInEnvironment keeps only rows scoped to the target environment', () => {
  const rows = [row(10, [457]), row(11, [999]), row(12, [457, 999])]
  const ids = idsInEnvironment(rows, ENV)
  assert.deepEqual([...ids].sort((a, b) => a - b), [10, 12])
})

test('idsInEnvironment ignores rows with no environments array', () => {
  const ids = idsInEnvironment([{ id: 10 }, row(11, [457])], ENV)
  assert.deepEqual([...ids], [11])
})

// ========================================================================
// end-to-end shape: a valid env id set makes a nested tree clean
// ========================================================================

test('nested refs resolved against an environment-filtered id set pass', () => {
  const tree: MutableElement[] = [
    { type: 'section', label: 'S', elements: [dynamicSelect(10), dataLookupText(20)] },
  ]
  const listIds = idsInEnvironment([row(10, [ENV])], ENV)
  const lookupIds = idsInEnvironment([row(20, [ENV])], ENV)
  const errs = validateResourceRefs(collectResourceRefs(tree), { listIds, lookupIds }, ENV)
  assert.equal(errs.length, 0)
})

// ========================================================================
// schema: validateResourceRefs input default
// ========================================================================

test('validateResourceRefs defaults to true', () => {
  const v = schema.parse({ name: 'F', formsAppEnvironmentId: ENV, elements: [{ type: 'text', label: 'A' }] })
  assert.equal(v.validateResourceRefs, true)
})

test('validateResourceRefs:false is accepted (skips the checks)', () => {
  const v = schema.parse({
    name: 'F',
    formsAppEnvironmentId: ENV,
    elements: [{ type: 'text', label: 'A' }],
    validateResourceRefs: false,
  })
  assert.equal(v.validateResourceRefs, false)
})
