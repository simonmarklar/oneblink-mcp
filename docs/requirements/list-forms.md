---
status: accepted
last_verified: 2026-10-11
verified_against:
  - "@oneblink/sdk Forms.searchForms -> FormsSearchResult.forms + meta.nextOffset"
  - "live run 2026-10-11: list_forms over env 380 returned 25 forms (page + JSONL)"
---

# Requirements: `list_forms`

**Status:** Approved
**Feature:** List forms for a given workspace and/or environment in an org.
**Purpose:** First feature — read-only walking skeleton validating build, auth,
and basic fetch end to end.

Conforms to steering: `security.md`, `tool-design.md`, `writing-style.md`, and
the `oneblink-list-pagination` skill. This spec only states what is specific to
`list_forms`.

## SDK mapping

```ts
new OneBlink.Forms({ accessKey, secretKey })
  .searchForms({ workspaceId?, formsAppEnvironmentId?, limit, offset })
// → { forms: Form[], meta }
```

- Service `Forms` (v13), method `searchForms`.
- Min role permission: **Forms: Read Only**.
- `FormsSearchOptions` fields used: `workspaceId`, `formsAppEnvironmentId`,
  `limit`, `offset`.

## Resolved decisions

| Q | Decision |
|---|---|
| Q1 org | **Not an input.** Org derives from the key (tool-design rule 1). No `organisationId` arg, not even optional, for this feature. |
| Q2 ids | `workspaceId` and `formsAppEnvironmentId` both **optional individually**, but **≥1 required** — reject if neither (tool-design rule 2). |
| Q3 output | **Trimmed projection** (tool-design rule 3). Fields below. |
| Q4 paging | **Both** page (default) + JSONL stream, per the pagination skill. |

## Inputs (zod)

Scope filters (this feature) + shared paging fields from the skill:

| Input | Type | Required | Notes |
|---|---|---|---|
| `workspaceId` | int > 0 | one-of | ≥1 of these two required |
| `formsAppEnvironmentId` | int > 0 | one-of | ≥1 of these two required |
| `mode` | `'page'\|'stream'` | no (`page`) | from skill |
| `limit` | int 1–200 | no (50) | from skill |
| `offset` | int ≥ 0 | no (0) | page mode |
| `fields` | string[] | no | top-level only; overrides projection (tool-design rule 3) |

Validation: fail closed if both scope ids absent. Reject any `fields` entry not
in the allowed set below (and any nested path).

## Output projection

Default per form: `id`, `name`, `formsAppEnvironmentId`, `workspaceId`,
`isAuthenticated`, `createdAt`, `updatedAt` (if present).

**Allowed `fields`** = top-level props of the SDK `Form` object. If `fields` is
given, return exactly those, coerced per tool-design rule 3:
- scalar → value
- array (e.g. `elements`, `submissionEvents`) → element count
- object → type name, else `[Object]`

Reject unknown or nested (`a.b`) field names (fail closed).

Page mode adds `meta: { limit, offset, returnedCount, nextOffset }`.
Stream mode: one projected form per JSONL line.

## Behaviour

1. Validate inputs; reject if neither scope id present.
2. Build `Forms` from key + tenant.
3. `page`: one `searchForms` call. `stream`: loop per the skill.
4. Map to projection; return.

## Security notes (specific)

- A01: min permission **Forms: Read Only**; auth/permission failure surfaces as
  an error (fail closed), not masked.
- A09: log `workspaceId`, `formsAppEnvironmentId`, `mode`, `limit`, `offset`,
  `returnedCount` only.
- A03: inputs are typed ints, zod-validated before the SDK.

## Acceptance criteria

- [ ] `npm run build` clean.
- [ ] `npm test` passes incl. mocked `searchForms`.
- [ ] Tool shows in MCP Inspector with the schema above.
- [ ] Valid scope id → projected list + `meta`.
- [ ] Neither scope id → validation error, no crash.
- [ ] `mode: stream` → JSONL, one projected form per line.
- [ ] `fields: ['name','elements']` → only those keys; `elements` returns a count, not the array.
- [ ] Unknown or nested field name → validation error.
- [ ] Auth/permission failure → error result; no secret/PII in logs.
- [ ] No field beyond the projection returned.

## Out of scope

Name→id resolution, create/update/delete, caching.
