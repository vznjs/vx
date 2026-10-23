---
title: 'See the plan before you run it'
date: 2026-10-08T23:39:00Z
authors:
  - vzn
tags:
  - dx
  - caching
excerpt: 'vx run --dry prints the task graph, which tasks would hit the cache and which would run, their keys and how long they should take. Nothing executes.'
---

One edit in `packages/b`. `--dry` shows what the next run will do,
without running anything:

```sh frame="terminal"
$ vx run build test --all --dry
would run:
  ✓  packages/a#build  cache hit (local)         4ab2bc0d
  ▶  packages/b#build  cache miss — would exec   e8c0e9d5  ~19ms
  ✓  packages/c#build  cache hit (local)         5e8ed98e
  ✓  packages/d#build  cache hit (local)         9f1cef08
  ✓  packages/a#test   cache hit (local)         9ea4543b
  ▶  packages/b#test   cache miss — would exec   537a0bf3  ~19ms
  ✓  packages/c#test   cache hit (local)         6c5e8b3a
  ✓  packages/d#test   cache hit (local)         5b407891

8 task(s) planned, 6 cache hits (6 local), 2 would run.
predicted: ~19ms wall · ~38ms total execution

$ vx run build test --all
 ⏺︎    10ms success miss     packages/b#test
 ⏺︎    17ms success miss     packages/b#build
```

The plan said two misses; the run ran those two. Linux x64, vx at
`69617eb`, 2026-10-23.

## Real keys, real predictions

- **Same keys.** A dry run derives the keys a real run would and asks
  the same cache. A hit in the plan is a hit in the run.
- **Last time's duration.** The time next to a task is its last run.
- **Wall time on the graph.** The prediction lays those times on the
  graph: a task waits for its dependencies, independent tasks overlap.

## For scripts and agents

`--dry=json` is the same plan as JSON, one object per task:

```json
{"id":"packages/a#build","project":"packages/a","task":"build","hash":"4ab2bc0d55dd78a0","cacheStatus":"hit-local","deps":[],"p50Ms":22}
```

An agent can decide whether a run is worth starting, or show a
reviewer what a change rebuilds:

```sh frame="terminal"
vx run build --affected --dry=json
```

## The graph itself

Each task carries its `deps`, so Graphviz DOT is one `jq` away:

```sh frame="terminal"
vx run build --all --dry=json \
  | jq -r '"digraph G {", (.tasks[] | .id as $t | .deps[] | "  \"\(.)\" -> \"\($t)\""), "}"' > graph.dot
dot -Tsvg graph.dot > graph.svg
```

Reference: [the CLI](../../cli/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
