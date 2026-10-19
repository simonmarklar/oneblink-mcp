/**
 * CSV -> FormElement[] compiler (spec D1, D3, D4, D7).
 *
 * Pure, no network. Parses a header-driven CSV (RFC-4180 subset: quoted fields,
 * doubled "" escapes, CRLF/LF) into element rows, resolves element types
 * case-insensitively against the SDK-derived set, parses the options cell,
 * coerces prop:* columns, and assembles the parent tree. Errors are COLLECTED
 * with row/column context (D7); the compiler never throws on bad input.
 *
 * The output tree is NOT yet id/name-backfilled or structurally validated —
 * that is the shared normalizer's job (form-normalize.ts), which both input
 * modes run through.
 */
import {
  FORM_ELEMENT_TYPE_META,
  FORM_ELEMENT_TYPES,
  type GeneratedFormElementType,
} from './generated/form-element-types.js'
import { closestType, type FormValidationError, type MutableElement } from './form-normalize.js'

const CORE_COLUMNS = new Set(['label', 'type', 'parent', 'required', 'options'])

export interface CsvCompileResult {
  elements: MutableElement[]
  errors: FormValidationError[]
}

interface Row {
  /** 1-based CSV line number (header is row 1, first data row is 2). */
  rowNum: number
  cells: Record<string, string>
}

/** Parse CSV text into header + rows. Minimal RFC-4180 subset. */
export function parseCsv(text: string): { header: string[]; rows: Row[]; errors: FormValidationError[] } {
  const errors: FormValidationError[] = []
  const records = tokenize(text)
  if (records.length === 0) {
    errors.push({ error: 'CSV is empty — no header row found.', fixHint: 'Provide a header row with at least "label" and "type".' })
    return { header: [], rows: [], errors }
  }
  const header = (records[0] as string[]).map((h) => h.trim())
  const rows: Row[] = []
  for (let i = 1; i < records.length; i += 1) {
    const cols = records[i] as string[]
    // skip wholly-empty lines
    if (cols.every((c) => c.trim() === '')) continue
    const cells: Record<string, string> = {}
    header.forEach((h, idx) => {
      cells[h] = (cols[idx] ?? '').trim()
    })
    rows.push({ rowNum: i + 1, cells })
  }
  return { header, rows, errors }
}

/** RFC-4180-subset tokenizer: returns array of records, each an array of fields. */
function tokenize(text: string): string[][] {
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  let i = 0
  const n = text.length
  const pushField = (): void => {
    record.push(field)
    field = ''
  }
  const pushRecord = (): void => {
    pushField()
    records.push(record)
    record = []
  }
  while (i < n) {
    const ch = text[i] as string
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (ch === ',') {
      pushField()
      i += 1
      continue
    }
    if (ch === '\r') {
      // handle CRLF and lone CR
      if (text[i + 1] === '\n') i += 1
      pushRecord()
      i += 1
      continue
    }
    if (ch === '\n') {
      pushRecord()
      i += 1
      continue
    }
    field += ch
    i += 1
  }
  // trailing field/record (file not ending in newline)
  if (field.length > 0 || record.length > 0) pushRecord()
  return records
}

/** Case-insensitive match of a human type string to the SDK type set. */
function resolveType(input: string): GeneratedFormElementType | undefined {
  const lower = input.trim().toLowerCase()
  return FORM_ELEMENT_TYPES.find((t) => t.toLowerCase() === lower)
}

/** Parse the options cell: `|`- or `,`-separated tokens, each `label:value` or bare `label`. */
export function parseOptions(cell: string): Array<{ label: string; value: string }> {
  return splitTopLevel(cell)
    .map((tok) => tok.trim())
    .filter((tok) => tok.length > 0)
    .map((tok) => {
      const idx = tok.indexOf(':')
      if (idx === -1) return { label: tok, value: tok }
      const label = tok.slice(0, idx).trim()
      const value = tok.slice(idx + 1).trim()
      return { label, value: value.length > 0 ? value : label }
    })
}

/**
 * Split the options cell into tokens. Accepts EITHER `|` or `,` as the token
 * separator. `|` is the preferred delimiter because the options cell is a single
 * CSV field: a `,` separator forces the whole cell to be CSV-quoted
 * ("NSW:nsw, VIC:vic") whereas `|` needs no quoting
 * (NSW:nsw|VIC:vic). When any `|` is present the cell is split on `|` only, so a
 * label/value may itself contain a comma; otherwise it falls back to `,`.
 */
export function splitTopLevel(s: string): string[] {
  return s.includes('|') ? s.split('|') : s.split(',')
}

/** Coerce a prop:* string value to boolean / number / JSON / string. */
function coerceProp(raw: string): unknown {
  const v = raw.trim()
  if (v === '') return undefined
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
    try {
      return JSON.parse(v) // A03: JSON.parse only, never eval
    } catch {
      return v // leave as string; SDK will validate
    }
  }
  return v
}

/**
 * Compile CSV text into an element tree. Does not backfill ids/names or run
 * structural validation (the normalizer does). Collects all errors.
 */
export function compileCsv(text: string): CsvCompileResult {
  const errors: FormValidationError[] = []
  const { header, rows, errors: parseErrors } = parseCsv(text)
  errors.push(...parseErrors)
  if (header.length === 0) return { elements: [], errors }

  if (!header.includes('label')) {
    errors.push({ row: 1, column: 'label', error: 'CSV header is missing required column "label".', fixHint: 'Add a "label" column.' })
  }
  if (!header.includes('type')) {
    errors.push({ row: 1, column: 'type', error: 'CSV header is missing required column "type".', fixHint: 'Add a "type" column.' })
  }
  if (errors.some((e) => e.row === 1)) return { elements: [], errors }

  // Build element records first (flat), tracking label -> record for parent links.
  interface Built {
    rowNum: number
    label: string
    parent: string
    el: MutableElement
    isContainer: boolean
  }
  const built: Built[] = []
  const byLabel = new Map<string, Built[]>()

  for (const row of rows) {
    const label = row.cells['label'] ?? ''
    const typeRaw = row.cells['type'] ?? ''
    if (label === '') {
      errors.push({ row: row.rowNum, column: 'label', error: 'Row has an empty "label".', fixHint: 'Give every row a label.' })
    }
    const resolved = resolveType(typeRaw)
    if (!resolved) {
      errors.push({
        row: row.rowNum,
        column: 'type',
        value: typeRaw,
        error: `Unknown element type '${typeRaw}'.`,
        suggestion: closestType(typeRaw),
        allowedTypes: FORM_ELEMENT_TYPES,
        fixHint: 'Set "type" to one of allowedTypes (case-insensitive).',
      })
      continue
    }
    const meta = FORM_ELEMENT_TYPE_META[resolved]
    const el: MutableElement = { type: resolved, label }

    // required
    const reqRaw = (row.cells['required'] ?? '').toLowerCase()
    if (reqRaw === 'true') el['required'] = true
    else if (reqRaw === 'false') el['required'] = false
    else if (reqRaw !== '') {
      errors.push({ row: row.rowNum, column: 'required', value: reqRaw, error: `"required" must be true/false, got '${reqRaw}'.`, suggestion: 'true', fixHint: 'Use true or false, or leave blank.' })
    }

    // options
    const optCell = row.cells['options'] ?? ''
    if (optCell !== '') {
      if (!meta.options) {
        errors.push({ row: row.rowNum, column: 'options', value: optCell, error: `Element type '${resolved}' does not accept options.`, fixHint: 'Remove the options cell, or change type to an options type (select, radio, checkboxes, autocomplete, compliance).' })
      } else {
        const opts = parseOptions(optCell)
        if (opts.length === 0) {
          errors.push({ row: row.rowNum, column: 'options', value: optCell, error: 'options cell is non-empty but produced no valid options.', fixHint: 'Use "Label:value|Label2:value2" (pipe-separated) or bare "Label".' })
        } else {
          el['options'] = opts // id assigned by normalizer; optionsType set below
          el['optionsType'] = 'CUSTOM'
        }
      }
    }

    // prop:* pass-through
    for (const col of header) {
      if (!col.startsWith('prop:')) continue
      const propName = col.slice('prop:'.length)
      if (propName === '') continue
      const coerced = coerceProp(row.cells[col] ?? '')
      if (coerced !== undefined) el[propName] = coerced
    }

    // unknown non-core, non-prop columns are a soft error (likely a typo).
    for (const col of header) {
      if (CORE_COLUMNS.has(col) || col.startsWith('prop:') || col === '') continue
      if ((row.cells[col] ?? '') !== '') {
        errors.push({ row: row.rowNum, column: col, value: row.cells[col], error: `Unknown column '${col}'. Non-core columns must be prefixed 'prop:' to pass through to the SDK.`, suggestion: `prop:${col}`, fixHint: `Rename the column to 'prop:${col}' if it is an SDK element property.` })
      }
    }

    const b: Built = { rowNum: row.rowNum, label, parent: row.cells['parent'] ?? '', el, isContainer: meta.container }
    built.push(b)
    const list = byLabel.get(label) ?? []
    list.push(b)
    byLabel.set(label, list)
  }

  // Assemble the tree from parent links (D4).
  const roots: MutableElement[] = []
  for (const b of built) {
    if (b.parent === '') {
      roots.push(b.el)
      continue
    }
    const parents = byLabel.get(b.parent) ?? []
    if (parents.length === 0) {
      errors.push({ row: b.rowNum, column: 'parent', value: b.parent, error: `parent '${b.parent}' does not match any row's label.`, fixHint: 'Set parent to the exact label of a container row, or leave blank for the form root.' })
      continue
    }
    if (parents.length > 1) {
      errors.push({ row: b.rowNum, column: 'parent', value: b.parent, error: `parent '${b.parent}' is ambiguous — ${parents.length} rows share that label.`, fixHint: 'Make container labels unique.' })
      continue
    }
    const parent = parents[0] as Built
    if (!parent.isContainer) {
      errors.push({ row: b.rowNum, column: 'parent', value: b.parent, error: `parent '${b.parent}' is a '${parent.el.type}', which cannot contain children.`, fixHint: 'Point parent at a container row (section, page, repeatableSet, form).' })
      continue
    }
    if (!Array.isArray(parent.el.elements)) parent.el.elements = []
    parent.el.elements.push(b.el)
  }

  // Cycle detection (a row's parent chain must terminate at a root).
  detectCycles(built, byLabel, errors)

  return { elements: roots, errors }
}

function detectCycles(
  built: Array<{ rowNum: number; label: string; parent: string }>,
  byLabel: Map<string, Array<{ label: string; parent: string }>>,
  errors: FormValidationError[],
): void {
  for (const b of built) {
    const seen = new Set<string>([b.label])
    let currentParent = b.parent
    let guard = 0
    while (currentParent !== '' && guard < 10000) {
      if (seen.has(currentParent)) {
        errors.push({ row: b.rowNum, column: 'parent', value: b.parent, error: `parent chain for '${b.label}' forms a cycle via '${currentParent}'.`, fixHint: 'Break the cycle so every element eventually reaches the form root.' })
        break
      }
      seen.add(currentParent)
      const parents = byLabel.get(currentParent)
      if (!parents || parents.length !== 1) break
      currentParent = (parents[0] as { parent: string }).parent
      guard += 1
    }
  }
}
