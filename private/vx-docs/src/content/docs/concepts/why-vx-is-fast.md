---
title: Why vx is fast
description: The engineering behind vx's speed and its correctness guarantees — git-OID hashing, bitset scheduling, strict output ownership, and a daemonless design — with measured numbers.
---

vx's speed isn't a microbenchmark trick; it comes from a handful of
structural decisions. This page explains them. The exhaustive,
source-cited catalog lives in [Optimizations](../../optimizations/) and
the raw numbers in [Benchmarks](../../benchmarks/).

## The numbers

These are reproducible on your own machine, not marketing figures:

- **Runner overhead**, the number to read first: the time a runner adds
  on top of the ideal run. On the synthetic %bench.tasks%-task workspace, with
  nothing changed, vx adds %bench.vx.warm%, Turborepo %bench.turbo.warm%,
  Vite Task %bench.vt.warm% and Nx %bench.nx.warm%. On a
  cold build over its %bench.ideal.cold% ideal schedule, vx adds %bench.vx.cold%,
  Turborepo %bench.turbo.cold%, Nx %bench.nx.cold% and Vite Task %bench.vt.cold%.
  The workload: %bench.projects% projects in %bench.levels% dependency levels;
  build %bench.task.build%, test and typecheck %bench.task.test%, lint
  %bench.task.lint%, publish %bench.task.publish%.
  %bench.provenance%

- **vx alone** — `bun private/vx-bench/run.ts [projects]` measures vx across
  fresh / warm-no-restore / warm-restore, from a `vx lock` snapshot,
  as every run reads one. A 100-project workspace
  replayed fully-cached in **74 ms** whole-process (1,000 projects in
  172 ms) on one macOS arm64 machine (2026-09-02); a 4-core Linux
  container reads 271 ms at 1,000 projects. Its restore row deletes the outputs first and extracts
  every artifact, so it costs more than the untouched tree; the
  current floors are in [Benchmarks](../../benchmarks/).
- **Head-to-head vs Turborepo, Nx and Vite Task** — `bun private/vx-bench/compare.ts` scaffolds
  one repo (%bench.projects% projects, %bench.levels% dependency levels, %bench.tasks% tasks) and runs every runner cold,
  with nothing changed and with outputs restored.
  The site's figures are its latest run, on
  [Benchmarks](../../benchmarks/). Run it yourself — every number here is
  a command away.

## What others don't have

These are correctness *and* speed wins — they make the cache both safer
and faster:

1. **Sparse `^task` bridging.** `^build` walks *through* dependency
   packages that don't declare the task to the nearest one that does, so
   sparse task coverage doesn't need no-op filler tasks, and the graph
   carries no placeholder nodes for the packages walked through.
2. **Resolved-config hashing.** vx hashes the evaluated `vx.config.ts`
   object, so imports, presets, and computed values participate in the
   key. Static-JSON config can't see them.
3. **Strict output ownership.** Declared outputs are wiped before exec,
   and a restore removes what its entry does not hold, so the tree ends
   as the cached snapshot, with no stale files. Two tasks whose outputs overlap are refused by default
   (`rules.exclusiveOutputs`); with that rule off, a task that adds files
   to an upstream task's outputs cleans nothing before exec and only the
   files it recorded before a restore. Turborepo/Nx
   restore additively.
4. **Daemonless.** No background process, no staleness window, no socket
   to corrupt, and the head-to-head benchmark shows what that costs on
   a cached run.

## The mechanics under the hood

- **Hashes come straight from git's index.** One `git ls-files -s` spawn
  yields the tracked file list *and* every clean file's blob OID; a
  concurrent `git status` prunes anything that diverges and lists untracked
  files. Clean-tree key derivation
  costs zero source-file reads, zero stats, zero database lookups. Dirty files get the
  identical blob OID computed in-process, so a key never flips across a
  commit boundary — a class of spurious miss the others accept.
- **Bitset graph algorithms.** Scheduler priority and the package graph
  use packed-bitset closures with popcount instead of set-union DFS. On a
  3,270-task graph this turned an 8.5 s priority computation into
  single-digit milliseconds.
- **A scheduler tick that re-scans nothing.** Ready tasks come off an
  exact most-blocked-first binary heap; a completion decrements its
  direct dependents' counters and pushes the ones that reach zero, so
  the run costs one pass over the edges plus an `O(log N)` heap
  operation per task, never a re-scan of the graph per completion.
- **Stat-check restore skips.** A warm-on-warm restore is N stats with
  zero writes and zero decompression — fingerprints in SQLite tell vx the
  tree is already current.
- **One artifact format end to end.** Local and remote move the same
  `tar.zst` bytes — metadata rides SQLite locally and the remote's own
  record on the wire, so nothing is repacked at the boundary.
- **In-process tar**, atomic publish, single-transaction SQL, and
  collision-hardened xxh3 key derivation round it out.

## Things vx deliberately *didn't* build

Speed by subtraction is still speed:

- **No daemon / project-graph process** — the cold numbers say it isn't
  needed.
- **No config evaluation in a run** — configs are programs, and a run
  evaluates none: it reads the resolved objects from `.vx/projects.lock.json`.
  Only `vx lock` evaluates them.
- **No filesystem-tracing auto-inputs.** Not a gap — a position. A
  traced input set describes what the task read *that time*, on that
  machine, which is not the same as what it depends on; and it cannot be
  known before the task runs, which is exactly when the key is needed.
  vx asks you to declare inputs and gives you a boundary to check them
  against: inside the workspace, a task with `sandbox` reads only what
  `allow.read` grants, plus `node_modules` and the linked packages it
  depends on. Reads outside the workspace stay open, except the
  credential stores under home (`~/.ssh`, `~/.aws`, …), and `inputs`
  grants nothing, so the sandbox checks the input list only where
  `allow.read` mirrors it. Guessing is replaced by a boundary.

## See where the time goes

`VX_DEBUG_TIMING=1` prints each stage of a run on stderr. A cached one-task
run on a 4-core Linux container:

```text
$ VX_DEBUG_TIMING=1 vx run @demo/app#build
[vx timing]  stage                    own   cumulative
             startup                 58.9ms      58.9ms
             workspace config         4.7ms      63.6ms
             discover projects        4.6ms      68.2ms
             load configs             5.7ms      81.9ms
             build graph              3.3ms      85.2ms
             git enumeration          8.8ms      93.9ms
             classify + probe        15.7ms     109.8ms
             run graph                8.5ms     118.3ms
             close                    3.9ms     125.7ms
```

Rows under 1 ms are cut here. See
[Timing](../../modules/timing/) for the full table.

## Go deeper

- **[Optimizations](../../optimizations/)** — every decision with its
  invariant and source.
- **[Benchmarks](../../benchmarks/)** — methodology and full results.
- **[vx vs Turborepo vs Nx](../../comparison/)** — feature-by-feature.
