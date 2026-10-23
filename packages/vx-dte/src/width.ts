// How many cores the rest of a run keeps busy: its remaining tasks laid
// out as early as their dependencies allow, each for its usual duration,
// on as many cores as they ask. The run starts workers for its work spread
// over its critical path, so it ends near that path: not its peak, which
// a moment fills and leaves workers idle, and not a level held for half its
// length, which one long task stretches until the wide part queues.

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
 * Each task's tail: its usual duration and its longest chain of
 * dependants after it, the most of the run that waits on it starting.
 */
export function tailsMs(
  nodes: ReadonlyMap<string, TaskNode>,
  durationMs: (id: string) => number | undefined,
): (id: string) => number {
  const dependants = new Map<string, string[]>()
  for (const [id, n] of nodes)
    for (const d of n.deps) dependants.set(d, [...(dependants.get(d) ?? []), id])
  const tail = new Map<string, number>()
  const visit = (id: string): number => {
    const known = tail.get(id)
    if (known !== undefined) return known
    tail.set(id, 0)
    const runs = nodes.get(id)?.config.exec?.command !== undefined
    let after = 0
    for (const d of dependants.get(id) ?? []) after = Math.max(after, visit(d))
    const t = after + (runs ? (durationMs(id) ?? UNKNOWN_MS) : 0)
    tail.set(id, t)
    return t
  }
  return visit
}

/**
 * How long the remaining tasks take at the least: their critical path,
 * each for its usual duration. A worker asked for now that warms up
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
  // The most cores in use at once, for workers that cannot come back once they leave.
  peak = false,
  // Only the work from this far on: a worker asked for now joins after its
  // warm-up, so a wide part that ends sooner is not its to fill.
  fromMs = 0,
): number {
  const spans = layout(remaining, nodes, cores, durationMs).flatMap((s) =>
    s.end > fromMs
      ? [{ ...s, start: Math.max(s.start, fromMs) - fromMs, end: s.end - fromMs }]
      : [],
  )
  if (spans.length === 0) return 0
  if (!peak) {
    const span = Math.max(...spans.map((s) => s.end))
    const work = spans.reduce((n, s) => n + s.cores * (s.end - s.start), 0)
    // A task longer than half the path covers its middle wherever it runs
    // in it, so those all run at once: 36 shards of 40 to 75 s spread as
    // work over the slowest queued half of them for a second wave (main,
    // 2026-10-22: 6 of 8 workers, 128 s).
    const long = spans.reduce((n, s) => (2 * (s.end - s.start) > span ? n + s.cores : n), 0)
    return Math.max(1, Math.ceil(work / span), Math.ceil(long))
  }
  // The highest level of cores in use, by a sweep over the starts and ends.
  const edges = spans.flatMap((s) => [
    [s.start, s.cores],
    [s.end, -s.cores],
  ])
  edges.sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)
  let level = 0
  let most = 0
  for (const [, d] of edges) most = Math.max(most, (level += d!))
  return most
}

/** One kind of worker, as `dte()` resolved it: memory in bytes, `max` Infinity when uncapped. */
export interface Size {
  readonly name: string
  readonly max: number
  readonly cpu: number
  readonly memory: number
}

/**
 * The workers to start next, in order: for each task that filled its worker
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
