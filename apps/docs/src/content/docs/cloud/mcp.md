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

| Tool | Arguments | What it answers |
| --- | --- | --- |
| `list_workspaces` | — | Every workspace in the org: id, name, slug, last seen, run count |
| `list_runs` | `workspace?`, `limit?` (default 50, ≤500) | Recent `vx run` invocations, newest first: command, branch/commit, CI, task/failed/hit counts, duration |
| `get_run` | **`runId`**, `workspace?` | One run in full — the invocation header plus every per-task outcome (`found: false` for an unknown id) |
| `run_trends` | `workspace?`, `bucket?` (`hour`\|`day`, default hour), `limit?` (≤1000) | **Workspace-wide** bucketed activity over time: run counts, failure counts, cache hits per bucket |
| `cache_stats` | `workspace?` | Cache effectiveness: entries/bytes, last-24h runs + hits, local-vs-remote hit split |
| `why_did_rerun` | **`runId`**, **`taskId`** (`project#task`), `workspace?` | Why the task re-executed — hash change vs the previous run + the per-component input diff |
| `compare_runs` | **`runId`**, `workspace?` | Diff the run against its **immediately-previous invocation**: per-task duration/status/hash deltas + totals |

Every tool takes an optional **`workspace`** argument (a workspace id
from `list_workspaces`), defaulting to the org's most-recently-seen
workspace. A **workspace-scoped token is pinned** to its own workspace —
the argument is ignored; an explicitly-named unknown workspace returns an
`isError` result, never another tenant's data, and every read is clamped
to the token's org.

**Errors and batching:** an unknown tool or missing required argument
comes back as a JSON-RPC error / `isError` tool result with the message
in the body. The endpoint accepts a single JSON-RPC message **or a
batch** (an array); a POST containing only notifications is answered
`202` with no body (the streamable-HTTP contract for non-streaming
servers).

Mint the token under **Admin → Tokens**. See
[Self-hosting](/vx/cloud/self-hosting/) to deploy the platform, and the
[HTTP API reference](/vx/cloud/api/) for the raw `/v1` routes behind
these tools.

## Which MCP surface do I want?

- **[`vx mcp` (core, stdio)](/vx/guides/mcp/)** — per-developer, per-workspace,
  process-private; reads the local `cache.db`. No server, no auth.
- **`POST /mcp` (this page)** — team-wide, org/workspace-clamped; reads
  Postgres on a deployment. Needs a `vxc_` token.

See also: [Dashboard](/vx/cloud/dashboard/) — the same analytics as a UI.
