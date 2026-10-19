---
status: accepted
last_verified: 2026-10-14
verified_against:
  - "SDK: FormElementLookups.searchFormElementLookups(options: { organisationId: string; limit?; offset?; workspaceId? }): Promise<FormElementLookupSearchResult> (tenants/classes/FormElementLookups.d.ts)"
  - "Types: FormElementLookupSearchResult = { formElementLookups: FormElementLookup[] } & BaseSearchResult (tenants/types.d.ts:358)"
  - "SDK also exposes getFormElementLookup(id): Promise<FormElementLookup> — optional single-fetch (out of scope this spec, note only)."
  - "LIVE-VERIFIED 2026-10-14 against the OneBlink Console: result wrapper is { meta, formElementLookups }; rows carry {id, name, type, environments[], workspaceIds, ...}; organisationId is required on the search (confirmed). meta.nextOffset present/omitted as per nextOffset?: number; ?? null handles both."
---

# list_element_lookups

List element/data lookups so a `create_form` caller can reference an existing
lookup by `id` (`dataLookupId` / `elementLookupId`). Read-only.

## Intent

Pair tool to `create_element_lookup`. Discover existing lookups + ids before
wiring a form element's lookup.

## SDK call

`getClient().formElementLookups().searchFormElementLookups({ organisationId, workspaceId?, limit, offset })`

## Input schema

| arg | type | req | notes |
| --- | --- | --- | --- |
| `workspaceId` | number int >0 | no | SDK-supported scope filter |
| `mode` | enum `page`\|`stream` | no, default `page` | |
| `limit` | int 1..200 | no, default 50 | |
| `offset` | int >=0 | no, default 0 | |
| `fields` | string[] | no | top-level projection override |

- `organisationId` REQUIRED by SDK, NOT a model input — derive server-side (rule
  1), the derived org is the mandatory scope satisfying rule 2.

## Pagination / projection

- Follow `.kiro/skills/oneblink-list-pagination`: use SDK `meta.nextOffset`;
  `STREAM_PAGE_CAP` guard; reuse `project`/`resolveFields`.
- Default projection: `['id','name','type','updatedAt']`. Allowed adds
  `['organisationId','environments','apiId','createdAt']`.

## Output projection

```json
{ "items": [ { "id": 7, "name": "...", "type": "DATA", "updatedAt": "..." } ],
  "meta": { "limit": 50, "offset": 0, "returnedCount": 1, "nextOffset": null } }
```

## Security (OWASP)

- A01/API1: org derived server-side; `workspaceId` optional narrower scope.
- A09: log `{mode, workspaceId?, returnedCount}` only.

## Definition of Done

- `list_element_lookups` registered; `formElementLookups()` accessor present
  (shared with item 3).
- Unit tests: page projection + `nextOffset`; stream JSONL; org-derivation;
  `fields` override + unknown-field rejection.
- `npm run typecheck` + `npm test` green.
- `docs/tools/list_element_lookups.md` generated.
- Live-verify `meta.nextOffset`, then flip `status: accepted`.

## Files

```
src/workflows/list-element-lookups.ts
test/list-element-lookups.test.ts
docs/tools/list_element_lookups.md
```
