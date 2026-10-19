# list_element_lookups

List element and data lookups so a caller can discover an existing lookup and its id before wiring a form element's dataLookupId or elementLookupId. Read-only pair tool to create_element_lookup. The organisation scope is derived from the credential (an optional workspaceId narrows it further). Supports paged results (default) or a JSONL stream for bulk export, with optional field selection.

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `workspaceId` | `integer` | Optional | Narrower scope filter; must exactly match a lookup's workspaceId. |
| `mode` | `enum: page | stream` | Optional | page returns one bounded page (default); stream emits all results as JSONL. |
| `limit` | `integer (1..200)` | Optional | Max items per page in page mode (default 50). |
| `offset` | `integer (>=0)` | Optional | Index of the first item to return in page mode (default 0). |
| `fields` | `string[]` | Optional | Top-level lookup properties to return; defaults to id, name, type, updatedAt. |
