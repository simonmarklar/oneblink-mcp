---
status: accepted
last_verified: 2026-10-14
verified_against:
  - "SDK: FormElementLists.createFormElementList(newFormElementList: FormTypes.NewFormElementOptionSet): Promise<FormTypes.FormElementOptionSet> (tenants/classes/FormElementLists.d.ts)"
  - "Types: NewFormElementOptionSetStatic = NewFormElementOptionSetBase & { type: 'STATIC' | 'HCMS_CATEGORIES'; environments: FormElementOptionSetEnvironmentStatic[] } (forms.d.ts:1973)"
  - "Types: NewFormElementOptionSetBase = WithOrganisationAssociation & WithWorkspacesAssociation & { name: string } (forms.d.ts:1963)"
  - "Types: FormElementOptionSetEnvironmentStatic = { options: DynamicChoiceElementOption[]; formsAppEnvironmentId: number } (forms.d.ts:1969)"
  - "Types: FormElementOptionSetStatic = IdResource & NewFormElementOptionSetStatic (returns id) (forms.d.ts:1977)"
  - "Consumer: FormElementWithOptionsBase.dynamicOptionSetId + optionsType:'DYNAMIC' (forms.d.ts:275,283)"
  - "LIVE-VERIFIED 2026-10-14 against the OneBlink Console: create returned numeric id (1732); return shape {type,environments,name,organisationId,workspaceIds,id,createdAt,updatedAt}; created list then deleted (no artifact)."
  - "LIVE FINDING: workspaceIds (WithWorkspacesAssociation, misc.d.ts:275) is REQUIRED and must be NON-EMPTY — omitting it 400s (\"workspaceIds\" Required); an empty [] 500s. It is a required, non-empty tool input."
---

# create_element_list

Create a reusable **STATIC** element option set ("element list") so a form
element can reference it by id (`dynamicOptionSetId` + `optionsType: 'DYNAMIC'`)
instead of carrying inline `CUSTOM` options.

## Intent

A form author wants the same option set (e.g. a states list) across many
elements/forms. Today `create_form` can only emit inline `CUSTOM` options; a
reusable DYNAMIC set has no id source. This tool is that source: create the list,
get back its `id`, feed the id to a form element.

Scope = this release handles `type: 'STATIC'` only. URL / HOSTED_API / SharePoint
/ Salesforce / GoodToGo option-set types are out of scope (separate tools later).

## SDK call

`getClient().formElementLists().createFormElementList(newFormElementList)`

The client factory does NOT yet expose `formElementLists()` — the builder
(`src/lib/oneblink-client.ts`) must add it alongside the existing `forms()` /
`formsAppEnvironments()` / `emailTemplates()` accessors (same construction from
`sdkOptions`). This is a shared prerequisite for items 1-4.

## Input schema

| arg | type | req | notes |
| --- | --- | --- | --- |
| `name` | string (min 1) | yes | human-readable list name |
| `workspaceIds` | `number[]` (non-empty) | yes | workspace id(s) the list belongs to; discover with `list_workspaces`. **API-required and must be non-empty** — omitting 400s, empty `[]` 500s (live-verified) |
| `environments` | `{ formsAppEnvironmentId: number; options: string }[]` | yes (min 1) | per-environment option sets; `options` uses the **same cell syntax** as `create_form` (`Label:value|Label2` pipe- or comma-separated) |
| `type` | enum `'STATIC'` | no, default `'STATIC'` | only STATIC this release; reject others fail-fast |

- `organisationId` is NOT an input — derive server-side (steering rule 1), the
  same way `create_form` does (read org off one existing form via
  `forms().searchForms({limit:1})`; fail closed if none).
- `formsAppEnvironmentId` IS a legitimate per-environment scope input; discover
  ids with `list_forms_app_environments`.
- Reuse the options-cell parser from `src/lib/form-elements-csv.ts`
  (`parseOptions` / `splitTopLevel`) — do not reinvent. Each parsed
  `{label,value}` maps to a `DynamicChoiceElementOption` `{label,value}`.

## Validation (fail-fast, before any API call)

- `environments` non-empty; every entry has a positive int
  `formsAppEnvironmentId` and a non-empty `options` cell that parses to >=1
  option. Collect ALL errors with the shared `{column,value,error,fixHint}`
  shape, never stop at first (D7 convention).
- Duplicate `formsAppEnvironmentId` across entries -> fail-fast.
- Unknown `type` -> fail-fast with allowed set.

## Output projection (steering rule 3)

Never the raw `FormElementOptionSet`. Return:

```json
{ "id": 123, "name": "...", "type": "STATIC", "environmentCount": 1 }
```

The `id` is the value a form element uses as `dynamicOptionSetId`.

## Security (OWASP)

- A01/API1: no `organisationId` arg; derived server-side.
- A03: options parsed by the existing hand-rolled parser, no eval.
- A09: log `{id, type, environmentCount}` only — never option labels/values.

## Definition of Done

- `create_element_list` registered in `src/workflows/index.ts`.
- `formElementLists()` accessor added to `oneblink-client.ts` + its interface.
- Unit tests: valid STATIC create (mocked SDK) returns projection; empty
  environments rejected; duplicate env rejected; bad options cell rejected;
  non-STATIC type rejected; org-derivation failure path.
- `npm run typecheck` + `npm test` green.
- `docs/tools/create_element_list.md` generated (tool-docs skill).
- Live-verify the return `id` field + env shape against a real create, then flip
  frontmatter `status: accepted` with the verified line (steering rule 6).

## Files

```
src/lib/oneblink-client.ts            # add formElementLists() accessor (shared 1-4)
src/workflows/create-element-list.ts  # the tool
test/create-element-list.test.ts
docs/tools/create_element_list.md
```
