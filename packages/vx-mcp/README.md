# @vzn/vx-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) server for
[`@vzn/vx`](https://github.com/vznjs/vx), as a plugin. Declaring it adds
`vx mcp`: a read-only, stdio JSON-RPC surface over your workspace's cache
and run history that Claude Code, Cursor, Continue.dev, GitHub Copilot and
any other MCP client can call.

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

Then point your agent at it:

```jsonc
// Claude Code: ~/.claude/mcp.json (or `claude mcp add vx -- vx mcp`)
{ "mcpServers": { "vx": { "command": "vx", "args": ["mcp"] } } }
```

Run the agent from inside the workspace — `vx mcp` finds the workspace
(and its cache) from the current directory, like every other verb.

## Tools

| Tool              | Answers                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getCacheStats`   | "What's the state of my cache?" — entries, total size, runs / hits in the last 24h, hit rate. `scope: { project }` narrows every number to that project.                                                           |
| `getRunHistory`   | "Which tasks have I been running, and how fast?" — recent runs plus per-task p50 / p99 / success rate / hit rate / failure mode (flaky only on a real nondeterminism signal). Filters: `project`, `task`, `limit`. |
| `explainCacheKey` | "What's the cache identity of `pkg#build`?" — the latest entry's hash, command, exit code, duration, size.                                                                                                         |
| `whyDidThisRerun` | "Why did `pkg#test` re-execute in run X?" — the run's key against the previous run's, and whether it changed.                                                                                                      |

Every tool is **read-only**. Nothing here runs a task or writes the
cache; the plugin declares only a CLI verb, no executor and no cache
layer, so it cannot.

## Why no SDK

MCP over stdio is newline-delimited JSON-RPC 2.0 and three methods
(`initialize`, `tools/list`, `tools/call`). `src/server.ts` speaks it in
about a hundred lines with no dependencies, where the reference SDK pulls
in an HTTP stack this transport never touches. `@vzn/vx` is the only peer.

## Troubleshooting

- **The agent lists no vx tools.** Most clients read their MCP config only
  at launch — restart the agent. Check `vx help` shows `vx mcp` under
  "Plugin commands" from the directory the agent runs in.
- **`unknown command: mcp`.** The cwd is outside a workspace that declares
  the plugin; `vx mcp` exists only where `vx.workspace.ts` says `mcp()`.
- **Empty stats.** No `vx run` has happened in this workspace yet, or the
  agent runs from a different workspace.
