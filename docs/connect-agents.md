---
status: accepted
last_verified: 2026-10-11
verified_against: src/http.ts, src/lib/config.ts, test/http-transport.test.ts (commit state 2026-10-11)
---

# Connecting coding agents to the OneBlink MCP server

This server is **HTTP-only** (Streamable HTTP transport). There is **no stdio
transport** and **no OAuth**. It binds **loopback only** and serves one route:

| Fact | Value |
|------|-------|
| URL | `http://127.0.0.1:3000/mcp` (`HTTP_BIND` / `HTTP_PORT` configurable) |
| Transport | Streamable HTTP (`POST /mcp`) |
| Auth | per-session **request headers** (below) — never tool args, never OAuth |
| Runtime | Node.js **24+**, npm **11+** |

## 1. Start the server

```bash
npm install
npm run build
npm run start:http     # binds 127.0.0.1:3000, logs "oneblink-mcp HTTP server started"
```

Leave it running. Every agent below talks to that one process.

## 2. The credentials (sent as headers, per session)

The server holds **no keys**. Each client sends its own OneBlink Developer Key
on every session:

```
X-OneBlink-Access-Key: <access key>      # required
X-OneBlink-Secret-Key: <secret key>      # required
X-OneBlink-CLI-Access-Key: <deploy key>  # optional — deploy_* tools only
X-OneBlink-CLI-Secret-Key: <deploy key>  # optional — reuses SDK key if omitted
```

A request missing the two required headers gets `401 unauthorized` naming the
header (never the value). The 401 carries **no `WWW-Authenticate`** header, so
clients do **not** try OAuth/DCR.

> Keep real keys out of shell history and committed files. Set them as env
> vars first (`ONEBLINK_ACCESS_KEY` / `ONEBLINK_SECRET_KEY`) and reference
> those, as the examples do.

## 3. Two connection patterns

MCP clients split into two camps:

- **Native HTTP** — the client can call a remote URL with custom headers
  directly. **Cursor, Claude Code, VS Code, MCP Inspector.** Preferred.
- **stdio-only** — the client only launches a local `command` over stdio. It
  reaches an HTTP server through the **`mcp-remote`** bridge
  (`npx -y mcp-remote <url> --header ...`), which speaks stdio to the client
  and Streamable HTTP to this server. **Kiro, Claude Desktop, Codex, Windsurf,
  Gemini CLI, Zed.**

Both are documented per agent below. The automated installer in §5 writes the
right one for you.

---

## 4. Per-agent configuration

Replace `AK` / `SK` with your keys (or `${ONEBLINK_ACCESS_KEY}` style refs where
the client expands env vars). URL assumes the default `127.0.0.1:3000`.

### Kiro (stdio via bridge)

`.kiro/settings/mcp.json` (workspace) or `~/.kiro/settings/mcp.json` (user):

```json
{
  "mcpServers": {
    "oneblink": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "http://127.0.0.1:3000/mcp",
        "--header", "X-OneBlink-Access-Key:${ONEBLINK_ACCESS_KEY}",
        "--header", "X-OneBlink-Secret-Key:${ONEBLINK_SECRET_KEY}"
      ],
      "env": {
        "ONEBLINK_ACCESS_KEY": "AK",
        "ONEBLINK_SECRET_KEY": "SK"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Claude Code (native HTTP)

Register with `--scope user` so the server persists across directories (without
it, Claude Code stores the server in the **project-local** scope, bound to the
current working directory — the usual reason it "doesn't work" elsewhere):

```bash
claude mcp add --transport http --scope user oneblink http://127.0.0.1:3000/mcp \
  --header "X-OneBlink-Access-Key: AK" \
  --header "X-OneBlink-Secret-Key: SK"
```

### Claude Desktop (stdio via bridge)

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "oneblink": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "http://127.0.0.1:3000/mcp",
        "--header", "X-OneBlink-Access-Key: AK",
        "--header", "X-OneBlink-Secret-Key: SK"
      ]
    }
  }
}
```

### Cursor (native HTTP)

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "oneblink": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "X-OneBlink-Access-Key": "AK",
        "X-OneBlink-Secret-Key": "SK"
      }
    }
  }
}
```

### Codex (stdio via bridge)

`~/.codex/config.toml`:

```toml
[mcp_servers.oneblink]
command = "npx"
args = [
  "-y", "mcp-remote", "http://127.0.0.1:3000/mcp",
  "--header", "X-OneBlink-Access-Key: AK",
  "--header", "X-OneBlink-Secret-Key: SK",
]
```

### VS Code (native HTTP, GitHub Copilot / Agent mode)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "oneblink": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "X-OneBlink-Access-Key": "AK",
        "X-OneBlink-Secret-Key": "SK"
      }
    }
  }
}
```

### Windsurf / Gemini CLI / Zed (stdio via bridge)

Same shape as Kiro — a `command: "npx"` + `mcp-remote` entry in the client's
MCP config file (`~/.codeium/windsurf/mcp_config.json`, `~/.gemini/settings.json`,
Zed `settings.json` `context_servers`). The installer writes these.

### MCP Inspector (native HTTP — smoke test)

```bash
npm run inspect:http   # add the two headers under Transport -> Headers, then Connect
```

---

## 5. Automated setup

`scripts/connect-agent.mjs` detects an agent (or takes one by name), writes the
correct config block (native HTTP or `mcp-remote` bridge), and keeps keys in env
vars rather than inlining them.

```bash
# interactive: pick from detected agents
node scripts/connect-agent.mjs

# explicit
node scripts/connect-agent.mjs --agent kiro
node scripts/connect-agent.mjs --agent cursor --url http://127.0.0.1:3000/mcp
node scripts/connect-agent.mjs --agent claude-code --access-key AK --secret-key SK

# see what it would write, change nothing
node scripts/connect-agent.mjs --agent kiro --dry-run
```

Supported `--agent` values: `kiro`, `claude-code`, `claude-desktop`, `cursor`,
`codex`, `vscode`, `windsurf`, `gemini`, `zed`.

What it does:

1. Resolves the config file path for the chosen agent (OS-aware).
2. Reads keys from `--access-key`/`--secret-key`, else `ONEBLINK_ACCESS_KEY` /
   `ONEBLINK_SECRET_KEY`, else prompts. Stores them as env refs in the entry,
   not inline — except `claude-code`, which registers via its own CLI.
3. Merges an `oneblink` server entry into the existing config (never clobbers
   other servers), backing the file up to `<file>.bak` first.
4. Prints the next step (restart the agent / reload the window).

Re-running is idempotent: it replaces only the `oneblink` entry.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `401 unauthorized`, message names `X-OneBlink-Access-Key` | missing/blank required headers | send both required headers |
| `Dynamic Client Registration rejected (HTTP 404)` | old build that advertised OAuth | `npm run build` and restart the server |
| client hangs / "server not found" | stdio-only client pointed straight at the URL | use the `mcp-remote` bridge entry (§4) |
| `ECONNREFUSED 127.0.0.1:3000` | server not running / wrong port | `npm run start:http`; match `HTTP_PORT` |
| `npx mcp-remote` fails | Node < 24 or no network for npx | install Node 24+, or `npm i -g mcp-remote` |
| tools call fails with a OneBlink auth error | keys valid but lack the role permission / app association | grant the Developer Key the permission the tool documents |
