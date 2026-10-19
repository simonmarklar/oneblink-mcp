---
status: accepted
last_verified: 2026-10-14
verified_against:
  - "SDK: FormElementLists.searchFormElementLists(searchParams: FormElementListSearchOptions): Promise<FormElementListSearchResult> (tenants/classes/FormElementLists.d.ts)"
  - "Types: FormElementListSearchOptions = BaseSearchOptions & { organisationId: string; workspaceId?: number } (tenants/types.d.ts:364)"
  - "Types: FormElementListSearchResult = { formElementLists: FormElementOptionSet[] } & BaseSearchResult (tenants/types.d.ts:361)"
  - "LIVE-VERIFIED 2026-10-14 against the OneBlink Console: result wrapper is { meta, formElementLists }; rows carry {id, environments[].formsAppEnvironmentId, workspaceIds, type, ...}. meta.nextOffset is present when more pages exist (confirmed on searchForms, value 1) and OMITTED at the last page — matches nextOffset?: number (misc.d.ts:78-83); result.meta?.nextOffset ?? null handles both."
---

# list_element_lists

List reusable element option sets so a `create_form` caller can reference an
existing list by `id` (as `dynamicOptionSetId`) instead of recreating it.
Read-only.

## Intent

Pair tool to `create_element_list`. Discover existing lists + their ids before
wiring a form element to a DYNAMIC options set.

## SDK call

`getClient().formElementLists().searchFormElementLists({ organisationId, workspaceId?, limit, offset })`

## Input schema

| arg | type | req | notes |
| --- | --- | --- | --- |
| `workspaceId` | number int >0 | no | SDK-supported scope filter |
| `mode` | enum `page`\|`stream` | no, default `page` | per pagination skill |
| `limit` | int 1..200 | no, default 50 | |
| `offset` | int >=0 | no, default 0 | |
| `fields` | string[] | no | top-level projection override (rule 3) |

- `organisationId` is REQUIRED by the SDK search options but is NOT a model input
  (steering rule 1) — derive it server-side exactly as `create_form` does, then
  pass it to the SDK. The model never supplies org.
- Bounded-scope note (rule 2): org is always present (derived), so this is not
  an unbounded fan-out across tenants; `workspaceId` is an optional narrower
  scope. This satisfies rule 2 because the derived org is itself the mandatory
  scope.

## Pagination / projection

- Follow `.kiro/skills/oneblink-list-pagination`: `page` mode returns
  `{items, meta:{limit,offset,returnedCount,nextOffset}}` using the SDK's
  **`meta.nextOffset`** (NOT a re-derived formula — the exact bug steering rule 6
  exists for); `stream` mode emits JSONL with the same `STREAM_PAGE_CAP` guard as
  `list_forms`.
- Reuse `project` / `resolveFields` from `src/lib/projection.ts`.
- Default projection: `['id','name','type','updatedAt']`. Allowed set adds
  `['organisationId','environments','createdAt']` (array/object fields coerce to
  count/type-name per rule 3).

## Output projection

`page` mode:
```json
{ "items": [ { "id": 1, "name": "...", "type": "STATIC", "updatedAt": "..." } ],
  "meta": { "limit": 50, "offset": 0, "returnedCount": 1, "nextOffset": null } }
```

## Security (OWASP)

- A01/API1: org derived server-side; `workspaceId` is a legitimate narrower scope.
- A09: log `{mode, workspaceId?, returnedCount}` only — never list contents.

## Definition of Done

- `list_element_lists` registered; `formElementLists()` accessor present
  (shared with item 1).
- Unit tests: page mode projection + `nextOffset` passthrough; stream JSONL;
  org-derivation path; `fields` override + unknown-field rejection.
- `npm run typecheck` + `npm test` green.
- `docs/tools/list_element_lists.md` generated.
- Live-verify `meta.nextOffset` presence, then flip `status: accepted`.

## Files

```
src/workflows/list-element-lists.ts
test/list-element-lists.test.ts
docs/tools/list_element_lists.md
```
