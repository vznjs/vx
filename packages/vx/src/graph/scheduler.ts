import { UserError } from '../util/index.js'
import type { TaskNode } from './task-graph.js'

export type TaskStatus =
  | 'success'
  | 'cache-hit'
  | 'cache-hit-remote'
  | 'failed'
  | 'skipped'
  // A child killed by a shutdown signal (SIGINT/SIGTERM — e.g. Ctrl-C):
  // the task never finished on its own terms, so it reverts to aborted —
  // excluded from the tally and the run history. It still PROPAGATES like
  // a failure (see `willSkip`): the child died mid-write, so its outputs
  // are partial.
  | 'aborted'

/**
 * Cache-correctness verdict for a task under `vx run --verify` (Phase 1:
 * determinism; Phase 2: input-completeness). Declared here (structurally)
 * because `graph` can't import `orchestrator` where the verifier lives —
 * same pattern as `inputComponents`. A pure side-channel: never hashed,
 * never persisted in Phase 1/2.
 */
export type VerifyVerdict =
  | { kind: 'proven-deterministic' }
  /** Phase 2: input-completeness proved — the task read nothing outside its
   *  declared inputs (from `--verify=inputs` when determinism wasn't also
   *  requested; an `--verify=all` pass reports the stronger deterministic). */
  | { kind: 'proven-complete' }
  /** Re-ran; outputs differ from the cached ones. `changed` names the rels. */
  | { kind: 'nondeterministic'; changed: readonly string[] }
  /** Phase 2: read a workspace path outside the declared inputs — the declared
   *  `cache.inputs` are incomplete, so a hit could serve stale bytes. `paths`
   *  names the undeclared reads (workspace-relative; empty when the sandbox
   *  denied structurally but strace wasn't available to name them). */
  | { kind: 'undeclared-inputs'; paths: readonly string[] }
  /** Diverged but the task is on `--verify-allow` — reported, not failed. */
  | { kind: 'allowed-nondeterministic'; changed: readonly string[] }
  /** The verify re-run exited non-zero / timed out (nondeterministic by
   *  definition — identical inputs, different outcome). */
  | { kind: 'rerun-failed'; exitCode: number }
  /** Cacheable + executed but declares no outputs — nothing to replay. */
  | { kind: 'no-outputs' }
  /** Didn't execute (cache hit) / not cacheable / group / persistent. */
  | { kind: 'not-verified' }
  /** A `remote: 'only'` task under `--verify=inputs`: verify pins placement
   *  local, so the task no-ops — there is no execution to sandbox, locally
   *  or anywhere. Reported, not silent: the proof does not cover it. */
  | { kind: 'unverifiable-remote-only' }

/**
 * Content fingerprint of a task's output tree, computed under a `--verify*`
 * mode on the executed (miss) path. Never hashed into any key; pure telemetry
 * side-channel for the cross-machine diff (a serve pairs fingerprints for the
 * SAME cache key across platforms and names diverging outputs). Declared here
 * (structurally) because `graph` can't import `orchestrator` — the
 * `VerifyVerdict` pattern. See docs/design/verify-cross-machine-2026-07.md.
 */
export interface OutputFingerprint {
  /** Roll-up: xxh3hex over the sorted (key, hash) pairs, folded as
   *  `key \0 hash \n` (\0 boundaries — the v18 lesson). Always present;
   *  divergence DETECTION never depends on the per-file map. */
  tree: string
  /** Total files in the tree (pre-truncation). */
  fileCount: number
  /** Per-file map as sorted [outputKey, xxh3hex] pairs, capped at
   *  FP_MAX_FILES (500). Deterministic truncation — sorted by key,
   *  first N — so two machines' truncated maps cover the same subset
   *  and partial diffs still name real rels. */
  files?: ReadonlyArray<readonly [string, string]>
  /** Set when `files` was truncated to the cap (or dropped by the
   *  sink's run budget). */
  truncated?: boolean
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
  /** v11 analytics: CPU time + peak RSS for this task's child process. */
  cpuMs?: number
  peakRssBytes?: number
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
  /** Executor-reported placement label (`ExecuteResult.where`) — set only
   *  when the task ran somewhere other than this host. Telemetry-only. */
  where?: string
  /** `'deferred'` when the task's outputs were left in the remote store
   *  (`--download=none`) instead of landing on this machine. Absent for
   *  every ordinary outcome. Telemetry-only. */
  outputs?: 'deferred'
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
   * `--retry` re-ran failed attempts. Set only when > 1 — a plain
   * single-attempt run carries nothing. Not persisted; telemetry-side
   * flaky detection reads it off the outcome stream.
   */
  attempts?: number
  /**
   * Count of sandbox violations captured during this task's exec.
   * Populated only when `--sandbox` was set and the task is cached.
   * Non-zero values mean the task read files outside its declared
   * inputs; `cache.save()` was skipped so the result can't be replayed.
   */
  sandboxViolations?: number
  /**
   * Raw violation log lines (one per access denial). Populated alongside
   * `sandboxViolations` so the framed-output renderer can show them
   * inline in the task's block instead of as loose status output.
   */
  sandboxViolationLines?: string[]
  /**
   * Cache-correctness verdict under `vx run --verify`. Set only in verify
   * mode; a plain run leaves it undefined. Pure side-channel (never hashed).
   */
  verify?: VerifyVerdict
  /**
   * Output-tree fingerprint under a fingerprinting `--verify*` mode
   * (`--verify` / `=all` / `=fingerprint`), executed + cacheable +
   * output-declaring tasks only. A plain run leaves it undefined.
   */
  outputFp?: OutputFingerprint
}

export type ContinueMode = 'never' | 'deps-ok' | 'always'

/**
 * Resolved per-task resource reservation, in absolute units (cpu may be
 * fractional; mem is bytes). Declared here (structurally) because `graph`
 * can't import `orchestrator`, where the resolver lives — same pattern as
 * `VerifyVerdict`. A `0` axis means "reserve nothing, run freely": the
 * task is exempt from that axis entirely (needs no headroom, holds none).
 */
export interface ResourceCost {
  cpu: number
  mem: number
}

export const ZERO_COST: ResourceCost = { cpu: 0, mem: 0 }

export interface ScheduleOptions {
  nodes: Map<string, TaskNode>
  concurrency: number
  /**
   * Failure propagation (default 'deps-ok' — the historical behavior):
   *   - 'deps-ok': a failed/skipped/aborted upstream skips its
   *     dependents; independent siblings keep running.
   *   - 'never': the first failure stops dispatch — in-flight tasks
   *     finish naturally, everything not yet started completes as
   *     skipped (restore-tier included: a fail-fast run stops
   *     restoring too).
   *   - 'always': dependents run even when an upstream failed. Sound
   *     under pure-input transitive hashing: failed outcomes carry the
   *     upstream's INPUT key (computed before exec), so dependents'
   *     keys fold exactly what a healthy run folds. An upstream that
   *     died before hashing folds nothing — that key is derivable by
   *     no healthy run, so the worst case is an unreachable cache
   *     entry, never a stale hit.
   */
  continueMode?: ContinueMode
  execute: (node: TaskNode, upstream: TaskOutcome[]) => Promise<TaskOutcome>
  onStart?: (node: TaskNode) => void
  onFinish?: (outcome: TaskOutcome) => void
  /**
   * Optional priority override: callers pass their own per-node weight
   * (e.g. `computePredictedPriorities` from the orchestrator's history
   * data). The scheduler picks the highest-weight ready task next.
   * When undefined, falls back to the static reverse-deps-count
   * heuristic (the default and historically the only behavior).
   */
  priorities?: ReadonlyMap<string, number>
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
   *     output is reported `cache-hit` regardless of a dep failing).
   * It still runs through `execute()` (so the logger frame is unchanged);
   * the orchestrator's execute reuses the up-front probe, so there is no
   * second cache.get. When undefined/empty, behavior is byte-identical.
   */
  restoreTier?: ReadonlySet<string>
  /**
   * Pool assignment for tasks placed on an executor with its own capacity
   * (a remote pool). Such a task occupies one of the pool's `capacity` slots
   * instead of a local worker slot and reserves no local resources, so a
   * remote pool is never throttled by the local CPU count. Undefined (or
   * a `undefined` result) = the local pool.
   */
  poolOf?: (id: string) => { name: string; capacity: number } | undefined
  /**
   * Resolved per-task resource reservations (`exec.resources`, resolved
   * by the orchestrator against the run's budgets). An absent id means
   * zero cost; undefined/empty means no task opted in — the scheduler
   * takes the legacy path byte-identically. Admission control only —
   * nothing is enforced on the child process.
   */
  resourceCosts?: ReadonlyMap<string, ResourceCost>
  /** CPU budget reservations pack against. Defaults to `concurrency`. */
  cpuBudget?: number
  /** Memory budget (bytes). Defaults to Infinity (axis off). */
  memBudget?: number
}

/**
 * Compute, for each task in the graph, how many OTHER tasks are
 * transitively blocked on it. Tasks with the highest count are the
 * most valuable to schedule first — finishing them unlocks the most
 * downstream work and minimizes worker idle time at the end of the
 * run. Matches Nx's `calculateReverseDeps`-driven schedule sort
 * (`packages/nx/src/tasks-runner/tasks-schedule.ts:166-207`).
 */
// Exported for the perf guard in tests/scheduler.test.ts, which times
// this function in isolation — end-to-end runGraph timing drowns the
// closure cost in task-promise overhead and flakes on slow CI.
export function computeReverseDepCount(nodes: Map<string, TaskNode>): Map<string, number> {
  // Exact transitive-dependent COUNTS need closure SETS (diamonds
  // double-count under naive summing). Set-of-strings closures are
  // O(N²) entries and took 8.5s on a 1090-package, 100-layer repo;
  // bitsets make the same closure O(E·N/32) time and N²/8 bits of
  // memory (3270 tasks ≈ 1.3 MB) — single-digit ms at that scale.
  const ids = [...nodes.keys()]
  const index = new Map<string, number>()
  for (let i = 0; i < ids.length; i++) index.set(ids[i]!, i)
  const n = ids.length
  const words = (n + 31) >>> 5

  // Direct dependents as index lists + in-degree for the topo pass.
  const directReverse: number[][] = Array.from({ length: n }, () => [])
  const indegree = new Uint32Array(n)
  for (const node of nodes.values()) {
    const ni = index.get(node.id)!
    for (const dep of node.deps) {
      const di = index.get(dep)
      if (di === undefined) continue
      directReverse[di]!.push(ni)
      indegree[ni]!++
    }
  }

  // Kahn topo order over dependency edges (deps before dependents).
  // Insertion order is topo today, but the closure's correctness
  // must not hinge on an unstated property of buildTaskGraph.
  const topo = new Int32Array(n)
  let head = 0
  let tail = 0
  for (let i = 0; i < n; i++) if (indegree[i] === 0) topo[tail++] = i
  while (head < tail) {
    const v = topo[head++]!
    for (const r of directReverse[v]!) {
      if (--indegree[r]! === 0) topo[tail++] = r
    }
  }

  // Reverse-topo sweep: every direct dependent's closure is final
  // before its dependency folds it in. closure[i] = bitset over node
  // indices of i's transitive dependents.
  const closure = new Uint32Array(n * words)
  const counts = new Map<string, number>()
  for (let t = tail - 1; t >= 0; t--) {
    const i = topo[t]!
    const base = i * words
    for (const r of directReverse[i]!) {
      closure[base + (r >>> 5)]! |= 1 << (r & 31)
      const rbase = r * words
      for (let w = 0; w < words; w++) closure[base + w]! |= closure[rbase + w]!
    }
    let count = 0
    for (let w = 0; w < words; w++) {
      let v = closure[base + w]!
      v = v - ((v >>> 1) & 0x55555555)
      v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
      count += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
    }
    counts.set(ids[i]!, count)
  }
  // Cycle-stranded nodes (never topo-visited) can't occur — the graph
  // builder rejects cycles — but a missing Map entry would silently
  // sort as undefined, so default them defensively to 0.
  for (const id of ids) if (!counts.has(id)) counts.set(id, 0)
  return counts
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
  private next = 0
  constructor(private readonly priority: ReadonlyMap<string, number>) {}
  get size(): number {
    return this.ids.length
  }
  /** True if slot i outranks slot j (higher priority, or equal priority + earlier seq). */
  private higher(i: number, j: number): boolean {
    const pi = this.priority.get(this.ids[i]!) ?? 0
    const pj = this.priority.get(this.ids[j]!) ?? 0
    return pi !== pj ? pi > pj : this.seq[i]! < this.seq[j]!
  }
  private swap(i: number, j: number): void {
    const ti = this.ids[i]!
    this.ids[i] = this.ids[j]!
    this.ids[j] = ti
    const si = this.seq[i]!
    this.seq[i] = this.seq[j]!
    this.seq[j] = si
  }
  /**
   * `seq` defaults to a fresh monotonic counter. A parked-then-repushed
   * task passes its ORIGINAL seq back in so FIFO-among-equals survives
   * the round trip (a fresh seq would demote it behind later arrivals).
   */
  push(id: string, seq: number = this.next++): void {
    this.ids.push(id)
    this.seq.push(seq)
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
    const lastId = this.ids.pop()!
    const lastSeq = this.seq.pop()!
    if (n > 1) {
      this.ids[0] = lastId
      this.seq[0] = lastSeq
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = 2 * i + 2
        let best = i
        if (l < this.ids.length && this.higher(l, best)) best = l
        if (r < this.ids.length && this.higher(r, best)) best = r
        if (best === i) break
        this.swap(i, best)
        i = best
      }
    }
    return top
  }
}

export async function runGraph(options: ScheduleOptions): Promise<Map<string, TaskOutcome>> {
  const { nodes, concurrency, execute, onStart, onFinish } = options
  const continueMode = options.continueMode ?? 'deps-ok'
  // 'never': set on the first failed outcome; from then on every
  // dequeued task is skipped instead of dispatched (in-flight tasks
  // finish naturally and their dependents drain through the same path).
  let failFastTripped = false
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
  const baseline = computeReverseDepCount(nodes)
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
  const execReady = new ReadyHeap(priority)
  const restoreReady = new ReadyHeap(priority)
  // A restore-tier task is dep-independent (a stable hit's restore needs
  // none of its deps' output), so it's ready immediately; its `pending`
  // decrements still happen (in finishOne) but never re-enqueue it.
  // Everything else enqueues on the exec-tier the moment its deps
  // complete.
  for (const node of nodes.values()) {
    if (restoreTier?.has(node.id)) restoreReady.push(node.id)
    else if (node.deps.length === 0) execReady.push(node.id)
  }

  let active = 0
  let resolved = false

  // Resource admission (2-D bin packing over the count limit). Inactive
  // (no task opted in) → the tick loop short-circuits before any of this
  // and behaves byte-identically to the count-only scheduler.
  const costs = options.resourceCosts
  const resourcesActive = costs !== undefined && costs.size > 0
  const cpuBudget = options.cpuBudget ?? concurrency
  const memBudget = options.memBudget ?? Infinity
  // Reservations are FLOAT sums (fractional cpus, and percent-of-budget
  // resolves to non-representable values like `0.30000000000000004`), so
  // add/release cycles leave ~1e-17 residue instead of an exact 0. Two
  // guards keep that residue from corrupting admission:
  //   - the solo-clamp gate ("is the axis idle?") reads INTEGER holder
  //     counts, never the float sum === 0 — a residue would otherwise
  //     park an over-budget task forever (active===0, no future tick =
  //     a silent hang / exit-0-without-running);
  //   - `reserved` snaps back to EXACT 0 whenever its holder count hits
  //     0, so residue can't accumulate across busy periods.
  // The within-budget comparison also carries a tiny relative epsilon so
  // an exact-fill (`reserved + cost == budget`) can't mis-round into a
  // spurious block. Admission is a hint, so the epsilon's sub-ulp
  // over-admission is harmless.
  let reservedCpu = 0
  let reservedMem = 0
  let holdersCpu = 0
  let holdersMem = 0

  // A restore-tier task is a confirmed local cache hit: its "execution"
  // is a cheap tar extract, not the task's real work — it reserves ZERO
  // regardless of what the config declares, so it never holds budget
  // against a real executor (and never parks).
  const poolOf = options.poolOf
  const poolActive = new Map<string, number>()
  // A pooled task is admitted against ITS pool's capacity, a local one
  // against `concurrency`; pooled tasks reserve no local resources.
  const hasRoom = (id: string): boolean => {
    const pool = poolOf?.(id)
    if (pool === undefined) return active < concurrency
    return (poolActive.get(pool.name) ?? 0) < pool.capacity
  }
  const admit = (id: string): (() => void) => {
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
  const costOf = (id: string): ResourceCost =>
    options.restoreTier?.has(id) || poolOf?.(id) !== undefined
      ? ZERO_COST
      : (costs?.get(id) ?? ZERO_COST)

  // Zero never blocks; a within-budget cost needs headroom (with an
  // exact-fill epsilon); an over-budget cost can never have headroom, so
  // it solo-clamps: admitted only when the axis is idle (no holders — an
  // idle pool always admits at least one ready task, no deadlock).
  const fitsAxis = (cost: number, reserved: number, holders: number, budget: number): boolean =>
    cost === 0 ? true : cost <= budget ? reserved + cost <= budget + budget * 1e-9 : holders === 0

  const fits = (id: string): boolean => {
    const c = costOf(id)
    return (
      fitsAxis(c.cpu, reservedCpu, holdersCpu, cpuBudget) &&
      fitsAxis(c.mem, reservedMem, holdersMem, memBudget)
    )
  }

  // Reserve/release keep the float sum AND the integer holder count in
  // lockstep; releasing the last holder on an axis snaps its sum to 0.
  const reserve = (c: ResourceCost): void => {
    if (c.cpu > 0) {
      reservedCpu += c.cpu
      holdersCpu++
    }
    if (c.mem > 0) {
      reservedMem += c.mem
      holdersMem++
    }
  }
  const release = (c: ResourceCost): void => {
    if (c.cpu > 0 && --holdersCpu === 0) reservedCpu = 0
    else reservedCpu -= c.cpu
    if (c.mem > 0 && --holdersMem === 0) reservedMem = 0
    else reservedMem -= c.mem
  }

  return new Promise<Map<string, TaskOutcome>>((resolve) => {
    const finishOne = (id: string, outcome: TaskOutcome): void => {
      if (continueMode === 'never' && outcome.status === 'failed') failFastTripped = true
      outcomes.set(id, outcome)
      // Observer hook (the logger's taskComplete). Crash-isolated: a
      // throwing observer must NOT break scheduling — it would otherwise
      // skip the dependent-enqueue + tick below and hang the run. Same
      // "observability never breaks a run" rule the telemetry
      // paths hold. Isolated here (not the completion arm) so a throw
      // can't be mistaken for the task itself failing.
      try {
        onFinish?.(outcome)
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        process.stderr.write(`[vx] onFinish observer threw for ${id}: ${m}\n`)
      }
      const ds = dependents.get(id)
      if (!ds) return
      for (const d of ds) {
        const rem = (pending.get(d) ?? 0) - 1
        pending.set(d, rem)
        // Restore-tier dependents were already enqueued at startup (they
        // don't wait on deps); only re-enqueue an exec-tier dependent.
        if (rem === 0 && !restoreTier?.has(d)) execReady.push(d)
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
    const willSkip = (id: string): boolean => {
      if (failFastTripped) return true
      if (restoreTier?.has(id)) return false
      if (continueMode === 'always') return false
      const node = nodes.get(id) as TaskNode
      return node.deps.some((d) => {
        const u = outcomes.get(d)
        // `aborted` propagates even though it is counted nowhere: the
        // upstream was killed mid-write, so its declared outputs are
        // partial. A dependent that ran anyway would CACHE what it built
        // from them — under the key a healthy run derives, since the fold
        // takes the upstream's INPUT key — so the next run replays those
        // bytes as a green hit.
        return u?.status === 'failed' || u?.status === 'skipped' || u?.status === 'aborted'
      })
    }

    const tick = (): void => {
      if (resolved) return
      // Exec-tier tasks parked THIS tick on a failed resource fit.
      // Within one synchronous tick `reserved` only increases (release
      // happens in the async completion callbacks, which run a fresh
      // tick), so a task that doesn't fit now cannot fit later in the
      // same tick — parking it for the tick's remainder is exact, and
      // each id pops at most once per tick (O(R log R)).
      const parked: Array<[string, number]> = []

      // Highest-priority admissible task: exec tier first (misses own
      // the pool), then restore tier. With no reservations declared this
      // short-circuits to exactly the legacy takeReady. A would-skip
      // task returns without a fit check (finishing it is free); restore
      // tasks cost zero by construction, so they never park.
      const takeFitting = (): string | undefined => {
        // No pools declared (the common case): a full local pool admits
        // nothing, so do not scan — this is the legacy O(1) gate.
        if (poolOf === undefined && active >= concurrency) return undefined
        while (execReady.size > 0) {
          const seq = execReady.peekSeq()
          const id = execReady.pop() as string
          if (willSkip(id) || ((!resourcesActive || fits(id)) && hasRoom(id))) return id
          parked.push([id, seq])
        }
        // Restore-tier tasks are local work (a cache restore on this disk).
        return active < concurrency ? restoreReady.pop() : undefined
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

        // If any upstream failed/skipped, propagate skip synchronously
        // without running. Skipped tasks still flow through this queue
        // because dependents are pushed when `pending` hits 0 regardless
        // of outcome — keeps the propagation logic in one place.
        if (willSkip(id)) {
          finishOne(id, { node, status: 'skipped', exitCode: 1, durationMs: 0 })
          continue
        }

        const leave = admit(id)
        // Reserve on dispatch; capture the cost so the release in the
        // completion callbacks is symmetric even if the maps change.
        const cost = costOf(id)
        reserve(cost)
        // Crash-isolated observer hook — a throwing onStart must not abort
        // the dispatch loop (it would strand the tick with reservations held).
        try {
          onStart?.(node)
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err)
          process.stderr.write(`[vx] onStart observer threw for ${id}: ${m}\n`)
        }

        // `.then(onFulfilled, onRejected)` — NOT `.then(f).catch(g)`. The
        // rejection arm handles ONLY `execute()` rejecting; a throw from
        // the fulfillment arm (finishOne / onFinish / tick) must NOT also
        // run the rejection arm, or `active`/`reserved` release twice —
        // and a double release drives `reserved` negative, permanently
        // wedging the solo-clamp gate.
        execute(node, upstream).then(
          (outcome) => {
            leave()
            release(cost)
            finishOne(id, outcome)
            tick()
          },
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            const outcome: TaskOutcome = {
              node,
              status: 'failed',
              exitCode: 1,
              durationMs: 0,
            }
            leave()
            release(cost)
            finishOne(id, outcome)
            // Surface the error live; the outcome itself doesn't
            // carry captured stderr (that's the logger's job). A
            // UserError is a config/input failure (e.g. a failed
            // `cache.inputs.runtime` command), not a vx bug — report it
            // plainly, never as an "internal error".
            if (err instanceof UserError) {
              process.stderr.write(`[vx] ${id}: ${message}\n`)
            } else {
              const named = err instanceof Error && err.name !== 'Error' ? `${err.name}: ` : ''
              process.stderr.write(`[vx] internal error in ${id}: ${named}${message}\n`)
            }
            tick()
          },
        )
      }

      // Repush parked ids with their ORIGINAL seqs — FIFO-among-equals
      // is exactly preserved for the next tick's admission pass.
      for (const [id, seq] of parked) execReady.push(id, seq)

      if (outcomes.size === nodes.size && active === 0) {
        resolved = true
        resolve(outcomes)
      }
    }

    tick()
  })
}

export function mergePriorities(
  baseline: ReadonlyMap<string, number>,
  overrides: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  // The override caller scored "expected critical-path duration" in ms.
  // Baseline reverse-deps counts are bounded by N; scale the override so
  // it sorts above the baseline for any node it covers, and add the
  // baseline as a tie-break for parity within the override set.
  const SCALE = 1 << 20
  const out = new Map<string, number>()
  for (const [id, w] of baseline) out.set(id, w)
  for (const [id, w] of overrides) {
    const b = baseline.get(id) ?? 0
    out.set(id, w * SCALE + b)
  }
  return out
}
