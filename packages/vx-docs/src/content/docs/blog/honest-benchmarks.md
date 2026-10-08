---
title: 'Benchmarks you can re-run'
date: 2026-09-10T23:30:00Z
authors:
  - vzn
tags:
  - performance
  - benchmarks
excerpt: "Retained native-config timings on a synthetic 1,090-package layered workspace, read alongside a separate scheduling counterexample. End-to-end wall time and baseline-subtracted excess are different metrics."
---

Benchmark numbers are only worth what the method behind them is worth.
Here is the method, then the numbers.

> **Scope:** The retained 2026-10-04 figures below are from a synthetic,
> uniform-sleep layered graph, with one repetition per runner/state, not
> a real build or a universal speed ranking. Read the separate
> [scheduling counterexample](../../benchmarks/#synthetic-scheduling-counterexample),
> including its retained preliminary case, alongside them. Default vx ranks
> by unique transitive-dependent count, not task duration; a different graph
> can favor a different ready-task order.

On the 3,270-node workspace below the tasks alone take 3m 38s under a
feasible ideal schedule. vx finishes the cold run in 3m 40s: about
**two seconds of baseline-subtracted excess**. Nx finishes in 3m 49s,
**eleven seconds**. Vite Task finishes in 4m 49s, **over a minute**.
Turborepo finishes in 4m 59s, **1m 21s of excess**. This difference
includes scheduling delay and idle workers as well as runner work;
it does not isolate hashing overhead.

## Synthetic: the same workload, four runners

`bun packages/vx-bench/compare.ts 100 11 1` scaffolds one workspace of
1,090 packages in 100 dependency layers. The requested 30 dependencies
are capped at the 11-package pool: each non-bottom package has 11 actual
dependencies. vx, Turborepo and Nx use 2,180 executable `build`/`test`
tasks and 1,090 commandless `installDeps` groups, 3,270 task nodes in
total. Vite Task uses direct build/test edges and an empty `vp-all`
aggregator per package instead. All four run the same executable work
across three cache states: cold, warm with outputs wiped (restore), and
warm with nothing touched (no-op).

The retained run is Turborepo 2.11.7, Nx 23.2.1 and Vite Task (`vp run`,
vite-plus 1.0.0) on Linux x64 with 4 cores, every runner pinned to
concurrency 10, every Nx task an `nx:run-commands` target. vx runs as
the compiled binary users install, from a `vx lock` snapshot
(`--frozen`) as a CI pipeline runs it. Turborepo and Nx run as they
would in CI (`CI=1`: Nx's daemon off, and Turborepo uses none for
`turbo run`). The runners are measured strictly one at a time, each
daemon stopped before the next runner is timed so it cannot idle-contend
for CPU. `build` and `test` use `sleep 1`, not compilation; cold wall
time still includes dispatch-order effects.

`build test --all`, the tasks' own ideal schedule being 3m 38s:

| Runner    | Cold build         | Fully cached | Cold build CPU |
| --------- | ------------------ | ------------ | -------------- |
| vx        | **3m 40s** (+0:02) | **393ms**    | **17.27s**     |
| Turborepo | 4m 59s (+1:21, vx 1.3× faster) | 463ms (vx 1.1× faster) | 21.04s (vx 1.2× faster) |
| Nx        | 3m 49s (+0:11, vx 1.03× faster) | 6.45s (vx 16× faster) | 52.19s (vx 3× faster) |
| Vite Task | 4m 49s (+1:11, vx 1.3× faster) | 2.49s (vx 6.3× faster) | 12.46s (vx 1.4× slower) |

vx N× faster: that tool takes N times as long as vx (theirs ÷ vx); N× slower: vx takes N times as long (vx ÷ theirs).

Using the retained cold run's unrounded timings, the Turborepo/vx
**end-to-end ratio is about 1.3555×**; dividing each runner's excess above
the same ideal instead gives **34.609×**. The latter is not a 34.609× total speedup. Subtracting
a large baseline leaves a small denominator, so excess ratios are
particularly sensitive to timing noise and baseline choice.

The first two columns are wall clock; the third is CPU time (user plus
system, of the invocation and every child it waited for). The tasks
sleep instead of compiling, but their shells still consume CPU; this
column is not pure hashing or scheduler CPU. A daemon that outlives the
invocation is not counted. CPU time, end-to-end wall time and excess
answer different questions. The theoretical baseline and measured floors
(one git walk is 24ms on that machine) are in
[Benchmarks](../../benchmarks/).

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
