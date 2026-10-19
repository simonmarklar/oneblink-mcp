/**
 * YAML -> FormElement[] compiler (peer input mode to the CSV compiler).
 *
 * Pure, no network. Parses a hierarchical YAML document into the SAME
 * intermediate `MutableElement[]` shape the CSV compiler produces, then hands
 * off to the SHARED normalizer (form-normalize.ts) for id/name backfill and
 * structural validation. There is NO second normalizer and NO duplicated
 * structural validation here — this file only translates YAML's natural
 * hierarchy into the intermediate tree and reports YAML-shape errors.
 *
 * YAML expresses every CSV feature:
 *   - nested elements   : a `children:` list under a container element
 *                         (YAML is hierarchical, so we prefer natural nesting
 *                         over the CSV's flat `parent` column; the normalized
 *                         output is identical to the equivalent CSV input).
 *   - option references : an `options:` list of `Label:value` / bare `Label`
 *                         strings OR `{ label, value }` maps.
 *   - pagination        : `type: page` container elements at the document root
 *                         (isMultiPage is inferred by the shared normalizer,
 *                         exactly as in CSV mode).
 *
 * Any key on an element that is NOT a reserved structural key
 * (label/type/required/options/children) is passed through verbatim to the SDK
 * element — the typed-YAML equivalent of the CSV `prop:*` columns. YAML is
 * already a typed document, so no `prop:` prefix is needed.
 *
 * Errors are COLLECTED with a dotted `path` into the document (D7); the compiler
 * never throws on bad input.
 *
 * Security (OWASP A03): parsing uses the `yaml` library's default document
 * parse, which does NOT resolve arbitrary/custom tags into executable code or
 * host objects (no `!!js/function`-style construction). We additionally reject
 * any custom tag the parser could not resolve, so only plain scalars, maps and
 * sequences reach the compiler.
 */
import { parseDocument, type Document } from 'yaml'
import {
  FORM_ELEMENT_TYPE_META,
  FORM_ELEMENT_TYPES,
  type GeneratedFormElementType,
} from './generated/form-element-types.js'
import { closestType, type FormValidationError, type MutableElement } from './form-normalize.js'

/** Structural keys the YAML compiler consumes; everything else is an SDK prop. */
const RESERVED_KEYS = new Set(['label', 'type', 'required', 'options', 'children'])

export interface YamlCompileResult {
  elements: MutableElement[]
  errors: FormValidationError[]
}

/** Case-insensitive match of a human type string to the SDK type set. */
function resolveType(input: string): GeneratedFormElementType | undefined {
  const lower = input.trim().toLowerCase()
  return FORM_ELEMENT_TYPES.find((t) => t.toLowerCase() === lower)
}

/**
 * Parse a single option entry.
 *   - string `Label:value`  -> { label, value }
 *   - string `Label`        -> { label, value: label }
 *   - map `{ label, value }` -> { label, value: value ?? label }
 * Mirrors the CSV `parseOptions` token semantics (D3) so YAML and CSV produce
 * identical option objects.
 */
function parseOptionEntry(entry: unknown): { label: string; value: string } | undefined {
  if (typeof entry === 'string') {
    const tok = entry.trim()
    if (tok.length === 0) return undefined
    const idx = tok.indexOf(':')
    if (idx === -1) return { label: tok, value: tok }
    const label = tok.slice(0, idx).trim()
    const value = tok.slice(idx + 1).trim()
    return { label, value: value.length > 0 ? value : label }
  }
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const rec = entry as Record<string, unknown>
    const label = typeof rec['label'] === 'string' ? (rec['label'] as string).trim() : ''
    if (label.length === 0) return undefined
    const rawVal = rec['value']
    const value =
      typeof rawVal === 'string' && rawVal.trim().length > 0
        ? (rawVal as string).trim()
        : typeof rawVal === 'number'
          ? String(rawVal)
          : label
    return { label, value }
  }
  return undefined
}

/**
 * Compile YAML text into an element tree. Does NOT backfill ids/names or run
 * structural validation (the shared normalizer does). Collects all errors.
 */
export function compileYaml(text: string): YamlCompileResult {
  const errors: FormValidationError[] = []

  if (typeof text !== 'string' || text.trim() === '') {
    errors.push({ error: 'YAML is empty — no document found.', fixHint: 'Provide a YAML document with an "elements" list (or a top-level list of elements).' })
    return { elements: [], errors }
  }

  let doc: Document.Parsed
  try {
    // A03: default parse resolves only core YAML tags (str/int/bool/map/seq);
    // custom/unknown tags are reported as warnings/errors below, never executed.
    doc = parseDocument(text, { prettyErrors: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'YAML parse failed'
    errors.push({ error: `YAML parse failed: ${message}`, fixHint: 'Fix the YAML syntax.' })
    return { elements: [], errors }
  }

  // Surface the parser's own structural errors/warnings (bad indentation,
  // unresolved custom tags, duplicate keys, etc.) before interpreting content.
  for (const e of doc.errors) {
    errors.push({ error: `YAML error: ${e.message}`, fixHint: 'Fix the YAML syntax.' })
  }
  for (const w of doc.warnings) {
    // Unresolved/custom tags land here — treat as fatal (A03: no custom tags).
    errors.push({ error: `YAML not allowed: ${w.message}`, fixHint: 'Remove custom YAML tags; use plain scalars, maps and lists only.' })
  }
  if (errors.length > 0) return { elements: [], errors }

  const root: unknown = doc.toJS({ maxAliasCount: 100 })
  if (root === null || root === undefined) {
    errors.push({ error: 'YAML document is empty.', fixHint: 'Provide an "elements" list (or a top-level list of elements).' })
    return { elements: [], errors }
  }

  // Accept either a top-level `elements:` list or a bare top-level list.
  let rawList: unknown
  if (Array.isArray(root)) {
    rawList = root
  } else if (root && typeof root === 'object') {
    rawList = (root as Record<string, unknown>)['elements']
    if (rawList === undefined) {
      errors.push({ path: 'elements', error: 'YAML document has no "elements" list.', fixHint: 'Add a top-level "elements:" list, or make the document a bare list of elements.' })
      return { elements: [], errors }
    }
  } else {
    errors.push({ error: 'YAML document must be a mapping with an "elements" list or a list of elements.', fixHint: 'Wrap elements under "elements:" or provide a top-level list.' })
    return { elements: [], errors }
  }

  if (!Array.isArray(rawList)) {
    errors.push({ path: 'elements', value: typeof rawList, error: '"elements" must be a list.', fixHint: 'Make "elements" a YAML list ("- label: ...").' })
    return { elements: [], errors }
  }

  const elements = compileList(rawList, 'elements', errors)
  return { elements, errors }
}

/** Compile a list of raw element nodes at a given dotted path. */
function compileList(list: unknown[], path: string, errors: FormValidationError[]): MutableElement[] {
  const out: MutableElement[] = []
  list.forEach((node, i) => {
    const el = compileNode(node, `${path}[${i}]`, errors)
    if (el) out.push(el)
  })
  return out
}

/** Compile one raw element node into a MutableElement (recursing into children). */
function compileNode(node: unknown, path: string, errors: FormValidationError[]): MutableElement | undefined {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    errors.push({ path, value: typeof node, error: 'Element must be a mapping with "label" and "type".', fixHint: 'Write each element as "- label: ...\\n  type: ...".' })
    return undefined
  }
  const rec = node as Record<string, unknown>

  const label = typeof rec['label'] === 'string' ? (rec['label'] as string) : ''
  const typeRaw = typeof rec['type'] === 'string' ? (rec['type'] as string) : ''

  if (label === '') {
    errors.push({ path: `${path}.label`, error: 'Element has an empty or missing "label".', fixHint: 'Give every element a label.' })
  }

  const resolved = resolveType(typeRaw)
  if (!resolved) {
    errors.push({
      path: `${path}.type`,
      value: typeRaw,
      error: `Unknown element type '${typeRaw}'.`,
      suggestion: closestType(typeRaw),
      allowedTypes: FORM_ELEMENT_TYPES,
      fixHint: 'Set "type" to one of allowedTypes (case-insensitive).',
    })
    return undefined
  }
  const meta = FORM_ELEMENT_TYPE_META[resolved]
  const el: MutableElement = { type: resolved, label }

  // required
  const req = rec['required']
  if (typeof req === 'boolean') {
    el['required'] = req
  } else if (req !== undefined) {
    errors.push({ path: `${path}.required`, value: req, error: `"required" must be a boolean, got '${String(req)}'.`, suggestion: 'true', fixHint: 'Use true or false, or omit.' })
  }

  // options
  const optRaw = rec['options']
  if (optRaw !== undefined) {
    if (!meta.options) {
      errors.push({ path: `${path}.options`, value: optRaw, error: `Element type '${resolved}' does not accept options.`, fixHint: 'Remove options, or change type to an options type (select, radio, checkboxes, autocomplete, compliance).' })
    } else if (!Array.isArray(optRaw)) {
      errors.push({ path: `${path}.options`, value: typeof optRaw, error: 'options must be a list.', fixHint: 'Write options as a YAML list of "Label:value" strings or { label, value } maps.' })
    } else {
      const opts = optRaw
        .map((entry) => parseOptionEntry(entry))
        .filter((o): o is { label: string; value: string } => o !== undefined)
      if (opts.length === 0) {
        errors.push({ path: `${path}.options`, value: optRaw, error: 'options is non-empty but produced no valid options.', fixHint: 'Use "Label:value" / bare "Label" strings, or { label, value } maps.' })
      } else {
        el['options'] = opts // id assigned by normalizer
        el['optionsType'] = 'CUSTOM'
      }
    }
  }

  // children (natural nesting) — only on container types.
  const childrenRaw = rec['children']
  if (childrenRaw !== undefined) {
    if (!meta.container) {
      errors.push({ path: `${path}.children`, error: `Element type '${resolved}' cannot contain children.`, fixHint: 'Remove children, or change type to a container (section, page, repeatableSet, form, infoPage).' })
    } else if (!Array.isArray(childrenRaw)) {
      errors.push({ path: `${path}.children`, value: typeof childrenRaw, error: 'children must be a list.', fixHint: 'Write children as a YAML list of elements.' })
    } else {
      el.elements = compileList(childrenRaw, `${path}.children`, errors)
    }
  }

  // Pass-through: every non-reserved key becomes an SDK element prop (typed-YAML
  // equivalent of the CSV prop:* columns). Values are used as-is — YAML already
  // carries their type (bool/number/string/map/list), and the SDK validates.
  for (const key of Object.keys(rec)) {
    if (RESERVED_KEYS.has(key)) continue
    el[key] = rec[key]
  }

  return el
}
