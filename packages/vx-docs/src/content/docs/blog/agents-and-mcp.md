---
title: "Give your coding agent the build's memory"
date: 2026-09-10T23:37:00Z
authors:
  - vzn
tags:
  - plugins
  - agents
excerpt: "An AI agent working in a monorepo asks the same questions you do: what can I run here, why did that re-run, which tasks flake. @vzn/vx-mcp answers them over the Model Context Protocol, read-only, from the cache database vx already keeps."
---

A coding agent dropped into a large monorepo spends a surprising share
of its tokens working out how the build works: reading `turbo.json` or
a hundred `project.json` files, guessing which task to run, re-running
things to see whether they are cached. The runner already knows all of
that. `@vzn/vx-mcp` hands it over.

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'
import { mcp } from '@vzn/vx-mcp'

export default defineWorkspace({ plugins: [mcp()] })
```

```jsonc
// Claude Code: ~/.claude/mcp.json — or: claude mcp add vx -- vx mcp
{ "mcpServers": { "vx": { "command": "vx", "args": ["mcp"] } } }
```

Cursor, Continue.dev and VS Code Copilot take the same command-and-args
shape. Run the agent from inside the workspace and `vx mcp` finds the
workspace and its cache from the current directory, exactly as `vx run`
does.

## What it answers

| Tool              | The question                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `listTasks`       | What can I run here? Every project and task as a run would see them, plugin stages included.              |
| `getCacheStats`   | What is the cache's state right now? Entries, size, runs and hit rate, per workspace or per project.      |
| `getRunHistory`   | What have I been running and how fast? Recent runs with per-task p50, p99, success rate, hit rate.       |
| `explainCacheKey` | What is the cache identity of `pkg#build`? The latest entry's hash, command, exit code, duration, size.   |
| `whyDidThisRerun` | Why did `pkg#test` re-execute instead of hitting? The run's key against the previous run's.               |

The history tools read the same local `cache.db` tables that `vx why`,
`vx last` and `vx info` read. `getRunHistory` calls a task flaky only
on a real nondeterminism signal, a within-run retry or one key that
both failed and succeeded, so an agent does not learn to shrug at
repeated failures on changing inputs.

Nothing exposed can run a task or write the cache. The transport is
stdio, which is process-private, so there is no port, no auth and no
attack surface beyond the process the agent already spawned.

## Why it is a hundred lines

MCP over stdio is newline-delimited JSON-RPC 2.0 and three methods:
`initialize`, `tools/list`, `tools/call`. The plugin speaks it natively
in about a hundred lines with no dependencies; the reference SDK pulls
in an HTTP stack this transport never uses. A tool's own refusal ("a
task id must be `project#task`") comes back as an `isError` result the
agent can read and correct, not as a protocol error that ends the
conversation.

It is also the clearest example of the `commands` seam doing what it is
for: one plugin contributes one verb, `vx help` lists it under "Plugin
commands" from any directory inside the workspace that declares it,
and outside such a workspace the verb does not exist. Core knows
nothing about agents.

## The other half

The MCP server is how an agent *reads* the build. The other half of
working with agents is letting one *run* the build safely, and that is
what the rest of vx already is: explicit inputs, [strict
outputs](../strict-output-ownership/), a [sandbox](../the-sandbox/) that
denies undeclared reads and network, and a
[teardown](../ctrl-c/) that leaves nothing running when the agent's
session is cancelled. An agent that can only run declared commands
against declared paths is an agent you can leave alone with the
repository.

The guide is [`vx mcp` — AI agents](../../guides/mcp/).
