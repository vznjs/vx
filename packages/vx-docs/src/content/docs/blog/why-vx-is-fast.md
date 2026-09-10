---
title: 'Why vx is fast: five decisions, not a trick'
date: 2026-09-10T23:58:00Z
authors:
  - vzn
tags:
  - performance
  - internals
excerpt: 'A fully cached run of 3,270 tasks finishes in about half a second with no daemon. That number is the sum of five structural decisions, each of which is also a correctness win.'
---

The headline number is the one you pay on every uncached build: what
the runner adds on top of your tasks. On a synthetic workspace of
1,090 packages and 3,270 tasks whose ideal schedule is 3m 38s, vx
finishes the cold build in 3m 46s, 4% over the schedule. Turborepo
finishes in 5m 13s (44% over) and Nx in 34m 44s (9.6× the schedule).
Warm, a fully cached `vx run build test --all` finishes in about
510 ms, Turborepo in 760 ms and Nx in 3.59 s; the cold build burns
35 s of CPU in vx, 73 s in Turborepo and 114 minutes in Nx. On a real
Turbo repository (solidjs/solid) the warm restore is 66 ms against
Turbo's 127 ms.

None of that comes from a microbenchmark trick. It comes from five
decisions, and every one of them is also a reason to trust the cache
more, not less.

## 1. The cache key is already in git's index

A content-addressed key needs a hash of every input file. Most tools
read each file and hash it, or keep a daemon around so they do not have
to. vx spawns one `git ls-files -s`, which returns the file list *and*
every clean file's blob object id, and one concurrent `git status` to
prune anything that diverges from the index. Clean-tree key derivation
costs zero file reads, zero stats and zero database lookups.

Dirty files get the identical blob id computed in-process, so a key
never flips when you commit. That class of spurious miss, "I committed
and everything rebuilt", does not exist here.

There is a whole post on this: [Your cache key is already in git's
index](../keys-from-git/).

## 2. Bitsets where others walk

Scheduling priority and the package graph are computed over packed
bitsets with popcount instead of set-union depth-first search. On the
3,270-task graph that turned an 8.5 s priority computation into roughly
50 ms. The scheduler tick itself is O(N+E): ready tasks come off an
exact most-blocked-first queue, and nothing re-scans the graph per
completion.

## 3. Strict output ownership makes restore cheap

Declared outputs are wiped before a miss executes and before a hit
restores, so the tree after either is exactly the cached snapshot.
That is a correctness rule first (no stale `dist/old.js` survives), but
it also means vx *knows* what the tree looks like after a hit. On a
warm-on-warm run it verifies the recorded `(size, mode, mtime)` of each
output with a stat and writes nothing, decompresses nothing. A restore
onto a current tree costs about what an untouched tree costs.

## 4. One artifact format end to end

A cache entry is one `tar.zst` archive plus a SQLite row. Metadata and
the captured stdout live in the row, so a hit is one indexed `SELECT`
and a replay from the row, not a decompression. The same bytes go over
the wire to a remote cache; nothing is repacked at the boundary.
Packing is in-process (`Bun.Archive`), the publish is an atomic rename,
and a run's cache writes are a single transaction.

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
