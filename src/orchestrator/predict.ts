// Predictive scheduling — use HistoryTable to compute expected
// remaining critical-path duration per node. Replaces the scheduler's
// graph-counter heuristic priority for runs that opt in via
// defineWorkspace({ predictive: true }) (predictive-execution-2026-06.md
// Phase B + architecture-review-2026-06.md §8.4).
//
// Pure functions; no side effects; tested standalone. The scheduler
// reads the priorities at queue time, picks the max.

import type { TaskNode } from '../graph/index.js'
import type { HistoryTable } from './history.js'

/** Default duration when neither task history nor workspace median exists. */
const DEFAULT_DURATION_MS = 1000

/**
 * For each node, the expected remaining critical-path duration (its own
 * p50 + the max over its dependents). Cache hits are NOT modeled as
 * zero-cost here because predicting cache state requires knowing the
 * key + probing the layer — the run-time scheduler can flip the
 * priority once a hit is observed; the upfront estimate is "what if
 * everything ran."
 */
export function computePredictedPriorities(
  nodes: readonly TaskNode[],
  history: HistoryTable,
): ReadonlyMap<string, number> {
  // Workspace-median fallback: across every history entry that has a
  // p50, pick the median of those p50s. If history is sparse, fall
  // back to DEFAULT_DURATION_MS.
  const p50s: number[] = []
  for (const h of history.values()) {
    if (h.p50DurationMs !== undefined) p50s.push(h.p50DurationMs)
  }
  p50s.sort((a, b) => a - b)
  const workspaceMedian =
    p50s.length > 0
      ? (p50s[Math.floor(p50s.length / 2)] ?? DEFAULT_DURATION_MS)
      : DEFAULT_DURATION_MS

  // Build a reverse-adjacency map so we can resolve dependents per
  // node in O(1). The TaskNode graph carries dependsOn (upstream); we
  // invert.
  const dependentsOf = buildDependentsIndex(nodes)
  const ownDuration = (n: TaskNode): number => {
    const h = history.get(n.id)
    return h?.p50DurationMs ?? workspaceMedian
  }

  // Memoized topo-DP. visit[id] = the expected critical path FROM this
  // node down to a leaf. We compute bottom-up using a stack-based
  // walker — iterative to avoid V8 stack-frame ceilings on deep graphs.
  const memo = new Map<string, number>()
  const nodeById = new Map<string, TaskNode>(nodes.map((n) => [n.id, n]))

  const stack: TaskNode[] = nodes.slice()
  // First pass: ensure deepest-first ordering via post-order traversal.
  const order: TaskNode[] = []
  const visited = new Set<string>()
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!
    if (visited.has(top.id)) {
      stack.pop()
      continue
    }
    const deps = dependentsOf.get(top.id) ?? []
    let pushed = false
    for (const d of deps) {
      const n = nodeById.get(d)
      if (n && !visited.has(n.id) && !stack.includes(n)) {
        stack.push(n)
        pushed = true
        break
      }
    }
    if (!pushed) {
      visited.add(top.id)
      order.push(top)
      stack.pop()
    }
  }

  for (const n of order) {
    const own = ownDuration(n)
    let downstream = 0
    for (const dep of dependentsOf.get(n.id) ?? []) {
      const d = memo.get(dep) ?? 0
      if (d > downstream) downstream = d
    }
    memo.set(n.id, own + downstream)
  }

  return memo
}

function buildDependentsIndex(nodes: readonly TaskNode[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const n of nodes) {
    for (const upstreamId of n.deps) {
      const list = out.get(upstreamId)
      if (list) list.push(n.id)
      else out.set(upstreamId, [n.id])
    }
  }
  return out
}
