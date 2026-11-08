---
title: 'DTE workers that fit the work, and a footer that says how full they ran'
date: 2026-11-07T22:10:00Z
authors:
  - vzn
tags:
  - execution
  - ci
excerpt: 'vx DTE puts each task on a machine type that can run it, books it by its measured memory peak and CPU, stops a server once nothing needs it, and prints how busy every worker was.'
---

On vx's own main branch, nine Linux workers ran 88% busy for one run.
The footer prints that for every worker, every run.

```mermaid
xychart-beta
  title "Machine busy, per worker (%)"
  x-axis ["small#1", "#2", "#3", "#4", "#5", "#6", "#7", "#8", "#9", "mac#3"]
  y-axis "%" 0 --> 100
  bar [94, 92, 89, 90, 88, 92, 85, 88, 86, 76]
```

<small>vx CI on GitHub runners, 160 tasks to run · 4a86e02 · 2026-11-07 · [the run](https://github.com/vznjs/vx/actions/runs/42373931129)</small>

## A Mac starts only for a Mac task

```ts
dte({
  workers: {
    hosted: {
      machines: {
        small: { max: 9, cpu: 4, memory: '16GB', platform: 'linux-x64' },
        arm: { max: 1, cpu: 4, memory: '16GB', platform: 'linux-arm64' },
        mac: { max: 4, cpu: 3, memory: '7GB', platform: 'darwin-arm64' },
      },
    },
  },
})
```

A task runs on a machine of its own platform, Linux unless it names
another. A Mac starts only when a task needs macOS, and only as many as
those tasks fill. `exec.worker` sends a task to one named type.

## A task is booked by what it used last time

```mermaid
flowchart LR
  H[run history] -->|peak memory, average CPU| B[booking]
  B --> F{a core free and the memory fits?}
  F -->|yes| W[sent to the worker]
  F -->|no| Q[waits, longest chain first]
```

Memory is booked at its peak, since running out kills a task. CPU is
booked at its average, so a worker is not left half idle.

## A server stops once no task needs it

A dev server or database a test depends on starts on that test's
worker. It stops when no task left in the run uses it, and its CPU is
charged to the tasks it served.

## The footer shows three numbers per worker

```ansi
  [38;2;192;132;252mhosted.small[0m[2m#[0m[38;2;167;139;250m1[0m  left     12 done · warm-up 91.9s
  [2m                declared 4c/16G · actual [0m[38;2;34;197;94m4c/17G[0m
  [2m                online 122.2s · busy 122.1s · idle 0.1s[0m
  [2m                cpu utilization machine 94% · tasks 67% · worker 3%[0m
  [2mbest            8 × hosted.small + 1 × hosted.arm + 2 × hosted.mac: 160.9s[0m
  total           cpu utilization machine 88% · tasks 63% · worker 2%
```

`machine` counts any process on the box, `tasks` only your tasks, and
`worker` vx itself. The `best` line says which workers would have run
this run soonest, with the fewest machines.

How DTE places work: [vx-dte](https://github.com/vznjs/vx/tree/main/packages/vx-dte#what-runs-where).
More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
