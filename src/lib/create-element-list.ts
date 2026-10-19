/**
 * Reusable element-list (STATIC option set) create logic.
 *
 * Extracted so BOTH the `create_element_list` workflow tool (item 1) and the
 * `create_form_with_resources` orchestrator (item 8) share ONE copy of the SDK
 * scaffold + create call — no duplicated SDK calls (spec DoD).
 *
 * This module is pure of MCP wiring and of org derivation: callers pass an
 * already-resolved organisationId and already-parsed options, and inject the
 * minimal SDK surface. It never derives org, never parses options, never logs
 * (the caller owns A09 logging + projection).
 *
 * SDK: FormElementLists.createFormElementList(NewFormElementOptionSet)
 *      : Promise<FormElementOptionSet>. STATIC shape carries
 *      environments: { formsAppEnvironmentId, options: {label,value}[] }[].
 */

/** Minimal SDK surface this helper needs — lets callers/tests mock the SDK. */
export interface FormElementListsLike {
  createFormElementList(newList: unknown): Promise<unknown>
}

/** A single parsed option. */
export interface ParsedOption {
  label: string
  value: string
}

/** One environment's parsed option set. */
export interface ParsedEnvironmentOptions {
  formsAppEnvironmentId: number
  options: ParsedOption[]
}

/** Validated input to the create helper (org already derived, options parsed). */
export interface CreateElementListArgs {
  name: string
  /** Only STATIC is in scope this release. */
  type: 'STATIC'
  organisationId: string
  /**
   * Workspace associations (WithWorkspacesAssociation, misc.d.ts:275). REQUIRED
   * and must be NON-EMPTY: the API rejects a missing field with 400
   * `"workspaceIds" Required` and an empty [] with a 500 (both verified live
   * against the Console). The caller resolves real workspace ids via
   * list_workspaces and passes at least one.
   */
  workspaceIds: number[]
  environments: ParsedEnvironmentOptions[]
}

/** What the helper returns to the caller. */
export interface CreateElementListResult {
  /** The created list id, or null when the SDK did not echo one. */
  id: number | string | null
  /** The created list name (SDK echo, falling back to the requested name). */
  name: string
}

/**
 * Scaffold a NewFormElementOptionSet (STATIC) from already-validated args.
 * Pure — no network, no logging. Exported for unit tests.
 */
export function scaffoldNewElementList(args: CreateElementListArgs): Record<string, unknown> {
  return {
    name: args.name,
    organisationId: args.organisationId,
    workspaceIds: args.workspaceIds,
    type: args.type,
    environments: args.environments.map((env) => ({
      formsAppEnvironmentId: env.formsAppEnvironmentId,
      options: env.options.map((o) => ({ label: o.label, value: o.value })),
    })),
  }
}

/**
 * Create a STATIC element list via the injected SDK service. Input is assumed
 * already validated (org derived, options parsed, env ids unique). Throws the
 * SDK error on failure — the caller decides how to surface it.
 */
export async function createElementList(
  lists: FormElementListsLike,
  args: CreateElementListArgs,
): Promise<CreateElementListResult> {
  const created = (await lists.createFormElementList(scaffoldNewElementList(args))) as Record<string, unknown>
  const id =
    typeof created.id === 'number' || typeof created.id === 'string' ? (created.id as number | string) : null
  const name = typeof created.name === 'string' ? created.name : args.name
  return { id, name }
}
