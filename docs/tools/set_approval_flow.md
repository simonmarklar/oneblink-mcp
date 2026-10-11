# set_approval_flow

Set (replace) the whole approval flow on a form - the ordered approvalSteps that decide which group approves a submission and in what order (STANDARD = sequential, CONCURRENT = parallel groups). Reach for it to configure who approves and in what sequence; it reads the form, replaces approvalSteps (not additive), optionally writes approvalConfiguration, and saves, stopping with a permission request if the form is locked. It does NOT approve or deny actual submissions - that is an Approvals-app operator action outside the SDK.

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `formId` | `integer` | Required | Id of the form whose approval flow is being set. |
| `steps` | `object[]` | Required | The full ordered approval flow; REPLACES the existing flow. Each step: label, group, type (STANDARD|CONCURRENT), optional nodes[] (CONCURRENT), conditional fields. |
| `approvalConfiguration` | `object` | Optional | Whole-flow config written verbatim when supplied; left untouched otherwise. |
| `overrideLock` | `boolean` | Optional | Explicit permission to override a form-builder lock; defaults to false, never set implicitly. |
