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

Scaffolding only. The server speaks MCP over the Streamable HTTP transport.
See `src/workflows/index.ts` for where workflows get wired in.

## Project layout

```
src/
  http.ts               # entry point (Streamable HTTP transport)
  server.ts             # server factory + workflow registration
  workflows/
    index.ts            # workflow registry (empty — add workflows here)
  lib/
    config.ts           # tenant + HTTP config loader (see security rule 3)
    oneblink-client.ts  # single OneBlink SDK auth/client seam
    auth/
      header-credentials.ts  # per-session key pair from request headers
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
```

### Running the MCP Inspector (credentials are per-session, not per-server)

OneBlink keys are **never baked into the server process**. On the HTTP
transport the **caller supplies its own key pair per session via request
headers** — the server holds no keys and reads neither `.env` nor a key file
for them:

```
X-OneBlink-Access-Key: <your access key>
X-OneBlink-Secret-Key: <your secret key>
```

Optionally, the deploy workflows (`deploy_hosted_api`, `deploy_cdn`) accept a
**separate CLI deploy key pair** — a different credential from the SDK
Developer Key:

```
X-OneBlink-CLI-Access-Key: <deploy access key>
X-OneBlink-CLI-Secret-Key: <deploy secret key>
```

When the CLI headers are omitted, the SDK key pair is reused for deploys (the
common case: one key does both).

**Per-session (correct) — HTTP transport + credential headers:**

```powershell
npm run start:http          # start the HTTP server (binds 127.0.0.1:3000)
npm run inspect:http        # open the Inspector against http://127.0.0.1:3000/mcp
```

In the Inspector web UI, add the credential headers above under **Transport →
Headers** (name/value, e.g. `X-OneBlink-Access-Key` / your key) before clicking
**Connect**. You can also pre-fill them on launch — the Inspector forwards
`--header` to the HTTP transport.

> The Inspector is a **local dev dependency**, not a global command. Run it with
> `npx` (resolves `node_modules/.bin`), or via the `npm run inspect:*` scripts.
> Bare `mcp-inspector` only works if you installed it globally.

```powershell
# Pre-fill the headers (web UI still requires you to click Connect).
# Keep real keys out of shell history — set env vars first, then reference them.
$env:ONEBLINK_ACCESS_KEY = '<your access key>'
$env:ONEBLINK_SECRET_KEY = '<your secret key>'
npx mcp-inspector --transport http --server-url http://127.0.0.1:3000/mcp `
  --header "X-OneBlink-Access-Key: $env:ONEBLINK_ACCESS_KEY" `
  --header "X-OneBlink-Secret-Key: $env:ONEBLINK_SECRET_KEY"
```

```bash
# CLI smoke test (no UI): list the tools with your keys attached.
export ONEBLINK_ACCESS_KEY='<your access key>'
export ONEBLINK_SECRET_KEY='<your secret key>'
npx mcp-inspector --cli --transport http --server-url http://127.0.0.1:3000/mcp \
  --header "X-OneBlink-Access-Key: $ONEBLINK_ACCESS_KEY" \
  --header "X-OneBlink-Secret-Key: $ONEBLINK_SECRET_KEY" \
  --method tools/list
```

Each tool call then runs with your key pair for that session.

### Connecting a coding agent (Kiro, Claude, Codex, Cursor, ...)

See **[docs/connect-agents.md](docs/connect-agents.md)** for per-agent config
(native HTTP for Cursor/VS Code/Claude Code; a `mcp-remote` stdio bridge for
Kiro/Claude Desktop/Codex/Windsurf/Gemini/Zed — this is an HTTP-only server, so
stdio-only clients need the bridge).

Automated setup writes the right config block for you:

```bash
npm run start:http               # server must be running (127.0.0.1:3000)
npm run connect -- --agent kiro  # or cursor, claude-code, codex, vscode, ...
npm run connect                  # interactive: pick from the list
npm run connect -- --agent kiro --dry-run   # preview, change nothing
```

It merges an `oneblink` entry into the agent's existing config (never clobbers
other servers), backs the file up to `<file>.bak`, and keeps keys in env refs.


> Credentials ride **headers, never tool arguments** — so they never enter the
> model's context, the transcript, or tool logs. The server never logs them and
> never returns them. A hosted deployment MUST terminate TLS in front so the
> header pair is never sent in clear text.

> **No OAuth.** This is a header-credential server, not an OAuth resource
> server. A `401` from `/mcp` carries **no** `WWW-Authenticate` header, so an
> MCP client does **not** attempt OAuth metadata discovery or Dynamic Client
> Registration — it just needs the credential headers. (If you ever see
> *"Dynamic Client Registration rejected (HTTP 404)"*, you are running an older
> build that still advertised OAuth — rebuild.)

**There is no stdio transport.** This is an HTTP-only server; credentials have
no per-process channel on stdio, so the only transport is Streamable HTTP with
the credential headers above.

### Configuration

- **No server-held keys.** The caller sends its OneBlink Developer Key (and
  optionally a separate CLI deploy key) as request headers per session;
  `getClient()` reads them from the per-request context and throws if a tool is
  somehow invoked outside a request. Only `HTTP_BIND` / `HTTP_PORT` (and the
  optional `ONEBLINK_TENANT`, `ONEBLINK_CLI_BIN`) are server env vars — all
  per-environment / per-host and non-secret. See `.env.example`.

## Adding a workflow

1. Agree the workflow's requirements (what task, which SDK calls, which inputs,
   which OWASP categories it touches, and the minimum Developer Key role
   permission / app association it needs).
2. Create `src/workflows/<name>.ts` exporting `register<Name>(server)`.
3. Validate all inputs with a `zod` schema.
4. Register it in `src/workflows/index.ts`.
5. Add a test and verify it in the MCP Inspector.
