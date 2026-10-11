# Keycloak (persistent) + MCP server for the OAuth PoC

Three services: Keycloak + Postgres (persistent via a volume) **and** the
oneblink-mcp HTTP server itself. A pre-built realm auto-imports on first run —
**no UI steps** to get a working token.

## Prerequisite: the keys file must exist

The server mounts `../oneblink-keys.local.json` read-only. Create it before
`up` or Docker errors on a missing mount source:

```powershell
Copy-Item ..\oneblink-keys.local.json.example ..\oneblink-keys.local.json
# then edit it: real OneBlink accessKey/secretKey under "acme"
```

## Start / stop

```powershell
cd keycloak
docker compose up -d --build    # builds the server image, imports the realm
docker compose logs -f oneblink-mcp
docker compose down             # stops; realm PERSISTS in the volume
docker compose down -v          # stops AND wipes the realm (fresh import next up)
```

- Keycloak admin console: [http://localhost:8080](http://localhost:8080) — `admin` / `admin`.
- MCP server: `http://127.0.0.1:3000/mcp` (published to host loopback).

## What the import gives you

| Thing | Value |
|---|---|
| Realm | `oneblink-poc` |
| Client | `oneblink-mcp-client` (public, PKCE + direct grant) |
| Audience mapper | adds `aud: oneblink-mcp` to the access token |
| Tenant mapper | adds `tenant` claim from the user attribute |
| User | `testuser` / `testpass`, attribute `tenant=acme` |

`tenant=acme` must match a key in `../oneblink-keys.local.json`. Change the
user's `tenant` attribute (admin console → Users → testuser → Attributes) to
target a different key.

> `--import-realm` only imports when the realm does NOT already exist. After
> first run, edits you make in the UI live in the volume — to change the baked
> import, edit the JSON and `docker compose down -v` to re-seed.

## Get a token

```powershell
$resp = curl.exe -s -X POST `
  "http://localhost:8080/realms/oneblink-poc/protocol/openid-connect/token" `
  -H "Content-Type: application/x-www-form-urlencoded" `
  -d "grant_type=password" -d "client_id=oneblink-mcp-client" `
  -d "username=testuser" -d "password=testpass" -d "scope=openid" | ConvertFrom-Json
$resp.access_token
```

Then call the server (see `../docs/guides/windows-oauth-poc.md` Step 7C).

## Export your own realm changes (make UI edits reproducible)

If you configure extra things in the UI and want them baked into the import:

```powershell
docker compose exec keycloak /opt/keycloak/bin/kc.sh export `
  --dir /tmp/export --realm oneblink-poc
docker compose cp keycloak:/tmp/export/oneblink-poc-realm.json ./import/oneblink-poc-realm.json
```

Then `docker compose down -v && docker compose up -d` to confirm it re-seeds
cleanly. **The exported file can contain user data — do not commit it with real
users/secrets.**

## Notes

- Loopback-only published ports (`127.0.0.1:8080`, `127.0.0.1:3000`); HTTP,
  default creds — PoC posture, not prod.
- Postgres has no published port; only Keycloak reaches it on the compose
  network.
- **Issuer vs JWKS host (the one gotcha).** A token's `iss` is the URL it was
  obtained from — `http://localhost:8080/...` (host browser/curl). But the
  containerized server fetches JWKS over the compose network at
  `http://keycloak:8080/...` (service DNS). So the two env vars deliberately use
  different hosts:
  - `HTTP_OAUTH_ISSUER = http://localhost:8080/realms/oneblink-poc` (must match `iss`)
  - `HTTP_OAUTH_JWKS_URI = http://keycloak:8080/.../certs` (network reachable)

  `KC_HOSTNAME: localhost` on Keycloak pins `iss` to `localhost` no matter which
  path reaches it, so this stays consistent. If you run the server on the
  **host** instead of in the container, set both to `localhost`.
- Production uses Cognito instead of this entirely — see the transition
  checklist in `../docs/requirements/auth-session.md`.
