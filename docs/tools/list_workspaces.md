# list_workspaces

List the distinct workspace ids in this tenant. OneBlink's Developer Key SDK has no workspace-listing endpoint, so this DERIVES the ids by scanning forms-app environments (which carry a workspaceId) and returns the distinct ids, optionally each with the environments that reference it. Read-only discovery helper.

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `includeEnvironments` | `boolean` | Optional | Include the environments referencing each workspace; false = ids only. Defaults to true. |
