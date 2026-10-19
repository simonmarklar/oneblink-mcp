---
status: accepted
last_verified: 2026-10-14
verified_against:
  - "Composes: createFormElementList (item 1), createFormElementLookup (item 3), Forms.createForm (existing create_form)"
  - "Precedent compose pattern: upsert_api_submission_event_with_deploy (src/workflows/upsert-api-submission-event-with-api.ts)"
  - "Consumer props: dynamicOptionSetId / dataLookupId / elementLookupId wired post-create"
  - "LIVE-VERIFIED 2026-10-14 transitively: the orchestrator uses the SAME fixed createElementList/createElementLookup scaffolds verified live (list id 1732, lookup id 911 created+deleted). workspaceIds is threaded into both resource creates."
  - "LIVE FINDING: workspaceIds required + non-empty on the inline resources (misc.d.ts:275); added as a top-level required, non-empty tool input applied to every inline list + lookup."
---

# create_form_with_resources

One call that creates missing supporting resources (element lists / lookups),
captures their ids, injects them into the element definitions, then creates the
form. Removes the manual "create resource -> copy id -> reference in form" dance.

## DEPENDENCY — build AFTER items 1 and 3

Composes the create logic of `create_element_list` (item 1) and
`create_element_lookup` (item 3) plus the existing `create_form`. Reuse their
lib functions — do NOT duplicate the SDK calls. The composer lands items 1 and 3
first; this is the integration task. Mirror the existing
`upsert_api_submission_event_with_deploy` compose precedent.

## Intent

An author describes a form whose elements reference resources that do not exist
yet. Instead of three tools + manual id plumbing, declare the resources inline
and let one tool create them in dependency order, wire the returned ids into the
elements, then create the form.

## Input schema

Superset of `create_form`'s scaffold args, plus a `resources` block:

| arg | type | notes |
| --- | --- | --- |
| ...all `create_form` args | | `name`, `description`, `formsAppEnvironmentId`, elements source, etc. |
| `workspaceIds` | `number[]` (non-empty) | **required**; applied to every inline list + lookup. API-required, non-empty (omitting 400s, empty `[]` 500s). Discover with `list_workspaces` |
| `resources.elementLists` | `{ ref: string; name: string; options: string }[]` | each creates a STATIC list; `ref` is a local handle |
| `resources.elementLookups` | `{ ref: string; name: string; type: 'DATA'\|'ELEMENT'; url: string }[]` | each creates a URL lookup; `ref` is a local handle |

Elements reference a resource by its local `ref` via a prop, e.g.
`prop:dynamicOptionSetRef=statesList` (resolved to the real
`dynamicOptionSetId` after the list is created). Same for
`dataLookupRef`/`elementLookupRef`.

- `organisationId` derived server-side (rule 1); `formsAppEnvironmentId` is the
  single environment all inline resources + the form are created in.

## Behaviour (ordered, best-effort transactional)

1. Validate the WHOLE input fail-fast (element structure + every `*Ref` resolves
   to a declared resource; unknown ref -> structured error). Nothing is created
   until clean.
2. Create element lists, then lookups; capture `ref -> id`.
3. Resolve `*Ref` props on elements to the real ids + set the matching flags
   (`optionsType:'DYNAMIC'`, `isDataLookup`/`isElementLookup`).
4. `createForm`.
5. On step-4 failure AFTER resources were created: do NOT silently leave orphans.
   Return the created resource ids in the error payload so the caller can clean
   up (and log the orphan ids). Document that this tool is not atomic — the
   platform has no multi-resource transaction; partial creation is reported, not
   hidden.

## Output projection (rule 3)

```json
{ "formId": 1234, "name": "...", "elementCount": 12,
  "createdResources": { "elementLists": [{"ref":"statesList","id":11}],
                        "elementLookups": [{"ref":"addr","id":7}] } }
```

On partial failure: `{ "error": "...", "createdResources": {...}, "formCreated": false }`.

## Security (OWASP)

- A01/API1: org derived server-side; one environment scope.
- A09: log counts + ids only — never options/urls/labels.

## Weigh before building

This is more surface to maintain and the only non-atomic tool. It fits the
server's workflow-focus charter (a real user task, not a raw SDK echo) and
mirrors an existing compose precedent, so it is in scope — but build it LAST,
after 1+3 are green, and keep the orphan-reporting honest.

## Definition of Done

- `create_form_with_resources` registered.
- Reuses item-1/item-3 lib create functions (no duplicated SDK calls).
- Unit tests: inline list+lookup created and refs wired into elements (mocked
  SDK); unknown `*Ref` rejected pre-flight; form-create failure returns
  `createdResources` + `formCreated:false`; happy path projection.
- `npm run typecheck` + `npm test` green.
- `docs/tools/create_form_with_resources.md` generated.

## Files

```
src/lib/create-element-list.ts   # extract reusable create fn (shared w/ item 1)
src/lib/create-element-lookup.ts # extract reusable create fn (shared w/ item 3)
src/workflows/create-form-with-resources.ts
test/create-form-with-resources.test.ts
docs/tools/create_form_with_resources.md
```
