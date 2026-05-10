import type { TaskNode } from './task-graph.js'

export type TaskStatus = 'success' | 'cache-hit' | 'failed' | 'skipped'

export interface TaskOutcome {
  node: TaskNode
  status: TaskStatus
  exitCode: number
  durationMs: number
  /** Cache key hash, if one was computed. Folded into dependents' keys. */
  hash?: string
}

export interface ScheduleOptions {
  nodes: Map<string, TaskNode>
  concurrency: number
  execute: (node: TaskNode, upstream: TaskOutcome[]) => Promise<TaskOutcome>
  onStart?: (node: TaskNode) => void
  onFinish?: (outcome: TaskOutcome) => void
}

/**
 * Run the task graph. Independent tasks run in parallel up to `concurrency`.
 * If a task fails, its dependents are marked `skipped` but unrelated tasks
 * keep running so the user gets maximum information per invocation.
 */
export async function runGraph(options: ScheduleOptions): Promise<Map<string, TaskOutcome>> {
  const { nodes, concurrency, execute, onStart, onFinish } = options
  const outcomes = new Map<string, TaskOutcome>()
  const remaining = new Set(nodes.keys())
  const inFlight = new Set<string>()

  return new Promise<Map<string, TaskOutcome>>((resolve) => {
    let active = 0
    let resolved = false

    const tick = (): void => {
      if (resolved) return

      // Snapshot to avoid surprises from concurrent Set mutation during iteration.
      for (const id of [...remaining]) {
        if (active >= concurrency) break
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
        onStart?.(node)

        const upstreamDefined = upstream.filter((u): u is TaskOutcome => u !== undefined)
        execute(node, upstreamDefined)
          .then((outcome) => {
            outcomes.set(id, outcome)
            inFlight.delete(id)
            active--
            onFinish?.(outcome)
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
            outcomes.set(id, outcome)
            inFlight.delete(id)
            active--
            onFinish?.(outcome)
            process.stderr.write(`[nxt] internal error in ${id}: ${message}\n`)
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
