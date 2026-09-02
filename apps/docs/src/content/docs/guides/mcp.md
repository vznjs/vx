---
title: vx mcp — AI agents
description: Expose vx to AI coding agents (Claude Code, Cursor, Continue.dev, GitHub Copilot) through the Model Context Protocol — cache stats, run history and cache-key explanations, read-only, over stdio. A plugin, not core.
---

`@vzn/vx-mcp` is a plugin that adds `vx mcp`: a Model Context Protocol
server over stdio, so AI coding agents can ask your workspace about its
build state through the standard agent-tool protocol. No HTTP, no auth —
stdio is process-private — and nothing it exposes can run a task or
write the cache.

## Install and declare

```sh
npm install -D @vzn/vx-mcp   # or pnpm add -D · bun add -d
```

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
import { localCachePlugin } from '@vzn/vx/plugins/local-cache'
import { mcp } from '@vzn/vx-mcp'

export default defineWorkspace({
  plugins: [mcp(), localExecutorPlugin(), localCachePlugin()],
})
```

That is the whole setup: the plugin contributes one CLI verb through
the [`commands` seam](/vx/guides/plugins/#adding-a-verb), and `vx help`
lists it under "Plugin commands" from any directory inside the
workspace.

## Point your agent at it

```jsonc
// Claude Code: ~/.claude/mcp.json — or: claude mcp add vx -- vx mcp
{
  "mcpServers": {
    "vx": { "command": "vx", "args": ["mcp"] }
  }
}
```

Cursor, Continue.dev and VS Code Copilot take the same `command + args`
shape in their own config files. Run the agent from inside the
workspace: `vx mcp` finds the workspace and its cache from the current
directory, exactly like `vx run`.

## Tools

| Tool              | What it answers                                                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getCacheStats`   | "What's the state of my cache right now?" — entries, total size, runs and hits in the last 24h, hit rate. `scope: { project }` narrows every number to that project rather than echoing the workspace's.                                 |
| `getRunHistory`   | "Which tasks have I been running, and how fast?" — recent runs plus per-task p50 / p99 / success rate / hit rate. `failureMode` calls a task flaky only on a real nondeterminism signal (a within-run retry, or one key that both failed and succeeded) — repeated failures on their own keys are a break, not flake. |
| `explainCacheKey` | "What's the cache identity of `pkg#build`?" — the latest entry's hash, command, exit code, duration and size. The per-component breakdown is `vx why`.                                                                                     |
| `whyDidThisRerun` | "Why did `pkg#test` re-execute in run X instead of hitting?" — the run's key against the previous run's for the same task, and whether it changed.                                                                                       |

All four read the local `cache.db` — the same tables `vx why`, `vx last`
and `vx info` read. Ask things like:

- "What's my cache hit rate today?"
- "Why did `pkg-a#test` re-run in the last build?"
- "Which tasks miss the cache most often?"

## How it works

MCP over stdio is newline-delimited JSON-RPC 2.0 and three methods —
`initialize`, `tools/list`, `tools/call`. The plugin speaks it natively
in about a hundred lines with no dependencies (the reference SDK pulls
in an HTTP stack this transport never uses). A tool's own refusal
("taskId must be `project#task`") comes back as an `isError` result the
agent can read and correct, not as a protocol error.

## Troubleshooting

- **The agent lists no vx tools.** Most clients read their MCP config
  only at launch — restart the agent, and check `vx help` shows `vx mcp`
  from the directory the agent runs in.
- **`unknown command: mcp`.** The cwd is outside a workspace whose
  `vx.workspace.ts` declares `mcp()`; the verb exists only there.
- **Empty stats.** No `vx run` has happened in this workspace yet, or
  the agent runs from another workspace.
