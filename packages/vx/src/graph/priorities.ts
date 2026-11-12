// The ready-queue ranking, apart from the scheduler. Nothing here touches the
// platform: the site's scheduler simulator bundles these functions for the
// browser.

import type { TaskNode } from './task-graph.js'

/**
 * `computeReverseDepCount` for a run with a restore tier. A restore-tier task
 * never waits on its deps, so it blocks only the exec-tier tasks that depend on
 * it: an exec task's count is taken over the exec tier (through any restore it
 * holds back), and a restore's is the sum over its exec dependents of one plus
 * theirs, plus each dependent restore's weight. The closure over the whole
 * graph cost 6 ms of a warm 476-package run for a ranking restores never
 * needed.
 */
export function tieredReverseDepCount(
  nodes: Map<string, TaskNode>,
  restoreTier: ReadonlySet<string>,
): Map<string, number> {
  const exec = new Map<string, TaskNode>()
  let runsAny = false
  for (const [id, node] of nodes) {
    if (restoreTier.has(id)) continue
    exec.set(id, node)
    if (node.config.exec !== undefined) runsAny = true
  }
  // Nothing outside the restore tier runs a command (a warm run), so no order
  // finishes work sooner: all rank 0 (the weights were 10 ms of a 1,000-project
  // warm run).
  if (!runsAny) {
    const zeros = new Map<string, number>()
    for (const id of nodes.keys()) zeros.set(id, 0)
    return zeros
  }
  // A restore releases its dependents only once its own deps have settled, so
  // an exec task under a restore blocks what that restore feeds (e1 → r → e2).
  // The exec tier is counted with each restore dep replaced by the exec tasks
  // it waits on.
  const view = execThroughRestores(nodes, exec, restoreTier)
  // An exec tier with no edge inside it (a warm run's groups) counts 0
  // everywhere: no closure to build.
  let linked = false
  for (const node of view.values()) {
    if (node.deps.some((d) => view.has(d))) {
      linked = true
      break
    }
  }
  const counts = linked ? computeReverseDepCount(view) : new Map<string, number>()
  if (!linked) for (const id of exec.keys()) counts.set(id, 0)
  let feeds = false
  for (const node of exec.values()) {
    const weight = 1 + counts.get(node.id)!
    for (const dep of node.deps) {
      if (!restoreTier.has(dep) || !nodes.has(dep)) continue
      counts.set(dep, (counts.get(dep) ?? 0) + weight)
      feeds = true
    }
  }
  for (const id of restoreTier) if (nodes.has(id) && !counts.has(id)) counts.set(id, 0)
  if (!feeds) return counts
  // A restore under another restore blocks whatever that one blocks (r1 → r2 →
  // e). Each restore hands its weight to its restore deps, dependents first
  // (Kahn over the reversed restore edges). A diamond counts twice; it is a
  // heuristic, and stays linear. Skipped when no restore feeds an exec task.
  const above = new Map<string, number>()
  for (const id of restoreTier) {
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (restoreTier.has(dep) && nodes.has(dep)) above.set(dep, (above.get(dep) ?? 0) + 1)
    }
  }
  const ready: string[] = []
  for (const id of restoreTier) if (nodes.has(id) && !above.has(id)) ready.push(id)
  while (ready.length > 0) {
    const id = ready.pop()!
    const weight = counts.get(id)!
    for (const dep of nodes.get(id)!.deps) {
      if (!restoreTier.has(dep) || !nodes.has(dep)) continue
      counts.set(dep, counts.get(dep)! + weight)
      const left = above.get(dep)! - 1
      above.set(dep, left)
      if (left === 0) ready.push(dep)
    }
  }
  return counts
}

/**
 * The exec tier with each restore dep replaced by the exec tasks that
 * restore waits on (directly or through other restores). A node with no
 * restore dep is itself; the restore tier is walked once, post-order.
 */
function execThroughRestores(
  nodes: Map<string, TaskNode>,
  exec: Map<string, TaskNode>,
  restoreTier: ReadonlySet<string>,
): Map<string, TaskNode> {
  const isRestore = (id: string): boolean => restoreTier.has(id) && nodes.has(id)
  const below = new Map<string, readonly string[]>()
  const belowOf = (root: string): readonly string[] => {
    const stack: Array<[id: string, depsDone: boolean]> = [[root, false]]
    while (stack.length > 0) {
      const [id, depsDone] = stack.pop()!
      if (below.has(id)) continue
      const deps = nodes.get(id)!.deps
      if (!depsDone) {
        stack.push([id, true])
        for (const d of deps) if (isRestore(d) && !below.has(d)) stack.push([d, false])
        continue
      }
      const out = new Set<string>()
      for (const d of deps) {
        if (exec.has(d)) out.add(d)
        else for (const e of below.get(d) ?? []) out.add(e)
      }
      below.set(id, [...out])
    }
    return below.get(root)!
  }
  let view: Map<string, TaskNode> | undefined
  for (const node of exec.values()) {
    if (!node.deps.some(isRestore)) continue
    const deps = new Set<string>()
    for (const d of node.deps) {
      if (isRestore(d)) for (const e of belowOf(d)) deps.add(e)
      else deps.add(d)
    }
    view ??= new Map(exec)
    view.set(node.id, { ...node, deps: [...deps] })
  }
  return view ?? exec
}

/**
 * For each task, how many other tasks are transitively blocked on it. The
 * highest go first: they unlock the most work and minimize idle workers at the
 * end. Nx ranks by direct dependents only.
 */
export function computeReverseDepCount(
  nodes: ReadonlyMap<string, TaskNode>,
  /** Count only these dependents (the exec tier); every one when absent. */
  counted?: ReadonlyMap<string, unknown>,
): Map<string, number> {
  return reverseDepCountsOver(nodes, [counted])[0]!
}

/**
 * `computeReverseDepCount` per entry of `counted`, from one closure: the
 * closure is the cost (~100 ms at 11k nodes), each count one popcount pass.
 */
function reverseDepCountsOver(
  nodes: ReadonlyMap<string, TaskNode>,
  counted: ReadonlyArray<ReadonlyMap<string, unknown> | undefined>,
): Map<string, number>[] {
  // Exact transitive counts need closure sets (diamonds double-count when
  // summed). String sets are O(N²) and took 8.5s on 1,090 packages; bitsets
  // are O(E·N/32) over N²/8 bits (3,270 tasks ≈ 1.3 MB), single-digit ms.
  const ids = [...nodes.keys()]
  const n = ids.length
  const index = new Map<string, number>()
  for (let i = 0; i < n; i++) index.set(ids[i]!, i)

  // Direct dependents as one flat list (offsets per node) + in-degree.
  const from: number[] = []
  const to: number[] = []
  const offset = new Int32Array(n + 1)
  const indegree = new Uint32Array(n)
  for (let ni = 0; ni < n; ni++) {
    for (const dep of nodes.get(ids[ni]!)!.deps) {
      const di = index.get(dep)
      if (di === undefined) continue
      from.push(di)
      to.push(ni)
      offset[di + 1]!++
      indegree[ni]!++
    }
  }
  for (let i = 0; i < n; i++) offset[i + 1]! += offset[i]!
  const next = offset.slice(0, n)
  const dependents = new Int32Array(from.length)
  for (let e = 0; e < from.length; e++) dependents[next[from[e]!]!++] = to[e]!

  // Kahn topo order: buildTaskGraph's insertion order is topo today, but
  // correctness must not hinge on that.
  const topo = new Int32Array(n)
  let head = 0
  let tail = 0
  for (let i = 0; i < n; i++) if (indegree[i] === 0) topo[tail++] = i
  while (head < tail) {
    const v = topo[head++]!
    for (let k = offset[v]!; k < offset[v + 1]!; k++) {
      const r = dependents[k]!
      if (--indegree[r]! === 0) topo[tail++] = r
    }
  }

  // The same lists by topo POSITION. A dependent sits after its
  // dependency, so a closure holds only bits past its own position.
  const pos = new Int32Array(n)
  for (let t = 0; t < tail; t++) pos[topo[t]!] = t
  const start = new Int32Array(tail + 1)
  for (let t = 0; t < tail; t++) {
    const i = topo[t]!
    start[t + 1] = start[t]! + offset[i + 1]! - offset[i]!
  }
  const rev = new Int32Array(start[tail]!)
  for (let t = 0; t < tail; t++) {
    const i = topo[t]!
    let k = start[t]!
    for (let j = offset[i]!; j < offset[i + 1]!; j++) rev[k++] = pos[dependents[j]!]!
  }
  const words = (tail + 31) >>> 5
  const masks = counted.map((only) => {
    const mask = new Uint32Array(words)
    if (only === undefined) mask.fill(0xffffffff)
    else
      for (let t = 0; t < tail; t++) if (only.has(ids[topo[t]!]!)) mask[t >>> 5]! |= 1 << (t & 31)
    return mask
  })

  // Reverse-topo sweeps, one per block of `span` words, counts summed over
  // blocks. All rows of all words (11.5 MB at 9,603 tasks) missed cache on
  // nearly every OR: 77 ms against 37 ms in ~256 KB blocks.
  const span = Math.max(1, Math.min(words, Math.floor(65536 / Math.max(1, tail))))
  const totals = masks.map(() => new Int32Array(tail))
  const closure = new Uint32Array(tail * span)
  for (let w0 = 0; w0 < words; w0 += span) {
    const width = Math.min(words, w0 + span) - w0
    const end = Math.min(tail, (w0 + width) << 5)
    if (w0 > 0) closure.fill(0, 0, end * span)
    for (let t = end - 1; t >= 0; t--) {
      const base = t * span
      for (let k = start[t]!; k < start[t + 1]!; k++) {
        const r = rev[k]!
        if (r >= end) continue
        const rw = r >>> 5
        if (rw >= w0) closure[base + rw - w0]! |= 1 << (r & 31)
        const rbase = r * span
        for (let w = rw > w0 ? rw - w0 : 0; w < width; w++)
          closure[base + w]! |= closure[rbase + w]!
      }
      for (let m = 0; m < masks.length; m++) {
        const mask = masks[m]!
        let count = 0
        for (let w = t >>> 5 > w0 ? (t >>> 5) - w0 : 0; w < width; w++) {
          let v = closure[base + w]! & mask[w0 + w]!
          if (v === 0) continue
          v = v - ((v >>> 1) & 0x55555555)
          v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
          count += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
        }
        totals[m]![t]! += count
      }
    }
  }
  const all = totals.map((total) => {
    const counts = new Map<string, number>()
    for (let t = 0; t < tail; t++) counts.set(ids[topo[t]!]!, total[t]!)
    // The builder rejects cycles, but a missing entry would sort as undefined,
    // so default to 0.
    for (const id of ids) if (!counts.has(id)) counts.set(id, 0)
    return counts
  })
  return all
}

/**
 * The ready-queue baseline a workspace may pick in place of the default
 * (`schedule` in.vx/workspace.ts). Each ranks with no timings; a `schedule`
 * plugin's weights still sort above it, and it breaks their ties.
 *   - `most-work`: transitive dependents (`computeReverseDepCount`), the default.
 *   - `critical-path`: steps on the longest chain of dependents below a task.
 *   - `direct-dependents`: direct dependents only, Nx's rule.
 *   - `ready-order`: none; the task that became ready first starts first, Turbo's rule.
 */
export type ScheduleStrategy = 'most-work' | 'critical-path' | 'direct-dependents' | 'ready-order'

/** The baseline for a strategy other than `most-work`, over the whole graph. */
export function strategyPriorities(
  nodes: Map<string, TaskNode>,
  strategy: Exclude<ScheduleStrategy, 'most-work'>,
): Map<string, number> {
  const out = new Map<string, number>()
  if (strategy === 'ready-order') {
    for (const id of nodes.keys()) out.set(id, 0)
    return out
  }
  const dependents = new Map<string, string[]>()
  for (const node of nodes.values()) {
    for (const dep of node.deps) {
      if (!nodes.has(dep)) continue
      const list = dependents.get(dep)
      if (list === undefined) dependents.set(dep, [node.id])
      else list.push(node.id)
    }
  }
  if (strategy === 'direct-dependents') {
    for (const id of nodes.keys()) out.set(id, dependents.get(id)?.length ?? 0)
    return out
  }
  // Longest chain below each task, dependents first: a task's depth is one
  // more than its deepest dependent's. Iterative, as a deep chain would
  // overflow a recursive walk.
  const left = new Map<string, number>()
  const ready: string[] = []
  for (const id of nodes.keys()) {
    const n = dependents.get(id)?.length ?? 0
    left.set(id, n)
    if (n === 0) ready.push(id)
  }
  while (ready.length > 0) {
    const id = ready.pop()!
    let depth = 0
    for (const d of dependents.get(id) ?? []) depth = Math.max(depth, out.get(d)! + 1)
    out.set(id, depth)
    for (const dep of nodes.get(id)!.deps) {
      if (!nodes.has(dep)) continue
      const n = left.get(dep)! - 1
      left.set(dep, n)
      if (n === 0) ready.push(dep)
    }
  }
  for (const id of nodes.keys()) if (!out.has(id)) out.set(id, 0)
  return out
}

/**
 * A task's merged weight, read as asked: a merged copy held an entry per
 * task of the run beside the two maps it was made of.
 */
export function mergePriorities(
  baseline: ReadonlyMap<string, number>,
  overrides: ReadonlyMap<string, number>,
): (id: string) => number {
  // The override is a duration in ms, while baseline counts are bounded by N:
  // scale it so it sorts above the baseline, with the baseline as tie-break.
  // The lowest weight maps to one SCALE, not 0, or a 0 ms p50 sank under the
  // unscored nodes it should outrank.
  const SCALE = 1 << 20
  let lo = 0
  for (const w of overrides.values()) if (w < lo) lo = w
  return (id) => {
    const b = baseline.get(id) ?? 0
    const w = overrides.get(id)
    return w === undefined ? b : (w - lo + 1) * SCALE + b
  }
}
