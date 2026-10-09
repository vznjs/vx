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
verdict: `0` when every task passed.

## Read answers as JSON

`vx run`, `vx show`, `vx info`, `vx why`, `vx last` and `vx cache prune`
take `--format json`. Each prints one JSON document to stdout, and every
notice goes to stderr, so stdout always parses. Each shape is a JSON
Schema shipped in the package (`node_modules/@vzn/vx/schemas/`).

```sh
vx show --format json              # every project and its tasks
vx why app#build --format json     # why app#build re-ran, down to the root cause
vx last --failed --format json     # the last failed run, task by task
vx run build --all --dry=json      # what a run would do, before it runs
vx run build --all --format json   # the run's result; task output goes to stderr
```

Under `--affected`, `--dry=json` gives each kept task an `affected`
reason: the changed input, or the `dependsOn` chain that reached it.
A failed row of `vx last --format json` carries the task's `output` and
the files it names (`locations`).

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
`explainCacheKey`, `whyDidThisRerun`, `getFailures`, `getTaskLog`,
`getWorkspaceInfo`, `runTasks` and `planTasks`. `runTasks` runs
`vx run <tasks> --format json` and returns the exit code and the run
summary; `planTasks` returns the `vx run <tasks> --dry=json` plan
without running anything; the others only read. See
[vx mcp](../plugins/#vx-mcp) for each one.
