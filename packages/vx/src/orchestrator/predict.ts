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

  // memo[id] = own p50 + max over dependents' memo — a fold over the
  // DOWNSTREAM chain, so every dependent must be computed before the
  // node it depends on. The graph Map's insertion order is PRE-order
  // from the requested roots (a dependent is inserted BEFORE the deps
  // it pulls in), so no fixed scan direction over `nodes` is safe:
  // process in reverse-topo order via an explicit Kahn pass over the
  // dependents relation (iterative — no V8 stack ceiling; the
  // scheduler's bitset-closure precedent).
  const memo = new Map<string, number>()
  const nodeById = new Map<string, TaskNode>(nodes.map((n) => [n.id, n]))
  // pending[id] = dependents not yet folded; 0 → every downstream chain
  // through this node is known, so its own memo can be computed.
  const pending = new Map<string, number>()
  const queue: TaskNode[] = []
  for (const n of nodes) {
    const count = dependentsOf.get(n.id)?.length ?? 0
    pending.set(n.id, count)
    if (count === 0) queue.push(n)
  }
  let head = 0
  while (head < queue.length) {
    const n = queue[head++]!
    let downstream = 0
    for (const dep of dependentsOf.get(n.id) ?? []) {
      const d = memo.get(dep) ?? 0
      if (d > downstream) downstream = d
    }
    memo.set(n.id, ownDuration(n) + downstream)
    for (const up of n.deps) {
      const left = (pending.get(up) ?? 0) - 1
      pending.set(up, left)
      if (left === 0) {
        const upNode = nodeById.get(up)
        if (upNode) queue.push(upNode)
      }
    }
  }
  // Cycles are rejected at graph build, so the queue drains fully in
  // practice; if anything were ever left, degrade to its own duration —
  // priorities are advisory and must never throw.
  for (const n of nodes) if (!memo.has(n.id)) memo.set(n.id, ownDuration(n))

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
