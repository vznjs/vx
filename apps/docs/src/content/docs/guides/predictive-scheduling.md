---
title: Predictive scheduling
description: Opt in to history-aware scheduling. vx loads the per-task duration history from cache.db and dispatches tasks by expected remaining critical path. The only task runner that learns from itself.
---

The default scheduler picks ready tasks by reverse-deps count — a
task that unblocks the most downstream work runs first. That's a
reasonable static heuristic but it doesn't know that a 30-second
test blocks less wall-time than a 4-second build that unblocks 40
downstream tasks.

Predictive scheduling reads `cache.db.runs` for every task in your
graph, computes the expected remaining critical-path duration per
node, and dispatches by that instead. The only task runner that
learns from itself.

## Quick start

```ts
// vx.workspace.ts
import { defineWorkspace } from '@vzn/vx'

export default defineWorkspace({
  predictive: true,
})
```

That's it. On the next run, vx loads history, computes priorities,
and uses them.

## How it works

1. **Load history.** `prepareRun` instantiates `LocalHistoryProvider`
   over the cache.db handle and calls `loadFor(taskIds)` to get a
   `HistoryTable` keyed by `project#task`. Each entry has p50/p99
   durations (cache hits excluded), success rate, hit rate.

2. **Compute expected critical path per node.** For each node,
   topo-DP sums the node's own p50 + the max across downstream
   chains:
   ```
   ECP(n) = p50(n) + max(ECP(d) for d in dependents(n))
   ```
   A leaf with no dependents has `ECP = p50(itself)`.

3. **Pick highest ECP from the ready set.** The scheduler's
   priority map merges history-aware ECP on top of the static
   baseline. Override > baseline by a large factor so a node with
   history beats one without; among nodes without history, the
   baseline still tiebreaks.

4. **Fall back when history is sparse.** A task with no prior
   runs falls back to the workspace median across tasks. If the
   workspace itself has no history, the default is 1000 ms — a
   sane "I don't know" that puts the priority in the right order
   of magnitude.

## What this changes vs. the default

Two example graphs where the heuristic differs:

### Graph A: long leaf

```
       build (5s)
        ↙   ↘
     test    publish
    (30s)    (2s)
```

- **Default**: starts with `build` (it unblocks 2 downstream). Then
  whichever of `test`/`publish` happens to be ordered first in the
  ready queue (typically graph-insertion).
- **Predictive**: starts with `build`. Once it finishes, picks
  `test` first (ECP = 30s + 0 = 30s) over `publish` (ECP = 2s).
  On a single worker, ordering doesn't change total wall time —
  but it surfaces the slow path earlier (better UX) and prevents
  worker starvation on multi-worker graphs.

### Graph B: lots of fast vs. one slow

```
    db_test (90s, blocks nothing)
    lint    (2s, blocks 40 build tasks)
```

- **Default**: picks `lint` (blocks 40). Critical for single-worker
  graphs.
- **Predictive**: still picks `lint` on a single worker; on a
  multi-worker graph where there's spare capacity, dispatches
  `db_test` early in parallel.

The merge function (`mergePriorities` in `src/graph/scheduler.ts`)
preserves correctness: nodes covered by the override sort above
all baseline-only nodes, and within the override set the baseline
tiebreaks. Nodes the override didn't see fall back to baseline.

## When predictive helps most

- **Multi-worker graphs** with mixed task durations. The historical
  ordering surfaces the long tail earlier so workers don't go idle
  waiting for the last slow task.
- **CI matrices** where you care about wall-time-to-failure for
  human debugging. A failing test surfaces faster.
- **Established repos** with weeks of history. Cold workspaces get
  the workspace-median fallback.

## When it doesn't help

- **Cache-warm full-hit runs.** Cache hits cost ~ms; there's
  nothing to prioritize.
- **Single-task runs.** No queue to reorder.
- **Brand-new workspaces.** No history; falls back to baseline +
  default duration.

## Observability

The scheduler reads the same run history those verbs read, so you can
inspect its raw material directly:

```bash
vx last --list       # recent runs, with per-task durations and outcomes
vx last <runId>      # one run replayed in full — failures first
vx why <task>        # what moved that task's key between its last two runs
```

`vx mcp` exposes `getRunHistory` as a tool, so an AI agent can ask "what
does the scheduler know about this task" without a shell.

## Trade-offs

- **Bias toward the slow path.** Predictive dispatches long tasks
  early. If you'd rather see fast feedback (lint failures first),
  leave it off.
- **Cold start.** A new task with no history uses the workspace
  median. If your tasks are wildly different durations, the median
  is a poor estimator until you have ~10 runs of the task.
- **Opt-in only today.** No "default-on" plan; needs more telemetry
  on the wall-time win before flipping the default. See
  `docs/design/predictive-execution-2026-06.md` Phase F.

## What's coming

Phase C-E are deferred but designed:

- **Speculative pre-warming**: `posix_fadvise(WILLNEED)` on input
  files, module preload for `bun`/`node` runtimes.
- **Bandit-driven retry**: flaky tasks (history success rate < 95%)
  auto-retry once on transient failure.
- **Regression detection**: at runEnd, compare this run's
  durations against the rolling p50; flag significant deviations.

See also: `docs/design/predictive-execution-2026-06.md`.
