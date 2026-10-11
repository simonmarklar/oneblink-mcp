# set_form_personalisation

Point an existing OneBlink form at a hosted-API prefill (personalisation) endpoint so the form is populated with data BEFORE the user starts filling it - distinct from submission events, which fire after submit. Reach for it after a hosted API with a prefill route is deployed and you want that form to call it on load. It reads the form, sets form.personalisation to a ONEBLINK_API endpoint config, and writes it back, stopping with a permission request if the form is locked.

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `formId` | `integer` | Required | Id of the form to attach the personalisation endpoint to. |
| `apiId` | `string` | Required | Full hosted-API scope domain, e.g. "oneblink-mcp-test.api.oneblink.io" (not a short id). |
| `apiEnvironment` | `string` | Required | Hosted-API environment the endpoint lives in, e.g. "dev", "test", "prod". |
| `apiEnvironmentRoute` | `string` | Required | Route on the hosted API to call, must start with "/", e.g. "/test". |
| `overrideLock` | `boolean` | Optional | Explicit permission to override a form-builder lock; defaults to false and is never set implicitly. |
