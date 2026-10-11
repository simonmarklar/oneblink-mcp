# PoC automation

One driver, two shells, same verbs. Orchestrates the whole OAuth PoC so it's
reproducible from a cold machine — the manual docker/token/smoke steps collapse
into one command.

| Verb | Does |
|---|---|
| `up` | ensure keys file exists → `docker compose up -d --build` → wait for Keycloak + server health |
| `token` | fetch an access token, decode it, assert `aud=oneblink-mcp` + a `tenant` claim |
| `smoke` | token → `list_forms` call → pass/fail against the expected-results table |
| `down` | stop (realm persists); `-Wipe` / `WIPE=1` also drops the volume |
| `logs` | tail the server container logs |
| `status` | container + health state |

## Windows (PowerShell)

```powershell
.\scripts\poc.ps1 up
.\scripts\poc.ps1 smoke
.\scripts\poc.ps1 down            # add -Wipe to re-import the realm next up
# or via npm:
npm run poc:up ; npm run poc:smoke ; npm run poc:down
```

## Linux / macOS / CI (bash)

```bash
./scripts/poc.sh up
./scripts/poc.sh smoke
WIPE=1 ./scripts/poc.sh down
# deps: docker (compose plugin), curl, jq
```

## Config is NOT in these scripts

Everything configurable lives in **`keycloak/docker-compose.yml`** (ports,
issuer/JWKS, audience, bind) and the auto-imported realm
(`keycloak/import/oneblink-poc-realm.json`). The scripts only read the same
constants to talk to the stack — change config in the compose file, not here.

### Config via a Docker volume mount (what's already wired)

Two things are injected into the containers by mount, never baked into an image:

| What | Source (host) | Mounted at | Why a mount |
|---|---|---|---|
| OneBlink keys | `oneblink-keys.local.json` | `/run/secrets/oneblink-keys.json` (ro) | secret — stays off the image, gitignored |
| Keycloak realm | `keycloak/import/*.json` | `/opt/keycloak/data/import` (ro) | declarative realm, auto-imported on fresh volume |

So "set up the config and use it from a disk mount" is the design: edit the JSON
on the host, `up`, and the containers pick it up. The realm JSON **is** the saved
config — capture any UI change back into it with the export command in
`keycloak/README.md`, and it re-seeds identically on the next machine.

## Expected smoke results (each non-200 is the design working)

| Status | Meaning | Fix |
|---|---|---|
| `200` | full path works | — |
| `401` | token `aud`/`iss` mismatch | `poc token` to inspect claims |
| `403` | tenant has no key entry | add it to `oneblink-keys.local.json` (or real keys) |
| no token | Keycloak down | `poc up` |
