# list_forms

Retrieve a bounded, pageable list of forms for a given workspace and/or forms-app environment, so a caller can browse or select forms without fetching the whole organisation. Returns a trimmed projection by default (overridable), with page mode for interactive use or a JSONL stream mode for bulk export. At least one scope filter is required.

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `workspaceId` | `integer` | Optional | Scope to one workspace id. At least one of workspaceId or formsAppEnvironmentId is required. |
| `formsAppEnvironmentId` | `integer` | Optional | Scope to one forms-app environment id. At least one of workspaceId or formsAppEnvironmentId is required. |
| `mode` | `enum: page | stream` | Optional | page (default) returns one page with meta; stream returns JSONL for bulk export. |
| `limit` | `integer (1-200)` | Optional | Max forms per page (default 50). Page mode only. |
| `offset` | `integer (>=0)` | Optional | Index of the first form to return, for paging (default 0). Page mode only. |
| `fields` | `string[]` | Optional | Top-level form properties to return; defaults to a trimmed set. Unknown or nested names are rejected. |
