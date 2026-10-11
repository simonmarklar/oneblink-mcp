# OneBlink MCP Server

A **Model Context Protocol (MCP)** server for the
[OneBlink Low-code Suite](https://oneblink.io/), built on the official
[`@oneblink/sdk`](https://github.com/oneblink/sdk-node-js).

## Design philosophy: workflow-focused, not a 1:1 SDK wrapper

This server does **not** expose the OneBlink SDK method-for-method. Instead each
MCP tool is a **workflow** — it groups several common SDK operations into a
single task an operator actually wants to perform.

> Bad (SDK mirror): `forms_updateForm`, `forms_getForm`, `forms_publishForm`
> Good (workflow):   `publish_form_and_verify` — updates, publishes, then
>                    confirms the form renders, in one call.

Workflows are defined one at a time: we agree the requirements for a workflow
first, then implement it. **No workflows are implemented yet** — this repository
is currently scaffolding.

## The underlying SDK

Built on [`@oneblink/sdk`](https://github.com/oneblink/sdk-node-js) (v13,
MIT, ESM, requires **Node.js 24+ / npm 11+**). The SDK is **multi-tenant** —
`oneblink` (Console, default), `oneblink-us`, and `civicplus` — selected per
environment via `ONEBLINK_TENANT`.

Each OneBlink service is its own class, constructed with a Developer Key:

```ts
import * as OneBlink from '@oneblink/sdk'
const forms = new OneBlink.Forms({ accessKey, secretKey })
```

Service classes available to compose workflows from (SDK v13):
`Approvals`, `DataManager`, `EmailTemplates`, `FormElementLists`,
`FormElementLookups`, `Forms`, `FormsAppEnvironments`, `FormsApps`, `Jobs`,
`Keys`, `Organisations`, `PDF`, plus a top-level `sendEmail` function.

Every action is gated by the Developer Key's **role permissions** and **app
associations** — each workflow must document its minimum required permission
(see the security steering).

## Status

Scaffolding only. The server starts, speaks MCP over stdio, and registers zero
workflows. See `src/workflows/index.ts` for where workflows get wired in.

## Project layout

```
src/
  index.ts              # entry point (stdio transport)
  server.ts             # server factory + workflow registration
  workflows/
    index.ts            # workflow registry (empty — add workflows here)
  lib/
    config.ts           # per-environment config loader (see security rule 3)
    oneblink-client.ts  # single OneBlink SDK auth/client seam
    logger.ts           # PII/secret-safe stderr logger (see security rule 2)
  schemas/              # shared zod schemas (as workflows need them)
test/
  server.test.ts        # smoke tests
.kiro/
  steering/
    security.md         # MANDATORY security requirements for every feature
```

## Security

`.kiro/steering/security.md` defines non-negotiable security requirements —
OWASP Top 10 at planning time, no PII/secrets in logs, and env vars for
per-environment values only. Read it before adding any workflow.

## Development

Requires Node.js 24+ and npm 11+ (matching the OneBlink SDK).

```bash
npm install
npm run build        # tsc -> dist/
npm test             # node:test smoke tests
npm run inspect      # launch the MCP Inspector against the built server
```

### Configuration

Copy `.env.example` to `.env` and fill in your OneBlink Developer Key. Only
per-environment values go in the environment — operational parameters are tool
inputs. See the security steering file.

## Adding a workflow

1. Agree the workflow's requirements (what task, which SDK calls, which inputs,
   which OWASP categories it touches, and the minimum Developer Key role
   permission / app association it needs).
2. Create `src/workflows/<name>.ts` exporting `register<Name>(server)`.
3. Validate all inputs with a `zod` schema.
4. Register it in `src/workflows/index.ts`.
5. Add a test and verify it in the MCP Inspector.
