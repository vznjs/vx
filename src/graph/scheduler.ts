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
   * Captured stdout/stderr from the task's process. Populated on real
   * `exec` runs (success or failure) so the orchestrator can replay
   * failed-task output at end of run + persist logs to disk. Empty
   * strings for cache-hits and group tasks.
   */
  stdout?: string
  stderr?: string
  /**
   * For cache-hit statuses: true if outputs were actually written to
   * disk this run, false if the on-disk state already matched the
   * cached snapshot (no materialization needed). Lets the formatter
   * surface "up-to-date" vs "local-cache" / "remote-cache" in the
   * framed block. Undefined on non-cache-hit outcomes (success /
   * failed / skipped) — irrelevant there.
   */
  restored?: boolean
}

export interface ScheduleOptions {
  nodes: Map<string, TaskNode>
  concurrency: number
  /**
   * `slot` is a stable lowest-free-index worker slot in `[0, concurrency)`.
   * Allocated as `execute` is called, released in the task's finally.
   * Lets dashboards / TUIs render per-slot timelines without inferring
   * which slot a task ran on from interleaved start events.
   */
  execute: (node: TaskNode, upstream: TaskOutcome[], slot: number) => Promise<TaskOutcome>
  onStart?: (node: TaskNode, slot: number) => void
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
  const remaining = new Set(nodes.keys())
  const inFlight = new Set<string>()

  // Pre-sort node IDs by reverse-dep count (descending). Reverse deps
  // are static for the duration of a run, so we sort once and iterate
  // this order on every tick instead of re-sorting `remaining` each
  // time. O(N log N) once vs O(N log N) per tick.
  const reverseDepCount = computeReverseDepCount(nodes)
  const scheduleOrder = [...nodes.keys()].sort(
    (a, b) => (reverseDepCount.get(b) ?? 0) - (reverseDepCount.get(a) ?? 0),
  )

  // Free-list of worker slots. Lowest-free-index allocation keeps a
  // task that's almost always running pinned to slot 0; idle gaps on
  // higher slot indices stay visible. Stable assignment matters more
  // to TUI consumers than any scheduling fairness — we already pick
  // tasks by ready-order.
  const freeSlots: number[] = Array.from({ length: concurrency }, (_, i) => i)
  const slotOf = new Map<string, number>()

  return new Promise<Map<string, TaskOutcome>>((resolve) => {
    let active = 0
    let resolved = false

    const tick = (): void => {
      if (resolved) return

      // Iterate the pre-sorted schedule order. `remaining` Set
      // membership tells us what's still pending; we walk the sorted
      // list (priority order) and pick the first ready node.
      for (const id of scheduleOrder) {
        if (active >= concurrency) break
        if (!remaining.has(id)) continue
        if (inFlight.has(id)) continue
        const node = nodes.get(id)
        if (!node) continue

        const upstream = node.deps.map((d) => outcomes.get(d))
        if (upstream.some((u) => u === undefined)) continue

        const failedDep = upstream.find(
          (u) => u && (u.status === 'failed' || u.status === 'skipped'),
        )
        if (failedDep) {
          const outcome: TaskOutcome = {
            node,
            status: 'skipped',
            exitCode: 1,
            durationMs: 0,
          }
          outcomes.set(id, outcome)
          remaining.delete(id)
          onFinish?.(outcome)
          continue
        }

        active++
        inFlight.add(id)
        remaining.delete(id)
        // shift() returns the lowest-index free slot; we already gated
        // on `active < concurrency`, so this is always defined.
        const slot = freeSlots.shift() as number
        slotOf.set(id, slot)
        onStart?.(node, slot)

        const upstreamDefined = upstream.filter((u): u is TaskOutcome => u !== undefined)
        const releaseSlot = (): void => {
          const s = slotOf.get(id)
          if (s !== undefined) {
            slotOf.delete(id)
            // Insert at the head so the next acquire picks the lowest index.
            freeSlots.unshift(s)
            freeSlots.sort((a, b) => a - b)
          }
        }
        execute(node, upstreamDefined, slot)
          .then((outcome) => {
            outcomes.set(id, outcome)
            inFlight.delete(id)
            active--
            releaseSlot()
            onFinish?.(outcome)
            tick()
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            // Park the message on the outcome's stderr so end-of-run
            // failure replay surfaces it. Without this, thrown errors
            // (spawn failures, config issues, etc.) were lost — users
            // saw ✗ with no logs.
            const outcome: TaskOutcome = {
              node,
              status: 'failed',
              exitCode: 1,
              durationMs: 0,
              stderr: `${err instanceof Error && err.name !== 'Error' ? err.name + ': ' : ''}${message}\n`,
            }
            outcomes.set(id, outcome)
            inFlight.delete(id)
            active--
            releaseSlot()
            onFinish?.(outcome)
            process.stderr.write(`[vx] internal error in ${id}: ${message}\n`)
            tick()
          })
      }

      // Re-check completion at the bottom: all remaining nodes may have been
      // synchronously marked `skipped` above, in which case nothing is in
      // flight to call us back.
      if (remaining.size === 0 && active === 0) {
        resolved = true
        resolve(outcomes)
      }
    }

    tick()
  })
}
