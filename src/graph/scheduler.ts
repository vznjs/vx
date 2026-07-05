import { UserError } from '../util/index.js'
import type { TaskNode } from './task-graph.js'

export type TaskStatus =
  | 'success'
  | 'cache-hit'
  | 'cache-hit-remote'
  | 'failed'
  | 'skipped'
  // A child killed by a shutdown signal (SIGINT/SIGTERM — e.g. Ctrl-C):
  // the task never finished on its own terms, so it reverts to
  // aborted — not counted, not shown (the run is tearing down).
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

export interface TaskOutcome {
  node: TaskNode
  status: TaskStatus
  exitCode: number
  durationMs: number
  /** Cache key hash, if one was computed. Folded into dependents' keys
   *  (pure-input transitive — the upstream's input key, not its output). */
  hash?: string
  /** v11 analytics: CPU time + peak RSS for this task's child process. */
  cpuMs?: number
  peakRssBytes?: number
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
}

export type ContinueMode = 'never' | 'deps-ok' | 'always'

export interface ScheduleOptions {
  nodes: Map<string, TaskNode>
  concurrency: number
  /**
   * Failure propagation (default 'deps-ok' — the historical behavior):
   *   - 'deps-ok': a failed/skipped upstream skips its dependents;
   *     independent siblings keep running.
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
  // restore-tier (confirmed stable local hits). Both are kept sorted on
  // insert (descending by priority); equal-priority items insert AFTER
  // existing entries so ties break in graph-insertion order — same
  // contract the prior `scheduleOrder` sort provided via stable sort.
  // The tick loop drains execReady FIRST, so misses own the worker pool
  // and restores only backfill idle capacity (or run when an exec is
  // blocked on a restorable dep and nothing else is runnable).
  const restoreTier = options.restoreTier
  const execReady: string[] = []
  const restoreReady: string[] = []
  const insertSorted = (queue: string[], id: string): void => {
    const p = priority.get(id) ?? 0
    let lo = 0
    let hi = queue.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if ((priority.get(queue[mid]!) ?? 0) >= p) lo = mid + 1
      else hi = mid
    }
    queue.splice(lo, 0, id)
  }
  // A restore-tier task is dep-independent (a stable hit's restore needs
  // none of its deps' output), so it's ready immediately; its `pending`
  // decrements still happen (in finishOne) but never re-enqueue it.
  // Everything else enqueues on the exec-tier the moment its deps
  // complete.
  for (const node of nodes.values()) {
    if (restoreTier?.has(node.id)) insertSorted(restoreReady, node.id)
    else if (node.deps.length === 0) insertSorted(execReady, node.id)
  }

  let active = 0
  let resolved = false

  return new Promise<Map<string, TaskOutcome>>((resolve) => {
    const finishOne = (id: string, outcome: TaskOutcome): void => {
      if (continueMode === 'never' && outcome.status === 'failed') failFastTripped = true
      outcomes.set(id, outcome)
      onFinish?.(outcome)
      const ds = dependents.get(id)
      if (!ds) return
      for (const d of ds) {
        const rem = (pending.get(d) ?? 0) - 1
        pending.set(d, rem)
        // Restore-tier dependents were already enqueued at startup (they
        // don't wait on deps); only re-enqueue an exec-tier dependent.
        if (rem === 0 && !restoreTier?.has(d)) insertSorted(execReady, d)
      }
    }

    // Drain a worker slot: prefer an exec-tier task (misses own the
    // pool); only when none is ready does a restore-tier task backfill.
    const takeReady = (): string | undefined =>
      execReady.length > 0 ? execReady.shift() : restoreReady.shift()

    const tick = (): void => {
      if (resolved) return

      while (active < concurrency && (execReady.length > 0 || restoreReady.length > 0)) {
        const id = takeReady() as string
        const node = nodes.get(id) as TaskNode
        const isRestore = restoreTier?.has(id) === true

        // If any upstream failed/skipped, propagate skip synchronously
        // without running. Skipped tasks still flow through this queue
        // because dependents are pushed when `pending` hits 0 regardless
        // of outcome — keeps the propagation logic in one place.
        //
        // Restore-tier tasks BYPASS this check: their key is independent
        // of any dep's success (pure-input transitive hashing), so a
        // valid cached output is reported `cache-hit` even if a dep
        // failed — and they're dep-independent, so they typically
        // restore before a dep could fail anyway.
        //
        // For a restore-tier task running BEFORE its deps finish, the
        // `upstream` entries below can be undefined (the cast lies) —
        // the preProbed hit path in execute-task never reads them, and
        // nothing on the restore path may.
        const upstream = node.deps.map((d) => outcomes.get(d) as TaskOutcome)
        if (failFastTripped) {
          finishOne(id, { node, status: 'skipped', exitCode: 1, durationMs: 0 })
          continue
        }
        if (!isRestore && continueMode !== 'always') {
          const failedDep = upstream.find((u) => u.status === 'failed' || u.status === 'skipped')
          if (failedDep) {
            finishOne(id, { node, status: 'skipped', exitCode: 1, durationMs: 0 })
            continue
          }
        }

        active++
        onStart?.(node)

        execute(node, upstream)
          .then((outcome) => {
            active--
            finishOne(id, outcome)
            tick()
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            const outcome: TaskOutcome = {
              node,
              status: 'failed',
              exitCode: 1,
              durationMs: 0,
            }
            active--
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
          })
      }

      if (outcomes.size === nodes.size && active === 0) {
        resolved = true
        resolve(outcomes)
      }
    }

    tick()
  })
}

function mergePriorities(
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
