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
  on top of the ideal run. On the synthetic 9,603-task workspace, with
  nothing changed, vx adds 1.07 s, Turborepo 898 ms (vx 19% slower),
  Vite Task 11.75 s (vx 11× faster) and Nx 25.45 s (vx 24× faster). On a
  cold build over its 1 min 53 s ideal schedule, vx adds 7.07 s,
  Turborepo 9.15 s (vx 29% faster) and Nx 3 min 48 s (vx 32× faster);
  Vite Task 8.16 s (vx 15% faster).
  Benchmark workload: a synthetic monorepo of 1,601 projects and 9,603 tasks in 30 dependency levels, five core libraries a quarter of the projects use; build 300 ms, test and typecheck 150 ms, lint 75 ms, publish 30 ms; real repos with uneven task times will differ. Run 2026-10-09 on linux x64, 4 cores, concurrency 10: vx from source, Turborepo 2.11.7, Nx 23.3.0, Vite Task (vite-plus) 1.1.0.

- **vx alone** — `bun packages/vx-bench/run.ts [projects]` measures vx across
  fresh / warm-no-restore / warm-restore, from a `vx lock` snapshot
  (`--frozen`), as every vx bench runs it. A 100-project workspace
  replayed fully-cached in **74 ms** whole-process (1,000 projects in
  172 ms) on one macOS arm64 machine (2026-09-02); a 4-core Linux
  container reads 271 ms at 1,000 projects. Its restore row deletes the outputs first and extracts
  every artifact, so it costs more than the untouched tree; the
  current floors are in [Benchmarks](../../benchmarks/).
- **Head-to-head vs Turborepo, Nx and Vite Task** — `bun packages/vx-bench/compare.ts` scaffolds
  one repo (1,601 projects, 30 dependency levels, 9,603 tasks) and runs every runner cold,
  with nothing changed and with outputs restored.
  The committed results live in
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
3. **Strict output ownership.** Declared outputs are wiped before exec
   *and* restore, so the tree ends as the cached snapshot, with no stale
   files. Two tasks whose outputs overlap are refused by default
   (`rules.exclusiveOutputs`); with that rule off, a task that adds files
   to an upstream task's outputs cleans nothing before exec and only the
   files it recorded before a restore. Turborepo/Nx
   restore additively.
4. **Daemonless.** No background process, no staleness window, no socket
   to corrupt — and the fastest warm/cached runs in the head-to-head
   benchmark all the same.

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
- **A config-eval cache only where it is provably sound** — configs
  are programs, so the cache is gated, not heuristic: a config that
  reads the environment, the clock, or anything non-deterministic is
  refused the cache outright (denied identifiers, including escaped and
  aliased spellings), and one that passes is keyed by the git blob ids
  of its whole import closure. The `load configs` stage is 16–25 ms per
  1,000 configs served from it, against ~200 ms of evaluations; a
  refused config simply evaluates live.
- **No filesystem-tracing auto-inputs.** Not a gap — a position. A
  traced input set describes what the task read *that time*, on that
  machine, which is not the same as what it depends on; and it cannot be
  known before the task runs, which is exactly when the key is needed.
  vx asks you to declare inputs and gives you a boundary to check them
  against: inside the workspace, a task with `sandbox` reads only what
  `allow.read` grants, plus `node_modules` and the linked packages it
  depends on. Reads outside the workspace stay open, except the
  credential stores under home (`~/.ssh`, `~/.aws`, …), and `cache.inputs`
  grants nothing, so the sandbox checks the input list only where
  `allow.read` mirrors it. Guessing is replaced by a boundary.

## Go deeper

- **[Optimizations](../../optimizations/)** — every decision with its
  invariant and source.
- **[Benchmarks](../../benchmarks/)** — methodology and full results.
- **[vx vs Turborepo vs Nx](../../comparison/)** — feature-by-feature.
