# @vzn/vx-mcp

Website: <https://vznjs.github.io/vx/> · this plugin: <https://vznjs.github.io/vx/plugins/vx-mcp/> · source: <https://github.com/vznjs/vx>

A [Model Context Protocol](https://modelcontextprotocol.io/) server for
[`@vzn/vx`](https://vznjs.github.io/vx/), as a plugin. Declaring it adds
`vx mcp`: a stdio JSON-RPC surface over your workspace's tasks, cache
and run history that Claude Code, Cursor, Continue.dev, GitHub Copilot and
any other MCP client can call.

```sh
npm install -D @vzn/vx @vzn/vx-mcp   # or: pnpm add -D -w · yarn add -D (-W on Yarn 1) · bun add -d
```

```ts
// vx.workspace.ts
import type { WorkspaceConfig } from '@vzn/vx/config'
import { mcp } from '@vzn/vx-mcp'

export default {
  plugins: [mcp()],
} satisfies WorkspaceConfig
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
| `listTasks`        | "What can I run here?" — every project, its `tags`, and the tasks a run would see (command, `dependsOn`, whether it caches), resolved like `vx run` resolves them, plugin stages included; a command's `exec.env.secret` values read `***`, as in `vx show`. `project` narrows to one; `filter` and `affected` narrow as `vx show --filter` / `--affected` do, the CLI making the selection.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `getCacheStats`    | "What's the state of my cache?" — entries, total size, runs / hits in the last 24h, hit rate. `scope: { project }` narrows every number to that project.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `getRunHistory`    | "Which tasks have I been running, and how fast?" — recent runs plus per-task p50 / p99 / success rate / hit rate / failure mode (flaky only on a real nondeterminism signal), and the largest peak RSS and CPU parallelism the executions showed (`maxPeakRssBytes`, `maxCpuParallelism` — the peak is what `@vzn/vx-schedule-history` reserves from; a task lighter than vx itself shows no peak). Each recent row carries its exit code and, where it applies, why it failed or was skipped as the run's footer said it (`blockedBy`, `timedOut`, `sandboxViolations`, `notReady`). Filters: `project`, `task` (a task name; a `project#task` is refused), `limit` (1..500, clamped rather than refused — the answer carries the `limit` it applied, so a truncated list cannot read as an exhausted one). |
| `explainCacheKey`  | "What's the cache identity of `pkg#build`?" (`taskId`) — the latest entry's hash, command, exit code, duration, size.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `whyDidThisRerun`  | "Why did `pkg#test` re-execute in run X?" (`taskId`, `runId`) — the run's key against the previous run's, whether it changed, what moved (`diff`) and, under a moved upstream, the tasks whose own inputs moved (`roots`), as `vx why --format json` answers (`runId` optional: the task's latest run; whole or the unique prefix `vx last --list` prints; runs recorded before run ids answer the task's latest cache entry, as `vx why` does).                                                                                                                                                                                                                                                                                                                                                             |
| `pruneCache`       | "Free cache space." (`olderThan`, `maxSize`, `dryRun`) — `vx cache prune --format json` on the cache the other tools read: `dryRun`, `evicted`, `bytesFreed`, `orphans`, `orphanBytes`. A dry run unless `dryRun` is false.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `planInit`         | "What would adopting vx write here?" (`mode`) — `vx init --dry --format json`: each file with its text, `kept`, `replaced`, `todos`, `notes`, `next`. Nothing written; in a Turbo or Nx repo the plan is vx-migrate's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `searchDocs`       | "Where is X documented?" (`query`, `limit`) — `vx docs <query> --format json`: the reference sections holding every word, each whole with its URL. No network.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `checkLock`        | "Is the config lock current?" — `vx lock --check --format json`: `upToDate`, `audited`, `notAudited`, and each drift in `problems`; `exitCode` 1 on drift.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `getConfig`        | "What does this task declare?" (`target`: a project, `project#task`, or a task name) — `vx show <target> --format json`'s resolved config: inputs, outputs, env, sandbox, dependsOn, secrets masked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `getTaskLog`       | "What did task X print?" (`taskId`, `runId`) — `vx last --log`'s answer: `runId`, `taskId`, `status`, `source` (`failure`, `cache`, or null when vx kept none: an uncached pass, a skip) and `output` (plain text, a cached log masked as a hit replays it). `runId` defaults to the latest run that recorded the task.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `getFailures`      | "Why did run X fail?" (`runId`) — each failed task's `taskId`, `exitCode`, `timedOut`, its `output` (plain text, the first 8 KiB and last 56 KiB, secrets masked) and the `locations` it names (`{ file, line?, col? }`, file absolute), and `fixedIn` when a later run passed the task — no terminal scraping (`runId` optional: the latest failed run; whole or a unique prefix).                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `runTasks`         | "Run these tasks and tell me how it went." (`tasks`, `all`, `filter`, `affected`, `force`) — runs `vx run <tasks> --format json` here, with this workspace's cache and sandbox, and returns `exitCode` and the run `summary` (the `--summarize` document: `ok`, each task's status, hits, durations). `filter` is the `--filter` values, `affected` is `true` or a git ref. A refusal before the run (an unknown task) returns no summary and the CLI's message, secrets masked, as `error`; a failed task's output is `getFailures`.                                                                                                                                                                                                                                                                        |
| `planTasks`        | "What would run, and why?" (`tasks`, `all`, `filter`, `affected`) — `vx run <tasks> --dry=json` here, nothing executed: each task's predicted cache status, hash, deps and p50, an `affected` reason under `--affected`, and `predicted` (`wallMs`, `workMs`, `criticalPath`). Answers `exitCode` and `plan`; a refusal returns no plan and the CLI's message, secrets masked, as `error`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `getWorkspaceInfo` | "What is this workspace, and what will a run use?" — `vx info --format json`: versions, the git status cache, projects and tasks (and the configs that did not load), plugins and their seams, the worker count and memory budget with their sources, cache versions and state, flaky tasks, the sandbox runtime's verdict for this host and how many tasks declare one, the lock.                                                                                                                                                                                                                                                                                                                                                                                                                           |

Arguments are checked, never coerced: `arguments` that is not an object
(a string, an array), a key the tool does not take (`tsk` for `task`, or a `task` in
`getCacheStats`' scope),
a filter that is not a non-empty string, a task id
missing a half (`#build`, `app#`) or an empty run id, or a `limit` that is not a
finite number is refused with a line naming it, rather than answered
for a question the agent did not ask.

Every tool but `runTasks` is **read-only** (`planTasks` plans and runs nothing): none runs a task or writes
the cache (`listTasks` opens it only to serve cached config evaluations).
`runTasks` writes only what `vx run` writes, through the CLI itself, as a
child process; the plugin declares only a CLI verb, no executor and no
cache layer. The four cache tools open the index as `vx last`
does: where there is none they answer from an empty one and make nothing
on disk, an index from an earlier vx is refused by name and left for the
next `vx run` to reset, and old run history is never pruned by a read.

`mcp({ run })` (`McpOptions`) limits `runTasks`. With `run: false` the tool is not listed and
the server runs nothing. With `run: ['test', 'lint']` an agent may run only
those task names, and any other is refused before anything runs. A task's
`dependsOn` still runs. The default, `true`, runs any task.

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
is an `isError` result. Either error's text has secret values masked
(`***`), as the CLI masks the error it ends on: a config's refusal quotes
the config's own strings.

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
