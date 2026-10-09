---
title: AI agents
description: Let a coding agent run vx, read its answers as JSON, and ask the workspace about its cache and history.
---

vx is built to be run by agents as much as by people. Everything a
person reads in the terminal, an agent can read as data, and the docs
themselves are plain markdown.

## Give the agent the docs

Point the agent at [llms.txt](https://vznjs.github.io/vx/llms.txt): an index of every page as
markdown. [llms-full.txt](https://vznjs.github.io/vx/llms-full.txt) is every docs page in one
file. Any page is also served raw beside its HTML: add `.md` to its
path, as in [quickstart.md](https://vznjs.github.io/vx/quickstart.md).

Without network, `vx docs <query>` searches the reference that ships
inside vx (CLI, config schema, caching, execution, patterns, security,
features) and prints the matching sections whole; `--format json` gives
`{query, hits}`.

## Install the vx skill

`@vzn/vx` ships an agent skill: one `SKILL.md` that teaches an agent to
run tasks, read failures and query the workspace as JSON. Copy it where
your agent reads skills, for Claude Code:

```sh
mkdir -p .claude/skills/vx
cp node_modules/@vzn/vx/skills/vx/SKILL.md .claude/skills/vx/
```

## Run tasks

The commands are the same for an agent as for you:

```sh
vx run build --all
vx run test --affected=origin/main
```

Outside a terminal vx prints plain lines, with no live status region.
A run that is missing its task name does not open the picker without a
TTY; it fails and lists the tasks it found. The exit code is the
verdict: `0` when every task passed ([exit codes](#branch-on-exit-codes-and-error-codes)).

## Read answers as JSON

`vx run`, `vx show`, `vx info`, `vx why`, `vx last`, `vx cache prune`,
`vx lock --check` and `vx init --dry` take `--format json`. Each prints one JSON document to stdout, and every
notice goes to stderr, so stdout always parses. Each shape is a JSON
Schema shipped in the package (`node_modules/@vzn/vx/schemas/`).

```sh
vx show --format json              # every project and its tasks
vx why app#build --format json     # why app#build re-ran, down to the root cause
vx last --failed --format json     # the last failed run, task by task
vx run build --all --dry=json      # what a run would do, before it runs
vx run build --all --format json   # the run's result; task output goes to stderr
vx init --dry --format json        # what adopting vx would write, file by file
```

Under `--affected`, `--dry=json` gives each kept task an `affected`
reason: the changed input, or the `dependsOn` chain that reached it.
A failed row of `vx last --format json` carries the task's `output` and
the files it names (`locations`).

## Branch on exit codes and error codes

The exit code says whether `vx run` worked:

| Exit                  | Means                                                                  |
| --------------------- | ---------------------------------------------------------------------- |
| `0`                   | Every task passed or was a cache hit, or nothing was affected.         |
| `1`                   | A task failed or was skipped, or vx refused the command (see below).   |
| `130` / `143` / `129` | Interrupted by SIGINT / SIGTERM / SIGHUP; vx stopped every task first. |

When vx refuses a command asked for JSON, stdout carries one line with
a stable code, and the exit code stays `1`. Branch on the code, not the
message:

```sh frame="terminal"
$ vx run biuld --all --format json
{"ok":false,"error":{"code":"VX_E_UNKNOWN_TASK","message":"vx run: no projects declare task(s): biuld. Did you mean build?"}}
```

| Code                | What to do                                             |
| ------------------- | ------------------------------------------------------ |
| `VX_E_UNKNOWN_TASK` | Read the task names from `vx show --format json`.      |
| `VX_E_USAGE`        | Fix the flag or argument; `vx help <verb>` lists them. |
| `VX_E_CONFIG`       | Fix the config file named in the message.              |
| `VX_E_NO_HISTORY`   | Run the task first; `vx why` and `vx last` need a run. |
| `VX_E_INTERNAL`     | A defect in vx: report it with the stack from stderr.  |

Every code is in the [CLI reference](../../cli/#error-codes), and
`node_modules/@vzn/vx/schemas/error.json` describes the line.

## Ask the workspace over MCP

`@vzn/vx-mcp` adds `vx mcp`, an MCP server over the workspace's
tasks, cache and run history. Claude Code, Cursor,
Continue.dev and Copilot can call it.

```sh
npm install -D @vzn/vx-mcp
```

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { mcp } from '@vzn/vx-mcp'

export default defineWorkspace({
  plugins: [mcp()],
})
```

```sh
claude mcp add vx -- vx mcp
```

Its tools: `listTasks`, `getCacheStats`, `getRunHistory`,
`explainCacheKey`, `whyDidThisRerun`, `getFailures`, `getTaskLog`, `getConfig`, `checkLock`, `pruneCache`, `planInit`, `searchDocs`,
`getWorkspaceInfo`, `runTasks` and `planTasks`. `runTasks` runs
`vx run <tasks> --format json` and returns the exit code and the run
summary; `planTasks` returns the `vx run <tasks> --dry=json` plan
without running anything; `pruneCache` evicts only with `dryRun:
false`; `planInit` returns the `vx init --dry --format json` plan; the others only read. See
[vx mcp](../plugins/#vx-mcp) for each one.
