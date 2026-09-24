# `src/graph/scheduler.ts` — two-tier parallel topological executor

## Purpose

Walk the task graph honoring dependencies, running up to `N` tasks
concurrently, propagating failure as `skipped` to dependents while
keeping unrelated tasks moving — with a second, low-priority ready
queue for confirmed local cache hits (the restore tier) that may run
ahead of their dependencies, on its own lane: restores are disk I/O,
so up to twice `N` run at once while exec-tier work keeps the cap
(`--concurrency 1` stays serial for both). An outcome may still owe
something before its dependents start — `settledOf(outcome)`, the
orchestrator's off-slot cache save landing — and the scheduler frees
the slot at the outcome and unblocks the dependents at the settle.

## Public surface

```ts
export type TaskStatus =
  'success' | 'cache-hit' | 'cache-hit-remote' | 'failed' | 'skipped' | 'aborted' // child killed by a shutdown signal (Ctrl-C teardown)

export interface TaskOutcome {
  node: TaskNode
  status: TaskStatus
  exitCode: number
  durationMs: number // what THIS run spent (a hit's restore cost)
  hash?: string // cache key (pure-input transitive; folded into dependents)
  storedDurationMs?: number // hits: the exec time the entry was stored with — the work skipped
  storedCpuMs?: number // hits: what the producing execution used (rides the artifact)
  storedPeakRssBytes?: number
  admissionHeldMs?: number // how long an `admit` policy held a ready task with a free worker
  cpuMs?: number
  peakRssBytes?: number
  groupUpstream?: readonly TaskOutcome[] // a group's own dependency outcomes; never folded
  blockedBy?: string // skipped: the failed or aborted task at the root of the block
  timedOut?: true // failed: vx's own `timeout` killed the final attempt
  notReady?: 'timeout' | 'exited' | 'spawn' // failed persistent task: why it never became ready
  where?: string // executor-reported placement, when not this host (telemetry-only)
  outputs?: 'deferred' // outputs left in the remote store (`--download=none`)
  wallclockStartNs?: bigint // hrtime span relative to run t=0
  wallclockEndNs?: bigint
  restored?: boolean // cache hits: false = tree already current (up-to-date)
  attempts?: number // set only when `retries` / `--retry` ran it more than once
  sandboxViolations?: number
  sandboxViolationLines?: string[]
}

export type ContinueMode = 'never' | 'deps-ok' | 'always'

export interface ScheduleOptions {
  nodes: Map<string, TaskNode>
  concurrency: number
  /** Aborted → nothing further dispatches; every task not yet started completes `aborted`. */
  signal?: AbortSignal
  /** Failure propagation; default 'deps-ok'. */
  continueMode?: ContinueMode
  execute: (node: TaskNode, upstream: TaskOutcome[]) => Promise<TaskOutcome>
  onStart?: (node: TaskNode) => void
  onFinish?: (outcome: TaskOutcome) => void
  /** What an outcome still owes before its dependents may start (the off-slot cache save). */
  settledOf?: (outcome: TaskOutcome) => Promise<void> | undefined
  /** Optional per-node weight override (a scheduling policy's seam). */
  priorities?: ReadonlyMap<string, number>
  /** Confirmed stable-key local hits — ready immediately, backfill-only. */
  restoreTier?: ReadonlySet<string>
  /** Pool for tasks placed on an executor with its own capacity; undefined = the local pool. */
  poolOf?: (id: string) => { name: string; capacity: number } | undefined
  /** Admission over the worker count for local exec-tier tasks; `false` parks the task. */
  admit?: (id: string, running: ReadonlySet<string>) => boolean
}

export async function runGraph(options: ScheduleOptions): Promise<Map<string, TaskOutcome>>

// Thrown by `execute` for a restore-tier task with nothing to restore.
export class RestoreDemoted extends Error {
  constructor(readonly taskId: string)
}
```

A restore-tier task whose `execute` rejects with `RestoreDemoted` (its
artifact vanished after the up-front probe) records no outcome: the
scheduler releases its restore slot and dispatches it again as an
exec-tier task — at once if its deps are done, else when the last one
finishes, with the failed-dep skip applied like any other. It may have
been running ahead of those deps, so running its command in the
restore slot would build from outputs they have not written.
`onStart` fires once; its dependents wait for the second dispatch.

The ranking lives in `src/graph/priorities.ts`, a file with no runtime
import at all. The Learn page's scheduler simulator bundles it for the
browser (through `packages/vx-bench/schedule-policy.ts`), and
`scheduler.ts` imports `util/`, whose modules read `Bun` and `process`
when they load:

```ts
export function computeReverseDepCount(nodes: Map<string, TaskNode>): Map<string, number>
export function mergePriorities(
  baseline: ReadonlyMap<string, number>,
  overrides: ReadonlyMap<string, number>,
): ReadonlyMap<string, number>
```

## Algorithm

Per-node **dep counters + two ready heaps** — O(E) counter decrements
over a whole run plus one O(log N) heap operation per enqueue and per
dispatch (the old scan-everything-per-completion tick was O(N²)):

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
   no `poolOf` passed the admission gate is the legacy `active <
concurrency` check for exec-tier nodes — including its O(1) early-out
   — and `activeRestore < 2 × concurrency` for restore-tier nodes, a
   separate counter so neither lane waits on the other (measured
   2026-09-10 on the 1,000-project bench with every task a restore: 4 → 8
   workers cut the run-graph stage 683–754 → 556–595 ms, 16 no better).
   With pools
   (or with an `admit` policy) a saturated tick instead SCANS the ready
   queue, parking what does not fit and repushing it with its original
   seq; that is the price of a per-task admission predicate, and it is
   paid only when one exists. `admit(id, running)` is that predicate for
   local exec-tier nodes: asked after the count gate with the set of
   local exec-tier tasks running right now (tracked only while a policy
   exists), a `false` parks the node; restore-tier and pooled nodes are
   never asked. Core passes the plugins' `admit` stage here
   (`plugin-host.buildAdmission`) and holds no costs of its own. A
   task a policy refused while a worker was free is timed from that
   first refusal to its dispatch, and its outcome carries the wait as
   `admissionHeldMs` — `--summarize` rows, the event stream and the
   footer's `admit held N tasks` show the policy's hand; no policy, no
   field, no clock read.
5. **Failed upstream** → an exec-tier node is marked `skipped`
   synchronously (no `execute` call). Restore-tier nodes **bypass**
   this check — their key is dep-success-independent (pure-input
   transitive hashing), so a valid cached output reports `cache-hit`
   even when a dep failed.
6. When every node has an outcome and nothing is active, resolve.

Priority within a queue: highest transitive-reverse-dependent count
first (`computeReverseDepCount` — an exact bitset closure swept in
reverse-topo order, O(E·N/32); Set-based closures cost 8.5 s at 3,270
tasks). Ties break in graph-insertion order: `ReadyHeap` is a binary
max-heap ordered by (priority DESC, enqueue-seq ASC).
When `priorities` is passed, `mergePriorities` scales those weights
(by 2^20) to sort above the baseline for every covered node, with the
baseline as the tie-break inside the override set. Nothing in core
computes one; it is the seam a scheduling-policy plugin
(`@vzn/vx-schedule-history`) feeds.

## Failure isolation

A failed task does not stop the scheduler: its transitive exec-tier
dependents get `skipped`; unrelated tasks continue; the promise
resolves only after every task has _some_ outcome. This is Turbo's
middle `--continue` setting, `deps-ok`, as the default; `never` stops
dispatch at the first failure (in-flight tasks finish, everything not
yet started — restores included — completes `skipped`); `always` runs
dependents on a failed upstream, and the orchestrator withholds their
save (`ExecuteArgs.taintedUpstream`), since a healthy key over bytes
built on a partial tree would be the next clean run's stale hit. A
skipped outcome names the failed or aborted task at the root of its
block (`blockedBy`); fail-fast's skips name nothing. A rejected
`execute` promise becomes a `failed` outcome; a `UserError` reports
plainly, anything else as `[vx] internal error in <id>`.

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
workers) is a plugin's job through the `executor` seam —
`@vzn/vx-reapi` does it against a Bazel REAPI worker pool — and it
reuses these types unchanged; the scheduler never knows where a task
ran.
