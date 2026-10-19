# create_element_list

Create a reusable STATIC element option set (an "element list") so form elements can reference it by id (as dynamicOptionSetId with optionsType "DYNAMIC") instead of carrying the same inline options on every element. Reach for it when the same set of choices (a states list, a department list) is needed across many elements or forms. The organisation is derived from your Developer Key, and the whole input is validated before any API call; on success you get back the new list's id to wire into a form element.

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Required | Human-readable name for the list. |
| `workspaceIds` | `integer[]` | Required | Workspace id(s) the list belongs to (at least one); discover ids with list_workspaces. Required by the API. |
| `environments` | `object[]` | Required | Per-environment option sets (at least one); each has a formsAppEnvironmentId and an options cell. |
| `environments[].formsAppEnvironmentId` | `integer` | Required | Which environment this option set applies to (discover ids with list_forms_app_environments). |
| `environments[].options` | `string` | Required | Option tokens in create_form cell syntax: "Label:value|Label2" (pipe- or comma-separated). |
| `type` | `enum: STATIC` | Optional | Option-set type; only STATIC is supported this release (default STATIC). |
