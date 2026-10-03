---
title: 'Benchmarks you can re-run'
date: 2026-09-10T23:30:00Z
authors:
  - vzn
tags:
  - performance
  - benchmarks
excerpt: "A synthetic 1,090-package workspace where vx, Turborepo and Nx each run the same graph from their own native config. Every number is a command away."
---

Benchmark numbers are only worth what the method behind them is worth.
Here is the method, then the numbers.

One number first, because it is the one that decides whether a runner
is worth having. Imagine your tasks take three minutes on their own.
What does the tool add on top? On the 3,270-task workspace below the
tasks alone take 3m 38s under an ideal schedule. vx finishes the cold
build in 3m 47s: **nine seconds of overhead**. Turborepo finishes in
5m 13s, **a minute and a half**. Nx finishes in 34m 44s, **half an hour**.
Every warm number on
this page is a consequence of the same discipline, but this is the one
you feel on every uncached build.

## Synthetic: the same graph, three runners

`bun packages/vx-bench/compare.ts 100 11 1` scaffolds one workspace of
1,090 packages in 100 dependency layers, about 30 dependencies per
package and three tasks each, 3,270 task nodes, and runs vx, Turborepo
and Nx across the same three cache states: cold, warm with outputs
wiped (restore), and warm with nothing touched (no-op). The run below
is Turbo 2.10.12 and Nx 23.2.0 on macOS arm64 with 10 cores, every
runner pinned to concurrency 10. Fairness is deliberate: vx runs as
the compiled binary users install, Turbo and Nx run as they would in
CI (`CI=1`: Nx's daemon off, and Turbo uses none for `turbo run`), and
the runners are measured strictly one at a
time, each daemon stopped before the next runner is timed so it cannot
idle-contend for CPU. `build` and `test` are `sleep 1`, so the numbers
isolate the runner's own overhead from compilation.

`build test --all`, the tasks' own ideal schedule being 3m 38s:

| Runner    | Cold build         | Fully cached | Cold build CPU |
| --------- | ------------------ | ------------ | -------------- |
| vx        | **3m 47s** (+0:09) | **476ms**    | **34.33s**     |
| Turborepo | 5m 13s (+1:35, vx 27% faster) | 760ms (vx 37% faster) | 1m 13s (vx 53% faster) |
| Nx        | 34m 44s (+31:06, vx 89% faster) | 3.59s (vx 86% faster) | 114m 06s (vx 99% faster) |

vx N% faster: vx takes N% less time than that tool (1 − vx ÷ theirs).
Nx's figures ran every task through npm, a harness fault ([Benchmarks](../../benchmarks/) has the fixed run).

The first two columns are wall clock; the third is CPU time (user plus
system, of the invocation and every child it waited for), because on a
synthetic workspace the tasks sleep and that column measures the
runner's own work per task. A daemon that outlives the invocation is
not counted, so Turbo's and Nx's are floors. It is the fairest number for "what does
the tool cost me," and Nx's is not a typo. The wall-clock rows, the
theoretical baseline and the measured floors (one git walk is 67ms on
that machine) are in [Benchmarks](../../benchmarks/).

## Real repositories: rerun pending

An earlier version of this post measured solidjs/solid with vx on top of
its own `turbo.json` through `turbo()`. That measured a migration
bridge, not vx, so its numbers are gone. Real-repo rows return once each
repo is rerun on the native config `bunx @vzn/vx-migrate` writes.
(Updated 2026-10-02.)

## The method is the point

Every warm-path change in vx's history shipped with a number measured
this way: A/B arms interleaved, min-of-N, the "before" arm checked out
into an immutable git worktree, one workspace copy per arm pre-warmed
by that arm. Where the headroom went, release by release, is a table in
[Benchmarks](../../benchmarks/). The scripts are in the repository:
`packages/vx-bench/compare.ts` for the synthetic workspace. If a number here does not reproduce on your
machine, that is a bug report.
