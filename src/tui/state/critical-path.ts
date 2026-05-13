// Critical-path DP. The longest path through the task DAG, in
// duration terms — predicted from history for waiting/ready tasks,
// observed-elapsed for running, actual for finished. Persistent
// tasks are excluded; their "duration" is undefined and would always
// dominate. See docs/design/tui-design.md §11.2.

export interface CriticalPathTask {
  id: string
  deps: readonly string[]
  status:
    | 'waiting'
    | 'ready'
    | 'running'
    | 'success'
    | 'cache-hit'
    | 'cache-hit-remote'
    | 'failed'
    | 'skipped'
  /** Final wallclock duration; set when status is one of the terminal `success`-like values. */
  actualMs?: number
  /** Live `(now - taskStart)` ms while running. */
  currentElapsedMs?: number
  /** History avg ms; used as the predicted weight for unstarted tasks. */
  historyAvgMs?: number
  /** Persistent (long-running) tasks are excluded entirely. */
  persistent: boolean
}

export interface CriticalPathInput {
  tasks: readonly CriticalPathTask[]
}

export interface CriticalPath {
  /** Ordered list of node ids from start to end. */
  path: string[]
  /** Total weight along `path` (ms). */
  totalMs: number
  /** Optional: weight contribution per id on the path. */
  weights: Record<string, number>
}

function weight(task: CriticalPathTask): number {
  if (task.persistent) return 0
  switch (task.status) {
    case 'success':
    case 'cache-hit':
    case 'cache-hit-remote':
      return task.actualMs ?? 0
    case 'running':
      return task.currentElapsedMs ?? 0
    case 'waiting':
    case 'ready':
      return task.historyAvgMs ?? 0
    case 'skipped':
    case 'failed':
      return 0
    default:
      return 0
  }
}

/**
 * Single forward pass over a topo-sorted task list. The caller is
 * responsible for passing tasks in topo order — we don't sort defensively
 * because the orchestrator's graph already maintains it (`Map.keys()`
 * preserves insertion order; `buildTaskGraph` inserts in topo).
 *
 * Ties: when two parents lead to the same `dist`, the earlier entry in
 * `deps[]` wins. Deterministic + matches the natural left-to-right
 * reading of the config.
 */
export function computeCriticalPath(input: CriticalPathInput): CriticalPath {
  const dist = new Map<string, number>()
  const pred = new Map<string, string | null>()
  const weights: Record<string, number> = {}

  // Index by id for predecessor lookup.
  const byId = new Map<string, CriticalPathTask>()
  for (const t of input.tasks) byId.set(t.id, t)

  for (const t of input.tasks) {
    if (t.persistent) continue
    const w = weight(t)
    let best = 0
    let bestPred: string | null = null
    for (const d of t.deps) {
      const parent = byId.get(d)
      if (!parent || parent.persistent) continue
      const dParent = dist.get(d) ?? 0
      if (dParent > best) {
        best = dParent
        bestPred = d
      }
    }
    const total = best + w
    dist.set(t.id, total)
    pred.set(t.id, bestPred)
    weights[t.id] = w
  }

  // Find the sink with the largest `dist`.
  let sink: string | null = null
  let max = 0
  for (const [id, d] of dist) {
    if (d > max) {
      max = d
      sink = id
    }
  }
  if (!sink) return { path: [], totalMs: 0, weights: {} }

  // Walk predecessors backward to reconstruct.
  const reverse: string[] = []
  let cur: string | null = sink
  while (cur) {
    reverse.push(cur)
    cur = pred.get(cur) ?? null
  }
  return {
    path: reverse.reverse(),
    totalMs: max,
    weights,
  }
}
