---
status: accepted
last_verified: 2026-10-11
verified_against:
  - "SDK: @oneblink/sdk v13 Forms.createForm(newForm: FormTypes.NewForm): Promise<Form> (tenants/classes/Forms.d.ts:594)"
  - "Types: @oneblink/types FormElementType = FormElement['type'] (typescript/forms.d.ts:1592)"
  - "Types: NewForm requires name/description/formsAppIds/elements/isAuthenticated/isMultiPage/postSubmissionAction/cancelAction (forms.d.ts:1708)"
  - "LIVE (2026-10-11, env 457): createForm REQUIRES organisationId + formsAppEnvironmentId; org derived server-side from an existing form. Verified end-to-end: form 37280, template 671, PDF email event attached."
  - "Types: PageElement & SectionElement are FormElementWithoutName (no name prop); page only at root, never nested; isMultiPage=true => root is all pages (forms.d.ts:792, 1586)"
  - "Types: options-bearing = radio|checkboxes|select|autocomplete|compliance via FormElementWithOptionsBase (optionsType CUSTOM for inline) (forms.d.ts:262)"
  - "Types: container children live on _NestedElementsElement.elements (section|page|repeatableSet) and FormFormElement.elements (form|infoPage) (forms.d.ts:733)"
---

# create_form

Create a OneBlink form from either a human-authored **CSV** of element rows or a
**well-defined** `FormElement[]` definition. Both modes converge on one
normalizer and one SDK call (`Forms.createForm`).

## Intent

A spreadsheet author lists elements (label, type, required, options, parent) and
exports CSV; a developer passes a real `FormElement[]`. The tool scaffolds the
surrounding `NewForm` from structured args, compiles/normalizes the elements, and
creates the form. Everything is validated **fail-fast** before any API call, with
errors a human can read AND a machine can autofix.

## Input modes (exactly one element source)

| source arg      | audience            | content                 |
| --------------- | ------------------- | ----------------------- |
| `elementsCsv`   | spreadsheet authors | CSV text                |
| `elements`      | devs / machines     | SDK `FormElement[]` JSON |

Both omitted OR both present -> fail-fast (`element_source` error). No precedence.

`elementsCsv` is sugar that COMPILES to the same `FormElement[]` the `elements`
mode accepts, then both run the shared normalizer. "Mode A emits Mode B's input."

## Form scaffold args (both modes)

Required (map 1:1 to `NewForm`): `name`, `description`, `formsAppEnvironmentId`,
`formsAppIds: number[]`, `isAuthenticated: boolean`, `postSubmissionAction`,
`cancelAction`. Optional pass-through: `redirectUrl`. `submissionEvents` is set
to `[]` (attach events with `upsert_email_submission_event` afterwards).

`organisationId` is NOT accepted as a model input (steering rule 1). The live
API REQUIRES it on create (verified: `createForm` rejects with
`"organisationId" is required`), so the tool DERIVES it server-side from the
authenticated principal — it reads the org off one existing form the key can
see (`searchForms` -> `form.organisationId`). This keeps authority on the
credential, not the call.

`formsAppEnvironmentId` IS a required input: a form must be created in a specific
environment, and that is a legitimate per-form scope (not an identity echo).
Discover ids with `list_forms_app_environments`.

## CSV schema (one row per element, containers included)

Header-driven, order-independent. Core columns:

| column    | required | meaning                                                            |
| --------- | -------- | ------------------------------------------------------------------ |
| `label`   | yes      | display text; also the row's identity for `parent` references      |
| `type`    | yes      | matched case-insensitively to an SDK `FormElementType` (D1)        |
| `parent`  | no       | `label` of the container row this nests under; empty = form root   |
| `required`| no       | `true`/`false` -> SDK `required` (only on types that support it)   |
| `options` | no       | options-bearing types; comma tokens `label:value` or bare `label`  |
| `prop:*`  | no       | pass-through SDK prop, coerced (bool/number/json), SDK-validated   |

### Options cell syntax (D3)

Comma-separated tokens, each `label:value` or bare `label` (value defaults to
label). Example: `Red:red, Green:green, Blue` -> three `ChoiceElementOption`
`{id,label,value}`. Only valid on options-bearing types
(`radio|checkboxes|select|autocomplete|compliance`); those auto-set
`optionsType: 'CUSTOM'`. Options on a non-options type -> fail-fast.

## Decisions

- **D1 Type vocabulary — SDK-derived, never hard-coded.** The valid type set is
  generated from `@oneblink/types` `FormElementType` via the TS compiler API into
  a committed constant (`src/lib/generated/form-element-types.ts`). Input is
  lowercased and matched case-insensitively. New SDK types flow in on regen. An
  unknown type fails fast with the allowed set + a closest-match suggestion.
- **D2 name generation.** `label` -> snake_case, strip non-alphanumeric,
  collapse runs of `_`, lowercase; collision-suffix (`_2`, `_3`). SDK `name`
  regex is `[a-zA-Z\d_-]+` so snake_case is safe. Containers `page`/`section`
  have NO `name` (SDK `FormElementWithoutName`): id only, addressed by label.
- **D3 options** — see syntax above.
- **D4 containers / nesting.** Each container is its own row; children set
  `parent` = container label. Tree built from parent links. Enforced fail-fast:
  unknown parent label, cycle, duplicate label (ambiguous parent target), a
  `parent` pointing at a non-container type.
- **D5 isMultiPage.** CSV mode: inferred — any `type=page` row => `true` and all
  root rows must be pages; else `false`. `elements` mode: caller sets it, we
  validate (`page` only at root; root all-pages iff `true`; no nested `page`).
  Explicit caller override allowed but still validated.
- **D6 normalizer is shared.** Whichever mode supplies the array, missing `id`s
  are assigned (globally unique in form) and missing `name`s derived (D2); then
  structural validation (D4/D5) + duplicate-name check run. A raw `elements`
  definition does not have to be perfectly complete, just well-defined.
- **D7 validation + autofix affordance.** Validate the WHOLE input first; collect
  ALL errors (never stop at first). Each error carries `row`/`column`/`value`,
  a human `error` string, and machine `suggestion` / `allowedTypes` / `fixHint`.
  Nothing reaches `createForm` until clean.

## Error object shape (D7)

```json
{
  "row": 7,
  "column": "type",
  "value": "txt",
  "error": "Unknown element type 'txt'.",
  "suggestion": "text",
  "allowedTypes": ["text", "textarea", "email", "..."],
  "fixHint": "Set 'type' to one of allowedTypes."
}
```

Non-CSV (`elements`-mode / structural) errors omit `row`/`column` and use a
`path` (e.g. `elements[2].parent`).

## Output projection (steering rule 3)

Never the raw created `Form`. Return:

```json
{
  "formId": 1234,
  "name": "...",
  "isMultiPage": false,
  "elementCount": 12,
  "source": "csv" | "definition",
  "rootElementIds": ["..."]
}
```

## Security (OWASP)

- A01/API1: no `organisationId` arg; the tool derives it server-side from the
  authenticated principal (reads it off an existing form), so the model never
  supplies it.
- A03: CSV parsing is a hand-rolled RFC-4180-subset parser over strings, no eval;
  `prop:*` JSON values parsed with `JSON.parse` in a try/catch, never `eval`.
- A09: never log CSV content or element labels at info; log counts + formId only.

## Files

```
scripts/gen-form-element-types.ts     # TS compiler API -> committed constant (D1)
src/lib/generated/form-element-types.ts  # GENERATED, committed
src/lib/form-elements-csv.ts          # CSV text -> FormElement[] | errors (pure)
src/lib/form-normalize.ts             # shared id/name backfill + structural checks
src/workflows/create-form.ts          # create_form tool
test/form-elements-csv.test.ts
test/form-normalize.test.ts
test/create-form.test.ts
```
