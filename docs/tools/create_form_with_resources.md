# create_form_with_resources

Create a OneBlink form whose elements reference supporting resources (STATIC element lists and URL lookups) that do not exist yet, in one call. Declare the resources inline with local refs, reference them on elements via prop:dynamicOptionSetRef / prop:dataLookupRef / prop:elementLookupRef, and the tool validates the whole input fail-fast, creates the lists then the lookups, wires the returned ids into the elements (setting optionsType:'DYNAMIC', isDataLookup or isElementLookup), then creates the form. It is NOT atomic: if the form create fails after resources were created, it returns the created resource ids with formCreated:false so you can clean up the orphans. The organisation is derived from the credential, never a tool argument.

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Required | Form name. |
| `formsAppEnvironmentId` | `integer` | Required | The single environment all inline resources AND the form are created in. |
| `workspaceIds` | `integer[]` | Required | Workspace id(s) applied to every inline element list and lookup (at least one); discover ids with list_workspaces. Required by the API for those resources. |
| `elements` | `FormElement[]` | Optional | Well-defined SDK element array. Mutually exclusive with elementsCsv (exactly one required). |
| `elementsCsv` | `string` | Optional | CSV of element rows (label,type,parent,required,options,prop:*). Mutually exclusive with elements. |
| `resources.elementLists` | `{ ref, name, options }[]` | Optional | Inline STATIC option sets; each ref is a local handle referenced by prop:dynamicOptionSetRef. |
| `resources.elementLookups` | `{ ref, name, type, url }[]` | Optional | Inline URL lookups (type DATA or ELEMENT); each ref is referenced by prop:dataLookupRef or prop:elementLookupRef. |
| `description` | `string` | Optional | Form description. |
| `formsAppIds` | `integer[]` | Optional | Forms App ids this form belongs to. |
| `isAuthenticated` | `boolean` | Optional | Whether the form requires an authenticated user. |
| `isMultiPage` | `boolean` | Optional | Omit to infer from the elements (true iff root elements are pages). |
| `postSubmissionAction` | `enum: FORMS_LIBRARY|URL|CLOSE|BACK` | Optional | What the form does after a successful submission. |
| `cancelAction` | `enum: FORMS_LIBRARY|URL|CLOSE|BACK` | Optional | What the form does when cancelled. |
| `redirectUrl` | `string` | Optional | Required when an action is URL. |
