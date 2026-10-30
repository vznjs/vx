# `src/graph/scheduler.ts` — two-tier parallel topological executor

## Purpose

Walk the task graph honoring dependencies, running up to `N` tasks
concurrently, propagating failure as `skipped` to dependents while
keeping unrelated tasks moving — with a second, low-priority ready
queue for confirmed local cache hits (the restore tier) that may run
ahead of their dependencies, on its own lane: restores are disk I/O,
so up to twice `N` run at once while exec-tier work keeps the cap
(at `--concurrency 1` the two lanes share one slot). An outcome may still owe
something before its dependents start — `settledOf(outcome)`, the
orchestrator's off-slot cache save landing — and the scheduler frees
the slot at the outcome and unblocks the dependents at the settle. What
the settle resolves with (the save's time and size) is merged into the
outcome the dependents and observers see.

## Public surface

```ts
export type TaskStatus =
  'success' | 'cache-hit' | 'cache-hit-remote' | 'failed' | 'skipped' | 'aborted' // child killed by a shutdown signal (Ctrl-C teardown)

export interface InputChanges {
  count: number // components changed, added or removed; 0: the same key, its entry gone
  first: readonly { kind: string; name: string; change: 'changed' | 'added' | 'removed' }[] // the first ten, by kind then name
}

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
  queuedMs?: number // how long it waited ready for a worker, any admission hold included
  inputFiles?: number // on a cacheable task that ran: the files its key read
  artifactBytes?: number // a hit's entry size, or (sink listening) the size a miss's save wrote
  outputBytes?: number // its output files' raw bytes, restored or saved: the row's `outputs`
  fetchMs?: number // a remote hit this run pulled: download + ingest
  saveMs?: number // a miss that saved, sink listening: the save's own time
  inputChanges?: InputChanges // on one that ran with a sink listening: its key against the last saved entry
  cpuMs?: number
  peakRssBytes?: number
  peakCores?: number // sampled: most cores one interval burned
  avgRssBytes?: number // sampled: mean resident memory
  groupUpstream?: readonly TaskOutcome[] // a group's own dependency outcomes; never folded
  unkeyed?: true // ran over inputs its key no longer describes: no save, nor by a dependant (A-12)
  keylessBy?: string // the task with no `inputs` its key includes (or itself): no read, no save
  cacheOff?: true // the run's policy read and wrote nothing: a run of it is no-cache, not a miss
  blockedBy?: string // skipped: the failed or aborted task at the root of the block
  otherPlatform?: { readonly needs: readonly string[]; readonly host: string } // skipped: its `exec.platforms` leave this machine out
  timedOut?: true // failed: vx's own `timeout` killed the final attempt
  failedOutput?: string // failed command: its output log (output-log.ts), first 8 KiB + last 56 KiB, masked
  runLog?: string // run keeps bytes in a remote and this task saved no entry: its whole output log, masked
  notReady?: 'timeout' | 'exited' | 'spawn' // failed persistent task: why it never became ready
  serverExit?: number // ready persistent task whose child exited on its own mid-run (a setup step's 0 at ready, a crash's code): no label calls it running
  inputMoved?: string // failed by inputStability.severity 'error': the input that changed ('' unnamed)
  where?: string // executor-reported placement, when not this host
  carried?: true // a persistent task each dependant's executor starts where it runs: nothing ran here
  whereCores?: number // that machine's cores and memory (ExecuteResult.machine)
  whereMemoryBytes?: number
  cpuShare?: number // ExecuteResult.machine.cpuShare: the share of a core its threads got there
  outputs?: 'deferred' // outputs left in the remote store (`--cache-download=none`)
  saved?: true // ran here and its result went to the cache: the footer's `↑`
  wallclockStartNs?: bigint // hrtime span relative to run t=0
  wallclockEndNs?: bigint
  restored?: boolean // cache hits: false = tree already current (up-to-date)
  attempts?: number // set only when `retries` / `--retries` ran it more than once
  failedAttempts?: readonly { endedAt: number; exitCode: number; timedOut?: true }[] // the attempts that were run again
  flaky?: { passes: number; failures: number } // the run proved it flaky; its row says so
  sandboxViolations?: number
  sandboxViolationLines?: string[]
  sandboxFix?: { read?: string[]; write?: string[]; network?: string[]; systemInfo?: string[]; withheld?: string[] } // the grants that would have allowed the denials; withheld: credential paths left out
}

export type ContinueMode = 'never' | 'deps-ok' | 'always'

export interface ScheduleOptions {
  nodes: Map<string, TaskNode>
  concurrency: number
  restoreConcurrency?: number // restore-tier tasks at once; twice concurrency unset
  /** Aborted → nothing further dispatches; every task not yet started completes `aborted`. */
  signal?: AbortSignal
  /** Failure propagation; default 'deps-ok'. */
  continueMode?: ContinueMode
  /** A ready server that died: its dependants not yet started skip (through groups too); under 'never' dispatch stops. */
  serverDied?: (id: string) => boolean
  /** Called once, when 'never' stops dispatch: a task in flight starts no retry. */
  onFailFast?: () => void
  execute: (node: TaskNode, upstream: TaskOutcome[]) => Promise<TaskOutcome>
  onStart?: (node: TaskNode) => void
  onFinish?: (outcome: TaskOutcome) => void
  /** Where a rejected `execute`'s line goes, before its outcome; default stderr. */
  onError?: (node: TaskNode, line: string, err: unknown) => void
  /** What an outcome still owes before its dependents may start (the off-slot cache save). */
  settledOf?: (outcome: TaskOutcome) => Promise<Partial<TaskOutcome> | void> | undefined
  /** The outcome of an exec-tier task settled in place, or undefined to dispatch it. */
  settleNow?: (node: TaskNode, upstream: TaskOutcome[]) => (() => TaskOutcome) | undefined
  /** Optional per-node weight override (a scheduling policy's seam). */
  priorities?: ReadonlyMap<string, number>
  /** Later weights for `priorities`: the ready queues re-rank at once (a `schedule` plugin's `refine`). */
  reprioritize?: (apply: (priorities: ReadonlyMap<string, number>) => void) => void
  /** The baseline ranking under `priorities`: `schedule` in .vx/workspace.ts. */
  strategy?: 'most-work' | 'critical-path' | 'direct-dependents' | 'ready-order'
  /** The `most-work` baseline already counted (`computeReverseDepCount`), asked only when used. */
  reverseDeps?: () => ReadonlyMap<string, number>
  /** Confirmed stable-key local hits — ready immediately, backfill-only. */
  restoreTier?: ReadonlySet<string>
  /** Servers held until the caller adds their remote-hit dependants to `restoreTier` (the ids it added). */
  heldServers?: ReadonlyMap<string, Promise<readonly string[]>>
  /** Pool for tasks placed on an executor with its own capacity; undefined = the local pool. */
  poolOf?: (id: string) => { name: string; capacity: number } | undefined
  /** Admission over the worker count for local exec-tier tasks; `false` parks the task. */
  admit?: (id: string, running: ReadonlySet<string>) => boolean
  /** Tasks that hold the terminal: each starts once nothing runs, and nothing starts beside it. */
  exclusive?: ReadonlySet<string>
}

export async function runGraph(options: ScheduleOptions): Promise<Map<string, TaskOutcome>>

// The dead server a dependency stands for: itself, or one a group reaches.
// Iterative, each node once: a deep chain of groups does not overflow.
export function deadServerBehind(
  nodes: ReadonlyMap<string, TaskNode>,
  serverDied: (id: string) => boolean,
  id: string,
): string | undefined

// Persistent tasks nobody asked for whose every dependant is a restore-tier hit,
// or an unrequested group only such hits stand behind (those groups go in `groups`).
export function idleServers(
  nodes: ReadonlyMap<string, TaskNode>,
  dependents: ReadonlyMap<string, string[]>,
  restoreTier: ReadonlySet<string> | undefined,
  groups?: Set<string>,
): Set<string>

// Thrown by `execute` for a restore-tier task with nothing to restore.
export class RestoreDemoted extends Error {
  constructor(readonly taskId: string)
}
```

`task-status.ts` holds `TaskStatus` and what each status means, so no
reader re-lists the statuses:

- `deriveCacheSource(status)` — the `CacheSource`
  (`'miss' | 'local' | 'remote' | 'none'`): `'local'` / `'remote'` for the
  two hits, `'miss'` for `success` / `failed`, `'none'` for `skipped` /
  `aborted`; never null.
- `TASK_STATUSES`, `isPassStatus(status)`, `isCacheHit(status)` — every
  status at runtime and the two predicates every surface shares.

A restore-tier task whose `execute` rejects with `RestoreDemoted` (its
artifact vanished after the up-front probe) records no outcome: the
scheduler releases its restore slot and dispatches it again as an
exec-tier task — at once if its deps are done, else when the last one
finishes, with the failed-dep skip applied like any other. It may have
been running ahead of those deps, so running its command in the
restore slot would build from outputs they have not written.
`onStart` fires once; its dependents wait for the second dispatch.

`settleNow` is asked of a task once it is due (a restore-tier one when
its lane has room), after the skip check. A thunk settles it in the
same tick: `onStart` hears it, the thunk runs (a hit replays its output
there), and `onFinish` hears the outcome; no slot, no admission ask, no
`execute` promise. A throw from either dispatches it instead, started
once. The run passes it for unkeyed groups (they run nothing, X-192)
and for restore-tier hits whose tree is current (`currentHit`), unless a
taint or `--continue=always` needs the full path.

A persistent task neither requested nor surfaced whose every dependant
is in the restore tier is idle (X-59): due, it goes dormant instead of
dispatching, asking no admission policy and taking no slot. A demoted
dependant starts it, and that dependant runs once it is ready. Once
every dependant has an outcome it settles with none of its own and
releases them, so it is never spawned and the returned map lacks it.
Its own deps still run first and a failed one skips it as before; a
stop or fail-fast leaves it with no outcome.
A group neither requested nor surfaced that stands only between such a
server and its hits is idle with it: it waits the same way, settles
with no outcome once every hit above it has one, and a demotion above
it wakes it and the server.
A `heldServers` server does not dispatch until its promise answers: the
dependants it names join the restore lane, and it is idle when every
dependant is then in the tier, else it dispatches as usual
(`orchestrator/held-servers.ts` asks the remote).

A run counts dependents once: the `most-work` baseline is also every
row's `blocks`, groups counted as the scheduler counts them, and the
orchestrator remembers it with the graph (`graphCounts`, keyed by the graph
token and the node ids). A second count for the rows alone was a pass of
its own (2026-10-29).

The ranking lives in `src/graph/priorities.ts`, a file with no runtime
import at all. The Learn page's scheduler simulator bundles it for the
browser (through `private/vx-bench/schedule-policy.ts`), and
`scheduler.ts` imports `util/`, whose modules read `Bun` and `process`
when they load:

```ts
export function computeReverseDepCount(
  nodes: ReadonlyMap<string, TaskNode>,
  counted?: ReadonlyMap<string, unknown>,
): Map<string, number> // also the live region's waiting order; `counted` limits the dependents counted (the exec tier)
export function tieredReverseDepCount(
  nodes: Map<string, TaskNode>,
  restoreTier: ReadonlySet<string>,
): Map<string, number>
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
   paid only when one exists. With pools the scan still skips when every
   pool is full and no ready task is local: a DTE pool of 6 slots before
   2,000 ready tasks re-popped them all on every task's end (2026-10-25). `admit(id, running)` is that predicate for
   local exec-tier nodes: asked after the count gate with the set of
   local exec-tier tasks running right now (tracked only while a policy
   exists; a persistent task leaves it at ready, with its slot, since it
   never finishes before its dependants and a policy that counted it
   would hold them with no completion left to ask again), a `false` parks
   the node; restore-tier, pooled and group nodes are never asked and
   never in the set. Core passes the plugins' `admit` stage here
   (`plugin-host.buildAdmission`) and holds no costs of its own. A
   task a policy refused while a worker was free is timed from that
   first refusal to its dispatch, and its outcome carries the wait as
   `admissionHeldMs` — the event stream and the
   footer's `admit held N tasks` show the policy's hand; no policy, no
   field, no clock read.
5. **Exclusive nodes** (`exec.interactive` on a TTY) hold the terminal.
   When one is the next exec-tier node and anything runs, it parks and
   the tick dispatches nothing more, restores included, so the running
   nodes drain; it starts once none runs, and nothing starts while it
   holds. A persistent one releases at spawn, when `execute` resolves.
   A higher-priority node that becomes ready first still goes first.
6. **Failed upstream** → an exec-tier node is marked `skipped`
   synchronously (no `execute` call). Restore-tier nodes **bypass**
   this check — their key is dep-success-independent (pure-input
   transitive hashing), so a valid cached output reports `cache-hit`
   even when a dep failed.
7. When every node has an outcome and nothing is active, resolve.

Priority within a queue: highest transitive-reverse-dependent count
first (`computeReverseDepCount` — an exact bitset closure swept in
reverse-topo order, O(E·N/32); Set-based closures cost 8.5 s at 3,270
tasks). The sweep runs once per block of words that fits the cache:
at 9,603 tasks the whole closure is 11.5 MB and its one call took
77 ms, blocked 37 ms. Ties break in graph-insertion order: `ReadyHeap` is a binary
max-heap ordered by (priority DESC, enqueue-seq ASC).
With a restore tier the count is `tieredReverseDepCount` (item 754): a
restore-tier task never waits on its deps, so it blocks only the
exec-tier tasks that depend on it. Its dependents do wait on its deps:
one that finishes early releases them once its own deps have settled,
so `dependsOn` order holds through a hit (released at its own finish,
an `e2e` ran beside the `db:migrate` two edges up; item 963). An exec-tier task's count is the
exact closure over the exec tier, each restore dep read as the exec
tasks that restore waits on (`e1 → r → e2` holds `e2` until `e1` ran,
so `e1` counts `e2`; counted over the exec tier alone it ranked 0 behind
every idle task, about 1 ms more at 3,000 tasks); a restore's is the sum over its
direct exec-tier dependents of one plus theirs, plus the rank of each
restore that depends on it, since that one releases its dependents only
after it (C-51: `r1 → r2 → e` ranked `r1` 0, behind every idle restore,
and `e` waited for it; skipped when no restore feeds an exec task, so an
all-hit run pays nothing). The rank can count a diamond twice; that only
reorders restores among themselves, on a lane twice the exec cap. A warm run's exec tier is its group tasks with no
edges among them, and the whole-graph closure (476 packages: 1,428
nodes, 12.8k edges of 45-word bitsets) was 10 ms of the run-graph
stage (48.1 → 37.7 ms, min of 6).
When `priorities` is passed, `mergePriorities` scales those weights
(by 2^20, the lowest of them, 0 at most, mapped to one step) to sort
above the baseline for every covered node, a weight of 0 or below
included, with the
baseline as the tie-break inside the override set. Nothing in core
computes one; it is the seam a scheduling-policy plugin
(`@vzn/vx-history`) feeds.

## Failure isolation

A failed task does not stop the scheduler: its transitive exec-tier
dependents get `skipped`, through a restore-tier hit between them too
(the hit stays a `cache-hit`, its key being its deps' inputs, and passes
the block down with the root); unrelated tasks continue; the promise
resolves only after every task has _some_ outcome (an idle server
and its groups excepted, above). This is Turbo's
middle `--continue` setting, `deps-ok`, as the default; `never` stops
dispatch at the first failure (in-flight tasks finish, everything not
yet started — restores included — completes `skipped`); `always` runs
dependents on a failed upstream, and the orchestrator withholds their
save (`ExecuteArgs.taintedUpstream`), since a healthy key over bytes
built on a partial tree would be the next clean run's stale hit. A
skipped outcome names the failed or aborted task at the root of its
block (`blockedBy`); fail-fast's skips name nothing. A rejected
`execute` promise becomes a `failed` outcome; a `UserError`, a
file-system refusal or running out of descriptors reports plainly, once per run (a repeat says `as
<id> above`), anything else as `[vx] internal error in <id>`. The line
goes to `onError` before the outcome lands (stderr when absent); a run
gives it the task's own stderr, so the task's frame and the failure
recap carry it. One that rejects after the run's stop is the stop's
doing (a runtime probe it killed) and becomes `aborted`, with no line
(C-65).

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
`tests/scheduler-properties.test.ts` holds the promises over seeded
random graphs (restores, demotions, groups, pools, an admission policy,
failures, a stop, each `--continue` mode): one outcome per task, an
exec task starts after everything above it finished, `deps-ok` never
runs over a failure, a skip names a failed ancestor, nothing starts
after the stop, every lane stays under its cap; and the taint tracker
against its definition (C-70).
`tests/graph-pipeline-properties.test.ts` feeds `buildTaskGraph`'s
output over random workspaces that sometimes cycle into `runGraph`: a
refusal names a simple cycle of real edges, build and serial order
repeat, each task runs at most once, after its deps, under the cap,
and each `--continue` mode runs exactly the tasks it promises.

## Replacing this module

The contract is small: take a graph + an `execute`, return outcomes.
Keep `ScheduleOptions` and `TaskOutcome` shapes stable to avoid
churning consumers. Distribution (fanning `execute` to remote
workers) is a plugin's job through the `executor` seam —
`@vzn/vx-reapi` does it against a Bazel REAPI worker pool — and it
reuses these types unchanged; the scheduler never knows where a task
ran.
