import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileYaml } from '../src/lib/form-elements-yaml.ts'
import { normalizeElements } from '../src/lib/form-normalize.ts'

/**
 * YAML input-mode suite — mirrors test/form-elements-csv.test.ts case-for-case.
 * Each scenario is the YAML equivalent of a CSV case and asserts the SAME
 * normalized output (both modes converge on the shared normalizer).
 */

/** Compile + normalize in one step (how the tool uses them). */
function build(yaml: string, isMultiPage?: boolean) {
  const compiled = compileYaml(yaml)
  if (compiled.errors.length > 0) return { errors: compiled.errors, elements: [], isMultiPage: false }
  return normalizeElements(compiled.elements, isMultiPage)
}

test('compileYaml accepts a bare top-level list and an elements: mapping', () => {
  const bare = compileYaml('- label: Full Name\n  type: text\n')
  assert.equal(bare.errors.length, 0)
  assert.equal(bare.elements.length, 1)
  assert.equal(bare.elements[0]?.label, 'Full Name')

  const mapped = compileYaml('elements:\n  - label: Full Name\n    type: text\n')
  assert.equal(mapped.errors.length, 0)
  assert.equal(mapped.elements.length, 1)
  assert.equal(mapped.elements[0]?.label, 'Full Name')
})

test('simple flat form compiles with derived snake_case names', () => {
  const res = build(
    'elements:\n' +
      '  - label: Full Name\n' +
      '    type: text\n' +
      '    required: true\n' +
      '  - label: Email Address\n' +
      '    type: email\n' +
      '    required: false\n',
  )
  assert.equal(res.errors.length, 0)
  assert.equal(res.elements.length, 2)
  assert.equal(res.elements[0]?.name, 'full_name')
  assert.equal(res.elements[0]?.required, true)
  assert.equal(res.elements[1]?.name, 'email_address')
  assert.ok(typeof res.elements[0]?.id === 'string')
  assert.equal(res.isMultiPage, false)
})

test('type matching is case-insensitive', () => {
  const res = build('elements:\n  - label: State\n    type: SELECT\n  - label: Colour\n    type: Radio\n')
  assert.equal(res.errors.length, 0)
  assert.equal(res.elements[0]?.type, 'select')
  assert.equal(res.elements[1]?.type, 'radio')
})

test('duplicate labels get collision-suffixed names', () => {
  const res = build('elements:\n  - label: Name\n    type: text\n  - label: Name\n    type: text\n')
  assert.equal(res.errors.length, 0)
  assert.equal(res.elements[0]?.name, 'name')
  assert.equal(res.elements[1]?.name, 'name_2')
})

test('unknown type fails fast with suggestion + allowedTypes', () => {
  const compiled = compileYaml('elements:\n  - label: Foo\n    type: txt\n')
  assert.equal(compiled.errors.length, 1)
  const e = compiled.errors[0]!
  assert.ok((e.path ?? '').endsWith('.type'))
  assert.equal(e.value, 'txt')
  assert.equal(e.suggestion, 'text')
  assert.ok(e.allowedTypes && e.allowedTypes.includes('text'))
  assert.ok(e.fixHint)
})

test('options list parses label:value and bare label strings', () => {
  const res = build(
    'elements:\n' +
      '  - label: State\n' +
      '    type: select\n' +
      '    options:\n' +
      '      - NSW:nsw\n' +
      '      - VIC:vic\n' +
      '      - QLD\n',
  )
  assert.equal(res.errors.length, 0)
  const opts = res.elements[0]?.options as Array<{ label: string; value: string; id: string }>
  assert.equal(opts.length, 3)
  assert.deepEqual({ label: opts[0]!.label, value: opts[0]!.value }, { label: 'NSW', value: 'nsw' })
  assert.deepEqual({ label: opts[2]!.label, value: opts[2]!.value }, { label: 'QLD', value: 'QLD' })
  assert.ok(opts.every((o) => typeof o.id === 'string'))
  assert.equal(res.elements[0]?.optionsType, 'CUSTOM')
})

test('options list parses label:value strings (same output as CSV pipe form)', () => {
  // YAML equivalent of the CSV pipe-separated case (the AU-state demo).
  const res = build(
    'elements:\n' +
      '  - label: State\n' +
      '    type: select\n' +
      '    options:\n' +
      '      - New South Wales:NSW\n' +
      '      - Victoria:VIC\n' +
      '      - Queensland:QLD\n',
  )
  assert.equal(res.errors.length, 0)
  const opts = res.elements[0]?.options as Array<{ label: string; value: string; id: string }>
  assert.equal(opts.length, 3)
  assert.deepEqual({ label: opts[0]!.label, value: opts[0]!.value }, { label: 'New South Wales', value: 'NSW' })
  assert.deepEqual({ label: opts[2]!.label, value: opts[2]!.value }, { label: 'Queensland', value: 'QLD' })
  assert.equal(res.elements[0]?.optionsType, 'CUSTOM')
})

test('options list parses BARE labels and { label, value } maps (value defaults to label)', () => {
  // Mixed forms: bare label, label:value string, and a {label,value} map.
  const res = build(
    'elements:\n' +
      '  - label: Colour\n' +
      '    type: radio\n' +
      '    options:\n' +
      '      - Red\n' +
      '      - Green\n' +
      '      - label: Blue\n' +
      '        value: blue\n',
  )
  assert.equal(res.errors.length, 0)
  const opts = res.elements[0]?.options as Array<{ label: string; value: string; id: string }>
  assert.equal(opts.length, 3)
  assert.deepEqual({ label: opts[0]!.label, value: opts[0]!.value }, { label: 'Red', value: 'Red' })
  assert.deepEqual({ label: opts[1]!.label, value: opts[1]!.value }, { label: 'Green', value: 'Green' })
  assert.deepEqual({ label: opts[2]!.label, value: opts[2]!.value }, { label: 'Blue', value: 'blue' })
  assert.ok(opts.every((o) => typeof o.id === 'string'))
  assert.equal(res.elements[0]?.optionsType, 'CUSTOM')
})

test('options on a non-options type fails fast', () => {
  const compiled = compileYaml('elements:\n  - label: Name\n    type: text\n    options:\n      - a\n      - b\n')
  assert.equal(compiled.errors.length, 1)
  assert.ok((compiled.errors[0]?.path ?? '').endsWith('.options'))
})

test('nesting via children builds a tree', () => {
  const yaml =
    'elements:\n' +
    '  - label: Details\n' +
    '    type: section\n' +
    '    children:\n' +
    '      - label: First Name\n' +
    '        type: text\n' +
    '      - label: Last Name\n' +
    '        type: text\n'
  const res = build(yaml)
  assert.equal(res.errors.length, 0)
  assert.equal(res.elements.length, 1)
  assert.equal(res.elements[0]?.type, 'section')
  assert.equal(res.elements[0]?.name, undefined) // section has no name
  assert.equal(res.elements[0]?.elements?.length, 2)
  assert.equal(res.elements[0]?.elements?.[0]?.name, 'first_name')
})

test('children on a leaf type fails fast', () => {
  // YAML's natural-nesting analogue of the CSV "parent points at a leaf" case.
  const compiled = compileYaml(
    'elements:\n  - label: Holder\n    type: text\n    children:\n      - label: Child\n        type: text\n',
  )
  assert.equal(compiled.errors.length, 1)
  assert.match(compiled.errors[0]?.error ?? '', /cannot contain children/)
})

test('multipage inferred when a page element exists; all roots must be pages', () => {
  const yaml =
    'elements:\n' +
    '  - label: Page 1\n' +
    '    type: page\n' +
    '    children:\n' +
    '      - label: Name\n' +
    '        type: text\n'
  const res = build(yaml)
  assert.equal(res.errors.length, 0)
  assert.equal(res.isMultiPage, true)
})

test('page at root with a non-page sibling fails (multipage rule)', () => {
  const yaml =
    'elements:\n' +
    '  - label: Page 1\n' +
    '    type: page\n' +
    '    children:\n' +
    '      - label: Inner\n' +
    '        type: text\n' +
    '  - label: Loose\n' +
    '    type: text\n'
  const res = build(yaml)
  assert.ok(res.errors.some((e) => /every root element must be a PageElement/.test(e.error)))
})

test('non-reserved keys pass through as SDK props (typed)', () => {
  // YAML analogue of the CSV prop:* columns — keys are already typed by YAML.
  const res = build(
    'elements:\n' +
      '  - label: Notes\n' +
      '    type: textarea\n' +
      '    minLength: 5\n' +
      '    isSlider: false\n',
  )
  assert.equal(res.errors.length, 0)
  assert.equal(res.elements[0]?.minLength, 5)
  assert.equal(res.elements[0]?.isSlider, false)
})

test('all errors are collected, not just the first', () => {
  const compiled = compileYaml('elements:\n  - label: A\n    type: txt\n  - label: B\n    type: notatype\n')
  assert.equal(compiled.errors.length, 2)
})

test('empty / missing elements list fails fast', () => {
  const empty = compileYaml('')
  assert.ok(empty.errors.length >= 1)
  const noList = compileYaml('name: Just a form\n')
  assert.ok(noList.errors.some((e) => e.path === 'elements'))
})

test('custom YAML tags are rejected (A03 safe parse)', () => {
  // A !!js/function-style custom tag must never be resolved; the parser reports
  // it (as warning/error) and the compiler treats it as fatal.
  const compiled = compileYaml('elements:\n  - label: Evil\n    type: !!custom text\n')
  assert.ok(compiled.errors.length >= 1)
})
