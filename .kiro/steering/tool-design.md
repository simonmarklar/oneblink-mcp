---
inclusion: always
status: accepted
last_verified: 2026-10-11
verified_against:
  - "rule 6 confirmed live: @oneblink/sdk search results carry meta.nextOffset (2026-10-11)"
  - "rules 1-5: design decisions Q1-Q5 + auth-session.md"
---

# Tool Design

Cross-cutting rules for every MCP tool (workflow) in this server. Feature specs
apply these; they don't re-argue them. Pairs with `security.md` and
`writing-style.md`.

## 1. Authority derives from the credential (Q1)

Org / tenant / principal scope comes from the authenticated Developer Key — the
server's source of truth. Never require a caller-supplied identifier that only
echoes what the key already encodes.

- A required `organisationId` is **theatre** against a compromised key: the
  attacker holds the key, can read its org, and echoes it; `arg.org == key.org`
  passes for thief and owner alike. (OWASP API1:2023 BOLA — comparing a
  client-supplied id to the session's own identity "isn't a sufficient
  solution".)
- Real compromised-key controls live on the credential, not the call:
  revocation/rotation, short-lived creds, least-privilege scoping, signed
  requests w/ nonce, rate limiting.
- The genuine MCP risk is the **model drifting onto the wrong id** (hallucination
  / prompt injection). Mitigation: derive the id server-side, never from the
  model.
- **Pattern:** derive scope from the key. If a scope id *can* legitimately vary
  (multi-object/multi-tenant key), the server must authorize the principal for
  that specific object (BOLA/BFLA) — a real check, not an echo.
- **Optional defense-in-depth:** a tool MAY accept such an id as *optional* and
  **fail closed on mismatch** — catches honest caller/model error without taxing
  every call. Never make it required.

## 2. Bounded scope — no unbounded fan-out (Q2)

List/search tools require **at least one meaningful scope filter**. Reject a call
that would enumerate an entire org by default (fail closed). Which filters, and
whether ≥1 of several, is per-spec.

## 3. Deliberate output projection (Q3)

Return a **documented, non-sensitive projection** — never the raw SDK payload by
default. Data minimisation: large/raw objects embed config and PII we don't need
for the task, and leak into logs/results. The projection's field list is
per-spec. (Same instinct as the A09 logging rule, applied to outputs.)

### Caller-selectable fields (every list/search tool)

Tools accept an optional `fields: string[]` input to override the default
projection. Rules:

- **Top-level properties only.** Reject nested paths (`a.b`) and unknown field
  names — fail closed with the list of allowed fields.
- **Default** = the spec's documented projection when `fields` is omitted.
- **Value coercion** (never return raw nested data — keeps rule 3 + data
  minimisation intact):
  - scalar → the value
  - array → its **length** (number of elements)
  - object → its **type name**, else the literal string `[Object]`
- Allowed field set and type-name source are per-spec.

This is a single pattern — specs reference it, they don't redefine it.

## 4. Bounded & pageable results (Q4)

List/search tools must handle large result sets (thousands) without dumping
everything unframed. Support **both**:

- **Paged (default)** — offset/limit with a capped page size, `meta` carrying
  `nextOffset`. For interactive callers.
- **JSONL stream mode** — one JSON object per line for bulk export, when the
  caller opts in.

The *procedure* (page caps, cursor/`meta` shape, JSONL framing) lives in the
`oneblink-list-pagination` skill — follow it instead of re-deriving per tool.

## 5. Two-credential separation (auth)

Caller auth and OneBlink auth are **separate credentials for separate hops** —
never conflate them. Spec: `docs/requirements/auth-session.md`.

- Caller → server: the caller supplies its OneBlink Developer Key per session
  via request headers (`X-OneBlink-Access-Key` / `X-OneBlink-Secret-Key`, and
  optionally the `X-OneBlink-CLI-*` deploy pair). HTTP-only; fail closed (401)
  when a required header is absent.
- Server → OneBlink: the static HMAC Developer Key is the caller's own,
  supplied on the request. It is bound only for that request's context, never a
  tool argument, never returned to the client, never logged. The server holds
  no keys of its own.
- A tool never sees raw credentials as arguments. It asks `getClient()` for a
  service; the client factory owns the key from the per-request context.
  Changing the credential source must not touch workflow code.

## 6. Contracts derive from the SDK, not from assumption

A tool's behaviour must match what the SDK **actually** returns — verified
against its types or a live call — not what a spec or skill *assumed* it returns.

- **Prefer the SDK's own value over a re-derived one.** When the SDK already
  provides a field (a pagination cursor like `meta.nextOffset`, a total, a
  server-computed flag), use it. Deriving a local substitute invents a second
  source of truth that drifts the moment the assumption is wrong — e.g.
  `nextOffset = length === limit ? ... : null` is wrong when the total is an
  exact multiple of the page size (it points at an empty page); the SDK's
  `nextOffset` is correct.
- **Verify shape before encoding it.** Before a spec/skill hard-codes a return
  field or its semantics, confirm it against the SDK's `.d.ts` or a probe call.
  Assuming a *shape* to design against is fine; asserting a *specific field's
  semantics* without checking is how the mismatch above happened.
- **Meta files describe intent, not brittle formulas.** A skill/spec should say
  "use the SDK's `nextOffset`; derive one only if the SDK gives none" — not paste
  a concrete formula the SDK already owns. If a doc and the SDK disagree, the SDK
  wins and the doc is the bug.
