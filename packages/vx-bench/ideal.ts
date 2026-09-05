// The theoretical best case for the benchmark's cold run: the tasks' own
// durations list-scheduled on N workers along the exact dependency graph.
// Critical-path-first (longest remaining path to a sink), because a FIFO
// list schedule starts a layer's tests before its builds and starves the
// next layer — measured 4m 58s against vx's own 3m 46s (2026-09-03). With
// uniform durations the greedy schedule is never below the true lower bound
// max(critical path, total work / workers) and never above the work bound
// by more than one task; `listSchedule` asserts both.

export interface GraphNode {
  id: string
  /** Duration in ms; 0 for a pure ordering node. */
  dur: number
  /** Indices of the nodes this one waits for. */
  deps: number[]
}

export interface Schedule {
  /** The greedy critical-path-first makespan in ms. */
  makespan: number
  /** The longest path by duration — the floor no scheduler can beat. */
  critical: number
  /** Total work in ms (sum of durations). */
  work: number
}

export function listSchedule(nodes: readonly GraphNode[], workers: number): Schedule {
  const succ: number[][] = nodes.map(() => [])
  const indeg: number[] = nodes.map((n) => n.deps.length)
  nodes.forEach((n, i) => {
    for (const d of n.deps) succ[d]!.push(i)
  })
  // Topological order.
  const order: number[] = []
  const q = nodes.map((_, i) => i).filter((i) => indeg[i] === 0)
  const remainingIn = [...indeg]
  while (q.length > 0) {
    const i = q.shift()!
    order.push(i)
    for (const s of succ[i]!) if (--remainingIn[s]! === 0) q.push(s)
  }
  if (order.length !== nodes.length) throw new Error('listSchedule: the graph has a cycle')
  // Critical path (top-down) and bottom level (bottom-up).
  const dist: number[] = Array.from({ length: nodes.length }, () => 0)
  for (const i of order) {
    dist[i] = Math.max(dist[i]!, nodes[i]!.dur)
    for (const s of succ[i]!) dist[s] = Math.max(dist[s]!, dist[i]! + nodes[s]!.dur)
  }
  const critical = nodes.length === 0 ? 0 : Math.max(...dist)
  const work = nodes.reduce((a, n) => a + n.dur, 0)
  const level: number[] = Array.from({ length: nodes.length }, () => 0)
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k]!
    let best = 0
    for (const s of succ[i]!) best = Math.max(best, level[s]!)
    level[i] = nodes[i]!.dur + best
  }
  // Greedy critical-path-first list schedule: an event simulation.
  const ready: number[] = nodes.map((_, i) => i).filter((i) => indeg[i] === 0)
  const remaining = [...indeg]
  const running: Array<{ end: number; node: number }> = []
  let now = 0
  let makespan = 0
  const takeReady = (): number => {
    let bi = 0
    for (let k = 1; k < ready.length; k++) if (level[ready[k]!]! > level[ready[bi]!]!) bi = k
    return ready.splice(bi, 1)[0]!
  }
  const finish = (node: number): void => {
    for (const s of succ[node]!) if (--remaining[s]! === 0) ready.push(s)
  }
  while (ready.length > 0 || running.length > 0) {
    while (ready.length > 0 && running.length < workers) {
      const i = takeReady()
      running.push({ end: now + nodes[i]!.dur, node: i })
    }
    if (running.length === 0) break
    running.sort((a, b) => a.end - b.end)
    const next = running.shift()!
    now = next.end
    makespan = Math.max(makespan, now)
    finish(next.node)
    while (running.length > 0 && running[0]!.end === now) finish(running.shift()!.node)
  }
  const lower = Math.max(critical, work / workers)
  const maxDur = nodes.reduce((a, n) => Math.max(a, n.dur), 0)
  if (makespan < lower - 1e-6 || makespan > work / workers + critical + maxDur) {
    throw new Error(
      `listSchedule: makespan ${makespan} outside [${lower}, work/workers + critical + one task]`,
    )
  }
  return { makespan, critical, work }
}
