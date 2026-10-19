# list_element_lists

List reusable element option sets ("element lists") so you can discover an existing list and its id before wiring a form element to a DYNAMIC options set (as dynamicOptionSetId), rather than recreating one. Read-only and the pair tool to create_element_list. The organisation is derived from your Developer Key; results are bounded and pageable, with an optional JSONL stream mode for bulk export and an optional field selection to trim the output.

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `workspaceId` | `integer` | Optional | Optional narrower scope filter. |
| `mode` | `enum: page|stream` | Optional | page returns a bounded page with meta; stream emits JSONL for bulk export (default page). |
| `limit` | `integer` | Optional | Max lists per page, 1-200 (default 50). |
| `offset` | `integer` | Optional | Index of the first list to return, for paging (default 0). |
| `fields` | `string[]` | Optional | Top-level properties to return; overrides the default projection (unknown fields are rejected). |
