---
status: accepted
last_verified: 2026-10-14
verified_against:
  - "SDK: EmailTemplates.createEmailTemplate(data: EmailTemplateTypes.NewEmailTemplate): Promise<EmailTemplateTypes.EmailTemplate> (@oneblink/sdk tenants/classes/EmailTemplates.d.ts:70) — class ALREADY wired in oneblink-client.ts"
  - "type enum PINNED verbatim (7 values) from @oneblink/types typescript/emailTemplates.ts:17-24 (NewEmailTemplate.type union): FORM_SUBMISSION_EVENT_PDF | FORMS_APP_WELCOME_EMAIL | APPROVAL_CLARIFICATION_REQUEST | APPROVAL_APPROVED | APPROVAL_DENIED | TO_APPROVER_APPROVAL_CREATED | FORM_SUBMISSION_EVENT_EMAIL"
  - "NewEmailTemplate = WithOrganisationAssociation & WithWorkspacesAssociation & { name; environments: EmailTemplateEnvironment[]; type } (emailTemplates.ts:13-25); EmailTemplate adds { id:number; createdAt; updatedAt } (emailTemplates.ts:27-31); EmailTemplateEnvironment = WithEnvironmentAssociation & { template:string } (emailTemplates.ts:9-11); formsAppEnvironmentId:number / organisationId:string / workspaceIds:number[] (misc.d.ts:290/285/275)"
  - "Consumer: submission-event PDF/email templateId (upsert-email-submission-event workflow) references an email template id."
  - "LIVE-VERIFIED 2026-10-14 against the OneBlink Console: create returned numeric id (673) with type FORM_SUBMISSION_EVENT_PDF; return shape {name,environments,type,organisationId,workspaceIds,id,createdAt,updatedAt}; created template then deleted (no artifact)."
  - "LIVE FINDING: workspaceIds (WithWorkspacesAssociation, misc.d.ts:275) is REQUIRED and must be NON-EMPTY — omitting 400s, empty [] 500s. Earlier draft hardcoded workspaceIds:[] which would have 500'd live; now a required, non-empty tool input."
---

# create_email_template

Create a reusable email template so a PDF/email submission event can reference it
by `templateId`. Closes the create->reference loop for
`upsert_email_submission_event`.

## Intent

Email templates are a supporting resource submission events point at by id. The
`EmailTemplates` service is already wired in `oneblink-client.ts` but no CREATE
tool exists. This adds it.

## SDK call

`getClient().emailTemplates().createEmailTemplate(data)` — accessor already
present; no client-factory change needed (unlike items 1-4).

## Input schema

| arg | type | req | notes |
| --- | --- | --- | --- |
| `name` | string min 1 | yes | template name |
| `workspaceIds` | `number[]` (non-empty) | yes | workspace id(s) the template belongs to; discover with `list_workspaces`. **API-required, non-empty** — omitting 400s, empty `[]` 500s (live-verified) |
| `environments` | `{ formsAppEnvironmentId: number; template: string }[]` | yes min 1 | per-env template body; `template` supports `{{custom:tag}}` tokens (stored verbatim, SDK-validated) |
| `type` | string enum | yes | e.g. `FORM_SUBMISSION_EVENT_PDF` — SDK-authoritative 7-value enum, pinned from `emailTemplates.ts:17-24`; fail-fast on unknown with the allowed set |

- `organisationId` derived server-side (rule 1), not an input.
- Duplicate `formsAppEnvironmentId` -> fail-fast. Empty environments ->
  fail-fast. Empty `template` body -> fail-fast.
- Build NOTE: the valid `type` set is SDK-authoritative. Prefer deriving it from
  `EmailTemplateTypes` (same instinct as the form-element-type codegen) rather
  than hard-coding a guessed union (steering rule 6 / SDK-ground-truth lesson).
  If codegen is overkill for one enum, pin the union from the installed `.d.ts`
  and cite the exact line in frontmatter.

## Output projection (rule 3)

```json
{ "id": 1, "name": "...", "type": "FORM_SUBMISSION_EVENT_PDF", "environmentCount": 1 }
```

`id` is the value used as a submission-event `templateId`.

## Security (OWASP)

- A01/API1: org derived server-side.
- A03: template body stored verbatim; no eval, no interpolation server-side (the
  `{{custom:}}` tags are resolved by OneBlink's platform, not here).
- A09: log `{id, type, environmentCount}` only — never template bodies (may embed
  PII/custom content).

## Definition of Done

- `create_email_template` registered in `src/workflows/index.ts`.
- `type` enum sourced from SDK types (not guessed); cite line in frontmatter.
- Unit tests: valid create (mocked) returns projection; empty/duplicate env
  rejected; empty template rejected; unknown type rejected with allowed set;
  org-derivation failure path.
- `npm run typecheck` + `npm test` green.
- `docs/tools/create_email_template.md` generated.
- Live-verify return id + type enum, then flip `status: accepted`.

## Files

```
src/workflows/create-email-template.ts
test/create-email-template.test.ts
docs/tools/create_email_template.md
```
