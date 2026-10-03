# @vzn/vx-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) server for
[`@vzn/vx`](https://github.com/vznjs/vx), as a plugin. Declaring it adds
`vx mcp`: a read-only, stdio JSON-RPC surface over your workspace's cache
and run history that Claude Code, Cursor, Continue.dev, GitHub Copilot and
any other MCP client can call.

```sh
npm install -D @vzn/vx @vzn/vx-mcp   # or: pnpm add -D -w · yarn add -D (-W on Yarn 1) · bun add -d
```

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { mcp } from '@vzn/vx-mcp'

export default defineWorkspace({
  plugins: [mcp()],
})
```

Then point your agent at it:

```jsonc
// Claude Code: .mcp.json at the workspace root (or `claude mcp add vx -- vx mcp`)
{ "mcpServers": { "vx": { "command": "vx", "args": ["mcp"] } } }
```

Run the agent from inside the workspace — `vx mcp` finds the workspace
(and its cache) from the current directory, like every other verb.
`vx mcp --help` prints its usage; `--stdio`, the default, is its one flag.

## Tools

| Tool               | Answers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `listTasks`        | "What can I run here?" — every project and the tasks a run would see (command, `dependsOn`, whether it caches), resolved like `vx run` resolves them, plugin stages included; a command's `exec.env.secret` values read `***`, as in `vx show`. `project` narrows to one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `getCacheStats`    | "What's the state of my cache?" — entries, total size, runs / hits in the last 24h, hit rate. `scope: { project }` narrows every number to that project.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `getRunHistory`    | "Which tasks have I been running, and how fast?" — recent runs plus per-task p50 / p99 / success rate / hit rate / failure mode (flaky only on a real nondeterminism signal), and the largest peak RSS and CPU parallelism the executions showed (`maxPeakRssBytes`, `maxCpuParallelism` — the peak is what `@vzn/vx-schedule-history` reserves from; a task lighter than vx itself shows no peak). Each recent row carries its exit code and, where it applies, why it failed or was skipped as the run's footer said it (`blockedBy`, `timedOut`, `sandboxViolations`, `notReady`). Filters: `project`, `task` (a task name; a `project#task` is refused), `limit` (1..500, clamped rather than refused — the answer carries the `limit` it applied, so a truncated list cannot read as an exhausted one). |
| `explainCacheKey`  | "What's the cache identity of `pkg#build`?" (`taskId`) — the latest entry's hash, command, exit code, duration, size.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `whyDidThisRerun`  | "Why did `pkg#test` re-execute in run X?" (`taskId`, `runId`) — the run's key against the previous run's, and whether it changed (`runId` optional: the task's latest run; whole or the unique prefix `vx last --list` prints; runs recorded before run ids answer the task's latest cache entry, as `vx why` does).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `getWorkspaceInfo` | "What is this workspace, and what will a run use?" — `vx info --format json`: versions, the git status cache, projects and tasks (and the configs that did not load), plugins and their seams, the worker count and memory budget with their sources, cache versions and state, flaky tasks, the sandbox runtime's verdict for this host and how many tasks declare one, the lock.                                                                                                                                                                                                                                                                                                                                                                                                                           |

Arguments are checked, never coerced: `arguments` that is not an object
(a string, an array), a key the tool does not take (`tsk` for `task`, or a `task` in
`getCacheStats`' scope),
a filter that is not a non-empty string, a task id
missing a half (`#build`, `app#`) or an empty run id, or a `limit` that is not a
finite number is refused with a line naming it, rather than answered
for a question the agent did not ask.

Every tool is **read-only**. Nothing here runs a task or writes the
cache (`listTasks` opens it only to serve cached config evaluations); the plugin declares only a CLI verb, no executor and no cache
layer, so it cannot. The four cache tools open the index as `vx last`
does: where there is none they answer from an empty one and make nothing
on disk, an index from an earlier vx is refused by name and left for the
next `vx run` to reset, and old run history is never pruned by a read.

## Why no SDK

MCP over stdio is newline-delimited JSON-RPC 2.0 and four methods
(`initialize`, `tools/list`, `tools/call`, `ping`); a batch, which the 2025-03-26 revision allows, is answered as one array. `src/server.ts` speaks it in
about 230 lines with no dependencies, where the reference SDK pulls
in an HTTP stack this transport never touches. `@vzn/vx` is the only peer.
What a config or plugin stage prints while a tool loads the workspace
goes to stderr: `console`, `process.stdout`, `Bun.write(Bun.stdout, …)`
and `Bun.stdout.writer()` (item 1069). A write straight to fd 1
(`fs.writeSync(1, …)`) or a child with inherited stdout still lands in
the reply stream: give such a child `stdout: 'pipe'`.
It speaks revisions 2024-11-05, 2025-03-26 and 2025-06-18 (a client asking for
another is offered the newest), and answers a request
outside JSON-RPC 2.0's envelope with -32600 and a call to an unknown
tool or with non-object `arguments` with -32602; a tool's own refusal
is an `isError` result.

## Troubleshooting

- **The agent lists no vx tools.** Most clients read their MCP config only
  at launch — restart the agent. Check `vx help` shows `vx mcp` under
  "Plugin commands" from the directory the agent runs in.
- **`unknown command: mcp`.** The cwd is outside a workspace that declares
  the plugin; `vx mcp` exists only where `vx.workspace.ts` says `mcp()`.
- **Empty stats.** No `vx run` has happened in this workspace yet, or the
  agent runs from a different workspace.
- **`… a running process cannot evaluate an imported module again`.** A
  file a config imports changed while the server ran; Bun cannot load a
  module twice. Restart the agent (or its MCP server) to apply the edit.
