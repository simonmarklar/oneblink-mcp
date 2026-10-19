# create_email_template

Create a reusable OneBlink email template that a PDF or email submission event can later reference by templateId. Supply a name, an SDK-authoritative template type, and one or more per-environment template bodies; the organisation is derived from the authenticated Developer Key, never passed in. Reach for it to close the create-then-reference loop before wiring an email submission event.

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Required | Email template name. |
| `workspaceIds` | `integer[]` | Required | Workspace id(s) the template belongs to (at least one); discover ids with list_workspaces. Required by the API. |
| `type` | `enum (7 values)` | Required | The template type (SDK-authoritative union): FORM_SUBMISSION_EVENT_PDF, FORMS_APP_WELCOME_EMAIL, APPROVAL_CLARIFICATION_REQUEST, APPROVAL_APPROVED, APPROVAL_DENIED, TO_APPROVER_APPROVAL_CREATED, FORM_SUBMISSION_EVENT_EMAIL. An unknown value is rejected fail-fast. |
| `environments` | `object[]` | Required | At least one per-environment body: each { formsAppEnvironmentId: number, template: string }; formsAppEnvironmentId must be unique and template non-empty. |
