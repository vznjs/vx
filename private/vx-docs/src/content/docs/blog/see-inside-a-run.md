---
title: 'See inside a run'
date: 2026-10-09T09:00:00Z
authors:
  - vzn
tags:
  - dx
  - agents
excerpt: 'Why does this task run? What did the run do? Where did the time go? One command each: affected reasons, the run as JSON, the plan as a graph and vx''s own stage table.'
---

Four questions, four commands. Each prints something a script or an
agent can read.

| Question                  | Command                           |
| ------------------------- | --------------------------------- |
| Why does this task run?   | `vx run --affected=HEAD --dry`    |
| What did the run do?      | `vx last --format json`           |
| What depends on what?     | `vx run --dry=json`               |
| Where did vx spend time?  | `VX_DEBUG_TIMING=1 vx run`        |

## Why a task runs

Edit one file in `packages/a` and ask what a pull request would run:

```sh frame="terminal"
$ vx run build --all --affected=HEAD --dry
would run:
  ▶  packages/a#build  cache miss — would exec   2feaa870  ~15ms
                       affected: packages/a/src/index.ts changed (an input)
  ▶  packages/c#build  cache miss — would exec   7ed8a143  ~7ms
                       affected: packages/a/src/index.ts changed (an input), via packages/a#build

2 task(s) planned, 2 would run.
predicted: ~22ms wall · ~22ms total execution
```

Each task names the changed file, or the chain that reached it. The
prediction comes from past runs. `--dry=json` gives the same as JSON.

## What the run did, as JSON

```sh frame="terminal"
$ vx last --format json | jq -c '.invocation | {command, taskCount, failedCount, hitCount, totalDurationMs}'
{"command":"vx run build --all","taskCount":4,"failedCount":0,"hitCount":4,"totalDurationMs":9}
$ vx last --format json | jq -c '.tasks[0] | {project, task, status, durationMs, hash}'
{"project":"packages/d","task":"build","status":"cache-hit","durationMs":0,"hash":"9f1cef08a2fd4006"}
```

`vx last --list --format json` lists recent runs, newest first, each
with its commit and branch.

## The graph, for Graphviz

```sh frame="terminal"
$ vx run build --all --dry=json \
    | jq -r '"digraph G {", (.tasks[] | .id as $t | .deps[] | "  \"\(.)\" -> \"\($t)\""), "}"'
digraph G {
  "packages/a#build" -> "packages/c#build"
}
```

Pipe it into `dot -Tsvg`. Each task's `cacheStatus` says whether it
would hit.

## Where vx spends time

```sh frame="terminal"
$ VX_DEBUG_TIMING=1 vx run build --all
[vx timing]  stage                    own   cumulative
             startup                 46.4ms      46.4ms
             workspace config        10.2ms      56.6ms
             discover projects        1.9ms      58.5ms
             package graph            0.4ms      58.9ms
             open cache               5.0ms      63.9ms
             load configs             1.0ms      64.9ms
             build graph              2.3ms      67.2ms
             git enumeration          1.3ms      68.5ms
             plugin stages            0.2ms      68.8ms
             classify + probe         8.8ms      77.6ms
             schedule                 0.0ms      77.6ms
             run graph                4.2ms      81.8ms
             record history           5.2ms      87.0ms
             output dir snapshots     0.4ms      87.4ms
             close                    2.3ms      89.6ms
```

A fully cached run of four tasks, start to exit, in 90 ms. Each row is a
pipeline stage, so a slow config or a slow probe stands out.

Outputs above: demo workspace, vx at `22f6eb7`, 2026-10-23; the stage
table is the fastest of 7 runs.

Every flag: [CLI reference](../../cli/). The run JSON's fields:
[Built for agents](../built-for-agents/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
