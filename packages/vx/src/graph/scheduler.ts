import {
  fsRefusalHint,
  isFsRefusal,
  isOutOfFds,
  isUserError,
  OUT_OF_FDS_HINT,
  thrownMessage,
  ui,
} from '../util/index.js'
import {
  computeReverseDepCount,
  mergePriorities,
  strategyPriorities,
  tieredReverseDepCount,
  type ScheduleStrategy,
} from './priorities.js'
import { isGroupTask } from './folds.js'
import type { TaskNode } from './task-graph.js'
import type { TaskStatus } from './task-status.js'

/**
 * Thrown by `execute` for a restore-tier task that turned out to have
 * nothing to restore (its artifact vanished after the up-front probe). It
 * may be running ahead of its deps, so it cannot run its command in that
 * slot: the scheduler releases the slot and dispatches it again as an
 * exec-tier task once its deps are done. It records no outcome, and its
 * dependents wait for the second dispatch.
 */
export class RestoreDemoted extends Error {
  constructor(readonly taskId: string) {
    super(`${taskId}: restore demoted to a run`)
    this.name = 'RestoreDemoted'
  }
}

/** What moved in a missed task's key since the last entry saved for it. */
export interface InputChanges {
  /** How many components changed, appeared or went. 0: the same key, its entry gone. */
  count: number
  /** The first of them, by kind then name. */
  first: readonly { kind: string; name: string; change: 'changed' | 'added' | 'removed' }[]
}

export interface TaskOutcome {
  node: TaskNode
  status: TaskStatus
  exitCode: number
  durationMs: number
  /** Cache key hash, if one was computed. Folded into dependents' keys
   *  (pure-input transitive — the upstream's input key, not its output). */
  hash?: string
  /**
   * For cache-hit statuses: the exec time the ENTRY was stored with — i.e.
   * the work this hit skipped. Distinct from `durationMs`, which is always
   * what THIS run spent (a hit's restore cost). The two differ by whatever
   * the exec:restore ratio happens to be, so a surface reporting "time
   * saved" must read this one; a surface reporting "time spent" must not.
   * Undefined on every non-hit outcome — nothing was skipped.
   */
  storedDurationMs?: number
  /**
   * For cache-hit statuses: what the PRODUCING execution used, read from
   * the entry (it rides the artifact, so a remote hit on a fresh machine
   * carries it too). The same split as `storedDurationMs`: `cpuMs` /
   * `peakRssBytes` are what THIS run spent and stay absent on a hit.
   */
  storedCpuMs?: number
  storedPeakRssBytes?: number
  /**
   * How long an `admit` policy held this task after it was ready with a
   * free worker — the wait the plugin, not the count gate, imposed. Set
   * only when a policy refused it at least once (so a run with no policy
   * carries the field on no outcome); the event stream and the summary
   * footer show it.
   */
  admissionHeldMs?: number
  /**
   * How long this task waited ready (its deps done, or none to wait on)
   * before it was dispatched: a full worker pool's wait, plus any
   * `admissionHeldMs`. Absent when it started within the millisecond and
   * on a task that never ran.
   */
  queuedMs?: number
  /** On a cacheable task that ran: how many files its key read. */
  inputFiles?: number
  /**
   * The artifact's compressed size: on a hit, the entry's; on a miss, the one
   * its save wrote (measured only when a telemetry sink listens).
   */
  artifactBytes?: number
  /**
   * The raw bytes of the task's outputs: on a hit, the entry's files as
   * restored; on a miss, the files its save stored (the row waits for it).
   */
  outputBytes?: number
  /** On a remote hit this run pulled: the download and its ingest. */
  fetchMs?: number
  /** On a miss that saved, with a sink listening: the save's own time. */
  saveMs?: number
  /**
   * On a cacheable task that ran: what its key changed since the last entry
   * saved for it. Only when a telemetry sink asked, and the cache holds one.
   */
  inputChanges?: InputChanges
  /** v11 analytics: CPU time + peak RSS for this task's child process. */
  cpuMs?: number
  peakRssBytes?: number
  /**
   * The most cores one sampling interval burned and the mean resident
   * memory over the looks; only when a sink samples and a look landed.
   */
  peakCores?: number
  avgRssBytes?: number
  /**
   * A GROUP task's own dependency outcomes — the tasks it stands for.
   * A group has no `exec` and therefore no outputs and no cache entry: its
   * hash is a synthetic roll-up (`computeGroupHash`), so asking the local
   * index what it produced returns nothing. A dependent needs the real
   * tasks beneath it to describe its own input set, and only the group
   * itself is ever in a position to say which those are. Set on group
   * outcomes only; never folded into any key.
   */
  groupUpstream?: readonly TaskOutcome[]
  /**
   * This task RAN over inputs its key no longer describes: one moved while
   * it ran, a claimed root file moved, or an upstream carried this
   * mark. Its save was withheld, and its outputs are not what `hash` names,
   * so a dependant that folds `hash` saves nothing either (A-12).
   */
  unkeyed?: true
  /**
   * The task with no `inputs` this task's key folds (this task, or one
   * upstream): no run can derive that key again, so it neither read nor
   * saved an entry, and a dependant that folds `hash` does neither.
   */
  keylessBy?: string
  /**
   * The run's cache policy read and wrote nothing (`--no-cache`,
   * `--cache-policy=local:`): no cache answered for this task, so a run of it is
   * `no-cache`, not a miss. Set by `run()`; `ranNoCache` reads it.
   */
  cacheOff?: true
  /**
   * On a `skipped` outcome: the task at the ROOT of what blocked it — the
   * failed (or aborted) upstream, followed through any chain of skips
   * between. Absent when the skip was fail-fast's (no upstream failed).
   * The footer, the telemetry record and the run row all
   * read this one field (item 267).
   */
  blockedBy?: string
  /**
   * On a `skipped` outcome: its `exec.platforms` leave out this machine.
   * Its dependants are skipped with `blockedBy` naming it, and neither
   * fails the run.
   */
  otherPlatform?: { readonly needs: readonly string[]; readonly host: string }
  /**
   * On a `failed` outcome: vx's own `timeout` killed the final attempt.
   * The exit is the shell's 143, and every label says "timed out" instead
   * of reading it as a signal (item 268).
   */
  timedOut?: true
  /**
   * On a `failed` outcome of a command that ran: the final attempt's
   * output, both streams, as `encodeOutputLog` stores it, secrets masked,
   * bounded to its first 8 KiB and last 56 KiB. The run's history keeps it.
   */
  failedOutput?: string
  /**
   * When the run keeps its bytes in a remote, a task that ran and saved no
   * entry (failed, or uncached): its whole output as `encodeOutputLog`
   * stores it, secrets masked, at the entry's bounds.
   */
  runLog?: string
  /**
   * On a failed persistent task: why it never became ready — the readiness
   * deadline fired, the child exited first (`exitCode` is then its own), or
   * the spawn itself failed. Every label reads this instead of the exit.
   */
  notReady?: 'timeout' | 'exited' | 'spawn'
  /**
   * On a ready persistent task: its child exited on its own while the run
   * went on — a setup step's 0 at ready, a crash's code after it — so no
   * label calls it running.
   */
  serverExit?: number
  /**
   * The input that changed while the command ran, failing the task under
   * `inputStability.severity: 'error'` (workspace-relative; '' when vx
   * could not name it). The exit is vx's 1; the label reads this instead.
   */
  inputMoved?: string
  /** Executor-reported placement label (`ExecuteResult.where`) — set only
   *  when the task ran somewhere other than this host: telemetry and the task's row. */
  where?: string
  /** A persistent task each dependant's executor starts where it runs: nothing ran here, and it is no execution of its own. */
  carried?: true
  /** The cores and memory of the machine `where` names (`ExecuteResult.machine`). */
  whereCores?: number
  whereMemoryBytes?: number
  /** `ExecuteResult.machine.cpuShare`: the share of a core its threads got there. */
  cpuShare?: number
  /** `'deferred'` when the task's outputs were left in the remote store
   *  (`--cache-download=none`) instead of landing on this machine. Absent for
   *  every ordinary outcome. Telemetry-only. */
  outputs?: 'deferred'
  /** The task ran here and its result went to the cache. The footer's `↑`. */
  saved?: true
  /**
   * v11 analytics: hrtime span relative to the parent run's t=0.
   * Lets downstream analytics reconstruct the actual parallel timeline
   * (overlapping tasks, idle gaps) rather than just summing durations.
   */
  wallclockStartNs?: bigint
  wallclockEndNs?: bigint
  /**
   * For cache-hit statuses: true if outputs were actually written to
   * disk this run, false if the on-disk state already matched the
   * cached snapshot (no materialization needed). Lets the formatter
   * surface "up-to-date" vs "local-cache" / "remote-cache" in the
   * framed block. Undefined on non-cache-hit outcomes (success /
   * failed / skipped) — irrelevant there.
   */
  restored?: boolean
  /**
   * How many times the task executed this run, when `exec.retries` /
   * `--retries` re-ran failed attempts. Set only when > 1 — a plain
   * single-attempt run carries nothing. Not persisted; telemetry-side
   * flaky detection reads it off the outcome stream.
   */
  attempts?: number
  /** The attempts that failed and were run again, in order: when each ended (epoch ms) and how. */
  failedAttempts?: readonly { endedAt: number; exitCode: number; timedOut?: true }[]
  /**
   * Set when this run proved the task flaky: its key failed after it had
   * passed (this run's included) or it passed only on a retry. Its row carries it.
   */
  flaky?: { passes: number; failures: number }
  /**
   * Count of sandbox violations captured during this task's exec (a task
   * declaring `exec.sandbox`). Non-zero means the task touched something
   * it did not declare; execute-task fails the task on any violation, so
   * nothing built that way is ever saved or replayed.
   */
  sandboxViolations?: number
  /**
   * Raw violation log lines (one per access denial). Populated alongside
   * `sandboxViolations` so the framed-output renderer can show them
   * inline in the task's block instead of as loose status output.
   */
  sandboxViolationLines?: string[]
  /** The `exec.sandbox.allow` entries that would have granted the denials. */
  sandboxFix?: {
    read?: string[]
    write?: string[]
    network?: string[]
    systemInfo?: string[]
    /** Credential paths denied and left out of the grants: an agent applies the fix as given. */
    withheld?: string[]
    /**
     * Reads of the project the task's `inputs.files` does not match:
     * add them there too when the output depends on them, or a hit replays
     * output built from an older copy. Cached tasks only.
     */
    inputs?: string[]
  }
}

export type ContinueMode = 'never' | 'deps-ok' | 'always'

export interface ScheduleOptions {
  nodes: Map<string, TaskNode>
  concurrency: number
  /** Restore-tier tasks at once; twice `concurrency` unset. */
  restoreConcurrency?: number
  /**
   * An aborted run dispatches nothing further: every task not yet
   * started completes `aborted` (the ones in flight are being killed by
   * the orchestrator and report `aborted` through the runner's signal).
   */
  signal?: AbortSignal
  /**
   * Failure propagation (default 'deps-ok' — the historical behavior):
   *   - 'deps-ok': a failed/skipped/aborted upstream skips its
   *     dependents; independent siblings keep running.
   *   - 'never': the first failure stops dispatch — in-flight tasks
   *     finish their attempt but start no retry, everything not yet started completes as
   *     skipped (restore-tier included: a fail-fast run stops
   *     restoring too).
   *   - 'always': dependents run even when an upstream failed. Their
   *     keys are the ones a healthy run derives (failed outcomes carry
   *     the upstream's INPUT key, computed before exec), which is
   *     exactly why the orchestrator withholds their SAVE: the bytes
   *     were built on a partial tree, and a healthy key over them would
   *     be the next clean run's stale hit (`ExecuteArgs.taintedUpstream`).
   */
  continueMode?: ContinueMode
  /**
   * A failure the graph's outcomes do not hold yet: a persistent task
   * that died after it became ready. Its outcome said `success` when it
   * was ready, so this is how a dependant not yet started learns of it:
   * under 'deps-ok' it is skipped as below a failed task, and under
   * 'never' it stops dispatch.
   */
  serverDied?: (id: string) => boolean
  /**
   * Called once, when 'never' stops dispatch: a task in flight then
   * finishes its attempt but starts no retry.
   */
  onFailFast?: () => void
  execute: (node: TaskNode, upstream: TaskOutcome[]) => Promise<TaskOutcome>
  /** `queuedMs`: how long the task waited ready for a slot, when it did. */
  onStart?: (node: TaskNode, queuedMs?: number) => void
  onFinish?: (outcome: TaskOutcome) => void
  /**
   * Where the line naming a rejected `execute` goes, before its failed
   * outcome lands. Absent = stderr. The run gives it the task's own
   * stderr, so its frame carries the reason.
   */
  onError?: (node: TaskNode, line: string, err: unknown) => void
  /**
   * What an outcome still owes before its dependents may start — a cache
   * save that runs off the execution slot (the orchestrator's save lane):
   * a dependent reads the upstream's entry (its output rows travel in the
   * execute request), so it waits for the save to land, while the freed
   * slot admits other work at once. Undefined: nothing owed.
   */
  settledOf?: (outcome: TaskOutcome) => Promise<Partial<TaskOutcome> | void> | undefined
  /**
   * A task the caller settles in place: a thunk returning its outcome, or
   * undefined to dispatch it through `execute`. Asked of a task its lane
   * has room for, after the skip check; `onStart` hears it, then the thunk
   * runs (a hit replays its output there), and its outcome lands in the
   * same tick, holding no slot. An unkeyed group runs nothing, and the
   * dispatch, the slot and the promise around it were ~10 µs of each of a
   * warm run's 1,090 groups (X-192); a hit whose tree is current does no
   * more. A restore-tier task's `upstream` may hold undefined entries.
   */
  settleNow?: (node: TaskNode, upstream: TaskOutcome[]) => (() => TaskOutcome) | undefined
  /**
   * Optional priority override: callers pass their own per-node weight
   * (e.g. `computePredictedPriorities` from the orchestrator's history
   * data). The scheduler picks the highest-weight ready task next.
   * When undefined, falls back to the static reverse-deps-count
   * heuristic (the default and historically the only behavior).
   */
  priorities?: ReadonlyMap<string, number>
  /**
   * Called once as the run starts with a function that replaces
   * `priorities`: the ready queues re-rank at once, over the same baseline.
   * A `schedule` plugin's later, better weights land through it.
   */
  reprioritize?: (apply: (priorities: ReadonlyMap<string, number>) => void) => void
  /**
   * The baseline ranking under `priorities` (`schedule` in .vx/workspace.ts).
   * Undefined or `most-work` is the reverse-deps count above.
   */
  strategy?: ScheduleStrategy
  /**
   * The `most-work` baseline already counted (`computeReverseDepCount`, read
   * back with the graph): asked only when that baseline is the one used.
   */
  reverseDeps?: () => ReadonlyMap<string, number>
  /**
   * Restore-tier task ids: confirmed stable-key LOCAL cache hits (the
   * local short-circuit). A restore-tier task:
   *   - becomes READY IMMEDIATELY — its `pending` does NOT gate it, since
   *     a stable hit's restore needs none of its deps' output;
   *   - is LOW priority — exec-tier work (cache misses + unstable tasks)
   *     owns the worker pool, restores only backfill idle capacity (or
   *     run when an exec is blocked on a restorable dep and nothing else
   *     is runnable — then the restore is the only ready task and unblocks
   *     it);
   *   - bypasses the `failedDep`→`skipped` check (its key is independent
   *     of dep success — pure-input transitive hashing — so a valid cached
   *     output is reported `cache-hit` regardless of a dep failing);
   *   - leaves the tier when `execute` throws `RestoreDemoted`, and is
   *     dispatched again once its deps are done, with the dep check.
   * A persistent task nobody requested whose every dependant is in the
   * tier starts only when one of them is demoted; once they have all
   * finished it settles without an outcome, never spawned.
   * It still runs through `execute()` (so the logger frame is unchanged);
   * the orchestrator's execute reuses the up-front probe, so there is no
   * second cache.get. When undefined/empty, behavior is byte-identical.
   */
  restoreTier?: ReadonlySet<string>
  /**
   * Servers held back until the caller knows whether their dependants are
   * hits a remote holds. Each resolves to the dependants it has added to
   * `restoreTier` since the run began (the caller's set, read live); a
   * server whose every dependant is then in the tier is idle, as above,
   * and any other is dispatched as usual.
   */
  heldServers?: ReadonlyMap<string, Promise<readonly string[]>>
  /**
   * Pool assignment for tasks placed on an executor with its own capacity
   * (a remote pool). Such a task occupies one of the pool's `capacity` slots
   * instead of a local worker slot and reserves no local resources, so a
   * remote pool is never throttled by the local CPU count. Undefined (or
   * a `undefined` result) = the local pool.
   */
  poolOf?: (id: string) => { name: string; capacity: number } | undefined
  /**
   * Admission over the worker count: asked for every exec-tier task about
   * to start on this machine, with the ids of the exec-tier tasks running
   * here right now (added on dispatch, so two asks in one tick see each
   * other; removed when `execute` resolves, which for a persistent task is
   * at ready). `false` parks the task until something finishes. Undefined →
   * count-only, the legacy path byte for byte. Restore-tier hits, pooled
   * tasks and groups hold no local resources: never asked, never listed.
   */
  admit?: (id: string, running: ReadonlySet<string>) => boolean
  /**
   * Tasks that hold the terminal (`exec.interactive` on a TTY). One starts
   * only once nothing runs, and nothing starts while it runs. When one is
   * the next to start, dispatch stops so the running tasks drain. A
   * persistent one holds it until `execute` resolves, at spawn.
   */
  exclusive?: ReadonlySet<string>
}

/**
 * A binary max-heap of ready task ids, ordered by (priority DESC, enqueue-seq
 * ASC) so `pop()` returns the highest-priority task and equal-priority ties
 * break in enqueue order — the exact contract the prior sorted-array kept, but
 * O(log R) push/pop instead of O(R) splice/shift. On a wide ready frontier (the
 * 1000-package startup enqueue, or a fan-out completion), that turns the
 * queue's O(R²) maintenance into O(R log R).
 */
class ReadyHeap {
  private readonly ids: string[] = []
  private readonly seq: number[] = []
  // Each slot's priority, read once at push: a map lookup per comparison
  // was two per heap level on every push and pop.
  private readonly prio: number[] = []
  private next = 0
  /** Queued ids `counts` holds true for. */
  counted = 0
  constructor(
    private priority: ReadonlyMap<string, number>,
    private readonly counts?: (id: string) => boolean,
  ) {}
  get size(): number {
    return this.ids.length
  }
  /** Re-rank every queued id under `priority`, and every later push. */
  reprioritize(priority: ReadonlyMap<string, number>): void {
    this.priority = priority
    for (let i = 0; i < this.ids.length; i++) this.prio[i] = priority.get(this.ids[i]!) ?? 0
    for (let i = (this.ids.length >> 1) - 1; i >= 0; i--) this.down(i)
  }
  private down(i: number): void {
    for (;;) {
      const l = 2 * i + 1
      const r = 2 * i + 2
      let best = i
      if (l < this.ids.length && this.higher(l, best)) best = l
      if (r < this.ids.length && this.higher(r, best)) best = r
      if (best === i) return
      this.swap(i, best)
      i = best
    }
  }
  /** True if slot i outranks slot j (higher priority, or equal priority + earlier seq). */
  private higher(i: number, j: number): boolean {
    const pi = this.prio[i]!
    const pj = this.prio[j]!
    return pi !== pj ? pi > pj : this.seq[i]! < this.seq[j]!
  }
  private swap(i: number, j: number): void {
    const ti = this.ids[i]!
    this.ids[i] = this.ids[j]!
    this.ids[j] = ti
    const si = this.seq[i]!
    this.seq[i] = this.seq[j]!
    this.seq[j] = si
    const pi = this.prio[i]!
    this.prio[i] = this.prio[j]!
    this.prio[j] = pi
  }
  /**
   * `seq` defaults to a fresh monotonic counter. A parked-then-repushed
   * task passes its ORIGINAL seq back in, which makes FIFO-among-equals a
   * property of the heap rather than of the tick loop's shape.
   *
   * It is NOT the difference between correct and incorrect order today,
   * and the comment here used to claim it was ("a fresh seq would demote
   * it behind later arrivals"). It would not: `parked` is a subsequence
   * of the tick's pop order, so it is already in ranking order, and every
   * push that follows takes a later seq — so fresh seqs handed out in
   * parked order reproduce the same ranking. Measured over 800 randomized
   * scenarios (random DAGs, costs, budgets, concurrency, failures, all
   * three continue modes): zero order differences, item 493. Kept because
   * it holds without that argument.
   */
  push(id: string, seq: number = this.next++): void {
    if (this.counts?.(id) === true) this.counted++
    this.ids.push(id)
    this.seq.push(seq)
    this.prio.push(this.priority.get(id) ?? 0)
    let i = this.ids.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!this.higher(i, parent)) break
      this.swap(i, parent)
      i = parent
    }
  }
  /** The head's enqueue seq (capture before `pop` for a possible repush). */
  peekSeq(): number {
    return this.seq[0] ?? -1
  }
  pop(): string | undefined {
    const n = this.ids.length
    if (n === 0) return undefined
    const top = this.ids[0]!
    if (this.counts?.(top) === true) this.counted--
    const lastId = this.ids.pop()!
    const lastSeq = this.seq.pop()!
    const lastPrio = this.prio.pop()!
    if (n > 1) {
      this.ids[0] = lastId
      this.seq[0] = lastSeq
      this.prio[0] = lastPrio
      this.down(0)
    }
    return top
  }
}

/**
 * The dead server a dependency stands for: itself, or one a group reaches.
 * A group is a name for its deps, and it finished the moment the server
 * was ready, so a task behind it ran against the dead one. Walked with a
 * stack and a seen set: recursion threw `RangeError` on a deep chain of
 * groups, and re-walked a group each path reached it by.
 */
export function deadServerBehind(
  nodes: ReadonlyMap<string, TaskNode>,
  serverDied: (id: string) => boolean,
  id: string,
): string | undefined {
  const stack = [id]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const at = stack.pop()!
    if (seen.has(at)) continue
    seen.add(at)
    if (serverDied(at)) return at
    const n = nodes.get(at)
    if (n === undefined || !isGroupTask(n)) continue
    // Reversed, so the first dep is walked first, as the order it names them.
    for (let i = n.deps.length - 1; i >= 0; i--) stack.push(n.deps[i]!)
  }
  return undefined
}

/**
 * Run the task graph. Independent tasks run in parallel up to `concurrency`.
 * If a task fails, its dependents are marked `skipped` but unrelated tasks
 * keep running so the user gets maximum information per invocation.
 *
 * Scheduling: when more than one task is ready, the scheduler picks the
 * one that blocks the most downstream work (most transitive reverse
 * dependents). Ties break in graph-insertion order (which is the topo
 * order produced by `buildTaskGraph`). Minimizes worker idle at the
 * end of the run.
 */
export async function runGraph(options: ScheduleOptions): Promise<Map<string, TaskOutcome>> {
  const { nodes, concurrency, execute, onStart, onFinish } = options
  const continueMode = options.continueMode ?? 'deps-ok'
  // 'never': set on the first failed outcome; from then on every
  // dequeued task is skipped instead of dispatched (in-flight tasks
  // finish naturally and their dependents drain through the same path).
  let failFastTripped = false
  const tripFailFast = (): void => {
    if (failFastTripped) return
    failFastTripped = true
    options.onFailFast?.()
  }
  const outcomes = new Map<string, TaskOutcome>()

  // Reverse adjacency + pending dep counts. Built once. A task becomes
  // ready when its `pending` hits 0, at which point it's pushed to the
  // ready queue. This replaces the old "scan all of scheduleOrder on
  // every tick" pattern which was O(N²) over a full run.
  const dependents = new Map<string, string[]>()
  const pending = new Map<string, number>()
  for (const node of nodes.values()) {
    pending.set(node.id, node.deps.length)
    for (const dep of node.deps) {
      const list = dependents.get(dep)
      if (list) list.push(node.id)
      else dependents.set(dep, [node.id])
    }
  }

  // Override hook (predictive scheduling): when the caller passes a
  // priorities map (e.g. from history-aware critical-path estimation),
  // use those weights. Falls back to the reverse-deps-count heuristic
  // for nodes the caller didn't score, so partial coverage works.
  const baseline =
    options.strategy !== undefined && options.strategy !== 'most-work'
      ? strategyPriorities(nodes, options.strategy)
      : options.restoreTier !== undefined && options.restoreTier.size > 0
        ? tieredReverseDepCount(nodes, options.restoreTier)
        : (options.reverseDeps?.() ?? computeReverseDepCount(nodes))
  const priority: ReadonlyMap<string, number> = options.priorities
    ? mergePriorities(baseline, options.priorities)
    : baseline

  // Two ready queues — exec-tier (cache misses + unstable tasks) and
  // restore-tier (confirmed stable local hits). Each is a max-heap keyed by
  // (priority DESC, enqueue-seq ASC), so the highest-priority task pops first
  // and equal-priority ties break in graph-insertion order — same contract the
  // prior `scheduleOrder` sort provided via stable sort. The tick loop drains
  // execReady FIRST, so misses own the worker pool and restores only backfill
  // idle capacity (or run when an exec is blocked on a restorable dep and
  // nothing else is runnable).
  const restoreTier = options.restoreTier
  // Restore-tier tasks whose execute threw `RestoreDemoted`: from then on
  // they are exec-tier tasks, gated on their deps like any other.
  const demoted = new Set<string>()
  const inRestoreTier = (id: string): boolean => restoreTier?.has(id) === true && !demoted.has(id)
  // A server pulled in only for restore-tier hits serves nobody: it waits
  // (`dormant`) until a dependant is demoted, which starts it, or until
  // every dependant has finished, which settles it unspawned. Settled
  // without an outcome: it is not part of the run, as a pruned task is not.
  // A group between it and its hits is idle with it.
  const idleGroups = new Set<string>()
  const idle = idleServers(nodes, dependents, restoreTier, idleGroups)
  for (const g of idleGroups) idle.add(g)
  const dormant = new Set<string>()
  // The idle tasks below `id`, through idle groups: those its outcome may
  // let settle, and those its demotion wakes.
  const idleBelow = (id: string, each: (p: string) => void): void => {
    const stack = [...(nodes.get(id) as TaskNode).deps]
    const seen = new Set<string>()
    while (stack.length > 0) {
      const p = stack.pop()!
      if (seen.has(p) || !idle.has(p)) continue
      seen.add(p)
      each(p)
      if (idleGroups.has(p)) stack.push(...(nodes.get(p) as TaskNode).deps)
    }
  }
  // Every task above an idle one, through idle groups, has finished.
  const settledAbove = (id: string): boolean => {
    const stack = [id]
    const seen = new Set<string>()
    while (stack.length > 0) {
      for (const d of dependents.get(stack.pop()!) ?? []) {
        if (outcomes.has(d)) continue
        if (!idleGroups.has(d) || !idle.has(d)) return false
        if (!seen.has(d)) {
          seen.add(d)
          stack.push(d)
        }
      }
    }
    return true
  }
  // Held servers not yet answered, and those of them that became ready.
  const unanswered = new Set(options.heldServers?.keys() ?? [])
  for (const id of idle) unanswered.delete(id)
  const heldReady = new Set<string>()
  let settledIdle = 0
  // Counting those no pool takes: with every pool full, only one of them can start.
  const execReady = new ReadyHeap(
    priority,
    options.poolOf === undefined ? undefined : (id) => options.poolOf!(id) === undefined,
  )
  const restoreReady = new ReadyHeap(priority)
  options.reprioritize?.((weights) => {
    const merged = mergePriorities(baseline, weights)
    execReady.reprioritize(merged)
    restoreReady.reprioritize(merged)
  })
  // A restore-tier task is dep-independent (a stable hit's restore needs
  // none of its deps' output), so it's ready immediately; its `pending`
  // decrements still happen (in finishOne) but never re-enqueue it.
  // Everything else enqueues on the exec-tier the moment its deps
  // complete.
  // When each queued id became ready; dispatch takes it out.
  const readyAt = new Map<string, number>()
  const startedAt = Date.now()
  for (const node of nodes.values()) {
    if (restoreTier?.has(node.id)) restoreReady.push(node.id)
    else if (node.deps.length === 0) execReady.push(node.id)
    else continue
    readyAt.set(node.id, startedAt)
  }
  const promoted = new Set<string>()

  let active = 0
  // Restore-tier work is disk I/O — a confirmed hit's tar extract is ~8
  // filesystem round trips and no CPU — so it gets its own lane, twice
  // the exec cap: on the 1,000-project bench with every task a restore,
  // 4 → 8 workers cut the run-graph stage 683–754 → 556–595 ms and 16 was
  // no better (2026-09-10). Exec-tier work keeps the CPU-shaped cap; the
  // two lanes never wait on each other. `--concurrency 1` stays serial:
  // the two lanes share its one slot, where a lane each let an 80 MB
  // restore run inside another task's execution (item 1103).
  let activeRestore = 0
  const restoreConcurrency = options.restoreConcurrency ?? 2 * concurrency
  const serial = concurrency === 1
  const execRoom = (): boolean => (serial ? active + activeRestore < 1 : active < concurrency)
  const restoreRoom = (): boolean =>
    serial ? active + activeRestore < 1 : activeRestore < restoreConcurrency
  let resolved = false
  let stopListening = (): void => {}
  // A refusal's text → the first task that said it. A corrupt cache index
  // reaches every lookup as one UserError; on bare stderr a repeat names the first.
  const refusedBy = new Map<string, string>()

  // Admission policy over the count limit (a plugin's `admit`). Inactive
  // → the tick loop short-circuits before any of this and behaves
  // byte-identically to the count-only scheduler.
  const admitPolicy = options.admit
  const admitActive = admitPolicy !== undefined
  const running = new Set<string>()
  // When a policy first refused each parked task — so its outcome can say
  // how long the policy, not the count gate, held it. Nothing with no
  // policy: the map is never touched.
  const heldSince = new Map<string, number>()

  // A restore-tier task is a confirmed local cache hit: its "execution"
  // is a cheap tar extract, not the task's real work — it reserves ZERO
  // regardless of what the config declares, so it never holds budget
  // against a real executor (and never parks).
  const poolOf = options.poolOf
  const poolActive = new Map<string, number>()
  // Every pool a task of the run is placed in, by name: a task's pool is
  // fixed for the run, so read once here.
  const pools = new Map<string, number>()
  if (poolOf !== undefined)
    for (const id of nodes.keys()) {
      const p = poolOf(id)
      if (p !== undefined) pools.set(p.name, p.capacity)
    }
  const poolRoom = (): boolean => {
    for (const [name, capacity] of pools) if ((poolActive.get(name) ?? 0) < capacity) return true
    return false
  }
  // A pooled task is admitted against ITS pool's capacity, a local one
  // against `concurrency`; pooled tasks reserve no local resources. A
  // restore is local disk work wherever its task was placed: on the pool's
  // arm it bypassed the restore lane's cap.
  const hasRoom = (id: string): boolean => {
    if (inRestoreTier(id)) return restoreRoom()
    const pool = poolOf?.(id)
    if (pool === undefined) return execRoom()
    return (poolActive.get(pool.name) ?? 0) < pool.capacity
  }
  const exclusive = options.exclusive
  let holding = false
  const busy = (): boolean => {
    if (active > 0 || activeRestore > 0) return true
    for (const n of poolActive.values()) if (n > 0) return true
    return false
  }
  const admit = (id: string): (() => void) => {
    if (exclusive?.has(id) === true) {
      holding = true
      active++
      return () => {
        holding = false
        active--
      }
    }
    if (inRestoreTier(id)) {
      activeRestore++
      return () => {
        activeRestore--
      }
    }
    const pool = poolOf?.(id)
    if (pool === undefined) {
      active++
      return () => {
        active--
      }
    }
    poolActive.set(pool.name, (poolActive.get(pool.name) ?? 0) + 1)
    return () => {
      poolActive.set(pool.name, (poolActive.get(pool.name) ?? 1) - 1)
    }
  }
  // The policy sees exec-tier local tasks only; a restore is a tar
  // extract, a pooled task runs on someone else's capacity, and a group
  // runs nothing, so a packing policy that counted one parked work for it.
  const local = (id: string): boolean =>
    !inRestoreTier(id) && poolOf?.(id) === undefined && !isGroupTask(nodes.get(id) as TaskNode)
  const admits = (id: string): boolean => !local(id) || admitPolicy!(id, running)
  // With no policy nothing reads `running`, so nothing is tracked: the
  // count-only dispatch allocates no closure and touches no set per task.
  const untracked = (): void => {}
  const track = (id: string): (() => void) => {
    if (!admitActive || !local(id)) return untracked
    running.add(id)
    return () => {
      running.delete(id)
    }
  }

  return new Promise<Map<string, TaskOutcome>>((resolve) => {
    const finishOne = (id: string, outcome: TaskOutcome): void => {
      if (continueMode === 'never' && outcome.status === 'failed') tripFailFast()
      outcomes.set(id, outcome)
      // A dormant server is asked again: the dispatch settles it once its
      // last dependant is in.
      if (dormant.size > 0) {
        idleBelow(id, (p) => {
          if (dormant.delete(p)) execReady.push(p)
        })
      }
      // Observer hook (the logger's taskComplete). Crash-isolated: a
      // throwing observer must NOT break scheduling — it would otherwise
      // skip the dependent-enqueue + tick below and hang the run. Same
      // "observability never breaks a run" rule the telemetry
      // paths hold. Isolated here (not the completion arm) so a throw
      // can't be mistaken for the task itself failing.
      try {
        onFinish?.(outcome)
      } catch (err) {
        const m = thrownMessage(err)
        ui.say('warn', `[vx] onFinish observer threw for ${id}: ${m}\n`)
      }
      // A restore-tier task runs before its deps, but its DEPENDENTS keep
      // the order `dependsOn` states: they are released once its own deps
      // have settled too. Released at its own finish, an `e2e` ran beside
      // the `db:migrate` two edges up whenever the middle task was a hit,
      // and ran green after that dep failed (item 963).
      if (inRestoreTier(id) && (pending.get(id) ?? 0) > 0) {
        heldRelease.add(id)
        return
      }
      release(id)
    }

    // A restore-tier task whose deps did not all succeed is still a
    // `cache-hit` (its key is theirs, not their outcome), but it passes the
    // block down: its dependents are skipped as a failed dep's would be.
    // Its root: a failed or aborted dep, or the root a skipped or blocked
    // one carries.
    const blockedRestores = new Map<string, string | undefined>()
    const heldRelease = new Set<string>()
    const blockOf = (id: string): void => {
      if (inRestoreTier(id)) {
        for (const dep of (nodes.get(id) as TaskNode).deps) {
          const u = outcomes.get(dep)
          if (continueMode !== 'always' && (u?.status === 'failed' || u?.status === 'aborted')) {
            blockedRestores.set(id, dep)
            break
          }
          if (u?.status === 'skipped') {
            blockedRestores.set(
              id,
              u.blockedBy ?? (u.otherPlatform !== undefined ? dep : undefined),
            )
            break
          }
          if (blockedRestores.has(dep)) {
            blockedRestores.set(id, blockedRestores.get(dep))
            break
          }
        }
      }
    }
    // Its block, then its dependents: one whose pending hits 0 is enqueued,
    // or, when it is a held hit, released in turn before the next sibling.
    // A frame stack, not recursion: a chain of held hits is released in one
    // walk, and recursion threw RangeError on a 30,000-deep one.
    const release = (root: string): void => {
      const frames: { ds: readonly string[]; i: number }[] = []
      const enter = (id: string): void => {
        blockOf(id)
        const ds = dependents.get(id)
        if (ds !== undefined) frames.push({ ds, i: 0 })
      }
      enter(root)
      while (frames.length > 0) {
        const f = frames[frames.length - 1]!
        if (f.i === f.ds.length) {
          frames.pop()
          continue
        }
        const d = f.ds[f.i++]!
        const rem = (pending.get(d) ?? 0) - 1
        pending.set(d, rem)
        if (rem !== 0) continue
        // Restore-tier dependents were already enqueued at startup (they
        // don't wait on deps); one that finished early releases its own
        // dependents now. Only an exec-tier dependent is enqueued.
        if (heldRelease.delete(d)) enter(d)
        else if (!inRestoreTier(d)) {
          execReady.push(d)
          readyAt.set(d, Date.now())
        }
      }
    }

    // True when the task would be finished as `skipped` without running
    // (fail-fast tripped, or a failed/skipped/aborted upstream under
    // continueMode !== 'always'). ONE predicate shared by the admission
    // parker and the dispatch loop's skip branch — a would-skip task
    // executes nothing, so it must never park on a resource fit (a
    // too-big doomed task parking forever would hang the run).
    //
    // Restore-tier tasks BYPASS the dep check: their key is independent
    // of any dep's success (pure-input transitive hashing), so a valid
    // cached output is reported `cache-hit` even if a dep failed — and
    // they're dep-independent, so they typically restore before a dep
    // could fail anyway.
    const aborted = (): boolean => options.signal?.aborted === true
    const serverDied = options.serverDied ?? ((): boolean => false)
    const servers =
      options.serverDied === undefined
        ? []
        : [...nodes.values()]
            .filter((n) => n.config.exec?.persistent !== undefined)
            .map((n) => n.id)
    // Only a server can die: with none in the graph, no walk (a stack and
    // a set per dependency of every exec-tier task, X-171).
    const deadServerVia =
      servers.length === 0
        ? (): undefined => undefined
        : (id: string): string | undefined => deadServerBehind(nodes, serverDied, id)
    const willSkip = (id: string): boolean => {
      if (failFastTripped || aborted()) return true
      if (continueMode === 'never' && servers.some(serverDied)) {
        tripFailFast()
        return true
      }
      if (inRestoreTier(id)) return false
      const node = nodes.get(id) as TaskNode
      // `always` runs past a failed upstream, never past one that did not
      // run on this platform: under it, a skip has no other cause.
      if (continueMode === 'always')
        return node.deps.some(
          (d) => outcomes.get(d)?.status === 'skipped' || blockedRestores.has(d),
        )
      return node.deps.some((d) => {
        const u = outcomes.get(d)
        // `aborted` propagates even though it is counted nowhere: the
        // upstream was killed mid-write, so its declared outputs are
        // partial. A dependent that ran anyway would CACHE what it built
        // from them — under the key a healthy run derives, since the fold
        // takes the upstream's INPUT key — so the next run replays those
        // bytes as a green hit.
        return (
          u?.status === 'failed' ||
          u?.status === 'skipped' ||
          u?.status === 'aborted' ||
          blockedRestores.has(d) ||
          deadServerVia(d) !== undefined
        )
      })
    }

    // A throw falls back to the dispatch, whose `execute` reports it.
    const settleInPlace = (
      node: TaskNode,
      upstream: TaskOutcome[],
    ): (() => TaskOutcome) | undefined => {
      if (options.settleNow === undefined) return undefined
      try {
        return options.settleNow(node, upstream)
      } catch {
        return undefined
      }
    }
    const started = (node: TaskNode, queuedMs = 0): void => {
      try {
        if (queuedMs > 0) onStart?.(node, queuedMs)
        else onStart?.(node)
      } catch (err) {
        const m = thrownMessage(err)
        ui.say('warn', `[vx] onStart observer threw for ${node.id}: ${m}\n`)
      }
    }

    const tick = (): void => {
      if (resolved) return
      // Exec-tier tasks parked THIS tick on a refused admission. Within
      // one synchronous tick `running` only grows (tasks leave it in the
      // async completion callbacks, which run a fresh tick), so a task
      // refused now cannot be admitted later in the same tick — parking
      // it for the tick's remainder is exact, and each id pops at most
      // once per tick (O(R log R)).
      const parked: Array<[string, number]> = []

      // Highest-priority admissible task: exec tier first (misses own
      // the pool), then restore tier. With no admission policy this
      // short-circuits to exactly the legacy takeReady. A would-skip
      // task returns without asking (finishing it is free); restore
      // tasks are never asked, so they never park.
      const takeFitting = (): string | undefined => {
        if (holding) return undefined
        // No pools and a full exec lane: nothing on the exec queue can be
        // admitted, so it is not scanned — an admit policy only narrows
        // the count gate, never widens it (scanning under one cost the
        // history plugin's cold bench run 10 s, 2026-10-09) — scanning it
        // would pop and re-park every ready exec task on every tick, and
        // with a wide frontier that is O(R) per tick, O(R²) per run (the
        // 6,000-task scale pin went 0.5 s → 28 s when the restore lane's
        // first cut let the scan run past a full exec lane, 2026-09-10).
        // This is the legacy O(1) gate, kept per lane. Every pool full is
        // the same: a remote pool of 6 slots before 2000 ready tasks
        // re-popped them all on each end (DTE, 2026-10-25).
        const execAdmissible =
          poolOf === undefined ? execRoom() : (execRoom() && execReady.counted > 0) || poolRoom()
        if (execAdmissible) {
          while (execReady.size > 0) {
            const seq = execReady.peekSeq()
            const id = execReady.pop() as string
            if (unanswered.has(id) && !willSkip(id)) {
              heldReady.add(id)
              continue
            }
            if (willSkip(id) || idle.has(id)) return id
            if (exclusive?.has(id) === true) {
              if (!busy() && (!admitActive || admits(id))) return id
              parked.push([id, seq])
              return undefined
            }
            if (hasRoom(id)) {
              if (!admitActive || admits(id)) return id
              // A free worker, refused by the policy: the hold starts now.
              if (!heldSince.has(id)) heldSince.set(id, Date.now())
            }
            parked.push([id, seq])
          }
        }
        // Restore-tier tasks are local disk work, on their own lane.
        return restoreRoom() ? restoreReady.pop() : undefined
      }

      for (;;) {
        const id = takeFitting()
        if (id === undefined) break // nothing ready is admissible right now
        const node = nodes.get(id) as TaskNode

        // For a restore-tier task running BEFORE its deps finish, the
        // `upstream` entries below can be undefined (the cast lies) —
        // the preProbed hit path in execute-task never reads them, and
        // nothing on the restore path may.
        const upstream = node.deps.map((d) => outcomes.get(d) as TaskOutcome)

        // An idle task the stop or fail-fast would skip settles with no
        // outcome, as it would have run: the run never meant to start it.
        // Below a failed dep it is skipped as before, so the hits above it
        // pass the block down.
        const settlesIdle =
          idle.has(id) &&
          (!willSkip(id) ||
            aborted() ||
            (failFastTripped &&
              !node.deps.some((d) => {
                const s = outcomes.get(d)?.status
                return (
                  s === 'failed' || s === 'skipped' || s === 'aborted' || blockedRestores.has(d)
                )
              })))

        // If any upstream failed/skipped, propagate skip synchronously
        // without running. Skipped tasks still flow through this queue
        // because dependents are pushed when `pending` hits 0 regardless
        // of outcome — keeps the propagation logic in one place.
        if (!settlesIdle && willSkip(id)) {
          // The root of the block: a failed or aborted upstream names
          // itself; a skipped one hands down its own root.
          const blocker =
            continueMode === 'always'
              ? undefined
              : upstream.find(
                  (u) => u !== undefined && (u.status === 'failed' || u.status === 'aborted'),
                )
          const viaSkip = upstream.find((u) => u !== undefined && u.status === 'skipped')
          const viaRestore = node.deps.find((d) => blockedRestores.has(d))
          const blockedBy =
            blocker?.node.id ??
            node.deps.map(deadServerVia).find((d) => d !== undefined) ??
            viaSkip?.blockedBy ??
            (viaSkip?.otherPlatform !== undefined ? viaSkip.node.id : undefined) ??
            (viaRestore === undefined ? undefined : blockedRestores.get(viaRestore))
          // Behind a platform skip is no failure: the run passes, so the exit does.
          const notHere =
            !aborted() &&
            blockedBy !== undefined &&
            outcomes.get(blockedBy)?.otherPlatform !== undefined
          finishOne(id, {
            node,
            status: aborted() ? 'aborted' : 'skipped',
            exitCode: notHere ? 0 : 1,
            durationMs: 0,
            ...(blockedBy !== undefined ? { blockedBy } : {}),
          })
          continue
        }
        if (settlesIdle) {
          readyAt.delete(id)
          if (settledAbove(id)) {
            settledIdle++
            release(id)
          } else dormant.add(id)
          continue
        }

        const queuedMs = Date.now() - (readyAt.get(id) ?? Date.now())
        readyAt.delete(id)
        const settle = settleInPlace(node, upstream)
        let now: TaskOutcome | undefined
        if (settle !== undefined) {
          if (!demoted.has(id)) started(node, queuedMs)
          try {
            now = settle()
          } catch {
            // Dispatched below, already started: `execute` reports it.
          }
        }
        if (now !== undefined) {
          finishOne(id, queuedMs === 0 ? now : { ...now, queuedMs })
          continue
        }
        const leave = admit(id)
        // Listed as running on dispatch, so the policy's next ask in this
        // tick sees it; the completion callbacks unlist it.
        const untrack = track(id)
        const since = admitActive ? heldSince.get(id) : undefined
        const heldMs = since === undefined ? 0 : Math.max(1, Date.now() - since)
        if (since !== undefined) heldSince.delete(id)
        const withHold = (o: TaskOutcome): TaskOutcome =>
          heldMs === 0 && queuedMs === 0
            ? o
            : {
                ...o,
                ...(heldMs > 0 ? { admissionHeldMs: heldMs } : {}),
                ...(queuedMs > 0 ? { queuedMs } : {}),
              }
        // Crash-isolated observer hook — a throwing onStart must not abort
        // the dispatch loop (it would strand the tick with the slot held).
        // A demoted task's second dispatch is the same task, already started,
        // as is one whose settle threw.
        if (!demoted.has(id) && settle === undefined) started(node, queuedMs)

        // `.then(onFulfilled, onRejected)` — NOT `.then(f).catch(g)`. The
        // rejection arm handles ONLY `execute()` rejecting; a throw from
        // the fulfillment arm must NOT also run the rejection arm, or
        // `active` releases twice — and a double release wedges the count
        // gate. NOT `onFinish`, which this comment used to cite: it is
        // isolated inside `finishOne`, so it never reaches here (which is
        // why the row named for it cannot tell the two shapes apart —
        // item 560). What is left unisolated is the caller's
        // `settledOf`, and under THIS shape a throw there strands the
        // task's outcome and hangs the run rather than double-releasing.
        // The two-arm form is still the correct choice; there is simply
        // no reachable throw that makes the difference observable.
        execute(node, upstream).then(
          (raw) => {
            const outcome = withHold(raw)
            leave()
            untrack()
            // The slot is free now; the dependents wait for what the
            // outcome still owes (a save landing), if anything.
            const settled = options.settledOf?.(outcome)
            if (settled === undefined) {
              finishOne(id, outcome)
              tick()
              return
            }
            tick()
            // What the save cost rides the outcome it settles.
            const done = (owed?: Partial<TaskOutcome> | void): void => {
              finishOne(id, owed ? { ...outcome, ...owed } : outcome)
              tick()
            }
            void settled.then(done, () => done())
          },
          (err: unknown) => {
            if (err instanceof RestoreDemoted) {
              leave()
              untrack()
              demoted.add(id)
              idleBelow(id, (p) => {
                idle.delete(p)
                if (dormant.delete(p)) {
                  execReady.push(p)
                  readyAt.set(p, Date.now())
                }
              })
              if (pending.get(id) === 0) {
                execReady.push(id)
                readyAt.set(id, Date.now())
              }
              tick()
              return
            }
            const message = thrownMessage(err)
            // After the run's stop a rejection is the stop's doing (a probe
            // it killed, C-65): aborted, as any task it kills, and unsaid.
            const stopped = aborted()
            const outcome: TaskOutcome = withHold({
              node,
              status: stopped ? 'aborted' : 'failed',
              exitCode: 1,
              durationMs: 0,
            })
            leave()
            untrack()
            if (stopped) {
              finishOne(id, outcome)
              tick()
              return
            }
            // A UserError is a config/input failure (e.g. a failed
            // `inputs.runtime` command), not a vx bug — report it
            // plainly, never as an "internal error".
            let line: string
            // Out of descriptors is the environment's limit too: a stack
            // naming a file that was fine sent the user after the file.
            if (isUserError(err) || isFsRefusal(err) || isOutOfFds(err)) {
              const text = isUserError(err)
                ? message
                : `${message} — ${isOutOfFds(err) ? OUT_OF_FDS_HINT : fsRefusalHint(err)}`
              // In a task's own output block, in full: that block is read
              // alone, and "as <task> above" named one printed elsewhere or
              // not at all (2026-10-22). On bare stderr the first is above.
              const first = options.onError === undefined ? refusedBy.get(text) : undefined
              if (!refusedBy.has(text)) refusedBy.set(text, id)
              line = `[vx] ${id}: ${first === undefined ? text : `as ${first} above`}\n`
            } else {
              const named = err instanceof Error && err.name !== 'Error' ? `${err.name}: ` : ''
              // A wrapped error's cause is the fact the reader needs (a
              // CorruptArtifactError over an ENOENT is a race, not a bad
              // archive); print it, since the stack is not printed here.
              const cause =
                err instanceof Error && err.cause instanceof Error ? err.cause : undefined
              const because =
                cause === undefined
                  ? ''
                  : ` (cause: ${(cause as NodeJS.ErrnoException).code ?? cause.name}: ${cause.message})`
              line = `[vx] internal error in ${id}: ${named}${message}${because}\n`
            }
            try {
              if (options.onError === undefined) ui.say('error', line)
              else options.onError(node, line, err)
            } catch {
              ui.say('error', line)
            }
            finishOne(id, outcome)
            tick()
          },
        )
      }

      // Repush parked ids with their ORIGINAL seqs, so the next tick's
      // admission pass does not depend on `parked` having been built in
      // ranking order (it is, but see `push`).
      for (const [id, seq] of parked) execReady.push(id, seq)

      // The outcome count alone: a slot is released before its outcome
      // lands (`leave()` precedes `finishOne` in both arms, and a skip
      // takes none), so a task still holding one has no outcome yet, and
      // the lane counters could add nothing — deleting both from this
      // condition survived the whole core suite (item 644).
      if (outcomes.size + settledIdle === nodes.size) {
        resolved = true
        stopListening()
        resolve(outcomes)
      }
    }

    // A held server's answer: the dependants it found go on the restore
    // lane, and the server is idle when they were all of them. One whose
    // deps all settled is already on the exec queue, running, or done:
    // pushed again it ran twice (its server skipped, the exec lane full).
    const answer = (id: string, found: readonly string[]): void => {
      if (resolved || !unanswered.delete(id)) return
      for (const d of found) {
        // In `readyAt`: already queued, released to the exec queue when its
        // server was skipped before this answer. On both lanes it ran twice.
        if (
          promoted.has(d) ||
          outcomes.has(d) ||
          readyAt.has(d) ||
          pending.get(d) === 0 ||
          !inRestoreTier(d)
        )
          continue
        promoted.add(d)
        restoreReady.push(d)
        readyAt.set(d, Date.now())
      }
      if (dependents.get(id)?.every((d) => inRestoreTier(d)) === true) idle.add(id)
      if (heldReady.delete(id)) execReady.push(id)
      tick()
    }
    for (const [id, found] of options.heldServers ?? []) {
      if (unanswered.has(id))
        void found.then(
          (ids) => answer(id, ids),
          () => answer(id, []),
        )
    }
    // A stop reaches the scheduler through a completion, and a held server
    // waiting on the remote has none: the run waited out the remote's answer.
    const signal = options.signal
    if (unanswered.size > 0 && signal !== undefined) {
      const stop = (): void => {
        for (const id of [...unanswered]) answer(id, [])
      }
      signal.addEventListener('abort', stop, { once: true })
      stopListening = () => signal.removeEventListener('abort', stop)
    }

    tick()
  })
}

/**
 * Persistent tasks nobody asked for whose every dependant is a restore-tier
 * hit, or a group nobody asked for that only such dependants stand behind:
 * a group runs nothing, so `env: { dependsOn: ['dev'] }` between the server
 * and its hits booted the server on every warm run. Those groups go in
 * `groups`.
 */
export function idleServers(
  nodes: ReadonlyMap<string, TaskNode>,
  dependents: ReadonlyMap<string, string[]>,
  restoreTier: ReadonlySet<string> | undefined,
  groups?: Set<string>,
): Set<string> {
  const out = new Set<string>()
  if (restoreTier === undefined || restoreTier.size === 0) return out
  const unasked = (n: TaskNode): boolean => !n.requested && n.surfaced !== true
  // Per group: whether only hits stand behind it. Post-order on a stack, as
  // groups nest as deep as the graph.
  const spare = new Map<string, boolean>()
  const spareGroup = (root: string): boolean => {
    const stack = [root]
    while (stack.length > 0) {
      const id = stack[stack.length - 1]!
      if (spare.has(id)) {
        stack.pop()
        continue
      }
      const n = nodes.get(id)
      const ds = dependents.get(id)
      if (n === undefined || !isGroupTask(n) || !unasked(n) || ds === undefined) {
        spare.set(id, false)
        stack.pop()
        continue
      }
      const next = ds.find((d) => !restoreTier.has(d) && !spare.has(d))
      if (next !== undefined) {
        stack.push(next)
        continue
      }
      stack.pop()
      spare.set(
        id,
        ds.every((d) => restoreTier.has(d) || spare.get(d) === true),
      )
    }
    return spare.get(root)!
  }
  for (const n of nodes.values()) {
    if (n.config.exec?.persistent === undefined || !unasked(n)) continue
    const ds = dependents.get(n.id)
    if (ds === undefined || !ds.every((d) => restoreTier.has(d) || spareGroup(d))) continue
    out.add(n.id)
    if (groups === undefined) continue
    const stack = ds.filter((d) => !restoreTier.has(d))
    while (stack.length > 0) {
      const g = stack.pop()!
      if (groups.has(g)) continue
      groups.add(g)
      for (const d of dependents.get(g)!) if (!restoreTier.has(d)) stack.push(d)
    }
  }
  return out
}
