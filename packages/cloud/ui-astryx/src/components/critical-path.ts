// Pure critical-path + parallelism analysis for the run cockpit.
//
// The critical path is the longest-DURATION dependency chain through the DAG —
// the wall-time floor no amount of parallelism can beat. Given the run's nodes
// (id + deps) and a per-node duration map (ms), we compute, for each node, the
// best (longest) finishing time among all chains ending at it, then walk back
// from the worst finisher to recover the ordered chain. O(N + E) over a topo
// order; cycles (the DAG shouldn't have them, but guard) are broken by skipping
// any edge that revisits an in-progress node.

export interface CriticalPathInput {
  id: string
  deps: readonly string[]
}

export interface CriticalPath {
  /** Node ids on the longest-duration dependency chain, dependency-first order. */
  chain: string[]
  /** Sum of the chain's per-node durations (ms). */
  totalMs: number
}

/**
 * Longest-duration dependency chain through the DAG.
 *
 * `durationMs(id)` returns the node's own cost (0 when unknown). A node with no
 * deps starts at t=0; a node's finish is its own duration plus the max finish
 * among its (known) deps. The chain is the back-trace from the node with the
 * greatest finish.
 *
 * `independent(id)` (optional) marks a node whose start is NOT gated by its
 * deps — a stable cache HIT restored ahead of the schedule (the two-tier
 * scheduler's restore tier). Such a node's restore needs none of its deps'
 * output, so it starts at t=0 regardless of `deps`: its chain begins fresh at
 * itself. Without this, a cached dependent inflates the "floor" by the runtime
 * of an upstream it never actually waited for (e.g. `docs#build` restoring in
 * parallel with a slow `docs#import` was reported as `import + build` summed).
 */
export function criticalPath(
  nodes: readonly CriticalPathInput[],
  durationMs: (id: string) => number,
  independent?: (id: string) => boolean,
): CriticalPath {
  if (nodes.length === 0) return { chain: [], totalMs: 0 }

  const byId = new Map(nodes.map((n) => [n.id, n]))
  // best[id] = greatest finish time of any chain ending at id.
  const best = new Map<string, number>()
  // prev[id] = the dep that produced best[id] (for back-tracing), or null.
  const prev = new Map<string, string | null>()
  const visiting = new Set<string>()

  const finish = (id: string): number => {
    const cached = best.get(id)
    if (cached !== undefined) return cached
    if (visiting.has(id)) return 0 // cycle guard — skip the back-edge
    visiting.add(id)
    let bestDep = -1
    let bestDepId: string | null = null
    // A dependency-independent node (a cache hit restored ahead of its deps)
    // ignores its deps' finish times — its chain starts fresh at itself.
    if (independent?.(id) !== true) {
      for (const dep of byId.get(id)?.deps ?? []) {
        if (!byId.has(dep)) continue // dep outside this node set
        const f = finish(dep)
        if (f > bestDep) {
          bestDep = f
          bestDepId = dep
        }
      }
    }
    visiting.delete(id)
    const own = Math.max(0, durationMs(id))
    const total = (bestDep < 0 ? 0 : bestDep) + own
    best.set(id, total)
    prev.set(id, bestDepId)
    return total
  }

  let endId: string | null = null
  let endVal = -1
  for (const n of nodes) {
    const f = finish(n.id)
    if (f > endVal) {
      endVal = f
      endId = n.id
    }
  }

  const chain: string[] = []
  let cur = endId
  const seen = new Set<string>()
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    seen.add(cur)
    chain.push(cur)
    cur = prev.get(cur) ?? null
  }
  chain.reverse() // dependency-first order

  return { chain, totalMs: endVal < 0 ? 0 : endVal }
}

export interface ParallelismStats {
  /** Maximum number of tasks observed running at the same instant. */
  maxConcurrent: number
  /** Wall-clock span of the run window (ms). */
  spanMs: number
  /** Sum of all per-task busy time (ms). */
  busyMs: number
}

/**
 * Observed concurrency from per-task [start, end] windows (epoch ms). A sweep
 * over interval endpoints finds the peak overlap; busy/span gives an average
 * occupancy hint. Open-ended (still-running) tasks should pass `end = now`.
 */
export function parallelism(
  intervals: readonly { startedAt: number; endedAt: number }[],
): ParallelismStats {
  if (intervals.length === 0) return { maxConcurrent: 0, spanMs: 0, busyMs: 0 }
  // +1 at each start, -1 at each end; ties resolve ends before starts so two
  // tasks that merely touch (one ends exactly when the next starts) don't read
  // as concurrent.
  const events: { t: number; delta: number }[] = []
  let busyMs = 0
  let minStart = Infinity
  let maxEnd = -Infinity
  for (const iv of intervals) {
    const start = iv.startedAt
    const end = Math.max(iv.startedAt, iv.endedAt)
    events.push({ t: start, delta: 1 })
    events.push({ t: end, delta: -1 })
    busyMs += end - start
    if (start < minStart) minStart = start
    if (end > maxEnd) maxEnd = end
  }
  events.sort((a, b) => (a.t === b.t ? a.delta - b.delta : a.t - b.t))
  let cur = 0
  let max = 0
  for (const e of events) {
    cur += e.delta
    if (cur > max) max = cur
  }
  return { maxConcurrent: max, spanMs: Math.max(0, maxEnd - minStart), busyMs }
}
