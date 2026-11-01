// The critical-path score a `schedule` plugin feeds the scheduler, from
// whatever timings it learned. It imports only types, so the Learn page's
// scheduler simulator (through private/vx-bench/schedule-policy.ts) bundles
// it for the browser without the rest of `@vzn/vx`.

import type { TaskNode } from './task-graph.js'

/** Default duration when neither task history nor a workspace median exists. */
const DEFAULT_DURATION_MS = 1000

/**
 * For each node, the expected remaining critical-path duration: its own p50
 * plus the maximum over its dependents. A node with no history takes its
 * assumed duration if one was given, else the workspace median; an empty
 * history takes a flat default.
 */
export function criticalPath(
  nodes: readonly TaskNode[],
  history: ReadonlyMap<string, { readonly p50DurationMs?: number | undefined }>,
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

  // Integer ids and flat arrays: Maps keyed by id strings and an array per
  // node were 53 ms of a 9,603-task run's schedule stage (2026-11-01).
  const count = nodes.length
  const index = new Map<string, number>()
  for (let i = 0; i < count; i++) index.set(nodes[i]!.id, i)
  // Each node's dependents, as one flat list sliced by `first`.
  const ups: number[] = []
  const first = new Int32Array(count + 1)
  for (let i = 0; i < count; i++) {
    for (const up of nodes[i]!.deps) {
      const u = index.get(up)
      if (u === undefined) continue
      first[u + 1]!++
      ups.push(u, i)
    }
  }
  for (let i = 0; i < count; i++) first[i + 1]! += first[i]!
  const next = first.slice(0, count)
  const dependents = new Int32Array(ups.length / 2)
  for (let e = 0; e < ups.length; e += 2) dependents[next[ups[e]!]!++] = ups[e + 1]!
  // A group runs nothing, so it has no history; the median would charge it
  // a whole task and let a gate outrank the longest chain (PR #3286).
  const ownDuration = (n: TaskNode): number =>
    n.config.exec?.command === undefined
      ? 0
      : (history.get(n.id)?.p50DurationMs ?? assume[n.id] ?? workspaceMedian)

  // Reverse-topological pass: a node's value is final once every dependent's
  // is, so start from the sinks (no dependents) and release each upstream
  // when its last dependent has been scored.
  const score = new Float64Array(count)
  const scored = new Uint8Array(count)
  const pending = new Int32Array(count)
  const queue = new Int32Array(count)
  let tail = 0
  for (let i = 0; i < count; i++) {
    pending[i] = first[i + 1]! - first[i]!
    if (pending[i] === 0) queue[tail++] = i
  }
  for (let head = 0; head < tail; head++) {
    const i = queue[head]!
    let downstream = 0
    for (let e = first[i]!; e < first[i + 1]!; e++) {
      const d = score[dependents[e]!]!
      if (d > downstream) downstream = d
    }
    score[i] = ownDuration(nodes[i]!) + downstream
    scored[i] = 1
    for (const up of nodes[i]!.deps) {
      const u = index.get(up)
      if (u !== undefined && --pending[u]! === 0) queue[tail++] = u
    }
  }
  const memo = new Map<string, number>()
  for (let head = 0; head < tail; head++) memo.set(nodes[queue[head]!]!.id, score[queue[head]!]!)
  // A node on a cycle is never released: its own duration.
  for (let i = 0; i < count; i++)
    if (scored[i] === 0) memo.set(nodes[i]!.id, ownDuration(nodes[i]!))
  return memo
}
