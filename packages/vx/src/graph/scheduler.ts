import {
  fsRefusalHint,
  isFsRefusal,
  isOutOfFds,
  isUserError,
  notify,
  OUT_OF_FDS_HINT,
  thrownMessage,
} from '../util/index.js'
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
   * Failure propagation:
   * - 'deps-ok' (default): a failed, skipped or aborted upstream skips its
   *   dependents; independent siblings keep running.
   * - 'never': the first failure stops dispatch; in-flight tasks finish but
   *   start no retry, and the rest (restore tier too) completes skipped.
   * - 'always': dependents run anyway. Their keys are a healthy run's (a failed
   *   outcome carries the upstream's input key), so their save is withheld:
   *   bytes built on a partial tree would be the next clean run's stale hit
   *   (`ExecuteArgs.taintedUpstream`).
   */
  continueMode?: ContinueMode
  /**
   * A persistent task that died after it became ready: its outcome said
   * `success`, so this is how a dependant not yet started learns of it.
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
   * A cache save still owed before dependents may start: a dependent reads the
   * upstream's entry, so it waits for the save, while the freed slot admits
   * other work. Resolves to the outcome with the save folded in.
   */
  settledOf?: (outcome: TaskOutcome) => Promise<TaskOutcome | void> | undefined
  /**
   * A task the caller settles in place: a thunk returning its outcome, or
   * undefined to dispatch it through `execute`. Its outcome lands in the same
   * tick and holds no slot: the dispatch and promise cost ~10 µs per group or
   * current hit on a warm run. A restore-tier task's `upstream` may hold
   * undefined entries. The queue time is set on the thunk's outcome itself, not
   * a copy.
   */
  settleNow?: (node: TaskNode, upstream: TaskOutcome[]) => (() => TaskOutcome) | undefined
  /**
   * Optional per-node weights (e.g. `computePredictedPriorities`); the
   * highest-weight ready task runs next. Undefined: the reverse-deps-count
   * heuristic.
   */
  priorities?: ReadonlyMap<string, number>
  /**
   * Called once as the run starts with a function that replaces
   * `priorities`: the ready queues re-rank at once, over the same baseline.
   * A `schedule` plugin's later, better weights land through it.
   */
  reprioritize?: (apply: (priorities: ReadonlyMap<string, number>) => void) => void
  /**
   * The baseline ranking under `priorities` (`schedule` in.vx/workspace.ts).
   * Undefined or `most-work` is the reverse-deps count above.
   */
  strategy?: ScheduleStrategy
  /**
   * The `most-work` baseline already counted (`computeReverseDepCount`, read
   * back with the graph): asked only when that baseline is the one used.
   */
  reverseDeps?: () => ReadonlyMap<string, number>
  /**
   * Restore-tier task ids: confirmed stable local cache hits. A restore-tier
   * task:
   * - is ready at once, since its restore needs none of its deps' output;
   * - is low priority: exec-tier work owns the pool, restores backfill idle
   *   capacity;
   * - bypasses the failed-dep skip, since its key does not depend on dep
   *   success;
   * - leaves the tier when `execute` throws `RestoreDemoted`, and is dispatched
   *   again once its deps are done. A persistent task nobody requested whose
   *   every dependant is in the tier starts only when one is demoted, and
   *   settles unspawned once all have finished.
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
   * Pool assignment for tasks on an executor with its own capacity (a remote
   * pool): such a task takes one of the pool's slots, not a local one, so a
   * remote pool is never throttled by the local CPU count. Undefined: the local
   * pool.
   */
  poolOf?: (id: string) => { name: string; capacity: number } | undefined
  /**
   * Admission over the worker count: asked for every exec-tier task about to
   * start here, with the ids of exec-tier tasks running here (added on
   * dispatch, so two asks in one tick see each other). `false` parks the task
   * until something finishes. Restore-tier hits, pooled tasks and groups hold
   * no local resources and are never asked.
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
 * The dead server a dependency stands for: itself, or one a group or a server
 * reaches (a task behind `web` runs against the `api` under it too). A stack
 * and seen set: recursion overflowed on deep group chains and re-walked shared
 * groups.
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
 * Run the task graph, up to `concurrency` tasks at once. A failed task skips
 * its dependents; unrelated tasks keep running.
 *
 * When several are ready, the one blocking the most downstream work goes first;
 * ties break in graph-insertion (topo) order.
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
  // 'never': set on the first failure; every dequeued task is then skipped.
  private failFastTripped = false
  private readonly outcomes = new Map<string, TaskOutcome>()
  // Reverse adjacency and pending dep counts, built once: a task is ready when
  // its `pending` hits 0, so no tick scans the whole order.
  private readonly dependents = new Map<string, string[]>()
  private readonly pending = new Map<string, number>()
  private readonly baseline: ReadonlyMap<string, number>
  private readonly restoreTier: ReadonlySet<string> | undefined
  // Restore-tier tasks whose execute threw `RestoreDemoted`: from then on
  // they are exec-tier tasks, gated on their deps like any other.
  private readonly demoted = new Set<string>()
  // A server pulled in only for restore-tier hits serves nobody: it stays
  // `dormant` until a dependant is demoted (it starts) or every dependant has
  // finished (it settles unspawned, outside the run, like a pruned task). A
  // group or server between it and its hits is idle with it.
  private readonly idleGroups = new Set<string>()
  private readonly idle: Set<string>
  private readonly dormant = new Set<string>()
  // Held servers not yet answered, and those of them that became ready.
  private readonly unanswered: Set<string>
  private readonly heldReady = new Set<string>()
  private settledIdle = 0
  // Two ready queues, exec tier (misses, unstable tasks) and restore tier, each
  // a max-heap on (priority desc, enqueue seq asc), so ties keep
  // graph-insertion order. The exec queue drains first.
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
  // Admission policy (a plugin's `admit`). Inactive: the tick loop skips all of
  // this.
  private readonly admitActive: boolean
  private readonly running = new Set<string>()
  // When a policy first refused each parked task, so its outcome can say how
  // long the policy held it.
  private readonly heldSince = new Map<string, number>()
  // A restore-tier task whose deps did not all succeed is still a `cache-hit`,
  // but passes the block down: its dependents are skipped as a failed dep's
  // would be. Its root: a failed or aborted dep, or the root a skipped or
  // blocked one carries.
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

    // Caller weights first; the reverse-deps count covers nodes the caller did
    // not score.
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
    // A restore-tier task is ready at once; its `pending` still decrements but
    // never re-enqueues it. Everything else enqueues on the exec tier once its
    // deps complete. Elapsed-time stamps (queue and hold waits) are immune to
    // wall clock steps.
    const startedAt = performance.now()
    for (const node of nodes.values()) {
      if (this.restoreTier?.has(node.id)) this.restoreReady.push(node.id)
      else if (node.deps.length === 0) this.execReady.push(node.id)
      else continue
      this.readyAt.set(node.id, startedAt)
    }

    // A restore is a tar extract, not the task's work: it reserves nothing,
    // whatever the config declares, so it never holds budget or parks.
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
    // Only a server can die: with none in the graph, no walk (a stack and a set
    // per dependency of every exec-tier task).
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

  // Exec-tier local tasks only: a restore, a pooled task or a group counted by
  // a packing policy would park real work for it.
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
    // Crash-isolated: a throwing observer would skip the dependent enqueue and
    // tick below and hang the run. Isolated here, not in the completion arm, so
    // a throw is never taken for the task failing.
    try {
      this.options.onFinish?.(outcome)
    } catch (err) {
      const m = thrownMessage(err)
      notify({ kind: 'line', tone: 'warn', text: `[vx] onFinish observer threw for ${id}: ${m}\n` })
    }
    // A restore-tier task runs before its deps, but its dependents are released
    // only once its own deps have settled too: otherwise an `e2e` ran beside a
    // `db:migrate` two edges up whenever the middle task was a hit, and ran
    // green after that dep failed.
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

  // Its block, then its dependents: one whose pending hits 0 is enqueued, or,
  // if a held hit, released in turn. A frame stack, not recursion: a
  // 30,000-deep chain of held hits overflowed.
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
      // Restore-tier dependents were enqueued at startup; one that finished
      // early releases its own dependents now.
      if (this.heldRelease.delete(d)) enter(d)
      else if (!this.inRestoreTier(d)) {
        this.execReady.push(d)
        this.readyAt.set(d, performance.now())
      }
    }
  }

  // True when the task would finish `skipped` without running (fail-fast
  // tripped, or a failed upstream unless `continueMode` is 'always'). Shared by
  // the admission parker and the dispatch loop: a doomed task must never park
  // on a resource fit, or a too-big one would hang the run.
  //
  // Restore-tier tasks bypass the dep check: their key does not depend on dep
  // success.
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
      // `aborted` propagates though it is counted nowhere: the upstream died
      // mid-write, so a dependent would cache what it built from partial
      // outputs under a healthy key, and the next run would replay it as a
      // green hit.
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
      notify({
        kind: 'line',
        tone: 'warn',
        text: `[vx] onStart observer threw for ${node.id}: ${m}\n`,
      })
    }
  }

  private tick(): void {
    if (this.resolved) return
    // Exec-tier tasks refused admission this tick. Within one synchronous tick
    // `running` only grows, so a refused task cannot be admitted later in the
    // tick; each id pops at most once per tick.
    const parked: Parked = []
    for (;;) {
      const id = this.takeFitting(parked)
      if (id === undefined) break // nothing ready is admissible right now
      this.dispatch(id)
    }

    // Repush with original seqs so the next tick's order does not depend on
    // `parked`'s.
    for (const [id, seq] of parked) this.execReady.push(id, seq)

    // The outcome count alone: a slot is released before its outcome lands, so
    // the lane counters add nothing here.
    if (this.outcomes.size + this.settledIdle === this.nodes.size) {
      this.resolved = true
      this.stopListening()
      this.resolve(this.outcomes)
    }
  }

  // Highest-priority admissible task: exec tier first, then restore tier. A
  // would-skip task returns without asking; restore tasks are never asked, so
  // never park.
  private takeFitting(parked: Parked): string | undefined {
    const lanes = this.lanes
    if (lanes.holding) return undefined
    // A full exec lane with no pools: an admit policy only narrows the count
    // gate, so nothing there can start and the queue is not scanned. Scanning
    // re-popped every ready task each tick, O(R²) per run (6,000 tasks: 0.5 s
    // to 28 s). The same holds per pool: a 6-slot remote pool before 2,000
    // ready tasks re-popped them all on each end.
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

    // For a restore-tier task running before its deps finish, `upstream`
    // entries may be undefined (the cast lies); the restore path never reads
    // them.
    const upstream = node.deps.map((d) => this.outcomes.get(d) as TaskOutcome)

    const settlesIdle = this.settlesIdle(id, node)

    // A failed or skipped upstream skips this task here, synchronously:
    // dependents are pushed when `pending` hits 0 whatever the outcome, so
    // propagation lives in one place.
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

  // An idle task the stop or fail-fast would skip settles with no outcome: the
  // run never meant to start it. Below a failed dep it is skipped, so the hits
  // above pass the block down.
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
    const blocked = blockedBy !== undefined ? { blockedBy } : {}
    if (this.aborted()) {
      this.finishOne(id, { node, status: 'aborted', exitCode: 1, durationMs: 0, ...blocked })
      return
    }
    // Behind a platform skip is no failure: the run passes.
    const platform =
      blockedBy !== undefined && this.outcomes.get(blockedBy)?.otherPlatform !== undefined
    this.finishOne(id, {
      node,
      status: 'skipped',
      durationMs: 0,
      ...blocked,
      ...(platform ? { platform: true as const } : {}),
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
      if (queuedMs !== 0) (now.timing ??= {}).queuedMs = queuedMs
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
            timing: {
              ...o.timing,
              ...(heldMs > 0 ? { admissionHeldMs: heldMs } : {}),
              ...(queuedMs > 0 ? { queuedMs } : {}),
            },
          }
    const free = (): void => {
      leave()
      untrack()
    }
    // Crash-isolated: a throwing onStart would strand the tick with the slot
    // held. A demoted task's second dispatch, or one whose settle threw, is
    // already started.
    if (!this.demoted.has(id) && settle === undefined) this.started(node)

    // Two-arm `.then`, not `.then().catch()`: a throw in the fulfilment arm
    // must not also run the rejection arm, or `active` is released twice and
    // the count gate wedges.
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
    const done = (settledOutcome?: TaskOutcome | void): void => {
      this.finishOne(id, settledOutcome ?? outcome)
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
    // After the run's stop a rejection is the stop's doing (a probe it killed):
    // aborted, as any task it kills, and unsaid.
    const stopped = this.aborted()
    const exitCode = thrown instanceof OutputsFailed ? thrown.exitCode : 1
    const durationMs = thrown instanceof OutputsFailed ? thrown.durationMs : 0
    const outcome: TaskOutcome = withHold(
      stopped
        ? { node, status: 'aborted', exitCode, durationMs }
        : {
            node,
            status: 'failed',
            exitCode,
            durationMs,
            ...(thrown instanceof RestoreFailed ? { restoreFailed: true as const } : {}),
          },
    )
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
    // A UserError is a config or input failure, not a vx bug: report it
    // plainly, never as an internal error.
    let line: string
    // Out of descriptors is the environment's limit too: a stack
    // naming a file that was fine sent the user after the file.
    if (isUserError(err) || isFsRefusal(err) || isOutOfFds(err)) {
      const said = isUserError(err)
        ? message
        : `${message} — ${isOutOfFds(err) ? OUT_OF_FDS_HINT : fsRefusalHint(err)}`
      const text = thrown instanceof KeyFailed ? `cache key not derived: ${said}` : said
      // In the task's own output block, in full: that block is read alone, so
      // "as <task> above" may name nothing visible. On bare stderr the first is
      // above.
      const first = this.options.onError === undefined ? this.refusedBy.get(text) : undefined
      if (!this.refusedBy.has(text)) this.refusedBy.set(text, id)
      line = `[vx] ${id}: ${first === undefined ? text : `as ${first} above`}\n`
    } else line = internalErrorLine(id, err, message)
    try {
      if (this.options.onError === undefined) notify({ kind: 'line', tone: 'error', text: line })
      else this.options.onError(node, line, err)
    } catch {
      notify({ kind: 'line', tone: 'error', text: line })
    }
  }

  // A held server's answer: its dependants go on the restore lane, and the
  // server is idle if that was all of them. One whose deps all settled is
  // already queued, running or done: pushed again, it ran twice.
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

  // Idle as `idleServers` finds it, through the unrequested groups and servers
  // above it; the servers beneath are held on the same keys, so the walk idles
  // them too.
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
  // A wrapped error's cause is what the reader needs (an ENOENT under a
  // CorruptArtifactError is a race, not a bad archive), and the stack is not
  // printed here.
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : undefined
  const because =
    cause === undefined
      ? ''
      : ` (cause: ${(cause as NodeJS.ErrnoException).code ?? cause.name}: ${cause.message})`
  return `[vx] internal error in ${id}: ${named}${message}${because}\n`
}

/**
 * Persistent tasks nobody asked for whose every dependant is a restore-tier
 * hit, directly or behind unrequested groups and servers: such a group (`env: {
 * dependsOn: ['dev'] }`) booted the server on every warm run. Those groups and
 * servers go in `groups`, settled as groups are.
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
