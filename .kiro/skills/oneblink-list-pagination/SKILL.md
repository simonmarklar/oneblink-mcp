---
name: oneblink-list-pagination
description: >-
  Procedure for list/search MCP tools in the OneBlink MCP server to return large
  result sets (thousands of forms, submissions, etc.) safely. Use when building
  any tool that calls an SDK search/list method (searchForms, etc.). Covers page
  size caps, offset pagination, the meta contract, and JSONL stream mode. Enforces
  tool-design steering rule 4.
status: accepted
last_verified: 2026-10-11
verified_against:
  - "@oneblink/sdk FormsSearchResult / FormsAppEnvironmentsSearchResult (meta.nextOffset) — verified live 2026-10-11"
---

# OneBlink List Pagination

How every list/search tool handles large result sets. Two modes; support both.

## Input schema (zod) — shared fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `mode` | `'page' \| 'stream'` | `'page'` | `stream` = JSONL bulk export |
| `limit` | int 1–200 | 50 | page size cap; hard max 200 |
| `offset` | int ≥ 0 | 0 | page mode only |
| `fields` | string[] | — | top-level props to return; default = spec projection |

Scope filters (e.g. `workspaceId`) are per-tool and required per steering rule 2.
`limit`/`offset`/`mode`/`fields` are tool inputs, never env vars (security rule 3).

## Field selection + coercion (steering rule 3)

Applies to both modes. `fields` overrides the default projection. Top-level
only; reject nested paths and unknown names (fail closed, list allowed fields).

```ts
function project(item: Record<string, unknown>, fields: string[]) {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const v = item[f]
    if (Array.isArray(v)) out[f] = v.length                 // array → count
    else if (v !== null && typeof v === 'object')           // object → type name
      out[f] = (v.constructor?.name && v.constructor.name !== 'Object')
        ? v.constructor.name
        : '[Object]'
    else out[f] = v                                          // scalar → value
  }
  return out
}
```

`toProjection(item)` below = `project(item, fields ?? defaultFields)`.

## Mode: page (default)

Interactive callers. One SDK page per call.

```ts
const result = await service.searchMethod({ ...filters, limit, offset })
return {
  items: result.items.map(toProjection),   // steering rule 3
  meta: {
    limit,
    offset,
    returnedCount: result.items.length,
    // Use the SDK's OWN cursor (steering rule 6). Do NOT re-derive it from
    // page length — a full page does not prove more data exists (it's wrong
    // when the total is an exact multiple of limit). Only derive a fallback
    // if the SDK provides no nextOffset.
    nextOffset: result.meta?.nextOffset ?? null,
  },
}
```

- `nextOffset: null` signals the last page. Caller re-calls with `nextOffset`
  until null.
- Never auto-loop all pages in page mode.
- If a particular SDK search method does NOT return `meta.nextOffset`, confirm
  that against its `.d.ts` first, then derive a fallback and note it in the tool.

## Mode: stream (JSONL bulk export)

Opt-in, for thousands of records. Server loops pages internally and emits one
JSON object per line (JSONL) — not a giant array.

```ts
// pseudo: loop offset until a short page, project each item, write as JSONL
let offset = 0
for (;;) {
  const page = await service.searchMethod({ ...filters, limit: 200, offset })
  for (const item of page.items) emitLine(JSON.stringify(toProjection(item)))
  if (page.items.length < 200) break
  offset += 200
}
```

- Each line is a projected object (steering rule 3) — never the raw SDK object.
- Use max page size (200) internally to minimise round trips.
- Guard against unbounded cost: enforce the scope filter (rule 2) and consider a
  safety cap on total pages; surface a `truncated: true` marker if hit.

## Logging (security rule 2 / A09)

Log scalars only: filter ids, `mode`, `limit`, `offset`, total `returnedCount`.
Never log item contents or raw SDK responses.

## Checklist for a new list tool

- [ ] ≥1 scope filter required (rule 2)
- [ ] `mode`/`limit`/`offset` from this schema
- [ ] page size capped at 200
- [ ] output is a projection, not raw (rule 3)
- [ ] optional `fields` honored; top-level only; array→count, object→type/`[Object]`; unknown/nested rejected
- [ ] `meta.nextOffset` from the SDK's own cursor (rule 6), not re-derived from page length
- [ ] stream mode emits JSONL, one projected object per line
- [ ] logs are scalars only
