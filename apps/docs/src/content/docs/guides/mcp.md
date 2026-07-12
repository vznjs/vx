---
title: vx mcp — Model Context Protocol server
description: Expose vx as a typed tool surface to AI coding agents (Claude Code, Cursor, Continue.dev, GitHub Copilot). Read cache stats, run history, and explain rebuild causes through the standard MCP protocol.
---

`vx mcp` boots a Model Context Protocol (MCP) server over stdio so
AI coding agents can query your repo's build state through the
standard agent-tool protocol. No HTTP, no auth — stdio is process-
private.

## What is MCP

The Model Context Protocol is the de-facto standard for AI agents to
discover and call typed tools. Claude Code, Cursor, Continue.dev,
VS Code GitHub Copilot, and many others all speak it. By shipping an
MCP server, vx gives any of them a typed surface for your build
state.

Spec: <https://modelcontextprotocol.io/>

## Quick start

```sh
vx mcp                           # stdio transport (default)
```

Add to your agent's MCP config (Claude Code example):

```jsonc
// ~/.claude/mcp.json
{
  "mcpServers": {
    "vx": { "command": "vx", "args": ["mcp"] }
  }
}
```

Cursor reads `.cursorrules`-adjacent config; Continue.dev reads
`~/.continue/config.json`. The shape is identical: `command + args`.

## Tools exposed

| Tool | What it answers |
| --- | --- |
| `getCacheStats` | "What's the state of my cache right now?" — entries, total size, runs/hits last 24h, hit rate |
| `getRunHistory` | "Which tasks have I been running, and how fast?" — distinct (project, task) pairs with p50/p99/successRate/hitRate aggregates |
| `explainCacheKey` | "What's the cache identity for `pkg#build`?" — latest entries-row (hash, command, exit code, duration, size, created_at) |
| `whyDidThisRerun` | "Why did this task re-execute instead of using the cache?" — compares the run's cache hash against the previous run for the same task |

All four read your workspace's local `cache.db` on demand. Open
your agent and ask things like:

- "What's my cache hit rate this week?"
- "Why did `pkg-a#test` re-run in the last build?"
- "Which tasks miss the cache most often?"
- "What was the slowest task in the last 50 runs?"

## How it works

The server is the same `@modelcontextprotocol/sdk` package every MCP
implementation uses. `vx mcp` opens cache.db, exposes the four tools
via `setRequestHandler(ListToolsRequestSchema, …)` /
`setRequestHandler(CallToolRequestSchema, …)`, and pipes JSON-RPC
2.0 over stdin/stdout. The agent reads tool results as text content
(stringified JSON).

vx's MCP tools share dispatch with the inspector RPC channel
(`vx:rpc` from `docs/design/wire-protocol-2026-06.md`). When the
WebSocket-side inspector ships, every MCP tool will work over WS
too — one handler, two transports.

## MCP over HTTP — the vx-cloud platform

`vx mcp` (stdio) is per-workspace and process-private. The [self-hosted
`vx-cloud` platform](../self-hosting/) also exposes MCP over HTTP at
`POST /mcp` — dependency-free (JSON-RPC 2.0, protocol `2025-03-26`, no
SDK), behind the platform's account/token auth and **tenant-clamped** by
org and workspace. An AI agent points at your deployment with a minted
`vxc_` API token and reads the same metrics the dashboard shows, across
every workspace in the org (a workspace-scoped token is pinned to its
workspace):

```jsonc
// Claude Code, pointing at your deployment
{
  "mcpServers": {
    "vx-team": {
      "url": "https://vx.example.com/mcp",
      "headers": { "Authorization": "Bearer vxc_..." }
    }
  }
}
```

The HTTP tools (`list_workspaces`, `list_runs`, `get_run`, `run_trends`,
`cache_stats`, `why_did_rerun`, `compare_runs`) read from **Postgres** —
the platform's system of record — so they work even though the platform
holds no workspace checkout or local `cache.db`. Mint the token under
**Admin → Tokens**. See [Self-host vx-cloud](../self-hosting/).

## What's coming

- `runTasks` — agents trigger a `vx run` directly (driver surface).
- MCP resources for `vx://runs/{runId}` and `vx://history` (browseable).

## Troubleshooting

- **Agent says "no MCP tools" after adding the config.** Restart
  the agent. Most MCP clients only re-read config on launch.
- **`vx mcp: requires @modelcontextprotocol/sdk`** — the binary
  was built without the SDK. Rebuild with `bun install &&
bun src/bin.ts run build`.
- **Empty results from `getCacheStats`** — you haven't run any
  `vx run` yet, or you're pointing at the wrong workspace. The
  server discovers the workspace via `findWorkspaceRoot(cwd)`; run
  the agent from the workspace root.

See also: `docs/design/extension-protocol-2026-06.md`.
