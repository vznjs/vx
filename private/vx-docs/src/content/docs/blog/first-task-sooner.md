---
title: 'A cold run asks the cache nothing'
date: 2026-10-09T17:30:00Z
authors:
  - vzn
tags:
  - performance
  - caching
excerpt: 'On an empty cache every lookup would miss, so vx skips them. On a 1,000-project workspace the first task starts 136 ms after `vx run`.'
---

A 1,000-project workspace, an empty cache, and vx's own stage timer:

```sh frame="terminal"
$ VX_DEBUG_TIMING=1 vx run build --all
[vx timing]  stage                    own   cumulative
             startup                 47.9ms      47.9ms
             …
             git enumeration         41.5ms     157.9ms
             classify + probe         9.8ms     168.3ms
             schedule                 0.1ms     168.4ms
             run graph             1855.1ms    2023.5ms
```

`schedule` ends when the first task starts. Everything above it is the
wait before anything happens.

| Cache before the run | `classify + probe` | First task starts |
| -------------------- | ------------------ | ----------------- |
| empty                | 8.8 ms             | 136 ms            |
| holds all 1,000 keys | 47.3 ms            | 162 ms            |

Min of 7 runs each, `private/vx-bench/generate.ts` with 1,000 projects,
`build --all`, Linux x64, 4 cores, vx at `13f6908`, 2026-10-23.

## Why the empty cache is cheaper

Before a run, vx works out each task's key and looks it up, so it knows
which tasks restore and which run. With a full cache that pass is what
makes a cached run fast.

With an empty cache every lookup would miss. So vx checks once whether
the local cache holds anything. If not, it skips the pass, and each task
works out its own key as it starts. The keys are the same either way;
only when they are computed moves.

The whole cold build takes as long as before. The saving is at the
start, where you sit and wait.

## Nothing to turn on

Every cold run works this way. Try it in your repo:

```sh
bunx @vzn/vx init
VX_DEBUG_TIMING=1 vx run build --all
```

More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
