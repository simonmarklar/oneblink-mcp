---
status: accepted
last_verified: 2026-10-14
verified_against:
  - "Consumer props: FormElementWithOptionsBase.dynamicOptionSetId (+ optionsType:'DYNAMIC'); LookupFormElement.dataLookupId/elementLookupId (forms.d.ts:129,139,283)"
  - "Existing: create_form passes prop:* through unvalidated (src/lib/form-elements-csv.ts coerceProp); normalizer form-normalize.ts does structural checks only"
  - "Depends on: list_element_lists (item 2) + list_element_lookups (item 4) for existence checks"
  - "LIVE-VERIFIED 2026-10-14: real search rows carry environments[].formsAppEnvironmentId, so idsInEnvironment() correctly filters org-wide search rows down to the target environment (list row env 568 observed). The pre-flight existence check works against real data."
---

# create_form enhancement: pre-flight resource-id validation

Add a pre-flight existence check to `create_form`: when a form element carries a
supporting-resource reference id, verify the id exists in the target environment
**before** `createForm`, and fail-fast with the structured error shape instead of
an opaque API rejection.

## DEPENDENCY — build AFTER items 2 and 4

This enhancement calls `searchFormElementLists` / `searchFormElementLookups`
(the SDK methods behind items 2 and 4). The composer must land items 2 and 4
(and the shared `formElementLists()` / `formElementLookups()` client accessors)
first. If built in parallel, this task stubs the check behind the accessors and
is wired last.

## Intent

Today `create_form` passes `prop:dynamicOptionSetId=123` straight through
(`coerceProp`), unvalidated. A wrong/nonexistent id fails only at the live
`createForm` call with an opaque message. Authors referencing resources "made
first" deserve a readable, machine-fixable error at validation time — matching
the existing fail-fast D7 contract.

## Scope — which references are checked

| element prop | requires | checked against |
| --- | --- | --- |
| `dynamicOptionSetId` (when `optionsType:'DYNAMIC'`) | element list exists in env | `searchFormElementLists` |
| `dataLookupId` (when `isDataLookup:true`) | lookup exists in env | `searchFormElementLookups` |
| `elementLookupId` (when `isElementLookup:true`) | lookup exists in env | `searchFormElementLookups` |

## Behaviour

- After normalization, walk the element tree (including nested elements) and
  collect every referenced resource id by kind.
- Resolve each kind ONCE (batch): fetch the lists/lookups for the derived org +
  target `formsAppEnvironmentId`, build an id set, check membership. Do not fetch
  per-element (N+1).
- Any referenced id not present in the target environment -> a structured error:
  ```json
  { "path": "elements[3].dynamicOptionSetId", "value": 123,
    "error": "Element list 123 does not exist in environment 457.",
    "fixHint": "Create it with create_element_list, or use list_element_lists to find a valid id." }
  ```
- Collect ALL such errors (never stop at first); nothing reaches `createForm`
  until clean. Consistent with existing create_form validation.
- Config flag: a `validateResourceRefs` input (default `true`) lets a caller
  skip the extra round-trips when they know the ids are good. Default-on because
  the whole point is catching the error early.

## Non-goals

- Does NOT auto-create missing resources (that is item 8).
- Does NOT validate `formsAppIds` existence (lower value; can add later).

## Security (OWASP)

- A01: existence checks run under the same derived org as the create — no new
  scope surface.
- A09: log `{refsChecked, refsMissing}` counts only — never ids-as-content or
  element labels.

## Definition of Done

- `create_form` collects + validates resource-ref ids pre-flight (default on),
  using the item-2/4 search methods.
- `validateResourceRefs` input added (default true).
- Unit tests: valid ref passes (mocked search returns the id); missing ref
  yields the structured path error; multiple missing refs all reported;
  `validateResourceRefs:false` skips the checks; nested-element refs walked.
- `npm run typecheck` + `npm test` green (existing create_form tests still pass).
- Update `docs/requirements/create-form.md` (new section) + regen
  `docs/tools/create_form.md`.

## Files

```
src/lib/form-normalize.ts  OR  new src/lib/form-resource-refs.ts  # ref collection
src/workflows/create-form.ts   # wire the pre-flight check
test/create-form-resource-refs.test.ts
docs/requirements/create-form.md   # append section
```
