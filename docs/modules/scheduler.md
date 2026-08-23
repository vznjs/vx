# `src/graph/scheduler.ts` — two-tier parallel topological executor

## Purpose

Walk the task graph honoring dependencies, running up to `N` tasks
concurrently, propagating failure as `skipped` to dependents while
keeping unrelated tasks moving — with a second, low-priority ready
queue for confirmed local cache hits (the restore tier) that may run
ahead of their dependencies.

## Public surface

```ts
export type TaskStatus =
  | 'success'
  | 'cache-hit'
  | 'cache-hit-remote'
  | 'failed'
  | 'skipped'
  | 'aborted' // child killed by a shutdown signal (Ctrl-C teardown)

export interface TaskOutcome {
  node: TaskNode
  status: TaskStatus
  exitCode: number
  durationMs: number
  hash?: string // cache key (pure-input transitive; folded into dependents)
  cpuMs?: number
  peakRssBytes?: number
  wallclockStartNs?: bigint // hrtime span relative to run t=0
  wallclockEndNs?: bigint
  restored?: boolean // cache hits: false = tree already current (up-to-date)
  sandboxViolations?: number
  sandboxViolationLines?: string[]
}

export interface ScheduleOptions {
  nodes: Map<string, TaskNode>
  concurrency: number
  execute: (node: TaskNode, upstream: TaskOutcome[]) => Promise<TaskOutcome>
  onStart?: (node: TaskNode) => void
  onFinish?: (outcome: TaskOutcome) => void
  /** Optional per-node weight override (predictive scheduling). */
  priorities?: ReadonlyMap<string, number>
  /** Confirmed stable-key local hits — ready immediately, backfill-only. */
  restoreTier?: ReadonlySet<string>
  /** Pool for tasks placed on an executor with its own capacity; undefined = the local pool. */
  poolOf?: (id: string) => { name: string; capacity: number } | undefined
}

export function computeReverseDepCount(nodes: Map<string, TaskNode>): Map<string, number>
export async function runGraph(options: ScheduleOptions): Promise<Map<string, TaskOutcome>>
```

## Algorithm

Per-node **dep counters + two sorted ready queues** — O(N + E) over a
whole run (the old scan-everything-per-completion tick was O(N²)):

1. Build reverse adjacency + `pending` counts once. A node enqueues
   when `pending` hits 0 — onto **execReady** (normal priority).
2. **Restore-tier nodes bypass the dep gate**: they enqueue onto
   **restoreReady** at startup (a stable hit's restore needs none of
   its deps' output). Their pending decrements still happen but never
   re-enqueue them.
3. `tick()` fills free worker slots by draining **execReady FIRST** —
   cache misses own the pool; restores only backfill idle capacity
   (or run when they're the only ready work, unblocking a dependent).
4. **Pooled nodes are admitted against their own pool.** When `poolOf`
   returns a pool for a node (its executor declared a `capacity` — see
   `executor.md`), it occupies one of that pool's slots instead of a
   local worker slot and reserves ZERO local resources: work running on
   another machine spends none of this one's CPU or RAM. Restore-tier
   nodes are always local (a restore is a tar extract on this disk). With
   no `poolOf` passed the admission gate is the byte-identical legacy
   `active < concurrency` check — including its O(1) early-out. With pools
   (or with `resourceCosts`) a saturated tick instead SCANS the ready
   queue, parking what does not fit and repushing it with its original
   seq; that is the same cost the resource-admission path already pays and
   is the price of a per-task admission predicate.
5. **Failed upstream** → an exec-tier node is marked `skipped`
   synchronously (no `execute` call). Restore-tier nodes **bypass**
   this check — their key is dep-success-independent (pure-input
   transitive hashing), so a valid cached output reports `cache-hit`
   even when a dep failed.
6. When every node has an outcome and nothing is active, resolve.

Priority within a queue: highest transitive-reverse-dependent count
first (`computeReverseDepCount` — an exact bitset closure swept in
reverse-topo order, O(E·N/32); Set-based closures cost 8.5 s at 3,270
tasks). Ties break in graph-insertion order via binary-search insert.
When `priorities` is passed (predictive scheduling,
`defineWorkspace({ predictive: true })`), those weights override the
baseline for covered nodes, scaled to always sort above it.

## Failure isolation

A failed task does not stop the scheduler: its transitive exec-tier
dependents get `skipped`; unrelated tasks continue; the promise
resolves only after every task has _some_ outcome. This is Turbo's
middle `--continue` setting as the default. A rejected `execute`
promise becomes a `failed` outcome; a `UserError` reports plainly,
anything else as `[vx] internal error in <id>`.

## What this does NOT do

- Doesn't compute the graph (that's `task-graph.ts`).
- Doesn't know about caching — `execute` is the seam; the
  restore-tier set is opaque input classified by the orchestrator
  (`local-shortcircuit.ts`).
- Doesn't enforce timeouts (that's `exec.timeout` in the runner).

## Tests

`tests/scheduler.test.ts`: topo order, concurrency cap, skip
propagation, independent siblings, throw handling, priority contract,
a perf guard on `computeReverseDepCount` (dense 100×30 graph must
stay under 1.5 s; old code took 7.2 s), and the two-tier contract
(restore-tier ready immediately / low priority / failed-dep bypass).

## Replacing this module

The contract is small: take a graph + an `execute`, return outcomes.
Keep `ScheduleOptions` and `TaskOutcome` shapes stable to avoid
churning consumers. Distribution (fanning `execute` to remote
workers) already exists in the service package's coordinator, which
reuses these types over the wire.
