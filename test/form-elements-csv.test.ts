import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileCsv, parseCsv } from '../src/lib/form-elements-csv.ts'
import { normalizeElements } from '../src/lib/form-normalize.ts'

/** Compile + normalize in one step (how the tool uses them). */
function build(csv: string, isMultiPage?: boolean) {
  const compiled = compileCsv(csv)
  if (compiled.errors.length > 0) return { errors: compiled.errors, elements: [], isMultiPage: false }
  return normalizeElements(compiled.elements, isMultiPage)
}

test('parseCsv handles quoted fields, doubled quotes, and CRLF', () => {
  const { header, rows } = parseCsv('label,type\r\n"Full, Name",text\r\n"He said ""hi""",textarea\n')
  assert.deepEqual(header, ['label', 'type'])
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.cells['label'], 'Full, Name')
  assert.equal(rows[1]?.cells['label'], 'He said "hi"')
})

test('simple flat form compiles with derived snake_case names', () => {
  const res = build('label,type,required\nFull Name,text,true\nEmail Address,email,false\n')
  assert.equal(res.errors.length, 0)
  assert.equal(res.elements.length, 2)
  assert.equal(res.elements[0]?.name, 'full_name')
  assert.equal(res.elements[0]?.required, true)
  assert.equal(res.elements[1]?.name, 'email_address')
  assert.ok(typeof res.elements[0]?.id === 'string')
  assert.equal(res.isMultiPage, false)
})

test('type matching is case-insensitive', () => {
  const res = build('label,type\nState,SELECT\nColour,Radio\n')
  assert.equal(res.errors.length, 0)
  assert.equal(res.elements[0]?.type, 'select')
  assert.equal(res.elements[1]?.type, 'radio')
})

test('duplicate labels get collision-suffixed names', () => {
  const res = build('label,type\nName,text\nName,text\n')
  assert.equal(res.errors.length, 0)
  assert.equal(res.elements[0]?.name, 'name')
  assert.equal(res.elements[1]?.name, 'name_2')
})

test('unknown type fails fast with suggestion + allowedTypes', () => {
  const compiled = compileCsv('label,type\nFoo,txt\n')
  assert.equal(compiled.errors.length, 1)
  const e = compiled.errors[0]!
  assert.equal(e.column, 'type')
  assert.equal(e.value, 'txt')
  assert.equal(e.suggestion, 'text')
  assert.ok(e.allowedTypes && e.allowedTypes.includes('text'))
  assert.ok(e.fixHint)
})

test('options cell parses label:value and bare label tokens', () => {
  const res = build('label,type,options\nState,select,"NSW:nsw, VIC:vic, QLD"\n')
  assert.equal(res.errors.length, 0)
  const opts = res.elements[0]?.options as Array<{ label: string; value: string; id: string }>
  assert.equal(opts.length, 3)
  assert.deepEqual({ label: opts[0]!.label, value: opts[0]!.value }, { label: 'NSW', value: 'nsw' })
  assert.deepEqual({ label: opts[2]!.label, value: opts[2]!.value }, { label: 'QLD', value: 'QLD' })
  assert.ok(opts.every((o) => typeof o.id === 'string'))
  assert.equal(res.elements[0]?.optionsType, 'CUSTOM')
})

test('options cell parses PIPE-separated label:value tokens (no CSV quoting needed)', () => {
  // The documented skill syntax: pipe-separated, so the cell is a single
  // unquoted CSV field. This is the exact case the AU-state demo uses.
  const res = build(
    'label,type,options\nState,select,New South Wales:NSW|Victoria:VIC|Queensland:QLD\n',
  )
  assert.equal(res.errors.length, 0)
  const opts = res.elements[0]?.options as Array<{ label: string; value: string; id: string }>
  assert.equal(opts.length, 3)
  assert.deepEqual({ label: opts[0]!.label, value: opts[0]!.value }, { label: 'New South Wales', value: 'NSW' })
  assert.deepEqual({ label: opts[2]!.label, value: opts[2]!.value }, { label: 'Queensland', value: 'QLD' })
  assert.equal(res.elements[0]?.optionsType, 'CUSTOM')
})

test('options cell parses PIPE-separated BARE labels (value defaults to label)', () => {
  // Bare labels (no ":value") on the pipe path: each value defaults to its
  // label, and a mixed cell (bare + label:value) works too.
  const res = build('label,type,options\nColour,radio,Red|Green|Blue:blue\n')
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
  const compiled = compileCsv('label,type,options\nName,text,"a,b"\n')
  assert.equal(compiled.errors.length, 1)
  assert.equal(compiled.errors[0]?.column, 'options')
})

test('nesting via parent builds a tree', () => {
  const csv =
    'label,type,parent\n' +
    'Details,section,\n' +
    'First Name,text,Details\n' +
    'Last Name,text,Details\n'
  const res = build(csv)
  assert.equal(res.errors.length, 0)
  assert.equal(res.elements.length, 1)
  assert.equal(res.elements[0]?.type, 'section')
  assert.equal(res.elements[0]?.name, undefined) // section has no name
  assert.equal(res.elements[0]?.elements?.length, 2)
  assert.equal(res.elements[0]?.elements?.[0]?.name, 'first_name')
})

test('unknown parent label fails fast', () => {
  const compiled = compileCsv('label,type,parent\nFirst,text,Nope\n')
  assert.equal(compiled.errors.length, 1)
  assert.equal(compiled.errors[0]?.column, 'parent')
})

test('parent pointing at a leaf type fails fast', () => {
  const compiled = compileCsv('label,type,parent\nHolder,text,\nChild,text,Holder\n')
  assert.equal(compiled.errors.length, 1)
  assert.match(compiled.errors[0]?.error ?? '', /cannot contain children/)
})

test('multipage inferred when a page row exists; all roots must be pages', () => {
  const csv =
    'label,type,parent\n' +
    'Page 1,page,\n' +
    'Name,text,Page 1\n'
  const res = build(csv)
  assert.equal(res.errors.length, 0)
  assert.equal(res.isMultiPage, true)
})

test('page at root with a non-page sibling fails (multipage rule)', () => {
  const csv =
    'label,type,parent\n' +
    'Page 1,page,\n' +
    'Loose,text,\n'
  const res = build(csv)
  assert.ok(res.errors.some((e) => /every root element must be a PageElement/.test(e.error)))
})

test('prop:* columns pass through coerced', () => {
  const res = build('label,type,prop:minLength,prop:isSlider\nNotes,textarea,5,false\n')
  assert.equal(res.errors.length, 0)
  assert.equal(res.elements[0]?.minLength, 5)
  assert.equal(res.elements[0]?.isSlider, false)
})

test('unknown non-prop column is flagged with a prop: suggestion', () => {
  const compiled = compileCsv('label,type,minLength\nNotes,textarea,5\n')
  assert.equal(compiled.errors.length, 1)
  assert.equal(compiled.errors[0]?.suggestion, 'prop:minLength')
})

test('all errors are collected, not just the first', () => {
  const compiled = compileCsv('label,type\nA,txt\nB,notatype\n')
  assert.equal(compiled.errors.length, 2)
})

test('missing required header fails fast', () => {
  const compiled = compileCsv('label\nName\n')
  assert.ok(compiled.errors.some((e) => e.column === 'type'))
})
