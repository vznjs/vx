import type { TaskNode } from './task-graph.js'

export type TaskStatus = 'success' | 'cache-hit' | 'cache-hit-remote' | 'failed' | 'skipped'

export interface TaskOutcome {
  node: TaskNode
  status: TaskStatus
  exitCode: number
  durationMs: number
  /** Cache key hash, if one was computed. Folded into dependents' keys. */
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
}

export interface ScheduleOptions {
  nodes: Map<string, TaskNode>
  concurrency: number
  execute: (node: TaskNode, upstream: TaskOutcome[]) => Promise<TaskOutcome>
  onStart?: (node: TaskNode) => void
  onFinish?: (outcome: TaskOutcome) => void
}

/**
 * Compute, for each task in the graph, how many OTHER tasks are
 * transitively blocked on it. Tasks with the highest count are the
 * most valuable to schedule first — finishing them unlocks the most
 * downstream work and minimizes worker idle time at the end of the
 * run. Matches Nx's `calculateReverseDeps`-driven schedule sort
 * (`packages/nx/src/tasks-runner/tasks-schedule.ts:166-207`).
 */
function computeReverseDepCount(nodes: Map<string, TaskNode>): Map<string, number> {
  // Direct reverse edges: dep -> set of tasks that name it.
  const directReverse = new Map<string, Set<string>>()
  for (const id of nodes.keys()) directReverse.set(id, new Set())
  for (const node of nodes.values()) {
    for (const dep of node.deps) {
      directReverse.get(dep)?.add(node.id)
    }
  }
  // Transitive closure via memoized DFS. Each task's reach is the
  // union of its direct reverse-edges plus their reaches.
  const reach = new Map<string, Set<string>>()
  function reachOf(id: string): Set<string> {
    const cached = reach.get(id)
    if (cached) return cached
    const out = new Set<string>()
    for (const r of directReverse.get(id) ?? []) {
      out.add(r)
      for (const t of reachOf(r)) out.add(t)
    }
    reach.set(id, out)
    return out
  }
  const counts = new Map<string, number>()
  for (const id of nodes.keys()) counts.set(id, reachOf(id).size)
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

  const priority = computeReverseDepCount(nodes)

  // Ready queue: tasks whose deps have all completed. Kept sorted on
  // insert (descending by priority); equal-priority items insert AFTER
  // existing entries so ties break in graph-insertion order — same
  // contract the prior `scheduleOrder` sort provided via stable sort.
  const ready: string[] = []
  const pushReady = (id: string): void => {
    const p = priority.get(id) ?? 0
    let lo = 0
    let hi = ready.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if ((priority.get(ready[mid]!) ?? 0) >= p) lo = mid + 1
      else hi = mid
    }
    ready.splice(lo, 0, id)
  }

  for (const node of nodes.values()) {
    if (node.deps.length === 0) pushReady(node.id)
  }

  let active = 0
  let resolved = false

  return new Promise<Map<string, TaskOutcome>>((resolve) => {
    const finishOne = (id: string, outcome: TaskOutcome): void => {
      outcomes.set(id, outcome)
      onFinish?.(outcome)
      const ds = dependents.get(id)
      if (!ds) return
      for (const d of ds) {
        const rem = (pending.get(d) ?? 0) - 1
        pending.set(d, rem)
        if (rem === 0) pushReady(d)
      }
    }

    const tick = (): void => {
      if (resolved) return

      while (active < concurrency && ready.length > 0) {
        const id = ready.shift() as string
        const node = nodes.get(id) as TaskNode

        // If any upstream failed/skipped, propagate skip synchronously
        // without running. Skipped tasks still flow through this queue
        // because dependents are pushed when `pending` hits 0 regardless
        // of outcome — keeps the propagation logic in one place.
        const upstream = node.deps.map((d) => outcomes.get(d) as TaskOutcome)
        const failedDep = upstream.find((u) => u.status === 'failed' || u.status === 'skipped')
        if (failedDep) {
          finishOne(id, { node, status: 'skipped', exitCode: 1, durationMs: 0 })
          continue
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
            // carry captured stderr (that's the logger's job).
            const named = err instanceof Error && err.name !== 'Error' ? `${err.name}: ` : ''
            process.stderr.write(`[vx] internal error in ${id}: ${named}${message}\n`)
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
