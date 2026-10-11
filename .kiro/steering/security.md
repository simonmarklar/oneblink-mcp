---
inclusion: always
status: accepted
last_verified: 2026-10-11
verified_against:
  - "OWASP Top 10 2025 references; design preferences (no SDK-shape claims)"
  - "in-practice notes match src/lib/config.ts + src/lib/logger.ts"
---

# Security Requirements

These requirements apply to the planning and implementation of **every** feature
in the OneBlink MCP server. Treat them as acceptance criteria, not aspirations:
a change that violates one of these rules is not done.

## 1. Security is a planning-time concern (OWASP Top 10)

Security — especially the [OWASP Top 10](https://top10.owasp.org/2025/) — MUST
be a key consideration when planning and implementing a feature, not something
bolted on afterwards.

**Why:** Addressing security at planning time reduces costs and the need to
rework.

**In practice for this project:**
- When defining a new workflow's requirements, explicitly note which OWASP Top
  10 categories it touches (e.g. a workflow that accepts a form id touches
  A01 Broken Access Control; one that forwards user input to the SDK touches
  A03 Injection).
- Validate and constrain all tool inputs at the boundary (we use `zod`
  schemas per workflow).
- Fail closed: on an auth or validation error, return an error result — never a
  partial or best-effort action.

**OneBlink Developer Key permissions (A01 Broken Access Control):** every SDK
action is gated by the Developer Key's **role permissions** and **app
associations** (see the [SDK docs](https://oneblink.github.io/sdk-node-js/)).
When defining a workflow, document its **minimum role permission** (e.g.
*Forms: Read Only*) and whether it requires an **app association**. Do not
assume a key can do what a workflow needs — surface the required permission in
the workflow's requirements and let the SDK's authorization fail closed rather
than catching and masking a permissions error.

## 2. No PII or secrets in logs (OWASP A09)

Logs MUST NOT contain personally identifiable information (PII) or secrets —
e.g. tokens, user profile details, or full request/response bodies.

**However, do not simply delete a log to fix this.** Prefer replacing it with a
log of non-PII, non-sensitive details that preserve its diagnostic value:
- a user id or opaque identifier instead of the full user profile,
- an error message or status code instead of the raw error object,
- a count or a resource id instead of the full response body.

Only remove the log entirely when no useful non-sensitive detail remains.

**Why:** Logs are important for diagnosing issues, so we want to keep them
useful while avoiding leaking sensitive data (OWASP A09:2021 — Security Logging
and Monitoring Failures).

**In practice for this project:**
- Log through `src/lib/logger.ts`, which accepts only scalar fields to
  discourage dumping arbitrary objects.
- The MCP server writes diagnostics to **stderr**; stdout is reserved for the
  transport. Never log a secret.
- When logging an SDK error, log its message and/or status code, not the raw
  error or the request that caused it.

## 3. Environment variables are for per-environment values only

Environment variables should only be used for variables that change **per forms
app environment** — e.g. form ids, forms-app ids, and credentials.

They should **not** be used for common variables — e.g. search parameters like
`limit` / `offset`, or any value that does not change per environment. Those
belong in the individual workflow's tool inputs instead.

**Why:** It is easier to understand the system when we do not have to
cross-reference external variables stored in a system like GitHub Actions
secrets or variables.

**In practice for this project:**
- Per-environment config is defined and validated in `src/lib/config.ts`. Do
  not add request-shaping options (page size, filters, sort order) to that
  schema.
- A new operational parameter is a workflow tool input (a `zod` field), not a
  new environment variable.
- If you are unsure whether something is "per-environment": ask "would this
  differ between the dev and prod OneBlink environments?" If no, it is a tool
  input.
