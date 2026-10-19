/**
 * Pre-flight supporting-resource reference collection + validation (pure).
 *
 * A form element can reference a supporting resource that must already exist in
 * the target environment:
 *   - `dynamicOptionSetId` when `optionsType === 'DYNAMIC'` -> an element LIST
 *   - `dataLookupId`       when `isDataLookup === true`      -> a LOOKUP
 *   - `elementLookupId`    when `isElementLookup === true`   -> a LOOKUP
 *
 * This module walks the (already-normalized) element tree and collects those
 * references, then validates each referenced id against the set of ids that
 * actually exist in the target environment — producing the create_form
 * fail-fast D7 error shape for any miss. It is PURE: no network, no SDK calls.
 * The caller (create-form.ts) does the batched SDK search and hands the id sets
 * in here. Spec: docs/requirements/create-form-resource-refs.md.
 *
 * Security: A09 — this module returns structured errors but never logs; the
 * caller logs {refsChecked, refsMissing} COUNTS only, never ids-as-content.
 */
import type { FormValidationError, MutableElement } from './form-normalize.js'

/** The kind of supporting resource a reference points at. */
export type RefKind = 'list' | 'lookup'

/** One collected resource reference, with the dotted path to its origin. */
export interface ResourceRef {
  /** `list` -> element lists; `lookup` -> element lookups. */
  kind: RefKind
  /** The referenced resource id. */
  value: number
  /** Dotted path into the elements array, e.g. `elements[3].dynamicOptionSetId`. */
  path: string
  /** Which element prop carried the reference. */
  prop: 'dynamicOptionSetId' | 'dataLookupId' | 'elementLookupId'
}

function asRefId(value: unknown): number | undefined {
  // Resource ids are numeric in the SDK; tolerate a numeric string from CSV
  // prop:* coercion, but anything else is not a resolvable reference.
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return undefined
}

/**
 * Walk the element tree (including nested `.elements`) and collect every
 * supporting-resource reference, by kind, with its path. Order is depth-first
 * matching the normalizer's own walk so paths line up with its errors.
 */
export function collectResourceRefs(elements: MutableElement[]): ResourceRef[] {
  const refs: ResourceRef[] = []

  const walk = (el: MutableElement, path: string): void => {
    // dynamicOptionSetId — only meaningful for a DYNAMIC options element.
    if (el.optionsType === 'DYNAMIC') {
      const id = asRefId(el.dynamicOptionSetId)
      if (id !== undefined) {
        refs.push({ kind: 'list', value: id, path: `${path}.dynamicOptionSetId`, prop: 'dynamicOptionSetId' })
      }
    }
    // dataLookupId — only when the element declares a data lookup.
    if (el.isDataLookup === true) {
      const id = asRefId(el.dataLookupId)
      if (id !== undefined) {
        refs.push({ kind: 'lookup', value: id, path: `${path}.dataLookupId`, prop: 'dataLookupId' })
      }
    }
    // elementLookupId — only when the element declares an element lookup.
    if (el.isElementLookup === true) {
      const id = asRefId(el.elementLookupId)
      if (id !== undefined) {
        refs.push({ kind: 'lookup', value: id, path: `${path}.elementLookupId`, prop: 'elementLookupId' })
      }
    }
    if (Array.isArray(el.elements)) {
      el.elements.forEach((child, i) => walk(child, `${path}.elements[${i}]`))
    }
  }

  elements.forEach((el, i) => walk(el, `elements[${i}]`))
  return refs
}

/** The id sets that actually exist in the target environment. */
export interface ExistingResourceIds {
  /** Element-list ids present in the target environment. */
  listIds: ReadonlySet<number>
  /** Element-lookup ids present in the target environment. */
  lookupIds: ReadonlySet<number>
}

/**
 * Validate collected refs against the ids that exist in the target
 * environment. Returns a structured error (D7 shape) for every reference whose
 * id is NOT present. Collects ALL misses — never stops at the first. Pure.
 *
 * @param refs                collected references (from collectResourceRefs)
 * @param existing            the id sets present in the environment
 * @param formsAppEnvironmentId the target environment (for the error message)
 */
export function validateResourceRefs(
  refs: readonly ResourceRef[],
  existing: ExistingResourceIds,
  formsAppEnvironmentId: number,
): FormValidationError[] {
  const errors: FormValidationError[] = []
  for (const ref of refs) {
    const present = ref.kind === 'list' ? existing.listIds.has(ref.value) : existing.lookupIds.has(ref.value)
    if (present) continue
    if (ref.kind === 'list') {
      errors.push({
        path: ref.path,
        value: ref.value,
        error: `Element list ${ref.value} does not exist in environment ${formsAppEnvironmentId}.`,
        fixHint: 'Create it with create_element_list, or use list_element_lists to find a valid id.',
      })
    } else {
      errors.push({
        path: ref.path,
        value: ref.value,
        error: `Element lookup ${ref.value} does not exist in environment ${formsAppEnvironmentId}.`,
        fixHint: 'Create it with create_element_lookup, or use list_element_lookups to find a valid id.',
      })
    }
  }
  return errors
}

/**
 * Build a set of resource ids present in a given environment from a search
 * result's resource rows. A resource is "in" the environment when its
 * `environments[]` carries a matching `formsAppEnvironmentId`. Resources are
 * environment-scoped (NewFormElementOptionSet / NewFormElementLookup both take
 * `environments: [{ formsAppEnvironmentId, ... }]`), so org-wide search rows
 * must be filtered down to the target environment here.
 *
 * Pure: operates on the already-fetched rows the caller passes in.
 */
export function idsInEnvironment(
  rows: ReadonlyArray<Record<string, unknown>>,
  formsAppEnvironmentId: number,
): Set<number> {
  const ids = new Set<number>()
  for (const row of rows) {
    const id = asRefId(row.id)
    if (id === undefined) continue
    const envs = row.environments
    if (!Array.isArray(envs)) continue
    const inEnv = envs.some(
      (e) => e !== null && typeof e === 'object' && (e as { formsAppEnvironmentId?: unknown }).formsAppEnvironmentId === formsAppEnvironmentId,
    )
    if (inEnv) ids.add(id)
  }
  return ids
}
