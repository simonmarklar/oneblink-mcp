# Using the OAuth PoC on Windows

> **Status: BUILT and VERIFIED end-to-end (local PoC).** The HTTP transport,
> JWKS token verifier, and file-backed credential resolver are implemented,
> unit-tested, and have been run live against a real Keycloak + a real OneBlink
> Developer Key: OAuth login -> token -> brokered `list_forms` returns `200`.
> Spec: `docs/requirements/auth-session.md`. Commands are PowerShell.

## Fast path (automated) — recommended

The whole stack (Keycloak + Postgres + the MCP server) and the token/smoke flow
are driven by one script. From the project root:

```powershell
.\scripts\poc.ps1 up      # build + start all 3 containers, wait for health
.\scripts\poc.ps1 token   # fetch a token, assert aud=oneblink-mcp + tenant claim
.\scripts\poc.ps1 smoke   # token -> list_forms -> pass/fail report
.\scripts\poc.ps1 down    # stop (add -Wipe to drop the realm volume)
```

`up` seeds `oneblink-keys.local.json` from the example if missing (placeholder
keys -> live OneBlink calls return `403` until you add a real key). The Keycloak
realm — client, `aud=oneblink-mcp` mapper, tenant-claim mapper, and a
`testuser`/`testpass` with `tenant=acme` — is **pre-seeded** via realm import
(`keycloak/import/oneblink-poc-realm.json`), so there are no manual UI steps.

To use a real OneBlink key, put it under the `acme` tenant in
`oneblink-keys.local.json`, then `.\scripts\poc.ps1 smoke` returns `200`.

The manual walkthrough below explains the same pieces for when you want to drive
Keycloak by hand or understand what the script automates.

---

## What you're running (3 processes)

| Process | Role | Port (default) |
|---|---|---|
| Keycloak (Docker) | Authorization Server — issues your OAuth token | `8080` |
| oneblink-mcp (HTTP) | Resource Server — validates the token, brokers OneBlink | `3000` |
| MCP Inspector *or* curl | the "caller" — gets a token, calls a tool | — |

The OneBlink Developer Key never leaves the oneblink-mcp process. You never type
it into the client. You authenticate to *your* server with an OAuth token; the
server authenticates to OneBlink with the HMAC key it reads locally.

## Tools to install

| Tool | Why | Install (PowerShell) |
|---|---|---|
| Docker Desktop | runs Keycloak with no local Java/DB setup | `winget install Docker.DockerDesktop` |
| Node.js ≥ 24 | already required by the SDK | `winget install OpenJS.NodeJS` |
| MCP Inspector | easiest token + tool-call client (has built-in OAuth) | bundled: `npm run inspect` |
| curl | manual token flow / scripting | ships with Windows 10+ |

Verify: `docker --version`, `node --version` (≥ 24).

## Step 1 — start Keycloak (the Authorization Server)

```powershell
docker run -d --name keycloak -p 8080:8080 `
  -e KEYCLOAK_ADMIN=admin -e KEYCLOAK_ADMIN_PASSWORD=admin `
  quay.io/keycloak/keycloak:latest start-dev
```

Open [http://localhost:8080](http://localhost:8080) → **Administration Console**
(admin / admin). Then:

1. **Create a realm** — name it `oneblink-poc`.
2. **Create a client** — Client ID `oneblink-mcp-client`:
   - Client authentication: **Off** (public client, PKCE) for the Inspector flow.
   - Valid redirect URIs: `http://localhost:*` (Inspector's callback).
   - Standard flow: **On**.
3. **Audience** — the server rejects any token whose audience isn't itself
   (RFC 8707, confused-deputy defense). Add a **client scope** / mapper that
   puts `aud: oneblink-mcp` in issued tokens, or set the client's audience
   mapper to `oneblink-mcp`. This matches `HTTP_OAUTH_AUDIENCE` below.
4. **Create a user** — set a password (Temporary: **Off**), and **fill in
   email, first name, and last name**. Recent Keycloak marks these required in
   the realm's user profile, and an account missing them fails the direct-grant
   token request with `invalid_grant: Account is not fully set up` even though
   no required actions are pending. Then add the **tenant claim** the server
   maps to an OneBlink key (user attribute `tenant=acme`, surfaced as a token
   claim via a user-attribute mapper). The server reads this to pick which
   OneBlink key to broker.

> JWKS the server will validate against:
> `http://localhost:8080/realms/oneblink-poc/protocol/openid-connect/certs`

## Step 2 — configure oneblink-mcp

Per-environment values (issuer/audience/JWKS legitimately vary per environment,
so they're env vars; see security rule 3). Copy `.env.example` → `.env` and set:

```ini
# --- Caller auth (OAuth Resource Server) ---
HTTP_BIND=127.0.0.1          # localhost only — never 0.0.0.0 in the PoC
HTTP_PORT=3000
# HTTP_PUBLIC_URL=http://127.0.0.1:3000  # reachable URL in metadata/WWW-Authenticate; defaults to 127.0.0.1:<port>
HTTP_OAUTH_ISSUER=http://localhost:8080/realms/oneblink-poc
HTTP_OAUTH_JWKS_URI=http://localhost:8080/realms/oneblink-poc/protocol/openid-connect/certs
HTTP_OAUTH_AUDIENCE=oneblink-mcp   # token.aud MUST equal this or → 401
# HTTP_OAUTH_TENANT_CLAIM=tenant   # token claim that selects the key (default: tenant)
# HTTP_KEY_FILE=oneblink-keys.local.json
```

The OneBlink keys themselves go in a **gitignored** local file the credential
resolver reads, keyed by the tenant claim — not in `.env`. Copy the template:

```powershell
Copy-Item oneblink-keys.local.json.example oneblink-keys.local.json
```

```jsonc
// oneblink-keys.local.json  (gitignored — never commit)
{
  "acme":  { "accessKey": "...", "secretKey": "..." },
  "other": { "accessKey": "...", "secretKey": "..." }
}
```

The key under each tenant name must match the `tenant` claim your Keycloak user
carries (Step 1.4). A token whose tenant has no entry here → `403` (fail-closed,
no key leaked).

Build and start HTTP mode:

```powershell
npm run build
npm run start:http   # serves Streamable HTTP on 127.0.0.1:3000
```

Sanity-check the two unauthenticated paths (both work without Keycloak):

```powershell
# RFC 9728 metadata → 200 JSON
curl.exe -s http://127.0.0.1:3000/.well-known/oauth-protected-resource
# no token → 401 + WWW-Authenticate
curl.exe -s -i -X POST http://127.0.0.1:3000/mcp -H "Content-Type: application/json" -d '{}'
```

## Step 3 — get a token and call a tool

### Option A — MCP Inspector (recommended, does OAuth for you)

```powershell
npm run inspect:http   # opens the Inspector UI with no stdio server attached
```

In the Inspector UI:
1. Transport: **Streamable HTTP**, URL `http://127.0.0.1:3000/mcp`.
2. **Connect.** The server returns `401` + `WWW-Authenticate` pointing at its
   RFC 9728 metadata; the Inspector discovers Keycloak and runs the OAuth
   login (PKCE) in your browser.
3. Log in as the Keycloak user. The Inspector stores the token and attaches it
   as `Authorization: Bearer <token>` on every call.
4. **Tools → `list_forms` → Run.** The server validates the token, resolves the
   tenant's OneBlink key, and brokers the call.

You never see or paste the OneBlink key. If login fails or the audience is
wrong, you get `401` — that rejection is the design working.

### Option B — manual token with curl (scripting / CI)

Get a token directly from Keycloak (direct grant; enable **Direct access
grants** on the client for this):

```powershell
$resp = curl.exe -s -X POST `
  "http://localhost:8080/realms/oneblink-poc/protocol/openid-connect/token" `
  -H "Content-Type: application/x-www-form-urlencoded" `
  -d "grant_type=password" `
  -d "client_id=oneblink-mcp-client" `
  -d "username=youruser" `
  -d "password=yourpassword" `
  -d "scope=openid" | ConvertFrom-Json
$token = $resp.access_token
$token   # inspect; paste into jwt.io to confirm aud=oneblink-mcp
```

Call the MCP endpoint with the bearer token (MCP uses JSON-RPC over HTTP):

```powershell
curl.exe -s -X POST "http://127.0.0.1:3000/mcp" `
  -H "Authorization: Bearer $token" `
  -H "Content-Type: application/json" `
  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"list_forms\",\"arguments\":{\"workspaceId\":1}}}'
```

Expected failures (all are the design working, not bugs):
- **No `Authorization` header** → `401` + `WWW-Authenticate`.
- **Expired / wrong-signature token** → `401`.
- **`aud` ≠ `oneblink-mcp`** → `401` (audience binding).
- **Tenant claim has no entry in `oneblink-keys.local.json`** → broker error,
  no key leaked.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `invalid_grant: Account is not fully set up` on token request | user missing email / first / last name (required by Keycloak's user profile) | set those fields on the user (realm import pre-seeds them) |
| `401` even after login | token `aud` ≠ `HTTP_OAUTH_AUDIENCE` | fix the Keycloak audience mapper to emit `oneblink-mcp` |
| `403` with a valid token | the token's `tenant` has no entry in the key file, or the key is still a placeholder | add a real `{accessKey,secretKey}` under that tenant in `oneblink-keys.local.json` |
| `406` on a tool call | missing `Accept: application/json, text/event-stream` header | add the header (the scripts already do) |
| Inspector can't discover auth | server not returning RFC 9728 metadata | confirm HTTP mode is running, not stdio |
| `connection refused :8080` | Keycloak not up | `docker ps`; `docker logs keycloak` |
| `connection refused :3000` | server bound wrong / not started | confirm `HTTP_BIND=127.0.0.1`, `npm run start:http` |
| `resource_metadata` URL shows `0.0.0.0` | `HTTP_PUBLIC_URL` unset in a non-loopback bind | set `HTTP_PUBLIC_URL` to the reachable URL (compose already does) |
| OneBlink call fails with auth error | wrong/missing Developer Key for tenant | check `oneblink-keys.local.json` entry + key role permissions |

## When you move to Cognito (later)

Nothing in this flow changes conceptually — you swap *where the token comes
from* and *where the key is stored*:

- `HTTP_OAUTH_ISSUER` / `HTTP_OAUTH_JWKS_URI` / `HTTP_OAUTH_AUDIENCE` → point at
  the Cognito user pool instead of Keycloak.
- `oneblink-keys.local.json` → AWS Secrets Manager (the credential resolver
  adapter changes; the server code calling it does not).

The Windows user experience is identical: get a token from the issuer, call the
server with it. See the transition checklist in
`docs/requirements/auth-session.md`.
