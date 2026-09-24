---
title: vx mcp — AI agents
description: Let an AI coding agent read your workspace's tasks, cache stats and run history through the Model Context Protocol, read-only, over stdio.
---

Let Claude Code, Cursor, Continue.dev or Copilot ask your workspace why a
task re-ran. Nothing it exposes can run a task or write the cache.

## Steps

1. Install: `npm install -D @vzn/vx-mcp`.
2. Declare `mcp()` in `vx.workspace.ts` (below). `vx help` now lists `vx mcp`.
3. Point your agent at `vx mcp`: `claude mcp add vx -- vx mcp`, or the JSON below.
4. Start the agent inside the workspace, and ask it: "Why did `app#test` re-run?"

## Config

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { mcp } from '@vzn/vx-mcp'

export default defineWorkspace({ plugins: [mcp()] })
```

```jsonc
// ~/.claude/mcp.json; Cursor, Continue.dev and Copilot take the same shape
{ "mcpServers": { "vx": { "command": "vx", "args": ["mcp"] } } }
```

## Tools

| Tool               | Answers                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `listTasks`        | What can I run here?                                             |
| `getCacheStats`    | How big is the cache, and what is today's hit rate?              |
| `getRunHistory`    | Which tasks run, how fast, how often they fail or flake?         |
| `explainCacheKey`  | What is the cache identity of `pkg#build`?                       |
| `whyDidThisRerun`  | Why did `pkg#test` re-run instead of hitting?                    |
| `getWorkspaceInfo` | What `vx info` says: versions, plugins, cache, sandbox           |

The server speaks MCP over stdio in about 150 lines, with no dependencies.

## Common problems

- **The agent lists no vx tools.** Most agents read their MCP config at launch: restart it.
- **`unknown command: mcp`.** The agent runs outside a workspace whose `vx.workspace.ts` declares `mcp()`.
- **The stats are empty.** No `vx run` has happened in this workspace yet.
