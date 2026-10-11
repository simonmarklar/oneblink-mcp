import { test } from 'node:test'
import assert from 'node:assert/strict'
import { labelToName, normalizeElements, closestType, type MutableElement } from '../src/lib/form-normalize.ts'

test('labelToName snake_cases and strips punctuation', () => {
  assert.equal(labelToName('Full Name!'), 'full_name')
  assert.equal(labelToName('  Email   Address  '), 'email_address')
  assert.equal(labelToName('ABN / ACN #'), 'abn_acn')
  assert.equal(labelToName('***'), 'element') // falls back when empty
})

test('definition mode backfills missing ids and names', () => {
  const input: MutableElement[] = [
    { type: 'text', label: 'Given Name' },
    { type: 'email', label: 'Email', name: 'custom_email' },
  ]
  const res = normalizeElements(input, undefined)
  assert.equal(res.errors.length, 0)
  assert.equal(res.elements[0]?.name, 'given_name')
  assert.ok(typeof res.elements[0]?.id === 'string')
  assert.equal(res.elements[1]?.name, 'custom_email') // respected
})

test('definition mode does not mutate the caller input', () => {
  const input: MutableElement[] = [{ type: 'text', label: 'A' }]
  normalizeElements(input, undefined)
  assert.equal(input[0]?.id, undefined)
  assert.equal(input[0]?.name, undefined)
})

test('invalid explicit name is rejected with a snake_case suggestion', () => {
  const res = normalizeElements([{ type: 'text', label: 'X', name: 'bad name!' }], undefined)
  assert.equal(res.errors.length, 1)
  assert.equal(res.errors[0]?.suggestion, 'bad_name')
})

test('page/section never receive a name', () => {
  const res = normalizeElements(
    [{ type: 'page', label: 'P1', elements: [{ type: 'section', label: 'S', elements: [{ type: 'text', label: 'F' }] }] }],
    true,
  )
  assert.equal(res.errors.length, 0)
  assert.equal(res.elements[0]?.name, undefined)
  assert.equal(res.elements[0]?.elements?.[0]?.name, undefined)
  assert.equal(res.elements[0]?.elements?.[0]?.elements?.[0]?.name, 'f')
})

test('nested page is rejected', () => {
  const res = normalizeElements(
    [{ type: 'page', label: 'P1', elements: [{ type: 'page', label: 'P2', elements: [] }] }],
    true,
  )
  assert.ok(res.errors.some((e) => /cannot be nested/.test(e.error)))
})

test('isMultiPage false but pages present is rejected', () => {
  const res = normalizeElements([{ type: 'page', label: 'P1', elements: [] }], false)
  assert.ok(res.errors.some((e) => /isMultiPage is false but the form contains PageElement/.test(e.error)))
})

test('leaf type carrying children is rejected', () => {
  const res = normalizeElements([{ type: 'text', label: 'X', elements: [{ type: 'text', label: 'Y' }] }], undefined)
  assert.ok(res.errors.some((e) => /cannot contain child elements/.test(e.error)))
})

test('unknown type in definition mode is rejected with allowedTypes', () => {
  const res = normalizeElements([{ type: 'notreal', label: 'X' }], undefined)
  assert.equal(res.errors.length, 1)
  assert.ok(res.errors[0]?.allowedTypes)
  assert.equal(res.errors[0]?.path, 'elements[0].type')
})

test('duplicate names across the tree get suffixed', () => {
  const res = normalizeElements(
    [
      { type: 'text', label: 'Name' },
      { type: 'section', label: 'Sec', elements: [{ type: 'text', label: 'Name' }] },
    ],
    undefined,
  )
  assert.equal(res.errors.length, 0)
  const names = [res.elements[0]?.name, res.elements[1]?.elements?.[0]?.name]
  assert.deepEqual(new Set(names).size, 2) // unique
})

test('option ids are backfilled in definition mode', () => {
  const res = normalizeElements(
    [{ type: 'select', label: 'S', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }],
    undefined,
  )
  assert.equal(res.errors.length, 0)
  const opts = res.elements[0]?.options as Array<{ id: string }>
  assert.ok(opts.every((o) => typeof o.id === 'string'))
  assert.equal(res.elements[0]?.optionsType, 'CUSTOM')
})

test('closestType suggests near matches and declines far ones', () => {
  assert.equal(closestType('txt'), 'text')
  assert.equal(closestType('selekt'), 'select')
  assert.equal(closestType('xyzqwlongnonsense'), undefined)
})
