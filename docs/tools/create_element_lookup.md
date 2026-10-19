# create_element_lookup

Create a URL-based element or data lookup so a form element can reference it by id (dataLookupId with isDataLookup for DATA, elementLookupId with isElementLookup for ELEMENT). Reach for it to register the lookup endpoint before wiring a form element to it; the tool returns the new lookup's id. Scope is URL lookups (type DATA or ELEMENT); STATIC_DATA lookups are out of scope. The organisation is derived from the credential, and each environment URL is validated as well-formed but never fetched by the server.

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Required | Human-readable name for the lookup. |
| `workspaceIds` | `integer[]` | Required | Workspace id(s) the lookup belongs to (at least one); discover ids with list_workspaces. Required by the API. |
| `type` | `enum: DATA | ELEMENT` | Required | DATA returns updated submission data; ELEMENT injects form elements. |
| `environments` | `{ formsAppEnvironmentId: number, url: string }[]` | Required | Per-environment lookup endpoint; at least one, each environment id unique, each url a well-formed URL. |
| `apiId` | `string` | Optional | Optional hosted-API id passthrough. |
| `excludeDefinition` | `boolean` | Optional | Exclude the form definition from the dynamic lookup call (SDK passthrough). |
