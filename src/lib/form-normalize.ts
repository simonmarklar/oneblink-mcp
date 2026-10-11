/**
 * Shared element normalizer + structural validator (spec D2, D5, D6, D7).
 *
 * Both input modes (CSV compiler, raw `elements` definition) converge here. It:
 *   1. assigns any missing element `id`s (globally unique within the form),
 *   2. derives any missing `name`s from `label` (snake_case) for NAMED element
 *      types only (page/section have no name),
 *   3. validates the structure: isMultiPage <-> page placement, no nested page,
 *      duplicate names, container/leaf consistency.
 *
 * Pure (no network, no SDK calls). Errors are COLLECTED, never thrown one at a
 * time, so a caller sees everything wrong at once (D7).
 */
import { randomUUID } from 'node:crypto'
import { FORM_ELEMENT_TYPE_META, type GeneratedFormElementType } from './generated/form-element-types.js'

/** A machine- and human-readable validation error (spec D7). */
export interface FormValidationError {
  /** CSV row (1-based, header = row 1) when the error originates from CSV. */
  row?: number
  /** CSV column name when applicable. */
  column?: string
  /** Dotted path into the elements array for definition-mode errors. */
  path?: string
  /** The offending value, when short and non-sensitive. */
  value?: unknown
  /** Human-readable explanation. */
  error: string
  /** A single best-guess corrected value, when one exists. */
  suggestion?: string
  /** The allowed set, when the error is a bad enum/type. */
  allowedTypes?: readonly string[]
  /** Imperative hint for an automated fixer. */
  fixHint?: string
}

/** Minimal element shape the normalizer operates on. */
export interface MutableElement {
  id?: string
  type: string
  label?: string
  name?: string
  elements?: MutableElement[]
  [k: string]: unknown
}

export interface NormalizeResult {
  elements: MutableElement[]
  isMultiPage: boolean
  errors: FormValidationError[]
}

/**
 * snake_case a label: lowercase, non-alphanumeric -> `_`, collapse repeats,
 * trim leading/trailing `_`. SDK name regex is [a-zA-Z\d_-]+ so this is safe.
 * (spec D2)
 */
export function labelToName(label: string): string {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return base.length > 0 ? base : 'element'
}

function isKnownType(t: string): t is GeneratedFormElementType {
  return Object.prototype.hasOwnProperty.call(FORM_ELEMENT_TYPE_META, t)
}

/**
 * Normalize + validate an element tree in place-safe fashion (returns new
 * objects; does not mutate the caller's input).
 *
 * @param input       the element array (already compiled, if from CSV)
 * @param isMultiPage caller's declared value, or undefined to INFER (CSV mode)
 */
export function normalizeElements(
  input: MutableElement[],
  isMultiPage: boolean | undefined,
): NormalizeResult {
  const errors: FormValidationError[] = []
  const usedNames = new Set<string>()
  const usedIds = new Set<string>()

  function uniqueName(desired: string): string {
    let candidate = desired
    let n = 2
    while (usedNames.has(candidate)) {
      candidate = `${desired}_${n}`
      n += 1
    }
    usedNames.add(candidate)
    return candidate
  }

  // Deep clone so we never mutate the caller's objects.
  const clone = (el: MutableElement): MutableElement => ({
    ...el,
    elements: el.elements ? el.elements.map(clone) : el.elements,
  })
  const elements = input.map(clone)

  // Pass 1: backfill ids + names, validate type, recurse.
  const walk = (el: MutableElement, path: string): void => {
    if (!el.type || typeof el.type !== 'string') {
      errors.push({ path: `${path}.type`, value: el.type, error: 'Element is missing a "type".', fixHint: 'Set a valid element type.' })
      return
    }
    if (!isKnownType(el.type)) {
      errors.push({
        path: `${path}.type`,
        value: el.type,
        error: `Unknown element type '${el.type}'.`,
        suggestion: closestType(el.type),
        allowedTypes: Object.keys(FORM_ELEMENT_TYPE_META),
        fixHint: 'Set "type" to one of allowedTypes.',
      })
      return
    }
    const meta = FORM_ELEMENT_TYPE_META[el.type]

    // id backfill (globally unique within form).
    if (typeof el.id !== 'string' || el.id.length === 0) {
      el.id = randomUUID()
    }
    if (usedIds.has(el.id)) {
      errors.push({ path: `${path}.id`, value: el.id, error: `Duplicate element id '${el.id}'.`, fixHint: 'Remove the id to let it be auto-assigned.' })
    }
    usedIds.add(el.id)

    // name: only for NAMED types; derive from label if absent.
    if (meta.named) {
      if (typeof el.name === 'string' && el.name.length > 0) {
        if (!/^[a-zA-Z0-9_-]+$/.test(el.name)) {
          errors.push({ path: `${path}.name`, value: el.name, error: `name '${el.name}' must match [a-zA-Z0-9_-]+.`, suggestion: labelToName(el.name), fixHint: 'Use snake_case with no spaces or punctuation.' })
        } else {
          el.name = uniqueName(el.name)
        }
      } else if (typeof el.label === 'string' && el.label.length > 0) {
        el.name = uniqueName(labelToName(el.label))
      } else {
        errors.push({ path: `${path}`, error: 'Element needs a label (to derive name) or an explicit name.', fixHint: 'Add a "label".' })
      }
    } else {
      // page/section carry no name; drop any stray one.
      delete el.name
    }

    // container/leaf consistency.
    if (meta.container) {
      if (!Array.isArray(el.elements)) el.elements = []
      el.elements.forEach((child, i) => walk(child, `${path}.elements[${i}]`))
    } else if (Array.isArray(el.elements) && el.elements.length > 0) {
      errors.push({ path: `${path}.elements`, error: `Element type '${el.type}' cannot contain child elements.`, fixHint: 'Remove child elements or change type to a container (section, page, repeatableSet, form).' })
    }

    // options: backfill option ids + default optionsType for choice elements.
    if (meta.options && Array.isArray(el.options)) {
      el.optionsType = typeof el.optionsType === 'string' ? el.optionsType : 'CUSTOM'
      el.options = (el.options as Array<Record<string, unknown>>).map((opt) => ({
        ...opt,
        id: typeof opt.id === 'string' && opt.id.length > 0 ? opt.id : randomUUID(),
      }))
    }
  }
  elements.forEach((el, i) => walk(el, `elements[${i}]`))

  // Pass 2: page / isMultiPage structural rules (spec D5).
  const rootPageCount = elements.filter((e) => e.type === 'page').length
  const anyPage = countType(elements, 'page') > 0
  const nestedPage = countType(elements, 'page') > rootPageCount
  if (nestedPage) {
    errors.push({ path: 'elements', error: 'PageElement must only appear at the form root; pages cannot be nested.', fixHint: 'Move nested pages to the root, or use section/repeatableSet for grouping.' })
  }

  const resolvedMultiPage = isMultiPage ?? anyPage
  if (resolvedMultiPage) {
    const nonPageRoots = elements.filter((e) => e.type !== 'page')
    if (nonPageRoots.length > 0) {
      errors.push({ path: 'elements', error: 'When isMultiPage is true, every root element must be a PageElement.', fixHint: 'Wrap root elements in page(s), or set isMultiPage false.' })
    }
    if (rootPageCount === 0) {
      errors.push({ path: 'elements', error: 'isMultiPage is true but there are no PageElements at the root.', fixHint: 'Add page(s) at the root, or set isMultiPage false.' })
    }
  } else if (anyPage) {
    errors.push({ path: 'elements', error: 'isMultiPage is false but the form contains PageElement(s).', fixHint: 'Set isMultiPage true (and make all root elements pages), or remove the pages.' })
  }

  return { elements, isMultiPage: resolvedMultiPage, errors }
}

function countType(els: MutableElement[], type: string): number {
  let n = 0
  for (const el of els) {
    if (el.type === type) n += 1
    if (Array.isArray(el.elements)) n += countType(el.elements, type)
  }
  return n
}

/** Levenshtein-nearest known type, for the "did you mean" suggestion (D7). */
export function closestType(input: string): string | undefined {
  const lower = input.toLowerCase()
  let best: string | undefined
  let bestDist = Infinity
  for (const t of Object.keys(FORM_ELEMENT_TYPE_META)) {
    const d = levenshtein(lower, t.toLowerCase())
    if (d < bestDist) {
      bestDist = d
      best = t
    }
  }
  // Only suggest when it's a plausibly close typo.
  return bestDist <= Math.max(2, Math.floor(lower.length / 2)) ? best : undefined
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0] as number
    dp[0] = i
    for (let j = 1; j <= n; j += 1) {
      const tmp = dp[j] as number
      dp[j] = Math.min(
        (dp[j] as number) + 1,
        (dp[j - 1] as number) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      prev = tmp
    }
  }
  return dp[n] as number
}
