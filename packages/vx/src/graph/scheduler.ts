import {
  fsRefusalHint,
  isFsRefusal,
  isOutOfFds,
  isUserError,
  OUT_OF_FDS_HINT,
  thrownMessage,
} from '../util/index.js'
import * as ui from '../ui/index.js'
import {
  computeReverseDepCount,
  mergePriorities,
  strategyPriorities,
  tieredReverseDepCount,
  type ScheduleStrategy,
} from './priorities.js'
import { isGroupTask } from './folds.js'
import { Lanes } from './lanes.js'
import { ReadyHeap } from './ready-heap.js'
import type { TaskNode } from './task-graph.js'
import {
  KeyFailed,
  markKeyFailed,
  markOutputsFailed,
  OutputsFailed,
  RestoreDemoted,
  RestoreFailed,
  type TaskOutcome,
} from './outcome.js'

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
  onStart?: (node: TaskNode) => void
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
   * The thunk's outcome is the scheduler's: its queue time is set on it,
   * not on a copy (a copy per hit).
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
 * The dead server a dependency stands for: itself, or one a group or a
 * server reaches. A group is a name for its deps, and it finished the
 * moment the server was ready, so a task behind it ran against the dead
 * one; a server stays up on the servers it depends on, so a task behind
 * `web` runs against the `api` under it too. Walked with a stack and a
 * seen set: recursion threw `RangeError` on a deep chain of groups, and
 * re-walked a group each path reached it by.
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
    if (n === undefined || (!isGroupTask(n) && n.config.exec?.persistent === undefined)) continue
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
  return new GraphRun(options).run()
}

/** A ready exec-tier id refused this tick, with its enqueue seq. */
type Parked = Array<[string, number]>

/** One `runGraph` call: the graph's state as it runs, and the steps that move it. */
class GraphRun {
  private readonly nodes: Map<string, TaskNode>
  private readonly continueMode: ContinueMode
  // 'never': set on the first failed outcome; from then on every
  // dequeued task is skipped instead of dispatched (in-flight tasks
  // finish naturally and their dependents drain through the same path).
  private failFastTripped = false
  private readonly outcomes = new Map<string, TaskOutcome>()
  // Reverse adjacency + pending dep counts. Built once. A task becomes
  // ready when its `pending` hits 0, at which point it's pushed to the
  // ready queue. This replaces the old "scan all of scheduleOrder on
  // every tick" pattern which was O(N²) over a full run.
  private readonly dependents = new Map<string, string[]>()
  private readonly pending = new Map<string, number>()
  private readonly baseline: ReadonlyMap<string, number>
  private readonly restoreTier: ReadonlySet<string> | undefined
  // Restore-tier tasks whose execute threw `RestoreDemoted`: from then on
  // they are exec-tier tasks, gated on their deps like any other.
  private readonly demoted = new Set<string>()
  // A server pulled in only for restore-tier hits serves nobody: it waits
  // (`dormant`) until a dependant is demoted, which starts it, or until
  // every dependant has finished, which settles it unspawned. Settled
  // without an outcome: it is not part of the run, as a pruned task is not.
  // A group or a server between it and its hits is idle with it.
  private readonly idleGroups = new Set<string>()
  private readonly idle: Set<string>
  private readonly dormant = new Set<string>()
  // Held servers not yet answered, and those of them that became ready.
  private readonly unanswered: Set<string>
  private readonly heldReady = new Set<string>()
  private settledIdle = 0
  // Two ready queues — exec-tier (cache misses + unstable tasks) and
  // restore-tier (confirmed stable local hits). Each is a max-heap keyed by
  // (priority DESC, enqueue-seq ASC), so the highest-priority task pops first
  // and equal-priority ties break in graph-insertion order — same contract the
  // prior `scheduleOrder` sort provided via stable sort. The tick loop drains
  // execReady FIRST, so misses own the worker pool and restores only backfill
  // idle capacity (or run when an exec is blocked on a restorable dep and
  // nothing else is runnable).
  private readonly execReady: ReadyHeap
  private readonly restoreReady: ReadyHeap
  // When each queued id became ready; dispatch takes it out.
  private readonly readyAt = new Map<string, number>()
  private readonly promoted = new Set<string>()
  private readonly lanes: Lanes
  private resolved = false
  private resolve: (outcomes: Map<string, TaskOutcome>) => void = () => {}
  private stopListening = (): void => {}
  // A refusal's text → the first task that said it. A corrupt cache index
  // reaches every lookup as one UserError; on bare stderr a repeat names the first.
  private readonly refusedBy = new Map<string, string>()
  // Admission policy over the count limit (a plugin's `admit`). Inactive
  // → the tick loop short-circuits before any of this and behaves
  // byte-identically to the count-only scheduler.
  private readonly admitActive: boolean
  private readonly running = new Set<string>()
  // When a policy first refused each parked task — so its outcome can say
  // how long the policy, not the count gate, held it. Nothing with no
  // policy: the map is never touched.
  private readonly heldSince = new Map<string, number>()
  // A restore-tier task whose deps did not all succeed is still a
  // `cache-hit` (its key is theirs, not their outcome), but it passes the
  // block down: its dependents are skipped as a failed dep's would be.
  // Its root: a failed or aborted dep, or the root a skipped or blocked
  // one carries.
  private readonly blockedRestores = new Map<string, string | undefined>()
  private readonly heldRelease = new Set<string>()
  private readonly serverDied: (id: string) => boolean
  private readonly servers: string[]
  private readonly deadServerVia: (id: string) => string | undefined

  constructor(private readonly options: ScheduleOptions) {
    const nodes = options.nodes
    this.nodes = nodes
    this.continueMode = options.continueMode ?? 'deps-ok'
    for (const node of nodes.values()) {
      this.pending.set(node.id, node.deps.length)
      for (const dep of node.deps) {
        const list = this.dependents.get(dep)
        if (list) list.push(node.id)
        else this.dependents.set(dep, [node.id])
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
    this.baseline = baseline
    const priority: (id: string) => number = options.priorities
      ? mergePriorities(baseline, options.priorities)
      : (id) => baseline.get(id) ?? 0

    this.restoreTier = options.restoreTier
    this.idle = idleServers(nodes, this.dependents, this.restoreTier, this.idleGroups)
    for (const g of this.idleGroups) this.idle.add(g)
    this.unanswered = new Set(options.heldServers?.keys() ?? [])
    for (const id of this.idle) this.unanswered.delete(id)
    // Counting those no pool takes: with every pool full, only one of them can start.
    this.execReady = new ReadyHeap(
      priority,
      options.poolOf === undefined ? undefined : (id) => options.poolOf!(id) === undefined,
    )
    this.restoreReady = new ReadyHeap(priority)
    options.reprioritize?.((weights) => {
      const merged = mergePriorities(baseline, weights)
      this.execReady.reprioritize(merged)
      this.restoreReady.reprioritize(merged)
    })
    // A restore-tier task is dep-independent (a stable hit's restore needs
    // none of its deps' output), so it's ready immediately; its `pending`
    // decrements still happen (in finishOne) but never re-enqueue it.
    // Everything else enqueues on the exec-tier the moment its deps
    // complete.
    // Elapsed-time stamps (queue and hold waits), immune to wall clock steps.
    const startedAt = performance.now()
    for (const node of nodes.values()) {
      if (this.restoreTier?.has(node.id)) this.restoreReady.push(node.id)
      else if (node.deps.length === 0) this.execReady.push(node.id)
      else continue
      this.readyAt.set(node.id, startedAt)
    }

    // A restore-tier task is a confirmed local cache hit: its "execution"
    // is a cheap tar extract, not the task's real work — it reserves ZERO
    // regardless of what the config declares, so it never holds budget
    // against a real executor (and never parks).
    this.lanes = new Lanes(
      options.concurrency,
      options.restoreConcurrency,
      options.poolOf,
      nodes.keys(),
    )
    this.admitActive = options.admit !== undefined

    this.serverDied = options.serverDied ?? ((): boolean => false)
    this.servers =
      options.serverDied === undefined
        ? []
        : [...nodes.values()]
            .filter((n) => n.config.exec?.persistent !== undefined)
            .map((n) => n.id)
    // Only a server can die: with none in the graph, no walk (a stack and
    // a set per dependency of every exec-tier task, X-171).
    this.deadServerVia =
      this.servers.length === 0
        ? (): undefined => undefined
        : (id: string): string | undefined => deadServerBehind(nodes, this.serverDied, id)
  }

  run(): Promise<Map<string, TaskOutcome>> {
    return new Promise<Map<string, TaskOutcome>>((resolve) => {
      this.resolve = resolve
      for (const [id, found] of this.options.heldServers ?? []) {
        if (this.unanswered.has(id))
          void found.then(
            (ids) => this.answer(id, ids),
            () => this.answer(id, []),
          )
      }
      // A stop reaches the scheduler through a completion, and a held server
      // waiting on the remote has none: the run waited out the remote's answer.
      const signal = this.options.signal
      if (this.unanswered.size > 0 && signal !== undefined) {
        const stop = (): void => {
          for (const id of [...this.unanswered]) this.answer(id, [])
        }
        signal.addEventListener('abort', stop, { once: true })
        this.stopListening = () => signal.removeEventListener('abort', stop)
      }
      this.tick()
    })
  }

  private tripFailFast(): void {
    if (this.failFastTripped) return
    this.failFastTripped = true
    this.options.onFailFast?.()
  }

  private inRestoreTier(id: string): boolean {
    return this.restoreTier?.has(id) === true && !this.demoted.has(id)
  }

  private aborted(): boolean {
    return this.options.signal?.aborted === true
  }

  // The idle tasks below `id`, through idle groups: those its outcome may
  // let settle, and those its demotion wakes.
  private idleBelow(id: string, each: (p: string) => void): void {
    const stack = [...(this.nodes.get(id) as TaskNode).deps]
    const seen = new Set<string>()
    while (stack.length > 0) {
      const p = stack.pop()!
      if (seen.has(p) || !this.idle.has(p)) continue
      seen.add(p)
      each(p)
      if (this.idleGroups.has(p)) stack.push(...(this.nodes.get(p) as TaskNode).deps)
    }
  }

  // Every task above an idle one, through idle groups, has finished.
  private settledAbove(id: string): boolean {
    const stack = [id]
    const seen = new Set<string>()
    while (stack.length > 0) {
      for (const d of this.dependents.get(stack.pop()!) ?? []) {
        if (this.outcomes.has(d)) continue
        if (!this.idleGroups.has(d) || !this.idle.has(d)) return false
        if (!seen.has(d)) {
          seen.add(d)
          stack.push(d)
        }
      }
    }
    return true
  }

  // The policy sees exec-tier local tasks only; a restore is a tar
  // extract, a pooled task runs on someone else's capacity, and a group
  // runs nothing, so a packing policy that counted one parked work for it.
  private local(id: string): boolean {
    return (
      !this.inRestoreTier(id) &&
      this.options.poolOf?.(id) === undefined &&
      !isGroupTask(this.nodes.get(id) as TaskNode)
    )
  }

  private admits(id: string): boolean {
    return !this.local(id) || this.options.admit!(id, this.running)
  }

  // With no policy nothing reads `running`, so nothing is tracked: the
  // count-only dispatch allocates no closure and touches no set per task.
  private track(id: string): () => void {
    if (!this.admitActive || !this.local(id)) return untracked
    this.running.add(id)
    return () => {
      this.running.delete(id)
    }
  }

  private finishOne(id: string, outcome: TaskOutcome): void {
    if (this.continueMode === 'never' && outcome.status === 'failed') this.tripFailFast()
    this.outcomes.set(id, outcome)
    // A dormant server is asked again: the dispatch settles it once its
    // last dependant is in.
    if (this.dormant.size > 0) {
      this.idleBelow(id, (p) => {
        if (this.dormant.delete(p)) this.execReady.push(p)
      })
    }
    // Observer hook (the logger's taskComplete). Crash-isolated: a
    // throwing observer must NOT break scheduling — it would otherwise
    // skip the dependent-enqueue + tick below and hang the run. Same
    // "observability never breaks a run" rule the telemetry
    // paths hold. Isolated here (not the completion arm) so a throw
    // can't be mistaken for the task itself failing.
    try {
      this.options.onFinish?.(outcome)
    } catch (err) {
      const m = thrownMessage(err)
      ui.say('warn', `[vx] onFinish observer threw for ${id}: ${m}\n`)
    }
    // A restore-tier task runs before its deps, but its DEPENDENTS keep
    // the order `dependsOn` states: they are released once its own deps
    // have settled too. Released at its own finish, an `e2e` ran beside
    // the `db:migrate` two edges up whenever the middle task was a hit,
    // and ran green after that dep failed.
    if (this.inRestoreTier(id) && (this.pending.get(id) ?? 0) > 0) {
      this.heldRelease.add(id)
      return
    }
    this.release(id)
  }

  private blockOf(id: string): void {
    if (!this.inRestoreTier(id)) return
    for (const dep of (this.nodes.get(id) as TaskNode).deps) {
      const u = this.outcomes.get(dep)
      if (this.continueMode !== 'always' && (u?.status === 'failed' || u?.status === 'aborted')) {
        this.blockedRestores.set(id, dep)
        break
      }
      if (u?.status === 'skipped') {
        this.blockedRestores.set(
          id,
          u.blockedBy ?? (u.otherPlatform !== undefined ? dep : undefined),
        )
        break
      }
      if (this.blockedRestores.has(dep)) {
        this.blockedRestores.set(id, this.blockedRestores.get(dep))
        break
      }
    }
  }

  // Its block, then its dependents: one whose pending hits 0 is enqueued,
  // or, when it is a held hit, released in turn before the next sibling.
  // A frame stack, not recursion: a chain of held hits is released in one
  // walk, and recursion threw RangeError on a 30,000-deep one.
  private release(root: string): void {
    const frames: { ds: readonly string[]; i: number }[] = []
    const enter = (id: string): void => {
      this.blockOf(id)
      const ds = this.dependents.get(id)
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
      const rem = (this.pending.get(d) ?? 0) - 1
      this.pending.set(d, rem)
      if (rem !== 0) continue
      // Restore-tier dependents were already enqueued at startup (they
      // don't wait on deps); one that finished early releases its own
      // dependents now. Only an exec-tier dependent is enqueued.
      if (this.heldRelease.delete(d)) enter(d)
      else if (!this.inRestoreTier(d)) {
        this.execReady.push(d)
        this.readyAt.set(d, performance.now())
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
  private willSkip(id: string): boolean {
    if (this.failFastTripped || this.aborted()) return true
    if (this.continueMode === 'never' && this.servers.some(this.serverDied)) {
      this.tripFailFast()
      return true
    }
    if (this.inRestoreTier(id)) return false
    const node = this.nodes.get(id) as TaskNode
    // `always` runs past a failed upstream, never past one that did not
    // run on this platform: under it, a skip has no other cause.
    if (this.continueMode === 'always')
      return node.deps.some(
        (d) => this.outcomes.get(d)?.status === 'skipped' || this.blockedRestores.has(d),
      )
    return node.deps.some((d) => {
      const u = this.outcomes.get(d)
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
        this.blockedRestores.has(d) ||
        this.deadServerVia(d) !== undefined
      )
    })
  }

  // A throw falls back to the dispatch, whose `execute` reports it.
  private settleInPlace(node: TaskNode, upstream: TaskOutcome[]): (() => TaskOutcome) | undefined {
    if (this.options.settleNow === undefined) return undefined
    try {
      return this.options.settleNow(node, upstream)
    } catch {
      return undefined
    }
  }

  private started(node: TaskNode): void {
    try {
      this.options.onStart?.(node)
    } catch (err) {
      const m = thrownMessage(err)
      ui.say('warn', `[vx] onStart observer threw for ${node.id}: ${m}\n`)
    }
  }

  private tick(): void {
    if (this.resolved) return
    // Exec-tier tasks parked THIS tick on a refused admission. Within
    // one synchronous tick `running` only grows (tasks leave it in the
    // async completion callbacks, which run a fresh tick), so a task
    // refused now cannot be admitted later in the same tick — parking
    // it for the tick's remainder is exact, and each id pops at most
    // once per tick (O(R log R)).
    const parked: Parked = []
    for (;;) {
      const id = this.takeFitting(parked)
      if (id === undefined) break // nothing ready is admissible right now
      this.dispatch(id)
    }

    // Repush parked ids with their ORIGINAL seqs, so the next tick's
    // admission pass does not depend on `parked` having been built in
    // ranking order (it is, but see `push`).
    for (const [id, seq] of parked) this.execReady.push(id, seq)

    // The outcome count alone: a slot is released before its outcome
    // lands (`leave()` precedes `finishOne` in both arms, and a skip
    // takes none), so a task still holding one has no outcome yet, and
    // the lane counters could add nothing — deleting both from this
    // condition survived the whole core suite.
    if (this.outcomes.size + this.settledIdle === this.nodes.size) {
      this.resolved = true
      this.stopListening()
      this.resolve(this.outcomes)
    }
  }

  // Highest-priority admissible task: exec tier first (misses own
  // the pool), then restore tier. With no admission policy this
  // short-circuits to exactly the legacy takeReady. A would-skip
  // task returns without asking (finishing it is free); restore
  // tasks are never asked, so they never park.
  private takeFitting(parked: Parked): string | undefined {
    const lanes = this.lanes
    if (lanes.holding) return undefined
    // No pools and a full exec lane: nothing on the exec queue can be
    // admitted, so it is not scanned — an admit policy only narrows
    // the count gate, never widens it (scanning under one cost the
    // history plugin's cold bench run 10 s) — scanning it
    // would pop and re-park every ready exec task on every tick, and
    // with a wide frontier that is O(R) per tick, O(R²) per run (the
    // 6,000-task scale pin went 0.5 s → 28 s when the restore lane's
    // first cut let the scan run past a full exec lane).
    // This is the legacy O(1) gate, kept per lane. Every pool full is
    // the same: a remote pool of 6 slots before 2000 ready tasks
    // re-popped them all on each end (DTE).
    const execAdmissible =
      this.options.poolOf === undefined
        ? lanes.execRoom()
        : (lanes.execRoom() && this.execReady.counted > 0) || lanes.poolRoom()
    if (execAdmissible) {
      const execReady = this.execReady
      while (execReady.size > 0) {
        const seq = execReady.peekSeq()
        const id = execReady.pop() as string
        if (this.unanswered.has(id) && !this.willSkip(id)) {
          this.heldReady.add(id)
          continue
        }
        if (this.willSkip(id) || this.idle.has(id)) return id
        if (this.options.exclusive?.has(id) === true) {
          if (!lanes.busy() && (!this.admitActive || this.admits(id))) return id
          parked.push([id, seq])
          return undefined
        }
        if (lanes.hasRoom(id, this.inRestoreTier(id))) {
          if (!this.admitActive || this.admits(id)) return id
          // A free worker, refused by the policy: the hold starts now.
          if (!this.heldSince.has(id)) this.heldSince.set(id, performance.now())
        }
        parked.push([id, seq])
      }
    }
    // Restore-tier tasks are local disk work, on their own lane.
    return lanes.restoreRoom() ? this.restoreReady.pop() : undefined
  }

  private dispatch(id: string): void {
    const node = this.nodes.get(id) as TaskNode

    // For a restore-tier task running BEFORE its deps finish, the
    // `upstream` entries below can be undefined (the cast lies) —
    // the preProbed hit path in execute-task never reads them, and
    // nothing on the restore path may.
    const upstream = node.deps.map((d) => this.outcomes.get(d) as TaskOutcome)

    const settlesIdle = this.settlesIdle(id, node)

    // If any upstream failed/skipped, propagate skip synchronously
    // without running. Skipped tasks still flow through this queue
    // because dependents are pushed when `pending` hits 0 regardless
    // of outcome — keeps the propagation logic in one place.
    if (!settlesIdle && this.willSkip(id)) {
      this.skip(id, node, upstream)
      return
    }
    if (settlesIdle) {
      this.readyAt.delete(id)
      if (this.settledAbove(id)) {
        this.settledIdle++
        this.release(id)
      } else this.dormant.add(id)
      return
    }
    this.start(id, node, upstream)
  }

  // An idle task the stop or fail-fast would skip settles with no
  // outcome, as it would have run: the run never meant to start it.
  // Below a failed dep it is skipped as before, so the hits above it
  // pass the block down.
  private settlesIdle(id: string, node: TaskNode): boolean {
    return (
      this.idle.has(id) &&
      (!this.willSkip(id) ||
        this.aborted() ||
        (this.failFastTripped &&
          !node.deps.some((d) => {
            const s = this.outcomes.get(d)?.status
            return (
              s === 'failed' || s === 'skipped' || s === 'aborted' || this.blockedRestores.has(d)
            )
          })))
    )
  }

  private skip(id: string, node: TaskNode, upstream: TaskOutcome[]): void {
    // The root of the block: a failed or aborted upstream names
    // itself; a skipped one hands down its own root.
    const blocker =
      this.continueMode === 'always'
        ? undefined
        : upstream.find((u) => u !== undefined && (u.status === 'failed' || u.status === 'aborted'))
    const viaSkip = upstream.find((u) => u !== undefined && u.status === 'skipped')
    const viaRestore = node.deps.find((d) => this.blockedRestores.has(d))
    const blockedBy =
      blocker?.node.id ??
      node.deps.map(this.deadServerVia).find((d) => d !== undefined) ??
      viaSkip?.blockedBy ??
      (viaSkip?.otherPlatform !== undefined ? viaSkip.node.id : undefined) ??
      (viaRestore === undefined ? undefined : this.blockedRestores.get(viaRestore))
    const aborted = this.aborted()
    // Behind a platform skip is no failure: the run passes, so the exit does.
    const notHere =
      !aborted &&
      blockedBy !== undefined &&
      this.outcomes.get(blockedBy)?.otherPlatform !== undefined
    this.finishOne(id, {
      node,
      status: aborted ? 'aborted' : 'skipped',
      exitCode: notHere ? 0 : 1,
      durationMs: 0,
      ...(blockedBy !== undefined ? { blockedBy } : {}),
    })
  }

  private start(id: string, node: TaskNode, upstream: TaskOutcome[]): void {
    const readySince = this.readyAt.get(id)
    const queuedMs = readySince === undefined ? 0 : Math.round(performance.now() - readySince)
    this.readyAt.delete(id)
    const settle = this.settleInPlace(node, upstream)
    let now: TaskOutcome | undefined
    if (settle !== undefined) {
      if (!this.demoted.has(id)) this.started(node)
      try {
        now = settle()
      } catch {
        // Dispatched below, already started: `execute` reports it.
      }
    }
    if (now !== undefined) {
      if (queuedMs !== 0) now.queuedMs = queuedMs
      this.finishOne(id, now)
      return
    }
    const leave = this.lanes.take(
      id,
      this.options.exclusive?.has(id) === true,
      this.inRestoreTier(id),
    )
    // Listed as running on dispatch, so the policy's next ask in this
    // tick sees it; the completion callbacks unlist it.
    const untrack = this.track(id)
    const since = this.admitActive ? this.heldSince.get(id) : undefined
    const heldMs = since === undefined ? 0 : Math.max(1, Math.round(performance.now() - since))
    if (since !== undefined) this.heldSince.delete(id)
    const withHold = (o: TaskOutcome): TaskOutcome =>
      heldMs === 0 && queuedMs === 0
        ? o
        : {
            ...o,
            ...(heldMs > 0 ? { admissionHeldMs: heldMs } : {}),
            ...(queuedMs > 0 ? { queuedMs } : {}),
          }
    const free = (): void => {
      leave()
      untrack()
    }
    // Crash-isolated observer hook — a throwing onStart must not abort
    // the dispatch loop (it would strand the tick with the slot held).
    // A demoted task's second dispatch is the same task, already started,
    // as is one whose settle threw.
    if (!this.demoted.has(id) && settle === undefined) this.started(node)

    // `.then(onFulfilled, onRejected)` — NOT `.then(f).catch(g)`. The
    // rejection arm handles ONLY `execute()` rejecting; a throw from
    // the fulfillment arm must NOT also run the rejection arm, or
    // `active` releases twice — and a double release wedges the count
    // gate. NOT `onFinish`, which this comment used to cite: it is
    // isolated inside `finishOne`, so it never reaches here (which is
    // why the row named for it cannot tell the two shapes apart).
    // What is left unisolated is the caller's
    // `settledOf`, and under THIS shape a throw there strands the
    // task's outcome and hangs the run rather than double-releasing.
    // The two-arm form is still the correct choice; there is simply
    // no reachable throw that makes the difference observable.
    this.options.execute(node, upstream).then(
      (raw) => this.executed(id, withHold(raw), free),
      (thrown: unknown) => this.rejected(id, node, thrown, withHold, free),
    )
  }

  private executed(id: string, outcome: TaskOutcome, free: () => void): void {
    free()
    // The slot is free now; the dependents wait for what the
    // outcome still owes (a save landing), if anything.
    const settled = this.options.settledOf?.(outcome)
    if (settled === undefined) {
      this.finishOne(id, outcome)
      this.tick()
      return
    }
    this.tick()
    // What the save cost rides the outcome it settles.
    const done = (owed?: Partial<TaskOutcome> | void): void => {
      this.finishOne(id, owed ? { ...outcome, ...owed } : outcome)
      this.tick()
    }
    void settled.then(done, () => done())
  }

  private rejected(
    id: string,
    node: TaskNode,
    thrown: unknown,
    withHold: (o: TaskOutcome) => TaskOutcome,
    free: () => void,
  ): void {
    if (thrown instanceof RestoreDemoted) {
      free()
      this.demote(id)
      this.tick()
      return
    }
    const err =
      thrown instanceof RestoreFailed ||
      thrown instanceof KeyFailed ||
      thrown instanceof OutputsFailed
        ? thrown.error
        : thrown
    // After the run's stop a rejection is the stop's doing (a probe
    // it killed, C-65): aborted, as any task it kills, and unsaid.
    const stopped = this.aborted()
    const outcome: TaskOutcome = withHold({
      node,
      status: stopped ? 'aborted' : 'failed',
      exitCode: thrown instanceof OutputsFailed ? thrown.exitCode : 1,
      durationMs: thrown instanceof OutputsFailed ? thrown.durationMs : 0,
      ...(thrown instanceof RestoreFailed && !stopped ? { restoreFailed: true } : {}),
    })
    if (thrown instanceof KeyFailed && !stopped) markKeyFailed(outcome)
    if (thrown instanceof OutputsFailed && !stopped) markOutputsFailed(outcome, thrown.step)
    free()
    if (!stopped) this.report(id, node, thrown, err)
    this.finishOne(id, outcome)
    this.tick()
  }

  private demote(id: string): void {
    this.demoted.add(id)
    this.idleBelow(id, (p) => {
      this.idle.delete(p)
      if (this.dormant.delete(p)) {
        this.execReady.push(p)
        this.readyAt.set(p, performance.now())
      }
    })
    if (this.pending.get(id) === 0) {
      this.execReady.push(id)
      this.readyAt.set(id, performance.now())
    }
  }

  // The line naming a rejected `execute`, to `onError` or stderr.
  private report(id: string, node: TaskNode, thrown: unknown, err: unknown): void {
    const message = thrownMessage(err)
    // A UserError is a config/input failure (e.g. a failed
    // `inputs.runtime` command), not a vx bug — report it
    // plainly, never as an "internal error".
    let line: string
    // Out of descriptors is the environment's limit too: a stack
    // naming a file that was fine sent the user after the file.
    if (isUserError(err) || isFsRefusal(err) || isOutOfFds(err)) {
      const said = isUserError(err)
        ? message
        : `${message} — ${isOutOfFds(err) ? OUT_OF_FDS_HINT : fsRefusalHint(err)}`
      const text = thrown instanceof KeyFailed ? `cache key not derived: ${said}` : said
      // In a task's own output block, in full: that block is read
      // alone, and "as <task> above" named one printed elsewhere or
      // not at all. On bare stderr the first is above.
      const first = this.options.onError === undefined ? this.refusedBy.get(text) : undefined
      if (!this.refusedBy.has(text)) this.refusedBy.set(text, id)
      line = `[vx] ${id}: ${first === undefined ? text : `as ${first} above`}\n`
    } else line = internalErrorLine(id, err, message)
    try {
      if (this.options.onError === undefined) ui.say('error', line)
      else this.options.onError(node, line, err)
    } catch {
      ui.say('error', line)
    }
  }

  // A held server's answer: the dependants it found go on the restore
  // lane, and the server is idle when they were all of them. One whose
  // deps all settled is already on the exec queue, running, or done:
  // pushed again it ran twice (its server skipped, the exec lane full).
  private answer(id: string, found: readonly string[]): void {
    if (this.resolved || !this.unanswered.delete(id)) return
    for (const d of found) {
      // In `readyAt`: already queued, released to the exec queue when its
      // server was skipped before this answer. On both lanes it ran twice.
      if (
        this.promoted.has(d) ||
        this.outcomes.has(d) ||
        this.readyAt.has(d) ||
        this.pending.get(d) === 0 ||
        !this.inRestoreTier(d)
      )
        continue
      this.promoted.add(d)
      this.restoreReady.push(d)
      this.readyAt.set(d, performance.now())
    }
    if (found.length > 0) this.idleWith(id)
    if (this.heldReady.delete(id)) this.execReady.push(id)
    this.tick()
  }

  // Idle as `idleServers` finds it: through the groups and servers
  // nobody asked for above it. The servers beneath it are held on the
  // same keys, so the walk idles them with it; a server already
  // answered, or never held, keeps its course.
  private idleWith(id: string): void {
    const tier =
      this.demoted.size === 0
        ? this.restoreTier
        : new Set([...this.restoreTier!].filter((t) => this.inRestoreTier(t)))
    const between = new Set<string>()
    const holdsHere = (s: string): boolean =>
      s === id || this.unanswered.has(s) || isGroupTask(this.nodes.get(s) as TaskNode)
    for (const s of idleServers(this.nodes, this.dependents, tier, between))
      if (holdsHere(s)) this.idle.add(s)
    for (const g of between)
      if (holdsHere(g) && !this.idleGroups.has(g)) {
        this.idleGroups.add(g)
        this.idle.add(g)
      }
  }
}

const untracked = (): void => {}

// The line for a rejection that is not the user's or the machine's: a vx bug.
function internalErrorLine(id: string, err: unknown, message: string): string {
  const named = err instanceof Error && err.name !== 'Error' ? `${err.name}: ` : ''
  // A wrapped error's cause is the fact the reader needs (a
  // CorruptArtifactError over an ENOENT is a race, not a bad
  // archive); print it, since the stack is not printed here.
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : undefined
  const because =
    cause === undefined
      ? ''
      : ` (cause: ${(cause as NodeJS.ErrnoException).code ?? cause.name}: ${cause.message})`
  return `[vx] internal error in ${id}: ${named}${message}${because}\n`
}

/**
 * Persistent tasks nobody asked for whose every dependant is a restore-tier
 * hit, or a group or server nobody asked for that only such dependants
 * stand behind: a group runs nothing, so `env: { dependsOn: ['dev'] }`
 * between the server and its hits booted the server on every warm run, and
 * `api` under an idle `web` serves nobody either. Those groups and servers
 * go in `groups`: the scheduler settles them as it settles a group.
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
  // Per group or server: whether only hits stand behind it. Post-order on a
  // stack, as groups and servers nest as deep as the graph.
  const spare = new Map<string, boolean>()
  const spareNode = (root: string): boolean => {
    const stack = [root]
    while (stack.length > 0) {
      const id = stack[stack.length - 1]!
      if (spare.has(id)) {
        stack.pop()
        continue
      }
      const n = nodes.get(id)
      const ds = dependents.get(id)
      if (
        n === undefined ||
        (!isGroupTask(n) && n.config.exec?.persistent === undefined) ||
        !unasked(n) ||
        ds === undefined
      ) {
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
    if (ds === undefined || !ds.every((d) => restoreTier.has(d) || spareNode(d))) continue
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
