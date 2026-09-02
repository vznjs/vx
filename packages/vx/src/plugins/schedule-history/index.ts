// History-based scheduling as a plugin: order ready tasks by their expected
// REMAINING critical-path duration (own p50 + the longest chain of
// dependents), learned from the local run history. This was core's opt-in
// `predictive` mode until 2026-09-02; it is the reference `schedule` plugin
// now — declared like any other, and paying its history read only in
// workspaces that ask for it.
//
// Cache hits are NOT modelled as zero-cost: predicting cache state needs
// the key and a probe, which the scheduler handles at run time (a confirmed
// hit is backfill, never a critical-path task). The estimate here is "what
// if everything ran", which is exactly the case where order matters.

import { LocalHistoryProvider, type HistoryTable, type TaskNode, type VxPlugin } from '@vzn/vx'

export const SCHEDULE_HISTORY_PLUGIN = 'vx/schedule-history'

/** Default duration when neither task history nor a workspace median exists. */
const DEFAULT_DURATION_MS = 1000

export interface ScheduleHistoryOptions {
  /** How many recent runs per task to learn from. Default 20. */
  readonly window?: number
}

export function scheduleHistoryPlugin(options: ScheduleHistoryOptions = {}): VxPlugin {
  return {
    name: SCHEDULE_HISTORY_PLUGIN,
    async schedule(nodes, ctx) {
      const provider =
        options.window === undefined
          ? new LocalHistoryProvider(ctx.localCache.dbHandle())
          : new LocalHistoryProvider(ctx.localCache.dbHandle(), options.window)
      let table: HistoryTable
      try {
        table = await provider.loadFor([...nodes.keys()])
      } catch (err) {
        // Failing open: a broken history read costs the ordering, never the run.
        ctx.warn(
          `[vx] schedule-history: falling back to the baseline order: ${err instanceof Error ? err.message : String(err)}`,
        )
        return undefined
      }
      return criticalPathPriorities([...nodes.values()], table)
    },
  }
}

/**
 * For each node, the expected remaining critical-path duration: its own p50
 * plus the maximum over its dependents. A node with no history takes the
 * workspace median; an empty history takes a flat default.
 */
export function criticalPathPriorities(
  nodes: readonly TaskNode[],
  history: HistoryTable,
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
  const ownDuration = (n: TaskNode): number => history.get(n.id)?.p50DurationMs ?? workspaceMedian

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
