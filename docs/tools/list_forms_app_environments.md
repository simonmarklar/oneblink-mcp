# list_forms_app_environments

List the forms-app environments (such as Production and Test) in the tenant so a caller can discover the ids other tools need: each result carries its own id (the formsAppEnvironmentId that list_forms takes) and its workspaceId. Supports page mode with pagination metadata or a JSONL stream mode, with an optional selectable field projection.

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `workspaceId` | `integer` | Optional | Filter to environments in one workspace id. |
| `mode` | `enum: page | stream` | Optional | page (default) returns one page with meta; stream returns JSONL for bulk export. |
| `limit` | `integer (1-200)` | Optional | Max environments per page (default 50). Page mode only. |
| `offset` | `integer (>=0)` | Optional | Index of the first environment to return, for paging (default 0). Page mode only. |
| `fields` | `string[]` | Optional | Top-level environment properties to return; defaults to a trimmed set. Unknown or nested names are rejected. |
