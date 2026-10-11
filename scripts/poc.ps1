<#
.SYNOPSIS
  One-stop PoC driver for the OneBlink MCP OAuth stack (Keycloak + Postgres + server).

.DESCRIPTION
  Wraps the manual docker-compose + token + smoke-test steps into verbs so the
  whole PoC is reproducible from a cold machine. All config comes from the
  compose file and the auto-imported realm - this script only orchestrates.

  Verbs:
    up        Ensure keys file exists, build + start the stack, wait for health.
    token     Fetch an access token, decode it, assert aud + tenant claims.
    smoke     Full end-to-end: token -> list_forms call -> pass/fail report.
    down      Stop the stack (realm persists). Add -Wipe to also drop the volume.
    logs      Tail the server logs.
    status    Show container + health state.

.PARAMETER Verb
  One of: up | token | smoke | down | logs | status

.PARAMETER Wipe
  With `down`: also remove the Postgres volume (fresh realm import next up).

.PARAMETER Tenant
  Smoke-test workspace scoping is tenant-driven via the token; this is only the
  username whose `tenant` attribute selects the key. Default: testuser.

.EXAMPLE
  .\scripts\poc.ps1 up
  .\scripts\poc.ps1 smoke
  .\scripts\poc.ps1 down -Wipe
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('up', 'token', 'smoke', 'down', 'logs', 'status')]
  [string]$Verb = 'up',

  [switch]$Wipe,

  [string]$Username = 'testuser',
  [string]$Password = 'testpass'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# --- paths -----------------------------------------------------------------
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$KeycloakDir = Join-Path $ProjectRoot 'keycloak'
$KeysFile    = Join-Path $ProjectRoot 'oneblink-keys.local.json'
$KeysExample = Join-Path $ProjectRoot 'oneblink-keys.local.json.example'

# --- config (keep in sync with keycloak/docker-compose.yml) ----------------
$Realm      = 'oneblink-poc'
$ClientId   = 'oneblink-mcp-client'
$KeycloakUrl = 'http://localhost:8080'
$ServerUrl  = 'http://127.0.0.1:3000/mcp'
$TokenUrl   = "$KeycloakUrl/realms/$Realm/protocol/openid-connect/token"

function Write-Step($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  !!  $msg" -ForegroundColor Yellow }
function Fail($msg)        { Write-Host "  XX  $msg" -ForegroundColor Red; exit 1 }

function Require-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail 'docker not found on PATH. Install Docker Desktop and retry.'
  }
  try { docker info *> $null } catch { Fail 'Docker daemon not reachable. Start Docker Desktop and retry.' }
}

function Ensure-KeysFile {
  if (Test-Path $KeysFile) { Write-Ok "keys file present ($(Split-Path -Leaf $KeysFile))"; return }
  Write-Warn2 "keys file missing - seeding from example (placeholder keys, will fail live OneBlink calls)."
  Copy-Item $KeysExample $KeysFile
  Write-Ok "created $KeysFile - edit it with a real accessKey/secretKey under the tenant key before a live call."
}

function Compose([string[]]$ComposeArgs) {
  Push-Location $KeycloakDir
  try { & docker compose @ComposeArgs } finally { Pop-Location }
}

function Wait-ForUrl($url, $what, $timeoutSec = 90) {
  Write-Step "waiting for $what ($url)"
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5 -SkipHttpErrorCheck
      # Any HTTP response (even 401) means the listener is up.
      if ($r.StatusCode -ge 200) { Write-Ok "$what responding (HTTP $($r.StatusCode))"; return }
    } catch { Start-Sleep -Seconds 3 }
    Start-Sleep -Seconds 3
  }
  Fail "$what did not come up within ${timeoutSec}s. Check: .\scripts\poc.ps1 logs"
}

function Get-Token {
  $body = @{
    grant_type = 'password'
    client_id  = $ClientId
    username   = $Username
    password   = $Password
    scope      = 'openid'
  }
  try {
    $resp = Invoke-RestMethod -Uri $TokenUrl -Method Post -Body $body `
      -ContentType 'application/x-www-form-urlencoded' -TimeoutSec 10
  } catch {
    Fail "token request failed: $($_.Exception.Message). Is Keycloak up? (.\scripts\poc.ps1 up)"
  }
  return $resp.access_token
}

function Decode-JwtPayload($jwt) {
  $p = $jwt.Split('.')[1].Replace('-', '+').Replace('_', '/')
  while ($p.Length % 4) { $p += '=' }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)) | ConvertFrom-Json
}

# --- verbs -----------------------------------------------------------------
switch ($Verb) {

  'up' {
    Require-Docker
    Ensure-KeysFile
    Write-Step 'building + starting the stack (docker compose up -d --build)'
    Compose @('up', '-d', '--build')
    Wait-ForUrl "$KeycloakUrl/realms/$Realm/.well-known/openid-configuration" 'Keycloak realm'
    Wait-ForUrl "http://127.0.0.1:3000/.well-known/oauth-protected-resource" 'MCP server metadata'
    Write-Ok 'stack is up. Next: .\scripts\poc.ps1 smoke'
  }

  'token' {
    $t = Get-Token
    $claims = Decode-JwtPayload $t
    Write-Step 'token claims'
    $audOk    = @($claims.aud) -contains 'oneblink-mcp'
    $tenantOk = [bool]$claims.tenant
    $claims | Select-Object iss, aud, tenant, exp | Format-List | Out-String | Write-Host
    if ($audOk)    { Write-Ok "aud contains 'oneblink-mcp'" }    else { Write-Warn2 "aud MISSING 'oneblink-mcp' - audience mapper not applied -> server will 401" }
    if ($tenantOk) { Write-Ok "tenant claim = '$($claims.tenant)'" } else { Write-Warn2 "tenant claim MISSING -> server will 403 (no key to broker)" }
    Write-Host ''
    Write-Host '$env:OB_TOKEN set for this session - reuse it in your own curl.' -ForegroundColor DarkGray
    $global:OB_TOKEN = $t
  }

  'smoke' {
    Require-Docker
    $t = Get-Token
    $claims = Decode-JwtPayload $t
    if (-not (@($claims.aud) -contains 'oneblink-mcp')) { Fail "token aud lacks 'oneblink-mcp' - fix the audience mapper before smoke." }
    Write-Ok "token acquired (tenant=$($claims.tenant))"

    $payload = @{
      jsonrpc = '2.0'; id = 1; method = 'tools/call'
      params  = @{ name = 'list_forms'; arguments = @{ workspaceId = 1; limit = 1 } }
    } | ConvertTo-Json -Depth 6 -Compress

    Write-Step "calling list_forms at $ServerUrl"
    try {
      $r = Invoke-WebRequest -Uri $ServerUrl -Method Post -Body $payload `
        -Headers @{ Authorization = "Bearer $t"; Accept = 'application/json, text/event-stream' } `
        -ContentType 'application/json' -TimeoutSec 20 -SkipHttpErrorCheck
    } catch { Fail "request failed: $($_.Exception.Message)" }

    Write-Host "HTTP $($r.StatusCode)" -ForegroundColor DarkGray
    switch ($r.StatusCode) {
      200 { Write-Ok 'list_forms returned 200 - full OAuth->broker->OneBlink path works.'; Write-Host $r.Content }
      401 { Write-Warn2 'server returned 401 - token audience/issuer mismatch. Run: .\scripts\poc.ps1 token' }
      403 { Write-Warn2 "server returned 403 - tenant '$($claims.tenant)' has no entry in oneblink-keys.local.json (or placeholder keys)." }
      406 { Fail "406 - missing/incorrect Accept header (needs application/json, text/event-stream). Script bug if you see this." }
      default { Write-Warn2 "unexpected status; body:`n$($r.Content)" }
    }
  }

  'down' {
    Require-Docker
    if ($Wipe) { Write-Step 'stopping + WIPING the volume (realm will re-import next up)'; Compose @('down', '-v') }
    else       { Write-Step 'stopping (realm persists in the volume)'; Compose @('down') }
    Write-Ok 'down.'
  }

  'logs'   { Require-Docker; Compose @('logs', '-f', 'oneblink-mcp') }
  'status' { Require-Docker; Compose @('ps') }
}
