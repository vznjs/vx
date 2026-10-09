---
title: Built for the agents that run your builds
description: vx is AI-first. An agent asks what to run, runs it, and learns why it failed, all as typed JSON. People get the same answers as text.
---

More and more builds start from a coding agent, not a person at a
terminal. vx is designed for that: an agent can ask what to run, run
it, and learn why it failed without scraping terminal output. People
get the same answers, formatted for reading.

## Ask the build over MCP

[`@vzn/vx-mcp`](../../plugins/vx-mcp/) adds `vx mcp`, an MCP server that
Claude Code, Cursor, Continue.dev, GitHub Copilot or any MCP client can
call. Its tools:

| Question                                      | Tool                                         |
| --------------------------------------------- | -------------------------------------------- |
| What can I run here?                          | `listTasks`                                  |
| What would run, and why?                      | `planTasks`                                  |
| Run these tasks and tell me how it went.      | `runTasks`                                   |
| Why did the run fail, at which file and line? | `getFailures`                                |
| What did a task print?                        | `getTaskLog`                                 |
| Why did this task run again?                  | `whyDidThisRerun`                            |
| What does a task declare?                     | `getConfig`                                  |
| What is this workspace?                       | `getWorkspaceInfo`                           |
| How is the cache doing?                       | `getCacheStats`, `explainCacheKey`           |
| What ran, how fast, what flaked?              | `getRunHistory`                              |
| Is the lock current? What would `vx init` do? | `checkLock`, `planInit`                      |
| Free cache space.                             | `pruneCache` (a dry run unless told not to)  |

Every tool but `runTasks` only reads. `runTasks` runs through the CLI
itself, so it writes only what `vx run` writes. You decide how far it
goes:

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx/config'
import { mcp } from '@vzn/vx-mcp'

export default defineWorkspace({
  // false: the agent runs nothing. A list: only these task names.
  plugins: [mcp({ run: ['test', 'lint'] })],
})
```

```sh
claude mcp add vx -- vx mcp
```

## JSON with a contract

`vx show`, `vx info`, `vx why`, `vx last` and `vx cache prune` take
`--format json`. Each prints one document whose shape is a JSON Schema
shipped in the package, and every object closes its key set, so a new
field is a schema change, never a surprise. `vx run --format json`
prints the run's result; `vx run --dry=json` prints the plan before
anything runs. See [Machine-readable output](../../cli/#machine-readable-output).

## Errors you can branch on

Asked for JSON, a refusal is one line on stdout with a stable code,
such as `VX_E_UNKNOWN_TASK` or `VX_E_CYCLE`. The code stays; the
message may change. See [Error codes](../../cli/#error-codes).

## Clean streams

A verb whose output is a product writes only that product to stdout.
Notices and warnings go to stderr, so `vx info --format json` pipes
straight into a parser.

## Answers, not guesses

`vx why app#test` walks the cause chain: which input changed, in which
upstream task. An agent fixes the cause instead of re-running to find
it. A mistyped flag gets the right one back: `--concurency` hints
`--concurrency`, and `--json` hints `--format json`.

## Docs an agent can read

[llms.txt](https://vznjs.github.io/vx/llms.txt) indexes every page as
markdown, and `vx docs <query>` searches the reference that ships
inside vx, offline.

## Still built for people

The same facts print as plain text. Run `vx run build --all`, and when
something re-runs, `vx why` tells you why. Setup steps for each agent
are in the [AI agents guide](../../guides/agents/).
