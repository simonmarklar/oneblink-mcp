---
inclusion: always
status: accepted
last_verified: 2026-10-11
verified_against:
  - "steering tool-design.md rule 6 (SDK-ground-truth)"
  - "research: ai-meta-file-validation/FINDINGS.md"
---

# Meta-File Convention

How every meta file in this project is WRITTEN — steering, skills (`SKILL.md`),
and requirement specs (`docs/requirements/*.md`). These files instruct an AI
agent that will CONFORM to them, so a wrong or over-specified instruction
silently propagates to every consumer. Pairs with `tool-design.md` (esp. rule 6)
and `writing-style.md`.

Scoping (`inclusion:`) controls WHEN a file loads, never WHETHER it is true. It
is not a validation mechanism — a perfectly scoped file can still be wrong.

## 1. Describe intent; reference the source of truth — don't copy its values

Prescribe the POLICY, describe the MECHANISM by reference. Never hard-code a
value, formula, or shape the underlying system (SDK, API, type) already owns —
a copy is a second source of truth that drifts the moment it's wrong.

- Say "use the SDK's `meta.nextOffset`", not "`nextOffset = len === limit ? ...`".
- For anything that must be exact, point at the authoritative file/type rather
  than reproducing it.
- (This is `tool-design.md` rule 6 applied to the docs themselves.)

## 2. Verify before you encode; mark what's unverified

Confirm a return field, type, or behaviour against the SDK's `.d.ts` or a live
probe BEFORE a meta file asserts it. Assuming a SHAPE to design against is fine;
asserting a specific field's SEMANTICS without checking is the failure this
convention exists to prevent.

If a claim is written unverified, mark it inline: `> UNVERIFIED: <what to check>`.
An unverified claim is a known debt, not a silent landmine.

## 3. Tag every code block run-vs-read and illustrative-vs-canonical

Ambiguity makes an agent copy a snippet verbatim. Each fenced block in a meta
file declares its intent:

- **`illustrative`** — shows the shape; the canonical form lives in real code.
  The agent adapts it, never pastes it verbatim. This is the default.
- **`canonical`** — the exact required form. Rare — prefer linking to a tested
  source file instead of freezing code in prose.

Mark it in the fence info or a one-line lead-in, e.g. ```ts illustrative``` or
"Illustrative — the SDK owns the cursor:".

## 4. Status + provenance frontmatter

Every meta file carries YAML frontmatter beyond its scoping:

| Field | Meaning |
|---|---|
| `status` | `proposed` \| `accepted` \| `deprecated` \| `superseded` |
| `last_verified` | ISO date or git SHA when the claims were last checked against reality |
| `verified_against` | list — what makes the claims true (SDK type, probe, another doc) |

Lifecycle is **append-only (ADR discipline)**: a reversed decision is a NEW file
(or section) that supersedes and links the old, not a silent in-place edit — the
history of *why* must survive.

## 5. When reality and a meta file disagree, reality wins

If the SDK/API/type contradicts a meta file, the meta file is the bug. Fix the
doc (and bump `last_verified`), don't bend the code to a stale instruction.

## Checklist for writing/editing a meta file

- [ ] Values the system owns are referenced, not copied (rule 1)
- [ ] Claims verified against the SDK/type/probe, or marked `UNVERIFIED` (rule 2)
- [ ] Code blocks tagged illustrative vs canonical (rule 3)
- [ ] Frontmatter has `status` + `last_verified` (+ `verified_against`) (rule 4)
- [ ] Reversals supersede, not silently edit (rule 4)
