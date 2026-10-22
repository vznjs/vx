// How many cores the rest of a run keeps busy: its remaining tasks laid
// out as early as their dependencies allow, each for its usual duration,
// on as many cores as they ask. The run starts agents for the most cores
// in use at once for at least half of what is left, not for its peak: a
// core the run fills for a moment is an agent mostly idle.

import type { TaskNode } from '@vzn/vx'

/** A task's duration when history has none. */
const UNKNOWN_MS = 1_000

type Span = { start: number; end: number; cores: number }

/** The remaining tasks laid out as early as their dependencies allow, on unbounded cores. */
function layout(
  remaining: ReadonlySet<string>,
  nodes: ReadonlyMap<string, TaskNode>,
  cores: (id: string) => number,
  durationMs: (id: string) => number | undefined,
): Span[] {
  const end = new Map<string, number>()
  const spans: Span[] = []
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
  return spans
}

/**
 * How long the remaining tasks take at the least: their critical path,
 * each for its usual duration. An agent asked for now that warms up
 * longer than this joins a run with nothing left for it.
 */
export function endsInMs(
  remaining: ReadonlySet<string>,
  nodes: ReadonlyMap<string, TaskNode>,
  durationMs: (id: string) => number | undefined,
): number {
  return Math.max(0, ...layout(remaining, nodes, () => 1, durationMs).map((s) => s.end))
}

export function busyCores(
  remaining: ReadonlySet<string>,
  nodes: ReadonlyMap<string, TaskNode>,
  cores: (id: string) => number,
  durationMs: (id: string) => number | undefined,
  // Of what is left, the share a level must hold; 0 is the peak.
  share = 0.5,
  // Only the work from this far on: an agent asked for now joins after its
  // warm-up, so a wide part that ends sooner is not its to fill.
  fromMs = 0,
): number {
  const spans = layout(remaining, nodes, cores, durationMs).flatMap((s) =>
    s.end > fromMs
      ? [{ ...s, start: Math.max(s.start, fromMs) - fromMs, end: s.end - fromMs }]
      : [],
  )
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
    if (held >= share * span) return l
  }
  return 1
}

/** One kind of agent, as `dte()` resolved it: memory in bytes, `max` Infinity when uncapped. */
export interface Size {
  readonly name: string
  readonly max: number
  readonly cpu: number
  readonly memory: number
}

/**
 * The agents to start next, in order: for each task that filled its agent
 * last time (`above`), one of the smallest size bigger than it while the
 * run has none of that size; then sizes in declared order while the cores
 * started fall short of `wantCores`.
 */
export function toStart(
  sizes: readonly Size[],
  started: ReadonlyMap<string, number>,
  cores: number,
  wantCores: number,
  above: Iterable<{ cores: number; memory: number }>,
): Size[] {
  const count = new Map(started)
  const out: Size[] = []
  const add = (s: Size): void => {
    count.set(s.name, (count.get(s.name) ?? 0) + 1)
    cores += s.cpu
    out.push(s)
  }
  const up = [...sizes].sort((x, y) => x.cpu - y.cpu || x.memory - y.memory)
  for (const a of above) {
    const z = up.find((s) => s.cpu > a.cores || s.memory > a.memory)
    if (z !== undefined && (count.get(z.name) ?? 0) === 0 && z.max > 0) add(z)
  }
  for (const s of sizes) while (cores < wantCores && (count.get(s.name) ?? 0) < s.max) add(s)
  return out
}
