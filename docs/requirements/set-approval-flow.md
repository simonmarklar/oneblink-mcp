---
status: proposed
last_verified: 2026-10-11
verified_against:
  - "@oneblink/sdk Forms.getForm(id, injectForms?)/updateForm(form, overrideLock?) - read 2026-10-11"
  - "@oneblink/types approvals.d.ts: FormApprovalFlowStep (STANDARD|CONCURRENT), FormApprovalFlowNodeBase {label,group,approvalFormId?,...}, FormApprovalCannedResponse - read 2026-10-11"
  - "@oneblink/types forms.d.ts L1774-1777: Form.approvalSteps?: FormApprovalFlowStep[]; Form.approvalConfiguration? - read 2026-10-11"
  - "NO live probe yet - status proposed until a form with an approval flow is written end-to-end"
---

# Requirements: `set_approval_flow`

**Status:** Draft for review (proposed - not yet live-verified)
**Feature:** Set (replace) the approval flow configuration on a form - the
ordered `approvalSteps` and optional whole-flow `approvalConfiguration`.
**Purpose:** Second class of form-definition write (after submission events).
Configures *who approves a submission and in what order*; it does NOT create,
approve, or deny an actual submission approval - that is operator action in the
Approvals app and is not in the server SDK (see `investigate` finding).

Conforms to steering: `security.md`, `tool-design.md`, `writing-style.md`,
`meta-files.md`. States only what is specific to this tool.

## Key SDK facts (verified against types; live probe pending)

OneBlink has **no** "set approval flow" endpoint. The flow lives on the **form
definition**: `getForm(id)` -> mutate `form.approvalSteps` -> `updateForm(form,
overrideLock?)`. Identical mutate-in-place pattern to `upsert_email_submission_event`.

### `approvalSteps: FormApprovalFlowStep[]`

Each step is one of two shapes (discriminated by `type`):

| `type` | Meaning | Shape |
|---|---|---|
| `'STANDARD'` (or omitted) | one approver group, sequential | `FormApprovalFlowNodeBase` fields inline on the step |
| `'CONCURRENT'` | several groups approve in parallel before the flow advances | `{ type:'CONCURRENT', nodes: FormApprovalFlowNodeBase[] }` |

`FormApprovalFlowNodeBase`:
- `label: string` - **required**, unique within the flow.
- `group: string` - **required**, the group assigned the approval for this node.
- `approvalFormId?: number` - a form the approver submits alongside the approval.
- `approvalFormPrefillMappings?` - requires `approvalFormId`; prefill mapping.
- `hideApprovalDenyButton?: boolean`.
- `editableFormElementIds?: string[]` - element ids the approver may edit (must
  be non-empty when present; omitted => approver edits nothing).

A STANDARD step additionally allows conditional-skip fields on the node
(`isConditional`, `requiresAllConditionalPredicates`, `conditionalPredicates`).

### `approvalConfiguration?` (whole-flow options; optional)

Carries canned responses, auto-deny-after-clarification, default notification
element, template ids, etc. Out of scope for v1 beyond a pass-through: this tool
writes it only if the caller supplies the whole object (no partial-merge magic).

## Decisions

- **D1 - Replace, not append.** Unlike submission events (ordered, additive), an
  approval flow is a single ordered sequence a user reasons about as a whole.
  The tool **replaces** `approvalSteps` wholesale with the supplied array. No
  `replaceIndex`. Rationale: appending one step to a flow is rarely meaningful
  and "insert at position" invites the model to guess order. Supply the whole
  intended flow.
- **D2 - Honour the form lock.** Same as submission events: try `updateForm`
  without override; on a lock error STOP and ask for permission unless the
  caller explicitly passed `overrideLock: true`. Reuse `isFormLockedError`.
- **D3 - Validate step integrity before any write (fail closed).**
  - >= 1 step required (reject empty - use a dedicated clear path if ever needed).
  - Every `label` non-empty and **unique across the whole flow** (including
    inside CONCURRENT `nodes`); OneBlink keys instance state off label.
  - Every `group` non-empty.
  - `approvalFormPrefillMappings` only allowed when `approvalFormId` is set.
  - `editableFormElementIds`, when present, non-empty.
  - A CONCURRENT step has >= 1 node; a STANDARD step is a single node.
  These are validated by a **pure helper** (`buildApprovalSteps`) with unit
  tests - no SDK, no I/O - mirroring `buildSubmissionEvent`.
- **D4 - approvalFormId not cross-checked against the org (v1).** We do not
  verify the referenced form exists / is in the same environment. Rationale:
  that is a second round-trip per node and OneBlink validates on save; a bad id
  fails the `updateForm` and we surface it. Documented limitation, revisit if it
  bites.
- **D5 - approvalConfiguration pass-through only.** Written verbatim when
  supplied; otherwise left untouched (we preserve the form's existing value).
  No field-level validation in v1 - it is a large optional config object and
  OneBlink validates it.

## Input

| Field | Type | Req | Notes |
|---|---|---|---|
| `formId` | number (int > 0) | yes | the form to configure |
| `steps` | array (>= 1) | yes | the full ordered flow; replaces existing (D1) |
| `steps[].type` | `'STANDARD' \| 'CONCURRENT'` | no | default STANDARD |
| `steps[].label` | string | STANDARD | unique across flow (D3) |
| `steps[].group` | string | STANDARD | approver group |
| `steps[].approvalFormId` | number | no | approver-submitted form |
| `steps[].hideApprovalDenyButton` | boolean | no | |
| `steps[].editableFormElementIds` | string[] | no | non-empty when present |
| `steps[].nodes` | node[] | CONCURRENT | >= 1 node (each: label/group/...) |
| `approvalConfiguration` | object | no | whole-flow config, pass-through (D5) |
| `overrideLock` | boolean (default false) | no | explicit lock override (D2) |

## Output (projection - rule 3)

Never the whole form. Return:

```json
{
  "formId": 123,
  "action": "replaced",
  "stepCount": 2,
  "labels": ["Manager Review", "Finance"],
  "approvalConfigurationWritten": false
}
```

## Security notes

- A01 (BOLA): `formId` is authorized by the Developer Key server-side; no
  org/principal id is a tool argument (tool-design rule 1).
- A08 (integrity): full-flow replace + fail-closed validation prevents a
  half-applied flow; the lock gate (D2) prevents clobbering a form being edited.
- A09 (logging): log `formId`, `stepCount`, labels, action - never submission
  data or the raw form.

## Open questions

- OQ1: should there be a `clear_approval_flow` (set to `[]`)? Deferred - no
  demand yet, and an empty array is a destructive change wanting its own gate.
- OQ2: validate `approvalFormId` existence (D4)? Deferred.
- OQ3: live-verify against a real form, then flip status accepted + add the
  live-probe line to `verified_against`.
