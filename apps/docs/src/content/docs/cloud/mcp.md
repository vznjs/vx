---
title: MCP over HTTP
description: The vx Cloud platform exposes MCP over HTTP at POST /mcp — a dependency-free JSON-RPC 2.0 endpoint behind the account/token auth, tenant-clamped by org and workspace. AI agents point at your deployment and read the same analytics the dashboard shows.
---

Core `vx` ships a per-workspace, process-private MCP server over stdio
(`vx mcp` — see [vx mcp (core)](/vx/guides/mcp/)). The **vx Cloud
platform** also exposes MCP over HTTP so an AI agent can read run history
and analytics from a deployment, across every workspace in an org.

## `POST /mcp`

The [self-hosted platform](/vx/cloud/self-hosting/) serves MCP at
`POST /mcp` — dependency-free (JSON-RPC 2.0, protocol `2025-03-26`, no SDK),
behind the platform's account/token auth and **tenant-clamped** by org and
workspace. An AI agent points at your deployment with a minted `vxc_` API
token and reads the same metrics the dashboard shows (a workspace-scoped
token is pinned to its workspace):

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

## Tools

The HTTP tools read from **Postgres** — the platform's system of record —
so they work even though the platform holds no workspace checkout or local
`cache.db`:

| Tool | What it answers |
| --- | --- |
| `list_workspaces` | Which workspaces exist in the org |
| `list_runs` | Recent `vx run` invocations (branch / commit / CI / tags) |
| `get_run` | A run's per-task detail |
| `run_trends` | Over-time trend for a project/task |
| `cache_stats` | Hit rate and cache-savings aggregates |
| `why_did_rerun` | The cache-key components that changed since the previous run |
| `compare_runs` | Diff two runs |

Mint the token under **Admin → Tokens**. See
[Self-hosting](/vx/cloud/self-hosting/) to deploy the platform.

## Which MCP surface do I want?

- **[`vx mcp` (core, stdio)](/vx/guides/mcp/)** — per-developer, per-workspace,
  process-private; reads the local `cache.db`. No server, no auth.
- **`POST /mcp` (this page)** — team-wide, org/workspace-clamped; reads
  Postgres on a deployment. Needs a `vxc_` token.

See also: [Dashboard](/vx/cloud/dashboard/) — the same analytics as a UI.
