---
title: 'Benchmarks you can re-run'
date: 2026-09-10
authors:
  - vzn
tags:
  - performance
  - benchmarks
excerpt: "Two benchmarks: a synthetic 1,090-package workspace where all three runners see the same graph, and solidjs/solid, a real Turbo repository with vx on top of its own turbo.json. Every number is a command away, and the cold rows are read honestly."
---

Benchmark numbers are only worth what the method behind them is worth.
Here is the method, then the numbers, then how to read the ones that
flatter vx less than the headline.

## Synthetic: the same graph, three runners

`bun packages/vx-bench/compare.ts 100 11 1` scaffolds one workspace of
1,090 packages in 100 dependency layers, about 30 dependencies per
package and three tasks each, 3,270 task nodes, and runs vx, Turborepo
and Nx across the same three cache states: cold, warm with outputs
wiped (restore), and warm with nothing touched (no-op). Fairness is
deliberate: vx runs as the compiled binary users install, every runner
is pinned to the same concurrency, and the runners are measured one at
a time with daemons stopped between them so they never fight for CPU.
`build` and `test` are `sleep 1`, so the numbers isolate the runner's
own overhead from compilation.

Fully cached, `build test --all`:

| Runner    | Fully cached | Cold build CPU |
| --------- | ------------ | -------------- |
| vx        | **510 ms**   | **35 s**       |
| Turborepo | 760 ms       | 73 s           |
| Nx        | 3.59 s       | 114 min        |

The cold column is CPU time (user plus system, of the invocation and
every child it waited for), not wall time, because on a synthetic
workspace the tasks sleep and the column measures the runner's own work
per task. A daemon that outlives the invocation is not counted, so
Turbo's and Nx's are floors. It is the fairest number for "what does
the tool cost me," and Nx's is not a typo. The wall-clock rows, the
theoretical baseline and the measured floors (one git walk is 67 ms on
that machine) are in [Benchmarks](../../benchmarks/).

## Real: solidjs/solid under its own `turbo.json`

A synthetic workspace cannot tell you what happens with rollup, tsc and
vitest in the loop. So the second benchmark is solidjs/solid at a
pinned commit: five packages, pnpm 9, Turbo 2.10.10 as the repository's
own dependency, Node 22. vx is put on top through `@vzn/vx-turbo`, a
two-line `vx.workspace.mjs`, no config rewritten, so both tools see the
same graph and restore the identical 64 output files. vx runs as its
compiled binary; Turbo runs with `--no-daemon` so both pay their own
discovery. Four cores, Linux, arms interleaved, medians.

| `build` (4 tasks)              | vx         | Turbo 2.10.10  |
| ------------------------------ | ---------- | -------------- |
| cold (caches and outputs wiped) | **40.6 s** | 45.5 s (1.12×) |
| warm, outputs wiped (restore)  | **66 ms**  | 127 ms (1.9×)  |
| warm, nothing wiped (no-op)    | **51 ms**  | 95 ms (1.9×)   |

| `test test-types` (7 tasks) | vx         | Turbo 2.10.10  |
| --------------------------- | ---------- | -------------- |
| cold                        | **53.6 s** | 58.2 s (1.09×) |
| warm, restore               | **80 ms**  | 166 ms (2.1×)  |
| warm, no-op                 | **59 ms**  | 93 ms (1.6×)   |

## Read the cold rows honestly

The cold rows are rollup, tsc and vitest. The runner is a few percent
of them. The 4–5 s gap is Turbo's per-task work around the same
commands, its `**` default inputs hashed per package, its log capture,
its cache write, and it was not profiled to the frame here. A cold
build is dominated by your tools, in both runners, and any tool that
tells you otherwise is measuring something else.

The warm rows are the product. With everything cached, vx answers in
50–80 ms where Turbo takes 95–170 ms, and the restore case, which is
what a CI job or a fresh checkout does, is where the ratio is widest.
Turbo's daemon, if turned on, would close part of the no-op gap. vx
has no daemon to turn on.

## The method is the point

Every warm-path change in vx's history shipped with a number measured
this way: A/B arms interleaved, min-of-N, the "before" arm checked out
into an immutable git worktree, one workspace copy per arm pre-warmed
by that arm. Where the headroom went, release by release, is a table in
[Benchmarks](../../benchmarks/). The scripts are in the repository:
`packages/vx-bench/compare.ts` for the synthetic workspace and
`packages/vx-bench/real/turbo-repo.sh` for any Turbo repository you
want to point it at. If a number here does not reproduce on your
machine, that is a bug report.
