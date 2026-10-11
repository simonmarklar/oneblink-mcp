---
status: proposed
last_verified: 2026-10-11
verified_against:
  - "@oneblink/sdk Forms.getForm/updateForm; EmailTemplates.create/update/search; submissionEvents.d.ts (PdfSubmissionEvent, EmailSubmissionEvent, PDFConfiguration, EmailConfiguration, customPdfId) — read 2026-10-11"
  - "forms.d.ts FormCustomPDF { id,label,s3,mapping }; form.customPDFs[]; aws.d.ts S3Configuration { bucket,key,region } — read 2026-10-11"
  - "live probe 2026-10-11: form 4768 type:'PDF' event; append/replace/converge verified end-to-end"
---

# Requirements: `upsert_email_submission_event`

**Status:** Draft for review
**Feature:** Add or update an email-type submission event on a form's workflow,
creating the Email Template and/or Custom PDF configuration it needs.
**Purpose:** First **write** tool. Everything prior is read-only; this mutates a
form definition, so it raises new concerns (optimistic locking, idempotency,
partial-failure across multiple SDK writes).

Conforms to steering: `security.md`, `tool-design.md`, `writing-style.md`,
`meta-files.md`. States only what is specific to this tool.

## Key SDK facts (verified)

OneBlink has **no** "add submission event" endpoint. A submission event lives on
the **form definition**: you `getForm(id)`, mutate `form.submissionEvents`, then
`updateForm(form, overrideLock?)`. Two relevant event shapes:

| Event `type` | Meaning | `configuration` |
|---|---|---|
| `'EMAIL'` | email the submitter/others; PDFs optional | `EmailConfiguration & { pdfConfigurations?: PDFConfiguration[] }` |
| `'PDF'` | email **with** a generated PDF of the submission | `PDFConfiguration & EmailConfiguration` |

`EmailConfiguration`: `toEmail[]`, `ccEmail[]`, `bccEmail[]`, `emailSubjectLine?`,
`emailTemplate?: { id, mapping? }` (reference to an Email Template), `email?`
(deprecated — never write it).

`PDFConfiguration` (OOTB submission PDF styling — NOT a "Custom PDF"):
`pdfFileName?`, `includeSubmissionIdInPdf?`, `includeExternalIdInPdf?`,
`excludedElementIds?`, `excludedCSSClasses?`, `usePagesBreaks?`,
`combineWithPdfAttachments?`, approval-inclusion fields. It ALSO carries the
Custom PDF link: **`customPdfId?: string`** and `isCustomPdfEditable?: boolean`.

**Custom PDF** (`FormTypes.FormCustomPDF`) — a reusable, S3-backed PDF template
defined ON THE FORM, referenced by an event via `configuration.customPdfId`.
Verified shape (`forms.d.ts`): `{ id: string, label: string, s3: { bucket, key,
region }, mapping: FormElementMapping[] }`. The form holds them in
`form.customPDFs?: FormCustomPDF[]`.

> IMPORTANT — the PDF **file** lives in S3 (`s3.{bucket,key,region}`), uploaded
> OUT OF BAND (OneBlink console). The SDK has NO "upload custom PDF file" method.
> So this tool can **reference or update** an existing Custom PDF on the form,
> and can **register** one only if the caller supplies the `s3` location of an
> already-uploaded template. It does not and cannot upload the PDF file itself.

**Email Template** (separate resource, `EmailTemplates` service):
`createEmailTemplate` / `updateEmailTemplate` / `searchEmailTemplates` /
`getEmailTemplate`. Shape: `{ id?, name, organisationId, workspaceIds[], environments: [{ template, formsAppEnvironmentId }], type }`
where `type` is e.g. `FORM_SUBMISSION_EVENT_PDF`. The event links a template by
`emailTemplate.id` (with a required `mapping` array, `[]` when no tags).

> NOTE: two different "PDF" concepts. `PDFConfiguration` = how the OOTB
> submission PDF is styled (exclusions, page breaks). `FormCustomPDF` = a
> pre-uploaded, mapped PDF **template** the event uses INSTEAD of the OOTB PDF,
> selected via `customPdfId`. This tool writes config/definitions; it never
> renders a PDF at runtime (that is `PDF.generatePDF()`, out of scope).

## Behaviour

Add-or-update one email/PDF submission event on a form, in one call:

1. `getForm(formId)` — load current definition (fail closed if the key lacks
   *Forms: Manager*).
2. Resolve the event to upsert. Matching an existing event to update vs adding a
   new one needs a stable key — see **Q1**.
3. If the event references an **Email Template** by name that doesn't exist (or
   the caller supplies template content), `createEmailTemplate`; if it exists
   and content changed, `updateEmailTemplate`. Link its `id` into the event's
   `emailTemplate.id`. (Create/update is **Email Templates: Manager**.)
4. If the caller supplies a **Custom PDF** (`customPdf`), upsert it into
   `form.customPDFs` (match by `id` or `label` — D6), then set the event's
   `configuration.customPdfId` to that PDF's id. If the caller references an
   existing Custom PDF by `id`/`label` only, link it without modifying it.
5. Build the event's `PDFConfiguration` (OOTB styling) from the caller's `pdf`
   fields, plus `customPdfId`/`isCustomPdfEditable` when a Custom PDF is used.
6. Splice the event into `form.submissionEvents` (replace at explicit index,
   else append — D1).
7. `updateForm(form, overrideLock)` — persist (one write carries BOTH the new
   `customPDFs` entry and the new submission event). Honour the form lock (D2).

Read-back the updated event and return a projection (steering rule 3), never the
whole form.

## Inputs (zod, draft)

- `formId` (required, int > 0) — scope filter (rule 2).
- `eventType`: `'EMAIL' | 'PDF'` (default `'PDF'`).
- `email`: `{ toEmail[], ccEmail?, bccEmail?, subjectLine? }` — at least one
  `toEmail` required.
- `pdf?`: `{ fileName?, includeSubmissionId?, includeExternalId?, excludedElementIds?, excludedCSSClasses?, usePagesBreaks?, combineWithPdfAttachments? }` — OOTB submission-PDF styling.
- `customPdf?`: ONE of —
  - `{ id }` or `{ label }` to **link an existing** Custom PDF on the form; OR
  - `{ label, s3: { bucket, key, region }, mapping?, id? }` to **register/update**
    one (the PDF file must already be uploaded to that S3 location — the tool
    does not upload it). `isEditable?` sets `isCustomPdfEditable`.
- `emailTemplate?`: either `{ id }` (link existing) OR
  `{ name, bodyHtml, formsAppEnvironmentId, type? }` (create/update). Mutually
  exclusive.
- `conditionallyExecute?`, `isRetryable?` — event-level flags (defaults match
  the live sample: `conditionallyExecute:false`, `isRetryable:true`).
- credentials/org are NOT inputs (rule 1 / security rule 3).

## Security (per security.md)

- **A01 Broken Access Control:** needs *Forms: Manager* and, for template
  writes, *Email Templates: Manager*. Document both; let the SDK fail closed —
  don't mask a permission error.
- **A08 Integrity / lost updates:** `updateForm` is read-modify-write — a stale
  copy clobbers concurrent edits. See Q2.
- **A09 logging:** log `formId`, `eventType`, template id, counts — never email
  addresses (PII), template bodies, or the raw form.
- **Fail closed:** validation or any SDK write error → error result; never a
  half-applied event.

## Resolved decisions

- **D1 — event identity:** caller passes an explicit `replaceIndex` to update an
  existing event; omitted = append. **Never guess** which event to replace.
- **D2 — form lock:** if `getForm`/`updateForm` reports the form is **locked**,
  the tool STOPS and returns a clear "form is locked by <holder>, needs
  permission to override" result. It does **not** unlock. The caller re-invokes
  with explicit `overrideLock: true` to grant permission. Never auto-override.
- **D3 — multi-write atomicity:** accept a possible orphan template on a failed
  form update; re-runs reuse the template by name (idempotent). No cleanup
  delete (could remove a shared template).
- **D4 — template environment:** create/update the Email Template in the **same
  environment as the form** — use `form.formsAppEnvironmentId` as the template's
  `environments[].formsAppEnvironmentId`. One environment entry, matching the form.
  `createEmailTemplate` also REQUIRES `workspaceIds: number[]` (verified via live
  409 "workspaceIds Required"); the form's workspace comes from its ENVIRONMENT
  (`getFormsAppEnvironment(envId).workspaceId`), not the form object (forms in
  env 380 carry `workspaceId: null`).
- **D5 — idempotency:** re-running the same call CONVERGES — reuse the template
  by name (D3), replace the event at `replaceIndex` (D1) — never duplicate.
- **D6 — Custom PDF identity:** match an existing `form.customPDFs` entry by
  explicit `id`, else by `label`. On create, generate a stable `id` (uuid) if
  none supplied. Re-running with the same `label` UPDATES in place (converge),
  never appends a duplicate. **Decision needed:** confirm label-match is
  acceptable, or require an explicit id like events do (D1). **Lean: match by
  id-or-label** — a Custom PDF has a human `label`, unlike the anonymous events.
- **D7 — Custom PDF S3 file is out of band (HARD CONSTRAINT):** `FormCustomPDF.s3`
  points at a PDF already uploaded to S3; the SDK offers no upload. The tool
  therefore CANNOT create a Custom PDF from a local file — the caller supplies
  the `s3` coordinates of a pre-uploaded template, or references an existing one.
  If a caller asks to "create a Custom PDF" with only content/no `s3`, fail
  closed with a clear message (upload via the console first). **Decision needed:**
  is "link/update existing + register-by-s3" sufficient, or do we need a separate
  upload path later (would require S3 PUT credentials — larger scope)?

## Acceptance criteria

- [ ] `getForm` → splice → `updateForm` round-trip adds/updates exactly one event.
- [ ] Email Template created when absent, linked by id; reused when present.
- [ ] Custom PDF upserted into `form.customPDFs` (match id/label), event's
      `customPdfId` set to its id; register-by-s3 and link-existing both work.
- [ ] "Create Custom PDF" with no `s3` fails closed with an upload-first message (D7).
- [ ] OOTB `PDFConfiguration` styling written from `pdf` inputs.
- [ ] Lock handling per Q2; no silent clobber.
- [ ] No PII/body/raw-form in logs.
- [ ] Partial-failure leaves no half-applied event (fail closed).
- [ ] Returns a projection of the upserted event, not the whole form.
- [ ] Unit tests for event-splice (add vs replace) + input validation; live test
      against a scratch form.
