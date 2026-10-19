#!/usr/bin/env node
/**
 * connect-agent.mjs — wire a coding agent to the OneBlink MCP server.
 *
 * The server is HTTP-only (Streamable HTTP, loopback). Agents split into:
 *   - native HTTP  : write { url, headers } directly        (cursor, vscode, claude-code*)
 *   - stdio bridge : write npx mcp-remote <url> --header ... (kiro, claude-desktop, codex, windsurf, gemini, zed)
 * (*claude-code registers via its own CLI, not a file.)
 *
 * Writes keys as ${ENV} refs, never inline. Merges the `oneblink` entry into
 * the agent's existing config without clobbering other servers. Backs up to
 * <file>.bak. Idempotent.
 *
 * Usage:
 *   node scripts/connect-agent.mjs [--agent NAME] [--url URL]
 *                                  [--access-key AK] [--secret-key SK] [--dry-run]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, platform } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { spawnSync } from 'node:child_process'
import { stdin, stdout } from 'node:process'

const DEFAULT_URL = 'http://127.0.0.1:3000/mcp'
const ACCESS_REF = '${ONEBLINK_ACCESS_KEY}'
const SECRET_REF = '${ONEBLINK_SECRET_KEY}'

// ---- arg parsing ----------------------------------------------------------
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i]
  }
  return out
}
const args = parseArgs(process.argv.slice(2))
const url = args.url || DEFAULT_URL
const dryRun = Boolean(args.dryRun)

// ---- OS-aware config paths ------------------------------------------------
const HOME = homedir()
const isWin = platform() === 'win32'
const isMac = platform() === 'darwin'
const APPDATA = process.env.APPDATA || join(HOME, 'AppData', 'Roaming')

function claudeDesktopPath() {
  if (isWin) return join(APPDATA, 'Claude', 'claude_desktop_config.json')
  if (isMac) return join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  return join(HOME, '.config', 'Claude', 'claude_desktop_config.json')
}

/**
 * kind: 'json-mcpServers' | 'json-servers' | 'toml' | 'cli'
 * transport: 'http' | 'bridge'
 */
const AGENTS = {
  kiro:            { path: join(HOME, '.kiro', 'settings', 'mcp.json'),              kind: 'json-mcpServers', transport: 'bridge' },
  'claude-desktop':{ path: claudeDesktopPath(),                                     kind: 'json-mcpServers', transport: 'bridge' },
  codex:           { path: join(HOME, '.codex', 'config.toml'),                     kind: 'toml',            transport: 'bridge' },
  windsurf:        { path: join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),   kind: 'json-mcpServers', transport: 'bridge' },
  gemini:          { path: join(HOME, '.gemini', 'settings.json'),                  kind: 'json-mcpServers', transport: 'bridge' },
  zed:             { path: join(HOME, '.config', 'zed', 'settings.json'),           kind: 'json-mcpServers', transport: 'bridge' },
  cursor:          { path: join(HOME, '.cursor', 'mcp.json'),                       kind: 'json-mcpServers', transport: 'http' },
  vscode:          { path: join(HOME, '.vscode', 'mcp.json'),                       kind: 'json-servers',    transport: 'http' },
  'claude-code':   { path: null,                                                    kind: 'cli',             transport: 'http' },
}

// ---- entry builders -------------------------------------------------------
function bridgeArgs(accessRef, secretRef) {
  return [
    '-y', 'mcp-remote', url,
    '--header', `X-OneBlink-Access-Key:${accessRef}`,
    '--header', `X-OneBlink-Secret-Key:${secretRef}`,
  ]
}

function buildJsonEntry(transport) {
  if (transport === 'http') {
    return {
      url,
      headers: { 'X-OneBlink-Access-Key': ACCESS_REF, 'X-OneBlink-Secret-Key': SECRET_REF },
    }
  }
  return {
    command: 'npx',
    args: bridgeArgs(ACCESS_REF, SECRET_REF),
    env: { ONEBLINK_ACCESS_KEY: ACCESS_REF /* placeholder; overwritten below */ },
    disabled: false,
    autoApprove: [],
  }
}

// ---- config read/merge/write ----------------------------------------------
function readJson(path) {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8').trim()
  if (!raw) return {}
  return JSON.parse(raw)
}

function backup(path) {
  if (existsSync(path)) copyFileSync(path, `${path}.bak`)
}

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true })
}

function writeFileReport(path, content) {
  if (dryRun) {
    console.log(`\n--- would write ${path} ---\n${content}\n`)
    return
  }
  ensureDir(path)
  backup(path)
  writeFileSync(path, content, 'utf8')
  console.log(`wrote ${path}` + (existsSync(`${path}.bak`) ? ` (backup: ${path}.bak)` : ''))
}

function mergeJsonMcpServers(agent, keys) {
  const cfg = readJson(agent.path)
  cfg.mcpServers = cfg.mcpServers || {}
  const entry = buildJsonEntry(agent.transport)
  if (agent.transport === 'bridge') {
    entry.env = { ONEBLINK_ACCESS_KEY: keys.access, ONEBLINK_SECRET_KEY: keys.secret }
  }
  cfg.mcpServers.oneblink = entry
  writeFileReport(agent.path, JSON.stringify(cfg, null, 2) + '\n')
}

function mergeJsonServers(agent, _keys) {
  const cfg = readJson(agent.path)
  cfg.servers = cfg.servers || {}
  cfg.servers.oneblink = { type: 'http', ...buildJsonEntry('http') }
  writeFileReport(agent.path, JSON.stringify(cfg, null, 2) + '\n')
}

function mergeToml(agent, keys) {
  // Minimal, dependency-free TOML emit for the one table we own. We append /
  // replace only the [mcp_servers.oneblink] block, leaving other tables intact.
  const block = [
    '[mcp_servers.oneblink]',
    'command = "npx"',
    'args = [',
    '  "-y", "mcp-remote", "' + url + '",',
    '  "--header", "X-OneBlink-Access-Key:' + keys.access + '",',
    '  "--header", "X-OneBlink-Secret-Key:' + keys.secret + '",',
    ']',
    '',
  ].join('\n')

  let existing = existsSync(agent.path) ? readFileSync(agent.path, 'utf8') : ''
  const header = '[mcp_servers.oneblink]'
  if (existing.includes(header)) {
    // replace from the header to the next top-level table or EOF
    const re = /\[mcp_servers\.oneblink\][\s\S]*?(?=\n\[|$)/
    existing = existing.replace(re, block.trimEnd() + '\n')
  } else {
    existing = (existing.trimEnd() + '\n\n' + block).trimStart()
  }
  writeFileReport(agent.path, existing)
}

function claudeCodeCli(keys) {
  // Claude Code stores MCP servers per SCOPE. Without --scope user the server
  // lands in the project-local scope (cwd-bound), so it silently "doesn't work"
  // from other directories. --scope user registers it for the whole user.
  const cliArgs = [
    'mcp', 'add', '--transport', 'http', '--scope', 'user', 'oneblink', url,
    '--header', `X-OneBlink-Access-Key: ${keys.access}`,
    '--header', `X-OneBlink-Secret-Key: ${keys.secret}`,
  ]
  const printable = 'claude ' + cliArgs
    .map((a) => (/\s/.test(a) ? `"${a}"` : a))
    .join(' ')

  if (dryRun) {
    console.log('\nwould run:\n\n' + printable + '\n')
    return
  }

  // claude is a CLI, not a .cmd we can always resolve by name on Windows; try
  // `claude` then `claude.cmd`, and fall back to printing if neither is found.
  const candidates = platform() === 'win32' ? ['claude.cmd', 'claude'] : ['claude']
  for (const bin of candidates) {
    const r = spawnSync(bin, cliArgs, { stdio: 'inherit', shell: platform() === 'win32' })
    if (r.error && r.error.code === 'ENOENT') continue
    if (r.status === 0) {
      console.log('\nregistered the oneblink server with claude (user scope).')
      return
    }
    // ran but failed — surface it and stop (do not retry a different bin).
    console.error(`\nclaude exited with status ${r.status}. Command was:\n\n${printable}\n`)
    return
  }
  console.log(
    '\nThe `claude` CLI was not found on PATH. Install Claude Code, then run:\n\n' + printable + '\n',
  )
}

// ---- key resolution -------------------------------------------------------
async function resolveKeys() {
  let access = args['access-key'] || process.env.ONEBLINK_ACCESS_KEY
  let secret = args['secret-key'] || process.env.ONEBLINK_SECRET_KEY
  if (access && secret) return { access, secret }
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    access = access || (await rl.question('OneBlink Access Key: ')).trim()
    secret = secret || (await rl.question('OneBlink Secret Key: ')).trim()
  } finally {
    rl.close()
  }
  if (!access || !secret) throw new Error('both an access key and a secret key are required')
  return { access, secret }
}

async function pickAgent() {
  if (args.agent) return args.agent
  const names = Object.keys(AGENTS)
  console.log('Agents:', names.join(', '))
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const a = (await rl.question('Which agent? ')).trim()
    return a
  } finally {
    rl.close()
  }
}

// ---- main -----------------------------------------------------------------
async function main() {
  const name = await pickAgent()
  const agent = AGENTS[name]
  if (!agent) {
    console.error(`unknown agent "${name}". Known: ${Object.keys(AGENTS).join(', ')}`)
    process.exit(1)
  }

  // claude-code (CLI) and native-HTTP file writers use env refs, so they do not
  // need the real keys baked in; the bridge/toml/cli forms do.
  const needsKeys = agent.kind === 'cli' || agent.transport === 'bridge'
  const keys = needsKeys ? await resolveKeys() : { access: ACCESS_REF, secret: SECRET_REF }

  switch (agent.kind) {
    case 'json-mcpServers': mergeJsonMcpServers(agent, keys); break
    case 'json-servers':    mergeJsonServers(agent, keys); break
    case 'toml':            mergeToml(agent, keys); break
    case 'cli':             claudeCodeCli(keys); break
    default: throw new Error(`unhandled kind ${agent.kind}`)
  }

  if (agent.kind !== 'cli') {
    console.log(`\nNext: restart ${name} (or reload its window) so it picks up the oneblink server.`)
    if (agent.transport === 'bridge') {
      console.log('The bridge uses `npx mcp-remote` — needs Node 24+ and npx on PATH.')
    }
  }
  console.log('Server must be running: `npm run start:http` (binds 127.0.0.1:3000).')
}

main().catch((err) => {
  console.error('error:', err.message)
  process.exit(1)
})
