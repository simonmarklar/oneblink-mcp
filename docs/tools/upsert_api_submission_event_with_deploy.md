# upsert_api_submission_event_with_deploy

Wire a hosted-API webhook submission event (ONEBLINK_API) onto a form in one call, EITHER pointing at an EXISTING hosted API (source=existing) OR provisioning/deploying a NEW hosted API from a project directory first (source=deploy) and wiring that. The deploy branch deploys THEN writes the event, so a failed deploy writes no event; deploying to prod requires confirmProduction. A locked form stops with a permission request unless overrideLock is set.

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `source` | `enum: existing|deploy` | Required | existing = wire an already-deployed API; deploy = deploy a NEW API first, then wire it. |
| `formId` | `integer` | Required | Form id to add the webhook event to. |
| `apiEnvironmentRoute` | `string` | Required | Route on the API+environment to call, must start with /, e.g. /my-route. |
| `apiId` | `string` | Required | Hosted API id. Required on both branches (deploy does not return it). |
| `apiEnvironment` | `string` | Optional | source=existing only: environment of the existing hosted API. On source=deploy it is derived from env. |
| `projectDir` | `string` | Optional | source=deploy only: absolute path to the API codebase (contains .blinkmrc.json). |
| `scope` | `string` | Optional | source=deploy only: API scope domain; when set, oneblink api scope <scope> runs before deploy. |
| `env` | `enum: dev|test|prod` | Optional | source=deploy only: target deploy environment (default dev); also becomes the event apiEnvironment. |
| `confirmProduction` | `boolean` | Optional | source=deploy only: required true to deploy to prod, else fails closed. |
| `organisationManagedSecretId` | `integer` | Optional | Optional org managed secret id to verify request authenticity; only its id is handled, never logged. |
| `label` | `string` | Optional | Optional label to identify the event. |
| `replaceIndex` | `integer` | Optional | Replace the event at this index; omit to append. Never guessed. |
| `overrideLock` | `boolean` | Optional | Explicit permission to override a form lock; defaults to false, never set implicitly. |
| `conditionallyExecute` | `boolean` | Optional | Whether the event runs only when its conditions are met. |
| `isRetryable` | `boolean` | Optional | Whether a failed event delivery is retried. |
