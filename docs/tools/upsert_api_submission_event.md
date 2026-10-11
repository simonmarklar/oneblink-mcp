# upsert_api_submission_event

Add or update a hosted-API webhook submission event (ONEBLINK_API) on a form, pointing at an EXISTING OneBlink hosted API and route. It fires AFTER a submission. Reach for it to wire a form to an already-deployed API webhook; it does not provision a new API. It reads the form, splices the event into submissionEvents (append, or replace at an explicit index), and saves, stopping with a permission request if the form is locked.

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `formId` | `integer` | Required | Form id to add the webhook event to. |
| `apiId` | `string` | Required | Id of the EXISTING OneBlink hosted API the request is made to. |
| `apiEnvironment` | `string` | Required | Environment of the hosted API, e.g. dev / test / prod. |
| `apiEnvironmentRoute` | `string` | Required | Route on the API+environment to call, must start with /, e.g. /my-route. |
| `organisationManagedSecretId` | `integer` | Optional | Optional org managed secret id used to verify request authenticity; only its id is handled, never logged. |
| `label` | `string` | Optional | Optional label to identify the event. |
| `replaceIndex` | `integer` | Optional | Replace the event at this index; omit to append. Never guessed. |
| `overrideLock` | `boolean` | Optional | Explicit permission to override a form lock; defaults to false, never set implicitly. |
| `conditionallyExecute` | `boolean` | Optional | Whether the event runs only when its conditions are met. |
| `isRetryable` | `boolean` | Optional | Whether a failed event delivery is retried. |
