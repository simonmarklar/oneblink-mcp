#!/usr/bin/env bash
# One-stop PoC driver for the OneBlink MCP OAuth stack (Keycloak + Postgres + server).
# Bash twin of scripts/poc.ps1 - for the eventual Linux/CI host. Same verbs.
#
#   ./scripts/poc.sh up      Ensure keys file, build + start, wait for health.
#   ./scripts/poc.sh token   Fetch a token, decode it, assert aud + tenant.
#   ./scripts/poc.sh smoke   End-to-end: token -> list_forms -> pass/fail.
#   ./scripts/poc.sh down    Stop (realm persists). WIPE=1 also drops the volume.
#   ./scripts/poc.sh logs    Tail server logs.
#   ./scripts/poc.sh status  Container + health state.
#
# Deps: docker (with compose plugin), curl, jq. Config mirrors docker-compose.yml.
set -euo pipefail

VERB="${1:-up}"
USERNAME="${OB_USER:-testuser}"
PASSWORD="${OB_PASS:-testpass}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
KEYCLOAK_DIR="$PROJECT_ROOT/keycloak"
KEYS_FILE="$PROJECT_ROOT/oneblink-keys.local.json"
KEYS_EXAMPLE="$PROJECT_ROOT/oneblink-keys.local.json.example"

REALM='oneblink-poc'
CLIENT_ID='oneblink-mcp-client'
KEYCLOAK_URL='http://localhost:8080'
SERVER_MCP='http://127.0.0.1:3000/mcp'
SERVER_META='http://127.0.0.1:3000/.well-known/oauth-protected-resource'
TOKEN_URL="$KEYCLOAK_URL/realms/$REALM/protocol/openid-connect/token"

c_cyan='\033[36m'; c_green='\033[32m'; c_yellow='\033[33m'; c_red='\033[31m'; c_dim='\033[90m'; c_off='\033[0m'
step() { printf "${c_cyan}==> %s${c_off}\n" "$1"; }
ok()   { printf "${c_green}  OK  %s${c_off}\n" "$1"; }
warn() { printf "${c_yellow}  !!  %s${c_off}\n" "$1"; }
fail() { printf "${c_red}  XX  %s${c_off}\n" "$1"; exit 1; }

require_docker() {
  command -v docker >/dev/null 2>&1 || fail 'docker not found on PATH.'
  docker info >/dev/null 2>&1 || fail 'Docker daemon not reachable. Start it and retry.'
}
require_tool() { command -v "$1" >/dev/null 2>&1 || fail "$1 not found on PATH."; }

ensure_keys_file() {
  if [[ -f "$KEYS_FILE" ]]; then ok "keys file present ($(basename "$KEYS_FILE"))"; return; fi
  warn 'keys file missing - seeding from example (placeholder keys; live calls will fail).'
  cp "$KEYS_EXAMPLE" "$KEYS_FILE"
  ok "created $KEYS_FILE - fill a real accessKey/secretKey before a live call."
}

compose() { ( cd "$KEYCLOAK_DIR" && docker compose "$@" ); }

wait_for_url() { # url what [timeout]
  local url="$1" what="$2" timeout="${3:-90}" deadline
  step "waiting for $what ($url)"
  deadline=$(( $(date +%s) + timeout ))
  while (( $(date +%s) < deadline )); do
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" || echo 000)
    if [[ "$code" != "000" ]]; then ok "$what responding (HTTP $code)"; return; fi
    sleep 3
  done
  fail "$what did not come up within ${timeout}s. Check: ./scripts/poc.sh logs"
}

get_token() {
  require_tool curl; require_tool jq
  curl -s -X POST "$TOKEN_URL" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -d grant_type=password -d "client_id=$CLIENT_ID" \
    -d "username=$USERNAME" -d "password=$PASSWORD" -d scope=openid \
    | jq -r '.access_token // empty'
}

decode_payload() { # jwt -> JSON on stdout
  local p; p="$(cut -d. -f2 <<<"$1" | tr '_-' '/+')"
  while (( ${#p} % 4 )); do p+='='; done
  printf '%s' "$p" | base64 -d 2>/dev/null
}

case "$VERB" in
  up)
    require_docker; ensure_keys_file
    step 'building + starting the stack (docker compose up -d --build)'
    compose up -d --build
    wait_for_url "$KEYCLOAK_URL/realms/$REALM/.well-known/openid-configuration" 'Keycloak realm'
    wait_for_url "$SERVER_META" 'MCP server metadata'
    ok 'stack is up. Next: ./scripts/poc.sh smoke'
    ;;

  token)
    t="$(get_token)"; [[ -n "$t" ]] || fail 'no token returned - is Keycloak up?'
    claims="$(decode_payload "$t")"
    step 'token claims'
    echo "$claims" | jq '{iss, aud, tenant, exp}'
    echo "$claims" | jq -e '.aud | if type=="array" then index("oneblink-mcp") else .=="oneblink-mcp" end' >/dev/null \
      && ok "aud contains 'oneblink-mcp'" || warn "aud MISSING 'oneblink-mcp' -> server will 401"
    echo "$claims" | jq -e '.tenant' >/dev/null \
      && ok "tenant = $(echo "$claims" | jq -r .tenant)" || warn 'tenant claim MISSING -> server will 403'
    echo "$t"   # emit token on stdout so you can: TOKEN=$(./scripts/poc.sh token | tail -1)
    ;;

  smoke)
    require_docker
    t="$(get_token)"; [[ -n "$t" ]] || fail 'no token returned.'
    claims="$(decode_payload "$t")"
    echo "$claims" | jq -e '.aud | if type=="array" then index("oneblink-mcp") else .=="oneblink-mcp" end' >/dev/null \
      || fail "token aud lacks 'oneblink-mcp' - fix the audience mapper first."
    tenant="$(echo "$claims" | jq -r .tenant)"; ok "token acquired (tenant=$tenant)"

    payload='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_forms","arguments":{"workspaceId":1,"limit":1}}}'
    step "calling list_forms at $SERVER_MCP"
    resp="$(curl -s -w '\n%{http_code}' -X POST "$SERVER_MCP" \
      -H "Authorization: Bearer $t" \
      -H 'Accept: application/json, text/event-stream' \
      -H 'Content-Type: application/json' \
      --max-time 20 -d "$payload")"
    code="$(tail -n1 <<<"$resp")"; body="$(sed '$d' <<<"$resp")"
    printf "${c_dim}HTTP %s${c_off}\n" "$code"
    case "$code" in
      200) ok 'list_forms returned 200 - full OAuth->broker->OneBlink path works.'; echo "$body" ;;
      401) warn 'server 401 - token audience/issuer mismatch. Run: ./scripts/poc.sh token' ;;
      403) warn "server 403 - tenant '$tenant' has no entry in oneblink-keys.local.json (or placeholder keys)." ;;
      406) fail '406 - Accept header issue (script bug if you see this).' ;;
      *)   warn "unexpected status; body:"; echo "$body" ;;
    esac
    ;;

  down)
    require_docker
    if [[ "${WIPE:-0}" == "1" ]]; then step 'stopping + WIPING volume'; compose down -v
    else step 'stopping (realm persists)'; compose down; fi
    ok 'down.'
    ;;

  logs)   require_docker; compose logs -f oneblink-mcp ;;
  status) require_docker; compose ps ;;
  *) fail "unknown verb '$VERB' - use: up | token | smoke | down | logs | status" ;;
esac
