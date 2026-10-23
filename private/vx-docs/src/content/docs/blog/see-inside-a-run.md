---
title: 'See inside a run'
date: 2026-10-09T09:00:00Z
authors:
  - vzn
tags:
  - dx
  - agents
excerpt: 'Why does this task run? What did the run save? Where did the time go? vx answers each in one command: affected reasons, the run as JSON, the plan as a graph and its own stage table.'
---

The default run output stays short. When you want the facts behind it,
each one is a command away, and each prints something a script or an agent
can read.

## Why a task runs

Edit one file in `@demo/ui` and ask what a pull request would run:

```sh frame="terminal"
$ vx run build --all --affected=HEAD --dry
would run:
  ▶  @demo/docs#build  cache miss — would exec   e50d7ee9  ~309ms
                       affected: packages/ui/src/index.ts changed (an input), via @demo/ui#build
  ▶  @demo/ui#build    cache miss — would exec   e212d097  ~312ms
                       affected: packages/ui/src/index.ts changed (an input)
  ▶  @demo/web#build   cache miss — would exec   c6c7de2f  ~308ms
                       affected: packages/ui/src/index.ts changed (an input), via @demo/ui#build

3 task(s) planned, 3 would run.
predicted: ~621ms wall · ~929ms total execution
```

Each kept task names the changed file, or the dependency chain that
reached it. The prediction comes from past runs. `--dry=json` gives the
same as JSON.

## What the run did, as JSON

`vx last --format json` reads the run back from run history: the
invocation, then a row per task.

```sh frame="terminal"
$ vx run build --all
$ vx last --format json | jq -c '.invocation | {command, taskCount, failedCount, hitCount, totalDurationMs, branch}'
{"command":"vx run build --all","taskCount":2,"failedCount":0,"hitCount":2,"totalDurationMs":16,"branch":"master"}
$ vx last --format json | jq -c '.tasks[0] | {project, task, status, durationMs, hash}'
{"project":"@demo/web","task":"build","status":"cache-hit","durationMs":3,"hash":"07179a1f06544b65"}
```

`vx last --list --format json` lists the recent runs, newest first, and
each run keeps its commit and branch, so a nightly run is easy to tell
from a pull request.

## The graph, for Graphviz

Each task in `--dry=json` carries its `deps`, so the graph is one `jq`
away from Graphviz DOT:

```sh frame="terminal"
$ vx run build --all --dry=json \
    | jq -r '"digraph G {", (.tasks[] | .id as $t | .deps[] | "  \"\(.)\" -> \"\($t)\""), "}"'
digraph G {
  "@demo/api#build" -> "@demo/web#build"
}
```

Pipe it into `dot -Tsvg`. Each task's `cacheStatus` in the same JSON
says whether it would hit.

## Where vx itself spends time

`VX_DEBUG_TIMING=1` prints vx's own stage table, for performance work on vx:

```sh frame="terminal"
$ VX_DEBUG_TIMING=1 vx run build --all
[vx timing]  stage                    own   cumulative
             startup                 65.7ms      65.7ms
             workspace config        14.6ms      80.3ms
             discover projects        4.2ms      84.5ms
             package graph            0.9ms      85.4ms
             open cache               6.8ms      92.2ms
             load configs             4.9ms      97.1ms
             build graph              3.2ms     100.3ms
             git enumeration          1.1ms     101.4ms
             plugin stages            0.1ms     101.5ms
             classify + probe        12.1ms     113.6ms
             run graph                6.5ms     120.1ms
             record history           2.9ms     123.0ms
             output dir snapshots     0.0ms     123.0ms
             close                    2.8ms     125.8ms
```

A fully cached run of four tasks, start to exit, in 126 ms. Each row is a
stage of the pipeline, so a slow config or a slow probe stands out.

Every flag is in the [CLI reference](../../cli/), and the run JSON's
fields are in [Built for agents](../built-for-agents/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
