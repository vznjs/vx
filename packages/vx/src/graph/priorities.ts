// The ready-queue ranking, apart from the scheduler that uses it. Nothing
// here touches the platform: the Learn page's scheduler simulator
// (packages/vx-docs, through packages/vx-bench/schedule-policy.ts) bundles
// these two functions for the browser, and an import of the scheduler would
// bring `util/` and its load-time `Bun` reads with them.

import type { TaskNode } from './task-graph.js'

/**
 * Compute, for each task in the graph, how many OTHER tasks are
 * transitively blocked on it. Tasks with the highest count are the
 * most valuable to schedule first — finishing them unlocks the most
 * downstream work and minimizes worker idle time at the end of the
 * run. Nx's schedule sort ranks by the same idea but counts DIRECT
 * dependents only (`calculateReverseDeps` in
 * `packages/nx/src/tasks-runner/utils.ts`, read 2026-09-24).
 */
export function computeReverseDepCount(nodes: Map<string, TaskNode>): Map<string, number> {
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
  // before its dependency folds it in. closure[i] = bitset over node
  // indices of i's transitive dependents.
  const closure = new Uint32Array(n * words)
  const counts = new Map<string, number>()
  for (let t = tail - 1; t >= 0; t--) {
    const i = topo[t]!
    const base = i * words
    for (const r of directReverse[i]!) {
      closure[base + (r >>> 5)]! |= 1 << (r & 31)
      const rbase = r * words
      for (let w = 0; w < words; w++) closure[base + w]! |= closure[rbase + w]!
    }
    let count = 0
    for (let w = 0; w < words; w++) {
      let v = closure[base + w]!
      v = v - ((v >>> 1) & 0x55555555)
      v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
      count += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
    }
    counts.set(ids[i]!, count)
  }
  // Cycle-stranded nodes (never topo-visited) can't occur — the graph
  // builder rejects cycles — but a missing Map entry would silently
  // sort as undefined, so default them defensively to 0.
  for (const id of ids) if (!counts.has(id)) counts.set(id, 0)
  return counts
}

export function mergePriorities(
  baseline: ReadonlyMap<string, number>,
  overrides: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  // The override caller scored "expected critical-path duration" in ms.
  // Baseline reverse-deps counts are bounded by N; scale the override so
  // it sorts above the baseline for any node it covers, and add the
  // baseline as a tie-break for parity within the override set.
  const SCALE = 1 << 20
  const out = new Map<string, number>()
  for (const [id, w] of baseline) out.set(id, w)
  for (const [id, w] of overrides) {
    const b = baseline.get(id) ?? 0
    out.set(id, w * SCALE + b)
  }
  return out
}
