---
title: 'Why vx is fast: five decisions, not a trick'
date: 2026-09-10T23:58:00Z
authors:
  - vzn
tags:
  - performance
  - internals
excerpt: 'With nothing changed, vx adds 1.07 s to a 9,603-task run, with no daemon. That number is the sum of five structural decisions, each of which is also a correctness win.'
---

The headline number is the runner's overhead: the time it adds on top
of the tasks themselves. On a synthetic workspace of 1,601 projects and
9,603 tasks, with nothing changed, vx adds 1.07 s over one git walk,
Turborepo 898 ms (vx 19% slower), Vite Task 11.75 s (vx 11× faster) and
Nx 25.45 s (vx 24× faster). On a cold build vx adds 7.07 s, Turborepo
9.15 s (vx 29% faster) and Nx 3 min 48 s (vx 32× faster); Vite Task
8.16 s (vx 15% faster). Each runner runs in its own native
config.

Benchmark workload: a synthetic monorepo of 1,601 projects and 9,603 tasks in 30 dependency levels, five core libraries a quarter of the projects use; build 300 ms, test and typecheck 150 ms, lint 75 ms, publish 30 ms; real repos with uneven task times will differ.
Run 2026-10-09 on linux x64, 4 cores, concurrency 10: vx from source, Turborepo 2.11.7, Nx 23.3.0, Vite Task (vite-plus) 1.1.0.

None of that comes from a microbenchmark trick. It comes from five
decisions, and every one of them is also a reason to trust the cache
more, not less.

```mermaid
flowchart LR
  A[keys from git's index] --> F[fast warm run]
  B[bitsets, not walks] --> F
  C[strict output ownership] --> F
  D[one artifact format] --> F
  E[nothing runs when nothing is needed] --> F
  style F stroke:#c6f84e,stroke-width:2px
```

## 1. The cache key is already in git's index

A content-addressed key needs a hash of every input file. Most tools
read each file and hash it, or keep a daemon around so they do not have
to. vx spawns one `git ls-files -s`, which returns the file list *and*
every clean file's blob object id, and one concurrent `git status` to
prune anything that diverges from the index. Clean-tree key derivation
costs zero source-file reads and zero per-file stats.

Dirty files get the identical blob id computed in-process, so a key
never flips when you commit. That class of spurious miss, "I committed
and everything rebuilt", does not exist here.

There is a whole post on this: [Your cache key is already in git's
index](../keys-from-git/).

## 2. Bitsets where others walk

Scheduling priority and the package graph are computed over packed
bitsets with popcount instead of set-union depth-first search. On the
3,270-task graph that turned an 8.5 s priority computation into
single-digit milliseconds. The scheduler tick re-scans nothing: ready
tasks come off an exact most-blocked-first binary heap, a completion
decrements its direct dependents' counters and pushes the ones that
reach zero, and the run costs one pass over the edges plus an
`O(log N)` heap operation per task.

## 3. Strict output ownership makes restore cheap

Declared outputs are wiped before a miss executes and before a hit
restores, so the tree after either is exactly the cached snapshot.
That is a correctness rule first (no stale `dist/old.js` survives), but
it also means vx *knows* what the tree looks like after a hit. On a
warm-on-warm run it verifies the recorded `(size, mode, mtime, inode, ctime)` of each
output with a stat and writes nothing, decompresses nothing. A restore
onto a current tree costs about what an untouched tree costs.

## 4. One artifact format end to end

A cache entry is one `tar.zst` archive plus SQLite rows. Metadata and
the captured stdout live in the index (the stdout in a side table, so
the run's access-time bump never rewrites it), so a hit is a few indexed
`SELECT`s and a replay from them, not a decompression. The same bytes go over
the wire to a remote cache; nothing is repacked at the boundary.
Packing is in-process (vx's own streaming tar), the publish is an atomic
rename, and each save is a single transaction.

## 5. Nothing runs when nothing is needed

vx has no daemon, so there is no process to keep warm and no staleness
window between what the daemon believes and what the disk holds. What
replaces the daemon is a set of zero-cost gates: no telemetry plugin
means no event-bus subscriber, no summary, no git spawn for provenance;
a plugin that declines a task costs nothing; a config that passes the
purity gate is served from an evaluation cache keyed on the git blob
ids of its whole import closure, and a config that reads the
environment or the clock is simply evaluated live.

## The method behind the numbers

Every change to the warm path in this repository ships with a number,
measured the same way: A/B arms interleaved, min-of-N, the "before" arm
checked out into an immutable git worktree, one workspace copy per arm
pre-warmed by that arm. A change without a number is not done. The
history of where the headroom went is in
[Benchmarks](../../benchmarks/), and the full catalogue of decisions,
each with its invariant and its source file, is in
[Optimizations](../../optimizations/).
