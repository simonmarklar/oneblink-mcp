# upsert_email_submission_event

Add or update an email or PDF submission event on a form's workflow, creating or reusing the Email Template and Custom PDF configuration it needs. It loads the form, resolves the template in the form's own environment, splices the event in, and saves the form. An existing event is only replaced when an explicit replaceIndex is given (never guessed), and a locked form stops with a permission request unless overrideLock is explicitly set.

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `formId` | `integer (>0)` | Required | The form whose submission events are being edited. |
| `eventType` | `enum: EMAIL | PDF` | Optional | EMAIL = email with optional PDF attachments; PDF (default) = email with a submission PDF. |
| `email` | `object { toEmail[], ccEmail?, bccEmail?, subjectLine? }` | Required | Email recipients and subject; at least one toEmail address is required. |
| `pdf` | `object { fileName?, includeSubmissionId?, includeExternalId?, excludedElementIds?, excludedCSSClasses? }` | Optional | The Custom PDF configuration for the generated submission PDF. |
| `emailTemplate` | `object { id } | { name, bodyHtml, type? }` | Optional | Link an existing template by id, or create/update one by name and HTML body. |
| `replaceIndex` | `integer (>=0)` | Optional | Replace the event at this index; omit to append. Never guessed. |
| `overrideLock` | `boolean` | Optional | Explicit permission to override a form lock (default false). Never set implicitly. |
| `conditionallyExecute` | `boolean` | Optional | Whether the event runs only when its conditional predicates pass. |
| `isRetryable` | `boolean` | Optional | Whether the event is retried on failure (default true). |
