// The ready-queue ranking, apart from the scheduler that uses it. Nothing
// here touches the platform: the Learn page's scheduler simulator
// (private/vx-docs, through private/vx-bench/schedule-policy.ts) bundles
// these two functions for the browser, and an import of the scheduler would
// bring `util/` and its load-time `Bun` reads with them.

import type { TaskNode } from './task-graph.js'

/**
 * `computeReverseDepCount` for a run with a restore tier (item 754). A
 * restore-tier task is a confirmed hit that never waits on its deps, so it
 * blocks only the exec-tier tasks that depend on it: an exec-tier task's
 * count is taken over the exec tier, an edge through a restore it holds
 * back counted too, and a restore's
 * is the sum over its direct exec-tier dependents of one plus theirs, plus
 * the weight of each restore that depends on it, so a restore that feeds
 * pending work, directly or through other restores, still goes first. A warm run's exec tier
 * is its group tasks with no edges among them, and the closure over the
 * whole graph (476 packages: 1,428 nodes, 12.8k edges of 45-word bitsets)
 * was 6 ms of the run-graph stage for a ranking the restores never needed.
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
  // Nothing outside the restore tier runs a command (a warm run: restores
  // and groups), so no order finishes any work sooner: everything ranks 0.
  // The weights below were 10 ms of a 1,000-project warm run.
  if (!runsAny) {
    const zeros = new Map<string, number>()
    for (const id of nodes.keys()) zeros.set(id, 0)
    return zeros
  }
  // A restore releases its dependents only once its own deps have settled
  // (scheduler.ts, item 963), so an exec task under a restore blocks what
  // that restore feeds: e1 → r → e2 held e2 until e1 ran, and e1 ranked 0
  // behind every idle task. The exec tier is counted with each restore dep
  // replaced by the exec tasks it waits on, through restores.
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
  // A restore's dependents are released only once its own deps have
  // settled (scheduler.ts, item 963), so a restore under another restore
  // blocks whatever that one blocks: r1 → r2 → e held e until r1 restored,
  // and r1 ranked 0 behind every idle restore (C-51). Each restore hands
  // its weight to its restore deps, dependents first (Kahn over the
  // restore tier's reversed edges). A diamond counts twice; the order
  // among restores is a heuristic, and this pass stays linear. A run with
  // no restore feeding an exec task (every task a hit) skips it.
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
 * Compute, for each task in the graph, how many OTHER tasks are
 * transitively blocked on it. Tasks with the highest count are the
 * most valuable to schedule first — finishing them unlocks the most
 * downstream work and minimizes worker idle time at the end of the
 * run. Nx's schedule sort ranks by the same idea but counts DIRECT
 * dependents only (`calculateReverseDeps` in
 * `packages/nx/src/tasks-runner/utils.ts`, read 2026-09-24).
 */
export function computeReverseDepCount(
  nodes: ReadonlyMap<string, TaskNode>,
  /** Count only these dependents (the exec tier); every one when absent. */
  counted?: ReadonlyMap<string, unknown>,
): Map<string, number> {
  return reverseDepCountsOver(nodes, [counted])[0]!
}

/**
 * `computeReverseDepCount` once per entry of `counted`, from ONE closure:
 * the closure is the cost (~100 ms at 11k nodes, 2026-10-29), each count
 * one popcount pass over it.
 */
export function reverseDepCountsOver(
  nodes: ReadonlyMap<string, TaskNode>,
  counted: ReadonlyArray<ReadonlyMap<string, unknown> | undefined>,
): Map<string, number>[] {
  // Exact transitive-dependent COUNTS need closure SETS (diamonds
  // double-count under naive summing). Set-of-strings closures are
  // O(N²) entries and took 8.5s on a 1090-package, 100-layer repo;
  // bitsets make the same closure O(E·N/32) time and N²/8 bits of
  // memory (3270 tasks ≈ 1.3 MB) — single-digit ms at that scale.
  const ids = [...nodes.keys()]
  const index = new Map<string, number>()
  for (let i = 0; i < ids.length; i++) index.set(ids[i]!, i)
  const n = ids.length
  const words = (n + 31) >>> 5

  // Direct dependents as index lists + in-degree for the topo pass.
  const directReverse: number[][] = Array.from({ length: n }, () => [])
  const indegree = new Uint32Array(n)
  for (const node of nodes.values()) {
    const ni = index.get(node.id)!
    for (const dep of node.deps) {
      const di = index.get(dep)
      if (di === undefined) continue
      directReverse[di]!.push(ni)
      indegree[ni]!++
    }
  }

  // Kahn topo order over dependency edges (deps before dependents).
  // Insertion order is topo today, but the closure's correctness
  // must not hinge on an unstated property of buildTaskGraph.
  const topo = new Int32Array(n)
  let head = 0
  let tail = 0
  for (let i = 0; i < n; i++) if (indegree[i] === 0) topo[tail++] = i
  while (head < tail) {
    const v = topo[head++]!
    for (const r of directReverse[v]!) {
      if (--indegree[r]! === 0) topo[tail++] = r
    }
  }

  // Reverse-topo sweep: every direct dependent's closure is final
  // before its dependency folds it in. closure[t] = bitset over topo
  // POSITIONS of the node at position t's transitive dependents. A
  // dependent sits after its dependency, so a closure holds only bits
  // past its own position, and each OR starts at the dependent's word:
  // half the words of indexing by insertion order on a layered graph.
  const pos = new Int32Array(n)
  for (let t = 0; t < tail; t++) pos[topo[t]!] = t
  const masks = counted.map((only) => {
    const mask = new Uint32Array(words)
    if (only === undefined) mask.fill(0xffffffff)
    else
      for (let t = 0; t < tail; t++) if (only.has(ids[topo[t]!]!)) mask[t >>> 5]! |= 1 << (t & 31)
    return mask
  })
  const closure = new Uint32Array(n * words)
  const all = masks.map(() => new Map<string, number>())
  for (let t = tail - 1; t >= 0; t--) {
    const i = topo[t]!
    const base = t * words
    for (const ri of directReverse[i]!) {
      const r = pos[ri]!
      closure[base + (r >>> 5)]! |= 1 << (r & 31)
      const rbase = r * words
      for (let w = r >>> 5; w < words; w++) closure[base + w]! |= closure[rbase + w]!
    }
    for (let m = 0; m < masks.length; m++) {
      const mask = masks[m]!
      let count = 0
      for (let w = t >>> 5; w < words; w++) {
        let v = closure[base + w]! & mask[w]!
        v = v - ((v >>> 1) & 0x55555555)
        v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
        count += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
      }
      all[m]!.set(ids[i]!, count)
    }
  }
  // Cycle-stranded nodes (never topo-visited) can't occur — the graph
  // builder rejects cycles — but a missing Map entry would silently
  // sort as undefined, so default them defensively to 0.
  for (const counts of all) for (const id of ids) if (!counts.has(id)) counts.set(id, 0)
  return all
}

/**
 * The ready-queue baseline a workspace may pick in place of the default
 * (`schedule` in .vx/workspace.ts). Each ranks with no timings; a `schedule`
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

export function mergePriorities(
  baseline: ReadonlyMap<string, number>,
  overrides: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  // The override caller scored "expected critical-path duration" in ms.
  // Baseline reverse-deps counts are bounded by N; scale the override so
  // it sorts above the baseline for any node it covers, and add the
  // baseline as a tie-break for parity within the override set.
  // The lowest weight maps to one SCALE, not to 0: a weight of 0 (a p50
  // that rounds to 0 ms) or below otherwise tied or sank under the
  // unscored nodes it is meant to outrank.
  const SCALE = 1 << 20
  let lo = 0
  for (const w of overrides.values()) if (w < lo) lo = w
  const out = new Map(baseline)
  for (const [id, w] of overrides) {
    const b = baseline.get(id) ?? 0
    out.set(id, (w - lo + 1) * SCALE + b)
  }
  return out
}
