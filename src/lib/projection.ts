/**
 * Output projection for list/search tools.
 *
 * Implements the field-selection + coercion contract from
 * .kiro/skills/oneblink-list-pagination (steering rule 3): callers may request
 * top-level fields only; arrays collapse to a count, objects to a type name.
 * Never returns raw nested SDK data.
 */

/** Coerce one value per the projection rules. */
function coerce(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.length // array -> element count
  if (typeof value === 'object') {
    const name = (value as { constructor?: { name?: string } }).constructor?.name
    return name && name !== 'Object' ? name : '[Object]' // object -> type name
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value // scalar -> value
  }
  return String(value)
}

/**
 * Project a single item onto the requested top-level fields.
 * Unknown fields are the caller's concern — validate against the allowed set
 * BEFORE calling this (fail closed); here an unknown key simply yields null.
 */
export function project(
  item: Record<string, unknown>,
  fields: readonly string[],
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  for (const f of fields) out[f] = coerce(item[f])
  return out
}

/** Resolve the effective field list: caller's selection or the default. */
export function resolveFields(
  requested: readonly string[] | undefined,
  defaults: readonly string[],
): readonly string[] {
  return requested && requested.length > 0 ? requested : defaults
}
