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

- **vx alone** — `bun bench/run.ts [projects]` measures vx across
  fresh / warm-no-restore / warm-restore. A 100-project workspace
  replays fully-cached in **~75 ms** whole-process (1,000 projects in
  ~170 ms), and a restore costs about the same as an untouched tree;
  the current floors are in [Benchmarks](../../benchmarks/).
- **Head-to-head vs Turborepo and Nx** — `bun bench/compare.ts` scaffolds
  one repo (1,090 packages, 100 dependency layers, a `build` + `test` task
  each) and runs all three runners across the same three cache states.
  vx leads on the warm paths; the committed results live in
  [Benchmarks](../../benchmarks/). Run it yourself — every number here is
  a command away.

## What others don't have

These are correctness *and* speed wins — they make the cache both safer
and faster:

1. **Sparse `^task` bridging.** `^build` walks *through* dependency
   packages that don't declare the task to the nearest one that does, so
   sparse task coverage doesn't need no-op filler tasks. Turborepo and Nx
   stop at direct dependencies.
2. **Resolved-config hashing.** vx hashes the evaluated `vx.config.ts`
   object, so imports, presets, and computed values participate in the
   key. Static-JSON config can't see them.
3. **Strict output ownership.** Declared outputs are wiped before exec
   *and* restore, so the tree is always exactly the cached snapshot — no
   stale files, ever. Turborepo/Nx restore additively.
4. **Daemonless.** No background process, no staleness window, no socket
   to corrupt — and the fastest warm/cached runs in the head-to-head
   benchmark all the same.

## The mechanics under the hood

- **Hashes come straight from git's index.** One `git ls-files -s` spawn
  yields the file list *and* every clean file's blob OID; a concurrent
  `git status` prunes anything that diverges. Clean-tree key derivation
  costs zero reads, zero stats, zero database lookups. Dirty files get the
  identical blob OID computed in-process, so a key never flips across a
  commit boundary — a class of spurious miss the others accept.
- **Bitset graph algorithms.** Scheduler priority and the package graph
  use packed-bitset closures with popcount instead of set-union DFS. On a
  3270-task graph this turned an 8.5 s priority computation into roughly
  50 ms.
- **A scheduler tick that's O(N+E).** Ready tasks come off an exact
  most-blocked-first queue; no re-scanning the whole graph per completion.
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
  of its whole import closure. Worth ~20 ms of the 1,000-project warm
  run; a refused config simply evaluates live.
- **No filesystem-tracing auto-inputs.** Not a gap — a position. A
  traced input set describes what the task read *that time*, on that
  machine, which is not the same as what it depends on; and it cannot be
  known before the task runs, which is exactly when the key is needed.
  vx asks you to declare inputs and then lets you ENFORCE the
  declaration: a task with `sandbox` runs with the declared paths as the
  only readable ones. Guessing is replaced by a boundary.

## Go deeper

- **[Optimizations](../../optimizations/)** — every decision with its
  invariant and source.
- **[Benchmarks](../../benchmarks/)** — methodology and full results.
- **[vx vs Turborepo vs Nx](../../comparison/)** — feature-by-feature.
