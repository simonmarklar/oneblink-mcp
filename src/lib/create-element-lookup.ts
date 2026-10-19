/**
 * Reusable element/data-lookup (URL lookup) create logic.
 *
 * Extracted so BOTH the `create_element_lookup` workflow tool (item 3) and the
 * `create_form_with_resources` orchestrator (item 8) share ONE copy of the SDK
 * scaffold + create call — no duplicated SDK calls (spec DoD).
 *
 * Pure of MCP wiring + org derivation: callers pass an already-resolved
 * organisationId and already-validated URLs, and inject the SDK surface. It
 * never derives org, never validates URLs, never logs (the caller owns A09
 * logging + projection + A10 "never fetched here" guarantee).
 *
 * SDK: FormElementLookups.createFormElementLookup(NewFormElementLookupUrl)
 *      : Promise<FormElementLookup>. URL shape carries
 *      environments: { formsAppEnvironmentId, url }[], type 'ELEMENT'|'DATA'.
 */

/** Minimal SDK surface this helper needs — lets callers/tests mock the SDK. */
export interface FormElementLookupsLike {
  createFormElementLookup(newLookup: unknown): Promise<unknown>
}

/** One environment's lookup endpoint. */
export interface LookupEnvironment {
  formsAppEnvironmentId: number
  url: string
}

/** Validated input to the create helper (org already derived, URLs valid). */
export interface CreateElementLookupArgs {
  name: string
  type: 'DATA' | 'ELEMENT'
  organisationId: string
  /**
   * Workspace associations (WithWorkspacesAssociation, misc.d.ts:275). REQUIRED
   * and must be NON-EMPTY: the API rejects a missing field with 400 and an empty
   * [] with a 500 (both verified live). Caller resolves ids via list_workspaces.
   */
  workspaceIds: number[]
  environments: LookupEnvironment[]
  apiId?: string
  excludeDefinition?: boolean
}

/** What the helper returns to the caller. */
export interface CreateElementLookupResult {
  id: number | string | null
  name: string
  type: string
}

/**
 * Scaffold a NewFormElementLookupUrl from already-validated args. Pure — no
 * network, no logging. Exported for unit tests.
 */
export function scaffoldNewElementLookup(args: CreateElementLookupArgs): Record<string, unknown> {
  return {
    name: args.name,
    organisationId: args.organisationId,
    workspaceIds: args.workspaceIds,
    type: args.type,
    environments: args.environments.map((e) => ({
      formsAppEnvironmentId: e.formsAppEnvironmentId,
      url: e.url,
    })),
    ...(args.apiId ? { apiId: args.apiId } : {}),
    ...(args.excludeDefinition !== undefined ? { excludeDefinition: args.excludeDefinition } : {}),
  }
}

/**
 * Create a URL lookup via the injected SDK service. Input is assumed already
 * validated (org derived, URLs well-formed, env ids unique). Throws the SDK
 * error on failure — the caller decides how to surface it.
 */
export async function createElementLookup(
  lookups: FormElementLookupsLike,
  args: CreateElementLookupArgs,
): Promise<CreateElementLookupResult> {
  const created = (await lookups.createFormElementLookup(scaffoldNewElementLookup(args))) as Record<string, unknown>
  const id =
    typeof created.id === 'number' || typeof created.id === 'string' ? (created.id as number | string) : null
  const name = typeof created.name === 'string' ? created.name : args.name
  const type = typeof created.type === 'string' ? created.type : args.type
  return { id, name, type }
}
