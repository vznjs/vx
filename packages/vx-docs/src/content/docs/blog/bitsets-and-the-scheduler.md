---
title: 'Bitsets, popcount, and a scheduler tick that is O(N+E)'
date: 2026-09-10T23:50:00Z
authors:
  - vzn
tags:
  - internals
  - performance
excerpt: "On a 3,270-task graph, computing scheduling priority with set unions took 8.5 seconds. Packed bitsets with popcount take about 50 ms. This post is the scheduler: what it computes, how it picks the next task, and the two-tier trick that keeps restores off the critical path."
---

A monorepo task graph is small by graph-algorithm standards: a few
thousand nodes, a few tens of thousands of edges. It is large enough
that the naive algorithm shows up in the profile of every warm run,
because the graph is rebuilt every run and there is no daemon to hide
it in.

## Closures as bitsets

Two questions come up constantly: which tasks are downstream of this
one (to prioritise the ones that unblock the most work) and which
packages are reachable from this one (for `--filter 'app...'` and
`--affected`). The textbook answer is a depth-first search with a set
per node, unioning children's sets into the parent's. On 3,270 tasks,
the priority computation done that way took **8.5 seconds**.

vx represents each closure as a packed bitset over a topological
numbering: one bit per node, a `Uint32Array` per row. A union is a
loop of bitwise ORs over machine words; a size is a popcount. The same
computation is roughly **50 ms**. The package graph uses the same
representation, so a filter over a thousand packages is a handful of
row ORs.

## The tick

Priority in vx is "most blocked first": the task with the most
transitive dependents goes to the worker pool first, because finishing
it releases the most work. The scheduler keeps an exact priority queue
of ready tasks and, on every completion, decrements the in-degree of
the completed task's direct dependents and enqueues the ones that
reached zero. No re-scan of the graph. A tick is O(1) amortised per
edge, O(N+E) for the whole run.

That is also why lookahead and idle-insertion scheduling are on the
repository's rejected list: they were measured, and the critical-path
priority already ties or wins. The one refinement worth having is
learning the real durations, which is what `@vzn/vx-schedule-history`
does on the `schedule` seam: order by the critical path measured in
previous runs instead of by edge count.

## Two tiers: misses own the pool, hits backfill

A cache hit costs a restore, and a restore should never take a worker
slot away from a miss that is on the critical path. On local-only runs,
before scheduling, vx classifies every stable, cacheable task by
probing the local cache once, up front:

- Confirmed **hits** form the restore tier. They are made ready
  immediately, with no dependency gate (their key does not depend on
  any upstream's success) but at low priority, so they fill idle
  capacity and never displace a miss.
- **Misses** own the worker pool from the first tick.

The up-front probe is not extra work: the execution path consumes the
same result instead of probing again. Measured at −6.6% on a mixed
slow-upstream, warm-downstream workload and at parity on all-hit runs.

A task whose key is only *preliminary*, because its inputs could match
a same-project upstream's declared outputs, stays in neither tier: it
waits for its dependencies like any other task and is not probed early,
because reusing a preliminary probe would be a stale-hit path. The rule
that decides stability is shared with the remote prefetch so the two
cannot disagree.

## Resources are part of the tick

`exec.resources` lets a task reserve cores and megabytes
(`resources: { cpus: 4, memory: 2048 }`). The scheduler treats the
budget as another gate: a ready task waits until its reservation fits
alongside the running ones. It is admission control, not enforcement;
nothing is cgroup-limited or reniced, and a task that exceeds its
declaration is the job of `exec.timeout` and the OS. The numbers are
absolute on purpose: a percentage would name a fraction of *this*
machine's budget, which means nothing to an executor placing the task
elsewhere. A remote executor with `capacity` gets its own pool, so a
64-wide worker fleet is not throttled by a laptop's core count.

Reference: the scheduler module notes under
[Architecture](../../architecture/).
