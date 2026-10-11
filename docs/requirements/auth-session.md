# Requirements: Session Authentication & Credential Handling

**Status:** Draft for review
**Scope:** How the server obtains and uses OneBlink Developer Keys per caller.
**Target:** Remote/hosted HTTP(S), multi-identity, from the start. Local stdio
is an **interim** transport, not the destination.

Conforms to steering: `security.md`, `tool-design.md`, `writing-style.md`.

## Decision

Server = **OAuth 2.1 Resource Server** (MCP spec rev 2025-06-18). The caller
authenticates to an external Authorization Server; the server validates a token
**audience-bound to itself**, then **brokers** the OneBlink Developer Key
server-side per tenant. The HMAC key never reaches the client and is never a
tool argument.

"Per session" = per authenticated HTTP connection/token. On stdio it has no real
meaning (one process = one identity) — see Interim.

## Does OAuth fit OneBlink's key model? (yes — it fronts it, not replaces it)

OAuth and the OneBlink Developer Key are **two different credentials for two
different hops**. OAuth never replaces the key.

| Hop | Credential | Held by | Validated by |
|---|---|---|---|
| caller → our MCP server | OAuth 2.1 token (audience = our server) | AI client / user | our server |
| our MCP server → OneBlink | static HMAC Developer Key | our server only (secrets mgr) | OneBlink |

- OneBlink does **not** need to know OAuth exists. The server still makes the
  same HMAC-signed SDK call (`new Forms({ accessKey, secretKey })`); the key
  stays static/long-lived/revoke-by-delete. Nothing about OneBlink's method
  changes.
- The server **terminates** the OAuth token and **swaps in** the mapped OneBlink
  key server-side. This swap is exactly why **token passthrough is forbidden**
  (never forward the caller's OAuth token to OneBlink).
- What would NOT work: making OneBlink itself the OAuth provider (end user
  OAuths directly against OneBlink). OneBlink keys aren't an OAuth system — and
  the design doesn't need that.
- **Caveat:** the caller-auth layer (an external AS, e.g. Cognito) is **new
  infra we own**, not something OneBlink supplies. See Q5 for a lighter
  alternative if standing up an AS is unwanted.

## Why (grounded)

| Fact | Source | Consequence |
|---|---|---|
| MCP server is an OAuth 2.1 **Resource Server** | MCP spec 2025-06-18 Authorization | We validate tokens, we are not the AS |
| RFC 9728 Protected Resource Metadata **MUST** | spec 2025-06-18 | 401 returns `WWW-Authenticate` → metadata URL |
| RFC 8707 Resource Indicators **MUST** | spec 2025-06-18 | token audience bound to this server |
| RFC 7591 Dynamic Client Registration **SHOULD** | spec 2025-06-18 | support dynamic clients |
| Token **passthrough forbidden**; confused-deputy named | spec Security Considerations | never forward caller token to OneBlink |
| stdio **SHOULD NOT** use OAuth; use env creds | spec 2025-06-18 | interim stdio stays env-based |
| OneBlink keys = static long-lived HMAC, no STS, revoke=delete | OneBlink Developer Keys doc | compensate with scoping + rotation + secrets manager |

## Target design (remote HTTP)

1. **Transport:** Streamable HTTP (MCP), replacing stdio for hosting.
2. **AuthN of caller:** external AS (Cognito / Keycloak / WorkOS / Auth0),
   OAuth 2.1 + PKCE. Server advertises RFC 9728 metadata; 401 →
   `WWW-Authenticate`.
3. **Token validation:** verify signature, expiry, and **audience = this
   server** (RFC 8707). Reject anything else (confused-deputy defense, OWASP
   API2).
4. **Tenant → OneBlink key mapping:** the validated token identifies a tenant.
   The server fetches that tenant's OneBlink Developer Key from a **secrets
   manager** (AWS Secrets Manager / Vault), per-tenant scoped by IAM/policy.
5. **Broker the call:** construct the OneBlink SDK client server-side, make the
   HMAC-signed call, return the projected result. The Developer Key **never
   leaves the server boundary**.
6. **Hardening:** optional mTLS; short-lived MCP tokens + refresh; per-tenant
   rate limiting (OWASP API4).

## OneBlink key handling (static HMAC — compensating controls)

Keys have no short-lived/STS story, are immutable, revoke-by-delete only. So:

- **Per-tenant, per-environment keys** — never shared across tenants/envs.
- **Least-privilege Role/type** per key.
- **Secrets manager only** — never in client config, env of a shared host, or
  source.
- **Scheduled rotation**: create → swap → delete (tracked; no auto-expiry).
- **Fast revoke-by-delete** as the compromise kill switch; monitor usage.

## Interim: local stdio

Until HTTP lands, keep the current model — spec-correct for stdio:

- `ONEBLINK_ACCESS_KEY` / `ONEBLINK_SECRET_KEY` per process (one process per
  identity).
- **Resolve from the OS keychain** at startup rather than plaintext config where
  possible.
- Secret stays in process memory, dies with the process; never logged (A09).

The workflow layer (`src/workflows/*`) and `getClient()` seam are designed so
the credential **source** can change (env → brokered secrets manager) without
touching workflow code: workflows ask `getClient()` for a service; only the
client factory learns about the auth context.

## MUST NOT (anti-patterns)

- ❌ OneBlink secret as a **tool-call argument** (lands in model context,
  history, logs). The worst option — explicitly forbidden here.
- ❌ **Token passthrough** — forwarding the caller's token or any token not
  issued for this server upstream to OneBlink (MCP spec).
- ❌ Sending the Developer Key **to the client** / embedding it client-side.
- ❌ **Logging secrets** anywhere (A09).
- ❌ **One shared key** across tenants/environments.

## Security mapping

- OWASP **API2 Broken Authentication** — validate token, bind audience.
- OWASP **API8 Security Misconfiguration** — no upstream-cred leakage, least
  scope.
- OWASP **A09 Logging** — no secrets in any log.
- MCP **Confused Deputy / Token Audience Binding** — audience = self, no
  passthrough.

## Acceptance criteria (target HTTP)

- [ ] Server serves RFC 9728 Protected Resource Metadata; 401 →
      `WWW-Authenticate` with metadata URL.
- [ ] Token rejected unless audience = this server (test: foreign-audience token
      → 401).
- [ ] No code path accepts an OneBlink key via tool args or returns it to the
      client.
- [ ] OneBlink key read only from the secrets manager, per tenant; absent in
      logs.
- [ ] `getClient()` resolves the key from the request's auth context, not a
      global env, in HTTP mode.
- [ ] Interim stdio path unchanged and still passes existing tests.

## Open questions

- **Q1:** Which Authorization Server — Cognito (AWS-native, matches the AWS
  guidance impl), or another (Keycloak/WorkOS/Auth0)?
- **Q2:** Secrets manager — AWS Secrets Manager (assume AWS hosting) or Vault?
- **Q3:** Tenant model — does one authenticated caller map to exactly one
  OneBlink org key, or can a caller act for several (changes the mapping table)?
- **Q4:** Hosting shape — Lambda + API Gateway, Fargate, or a long-running
  Node service? (Affects token caching, cold-start, secrets-manager calls.)
- **Q5:** Full OAuth 2.1 AS (spec-aligned, more infra) vs a lighter per-tenant
  **gateway API key** fronting the broker (fewer moving parts, weaker, not
  MCP-spec-aligned)? Both still broker the OneBlink key server-side.

---

## PoC: local Keycloak OAuth, no AWS (DECIDED)

**Status:** chosen build target. Proves the *real* OAuth flow end-to-end with
zero cloud, then swaps to Cognito by adapter only (Q1→Cognito, Q2→Secrets
Manager) once proven. No AWS resources.

### Principle: the cloud was always two roles, not a dependency

The target design never *requires* AWS — it requires an **Authorization Server**
and a **secrets store**. Both have local stand-ins with the identical interface:

| Role | PoC (local) | Production (swap target) | Code sees |
|---|---|---|---|
| Authorization Server | Keycloak in one Docker container | AWS Cognito user pool | a JWKS URL + issuer + audience |
| Secrets store | gitignored JSON file (or OS keychain) | AWS Secrets Manager | `resolve(tenant) → {accessKey, secretKey}` |

Because the server only ever consumes a **JWKS URL** and a **resolver
interface**, Keycloak and Cognito are interchangeable — both are standards-
compliant OIDC issuers publishing JWKS. The swap is configuration + one adapter
class, never a rewrite. This is steering rule 5 made concrete.

### The two seams that make the swap adapter-only

Both are injected into `getClient()`; nothing in `src/workflows/*` changes
across the local→Cognito transition.

**1. `TokenVerifier`** — validates the caller's OAuth token.

```ts
interface AuthContext { tenant: string; subject: string; scopes: string[] }
interface TokenVerifier {
  // Verify sig (JWKS), expiry, issuer, and audience === this server.
  // Throw (→ 401) on any failure. Returns the tenant/principal to broker as.
  verify(bearerToken: string): Promise<AuthContext>
}
```
- PoC impl: `JwksTokenVerifier` pointed at Keycloak's JWKS URL.
- Prod impl: **same class**, pointed at Cognito's JWKS URL. Issuer/audience/JWKS
  come from config (per-environment env vars — tenant/issuer legitimately vary
  per environment, so this fits the env-var rule).

**2. `CredentialResolver`** — maps the verified tenant to its OneBlink key.

```ts
interface CredentialResolver {
  resolve(tenant: string): Promise<SdkConstructorOptions> // {accessKey, secretKey}
}
```
- PoC impl: `FileCredentialResolver` — reads a gitignored
  `oneblink-keys.local.json` (or OS keychain), `{ "<tenant>": {accessKey,
  secretKey} }`.
- Prod impl: `SecretsManagerCredentialResolver` — one `GetSecretValue` per
  tenant, IAM-scoped. Same interface; `getClient()` is unchanged.

### getClient() changes from global singleton to per-context factory

Current `getClient()` is a process-global singleton reading env. HTTP mode makes
it **per-auth-context**:

```ts
// HTTP: per request. stdio interim: AuthContext synthesized from env (one
// identity), so the existing path and tests keep working unchanged.
function getClient(auth: AuthContext, resolver: CredentialResolver): OneBlinkClient
```
- stdio interim keeps a global built from env → one synthesized `AuthContext`.
  Existing tests unaffected (acceptance below).
- The per-tenant client is cached keyed by tenant, not globally.

### PoC request flow (local HTTP)

1. MCP client calls over Streamable HTTP with `Authorization: Bearer <token>`.
2. Server has no/invalid token → `401` + `WWW-Authenticate` → RFC 9728 metadata
   URL (points at local Keycloak). **This rejection path is exercised, not
   stubbed.**
3. `TokenVerifier.verify()` → JWKS check + **audience === this server** (reject
   foreign-audience token, even in PoC).
4. `AuthContext.tenant` → `CredentialResolver.resolve(tenant)` → OneBlink key
   from the local file.
5. `getClient(auth, resolver)` brokers the HMAC SDK call; projected result
   returned. Key never leaves the server; never logged; never a tool arg.

### PoC acceptance criteria

- [x] Local Keycloak issues a token the server validates against its JWKS.
      *(verified live against the compose Keycloak; also proven in tests with
      locally-minted RS256 tokens.)*
- [x] Server binds **`127.0.0.1` only** (`HTTP_BIND`, verified in smoke test).
- [x] No token → `401` + `WWW-Authenticate` → RFC 9728 metadata URL (verified).
- [x] Foreign-audience token → `401` (audience binding enforced — proven in
      `test/jwks-verifier.test.ts`, not stubbed).
- [x] Valid token → tenant resolved → OneBlink key read from local file →
      brokered `list_forms` call succeeds. *(verified live: OAuth token (aud
      `oneblink-mcp`, tenant `acme`) → brokered `searchForms` → `200`
      `{items,meta}`, with a real Developer Key in the key file.)*
- [x] OneBlink key absent from all logs and never in a tool arg/response
      (logger takes scalars only; resolver tests assert no secret in errors).
- [x] `oneblink-keys.local.json` is gitignored.
- [x] **stdio interim path and all existing tests still pass unchanged**
      (33/33 pass).
- [x] `TokenVerifier` + `CredentialResolver` are the *only* code touched to
      later swap to Cognito + Secrets Manager (both constructed in one place in
      `src/http.ts`; workflows + server factory unchanged).

### Local→Cognito transition checklist (future, no rewrite)

1. Point `JwksTokenVerifier` config at the Cognito pool's issuer/JWKS/audience.
2. Replace `FileCredentialResolver` with `SecretsManagerCredentialResolver`
   (same interface) + IAM per-tenant scoping.
3. Config/env swap only; `src/workflows/*` and `src/server.ts` untouched.

### PoC build steps (when implementing)

1. `docker run` Keycloak; realm + client (PKCE) + one test user/tenant claim.
2. Add Streamable HTTP transport alongside stdio (don't remove stdio).
3. `TokenVerifier` (jose + JWKS), `CredentialResolver` (file), inject into
   `getClient()`.
4. RFC 9728 metadata endpoint + 401 `WWW-Authenticate`.
5. `oneblink-keys.local.json` (gitignored) + `.env.example` for Keycloak
   issuer/audience/JWKS.
6. Tests: no-token 401, foreign-audience 401, valid-token broker path, stdio
   regression.
