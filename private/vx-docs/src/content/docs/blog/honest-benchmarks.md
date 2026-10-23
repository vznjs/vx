---
title: 'Benchmarks you can re-run'
date: 2026-09-10T23:30:00Z
authors:
  - vzn
tags:
  - performance
  - benchmarks
excerpt: "A synthetic 9,603-task workspace where vx, Turborepo, Nx and Vite Task each run the same graph from their own native config. Every number is a command away."
---

The time each runner adds on top of the tasks themselves, on one
9,603-task graph:

| Runner    | Cold build overhead | Nothing changed | Cold build CPU |
| --------- | ------------------- | --------------- | -------------- |
| vx        | **9.27 s** | **720 ms** | 49.58 s |
| Turborepo | 11.05 s | 1.05 s | 1 min 30 s |
| Nx        | 5 min 1 s | 26.21 s | 7 min 43 s |
| Vite Task | 9.89 s | 12.89 s | 29.74 s |

Lower is better. On a cold build the tasks alone take 1 min 53 s under
an ideal schedule; with nothing changed the ideal is 0, so every
millisecond there is the runner. No tool leads every row: Vite Task
burns the least CPU.

Benchmark workload: a synthetic monorepo of 1,601 projects and 9,603 tasks in 30 dependency levels, five core libraries a quarter of the projects use; build 300 ms, test and typecheck 150 ms, lint 75 ms, publish 30 ms; real repos with uneven task times will differ.
Run 2026-10-23 on linux x64, 4 cores, concurrency 10: vx at commit 0be036747, Turborepo 2.11.10, Nx 24.0.1, Vite Task (vite-plus) 1.4.0.

## Re-run it

```sh frame="terminal"
$ bun private/vx-bench/compare.ts 3
```

One workspace: 1,601 projects in 30 dependency levels, five core
libraries about a quarter of the projects use, six kinds of task
(`build`, `lint`, `test`, `typecheck`, `publish`, `installDeps`). Every
runner runs it cold, with nothing changed, and with outputs restored.
Every task is a `sleep` in fixed ratios, so the numbers isolate the
runner from compilation.

| Rule                         | Why                                                   |
| ---------------------------- | ----------------------------------------------------- |
| each tool in its native config | Turborepo `turbo.json`, Nx `nx:run-commands` targets, Vite Task `vite.config.ts` |
| concurrency 10 for all       | same parallelism                                      |
| vx as the compiled binary, from a `vx lock` snapshot | what users install and CI runs |
| CI mode                      | as CI runs them                                       |
| one runner at a time         | no daemon idle-contends for CPU                       |
| no edit row                  | Nx needs its daemon for one, and CI doesn't run it    |

Turbo and Nx run as they would in CI (`CI=1`: Nx's daemon off, and
Turbo uses none for `turbo run`).

## Reading the columns

The first two columns are wall clock. The third is CPU time (user plus
system, of the invocation and every child it waited for, less what the
task commands burn): the tasks sleep, so it measures the runner's own
work. A daemon that outlives the invocation isn't counted, so
Turborepo's and Nx's are floors. Every row and the ideal run are in
[Benchmarks](../../benchmarks/).

Real-repo rows return once each repo is rerun on the native config
`bunx @vzn/vx-migrate` writes.

## The method

Every warm-path change in vx ships with a number measured this way: A/B
arms interleaved, min-of-N, the "before" arm in an immutable git
worktree, one workspace copy per arm pre-warmed by that arm. If a number
here doesn't reproduce on your machine, that is a bug report.

More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
