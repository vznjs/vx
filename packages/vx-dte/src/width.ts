// How many cores the rest of a run keeps busy: its remaining tasks laid
// out as early as their dependencies allow, each for its usual duration,
// on as many cores as they ask. The run starts agents for the most cores
// in use at once for at least half of what is left, not for its peak: a
// core the run fills for a moment is an agent mostly idle.

import type { TaskNode } from '@vzn/vx'

/** A task's duration when history has none. */
const UNKNOWN_MS = 1_000

export function busyCores(
  remaining: ReadonlySet<string>,
  nodes: ReadonlyMap<string, TaskNode>,
  cores: (id: string) => number,
  durationMs: (id: string) => number | undefined,
): number {
  const end = new Map<string, number>()
  const spans: Array<{ start: number; end: number; cores: number }> = []
  const visit = (id: string): number => {
    const known = end.get(id)
    if (known !== undefined) return known
    // Done: ready now.
    if (!remaining.has(id)) return 0
    // Before the graph is known, a task stands alone.
    const node = nodes.get(id)
    end.set(id, 0)
    let start = 0
    for (const d of node?.deps ?? []) start = Math.max(start, visit(d))
    const runs = node === undefined || node.config.exec?.command !== undefined
    const t = start + (runs ? (durationMs(id) ?? UNKNOWN_MS) : 0)
    end.set(id, t)
    if (runs && t > start) spans.push({ start, end: t, cores: cores(id) })
    return t
  }
  for (const id of remaining) visit(id)
  if (spans.length === 0) return 0
  // Time at each level of cores in use, by a sweep over the starts and ends.
  const edges = spans.flatMap((s) => [
    [s.start, s.cores],
    [s.end, -s.cores],
  ])
  edges.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)
  const atLeast = new Map<number, number>()
  let level = 0
  let last = 0
  for (const [t, d] of edges) {
    if (t! > last && level > 0) atLeast.set(level, (atLeast.get(level) ?? 0) + (t! - last))
    level += d!
    last = t!
  }
  const span = Math.max(...spans.map((s) => s.end))
  // Time with at least L in use, from the top level down.
  let held = 0
  for (const l of [...atLeast.keys()].sort((a, b) => b - a)) {
    held += atLeast.get(l)!
    if (held * 2 >= span) return l
  }
  return 1
}
