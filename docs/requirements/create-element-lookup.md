---
status: accepted
last_verified: 2026-10-14
verified_against:
  - "SDK: FormElementLookups.createFormElementLookup(newFormElementLookup: FormTypes.NewFormElementLookup): Promise<FormTypes.FormElementLookup> (tenants/classes/FormElementLookups.d.ts)"
  - "Types: NewFormElementLookup = NewFormElementLookupUrl | NewFormElementLookupStaticData (forms.d.ts:2251)"
  - "Types: NewFormElementLookupUrl = NewFormElementLookupBase & { apiId?; environments: FormElementLookupEnvironmentUrl[]; type: 'ELEMENT'|'DATA'; builtInId?; excludeDefinition? } (forms.d.ts:2229)"
  - "Types: NewFormElementLookupBase = WithOrganisationAssociation & WithWorkspacesAssociation & { name: string } (forms.d.ts:2223)"
  - "Consumer: LookupFormElement.dataLookupId (isDataLookup) + elementLookupId (isElementLookup) (forms.d.ts:129,139)"
  - "LIVE-VERIFIED 2026-10-14 against the OneBlink Console: create returned numeric id (911); return shape {type,environments,name,organisationId,workspaceIds,id,createdAt,updatedAt}; created lookup then deleted (no artifact)."
  - "LIVE FINDING: workspaceIds (WithWorkspacesAssociation, misc.d.ts:275) is REQUIRED and must be NON-EMPTY — omitting 400s, empty [] 500s. Required, non-empty tool input."
---

# create_element_lookup

Create a URL-based element/data **Lookup** so a form element can reference it by
id (`dataLookupId` with `isDataLookup:true`, or `elementLookupId` with
`isElementLookup:true`). A DATA lookup returns updated submission data; an
ELEMENT lookup injects form elements.

## Intent

Lookups are a supporting resource a form element points at by id. No id source
exists today. This tool creates the URL-based lookup and returns its `id`.

Scope = URL lookups (`type: 'ELEMENT' | 'DATA'`) this release.
`STATIC_DATA` lookups are out of scope (separate shape, add later).

## SDK call

`getClient().formElementLookups().createFormElementLookup(newLookup)`

Requires the `formElementLookups()` accessor on the client factory (shared
prerequisite with items 1,2,4 — add once).

## Input schema

| arg | type | req | notes |
| --- | --- | --- | --- |
| `name` | string min 1 | yes | lookup name |
| `workspaceIds` | `number[]` (non-empty) | yes | workspace id(s) the lookup belongs to; discover with `list_workspaces`. **API-required, non-empty** — omitting 400s, empty `[]` 500s (live-verified) |
| `type` | enum `'DATA'`\|`'ELEMENT'` | yes | DATA=submission data, ELEMENT=inject elements |
| `environments` | `{ formsAppEnvironmentId: number; url: string(url) }[]` | yes min 1 | per-env endpoint |
| `apiId` | string | no | optional hosted-API id passthrough |
| `excludeDefinition` | boolean | no | passthrough per SDK |

- `organisationId` derived server-side (rule 1), not an input.
- `environments[].url` validated as a URL (zod `.url()`), fail-fast otherwise.
- Duplicate `formsAppEnvironmentId` -> fail-fast. Empty environments ->
  fail-fast.

## Output projection

```json
{ "id": 7, "name": "...", "type": "DATA", "environmentCount": 1 }
```

`id` is the value used as `dataLookupId` (DATA) or `elementLookupId` (ELEMENT) on
a form element, with the matching `isDataLookup`/`isElementLookup` flag set true.

## Security (OWASP)

- A01/API1: org derived server-side.
- A10 (SSRF awareness): the lookup `url` is stored config consumed by OneBlink's
  platform at form runtime, not fetched by this server — so no server-side fetch
  here. Still validate it is a well-formed absolute URL; do not probe it.
- A09: log `{id, type, environmentCount}` only — never urls (may embed tokens).

## Definition of Done

- `create_element_lookup` registered; `formElementLookups()` accessor present.
- Unit tests: valid DATA + ELEMENT create (mocked) returns projection; bad url
  rejected; empty/duplicate env rejected; STATIC_DATA type rejected (out of
  scope message); org-derivation failure path.
- `npm run typecheck` + `npm test` green.
- `docs/tools/create_element_lookup.md` generated.
- Live-verify env URL shape + return id, then flip `status: accepted`.

## Files

```
src/workflows/create-element-lookup.ts
test/create-element-lookup.test.ts
docs/tools/create_element_lookup.md
```
