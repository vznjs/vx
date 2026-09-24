// The critical-path score, apart from the plugin that feeds it to the
// scheduler. It imports only types, so the Learn page's scheduler simulator
// (through packages/vx-bench/schedule-policy.ts) bundles it for the browser
// without the rest of `@vzn/vx`.

import type { HistoryTable, TaskNode } from '@vzn/vx'

/** Default duration when neither task history nor a workspace median exists. */
const DEFAULT_DURATION_MS = 1000

/**
 * For each node, the expected remaining critical-path duration: its own p50
 * plus the maximum over its dependents. A node with no history takes its
 * assumed duration if one was given, else the workspace median; an empty
 * history takes a flat default.
 */
export function criticalPathPriorities(
  nodes: readonly TaskNode[],
  history: HistoryTable,
  assume: Readonly<Record<string, number>> = {},
): ReadonlyMap<string, number> {
  const p50s: number[] = []
  for (const h of history.values()) {
    if (h.p50DurationMs !== undefined) p50s.push(h.p50DurationMs)
  }
  p50s.sort((a, b) => a - b)
  const workspaceMedian =
    p50s.length > 0
      ? (p50s[Math.floor(p50s.length / 2)] ?? DEFAULT_DURATION_MS)
      : DEFAULT_DURATION_MS

  const dependentsOf = new Map<string, string[]>()
  for (const n of nodes) {
    for (const upstreamId of n.deps) {
      const list = dependentsOf.get(upstreamId)
      if (list) list.push(n.id)
      else dependentsOf.set(upstreamId, [n.id])
    }
  }
  const ownDuration = (n: TaskNode): number =>
    history.get(n.id)?.p50DurationMs ?? assume[n.id] ?? workspaceMedian

  // Reverse-topological pass: a node's value is final once every dependent's
  // is, so start from the sinks (no dependents) and release each upstream
  // when its last dependent has been scored.
  const memo = new Map<string, number>()
  const nodeById = new Map<string, TaskNode>(nodes.map((n) => [n.id, n]))
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
  for (const n of nodes) if (!memo.has(n.id)) memo.set(n.id, ownDuration(n))
  return memo
}
