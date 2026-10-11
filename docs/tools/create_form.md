# create_form

Create a OneBlink form in one call, taking its elements EITHER as a human-authored CSV (elementsCsv) or a well-defined SDK FormElement[] (elements) - exactly one source. Reach for it when a spreadsheet author or a machine has a form definition and you want it created without hand-building the SDK payload: types are matched case-insensitively to the SDK type set, names derived from labels, options parsed from Label:value tokens, nesting from a parent column or nested elements. The whole input is validated fail-fast (human- and machine-readable errors) before any API call, organisationId is derived server-side from the credential, and the form is created via Forms.createForm.

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Required | Form name. |
| `formsAppEnvironmentId` | `integer` | Required | Environment the form is created in; discover ids with list_forms_app_environments. |
| `elementsCsv` | `string` | Optional | CSV of element rows (label,type,parent,required,options,prop:*). Supply this XOR elements - exactly one. |
| `elements` | `object[]` | Optional | Well-defined SDK FormElement[]. Supply this XOR elementsCsv - exactly one. |
| `description` | `string` | Optional | Form description; defaults to empty. |
| `formsAppIds` | `integer[]` | Optional | Forms App ids this form belongs to; defaults to empty. |
| `isAuthenticated` | `boolean` | Optional | Whether the form requires an authenticated user; defaults to false. |
| `isMultiPage` | `boolean` | Optional | Omit to infer from the elements (true iff the root is pages); validated either way. |
| `postSubmissionAction` | `enum: FORMS_LIBRARY|URL|CLOSE|BACK` | Optional | What the form does after a successful submission; defaults to FORMS_LIBRARY. |
| `cancelAction` | `enum: FORMS_LIBRARY|URL|CLOSE|BACK` | Optional | What the form does on cancel; defaults to FORMS_LIBRARY. |
| `redirectUrl` | `string (url)` | Optional | Target URL; required when an action is URL. |
