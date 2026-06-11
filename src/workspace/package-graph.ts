import type { ProjectMeta } from './workspace.js'

export interface PackageGraph {
  /** All transitive workspace deps for each project. */
  transitiveDeps: (name: string) => string[]
  /** All transitive workspace dependents (packages that depend on the named one). */
  transitiveDependents: (name: string) => string[]
}

export function buildPackageGraph(projects: ProjectMeta[]): PackageGraph {
  const byName = new Map<string, ProjectMeta>()
  for (const p of projects) byName.set(p.name, p)

  const directDeps = new Map<string, string[]>()
  for (const p of projects) {
    const seen = new Set<string>()
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ] as const) {
      const obj = p.packageJson[field]
      if (!obj) continue
      for (const name of Object.keys(obj)) {
        if (name === p.name) continue
        if (byName.has(name)) seen.add(name)
      }
    }
    directDeps.set(p.name, [...seen].sort())
  }

  // Reverse adjacency: who declares X as a workspace dep.
  const directDependents = new Map<string, string[]>()
  for (const [name, deps] of directDeps) {
    for (const d of deps) {
      const arr = directDependents.get(d)
      if (arr) arr.push(name)
      else directDependents.set(d, [name])
    }
  }
  for (const arr of directDependents.values()) arr.sort()

  // Set-union DFS closures are O(P²) entries on dense layered graphs
  // (same disease the scheduler's reachOf had — 68 ms at 1090
  // projects). Bitset closures swept in topo order are O(E·P/32),
  // and indexing projects in sorted-name order means materializing a
  // closure is a single ascending bit-scan — already sorted, no
  // per-call sort. Package graphs (unlike task graphs) may legally
  // contain cycles; the bitset sweep requires a DAG, so a cycle
  // (detected by the Kahn pass not draining) falls back wholesale to
  // the legacy DFS — byte-identical behavior for that rare case.
  const names = [...byName.keys()].sort()
  const index = new Map<string, number>()
  for (let i = 0; i < names.length; i++) index.set(names[i]!, i)

  function bitsetClosures(edges: Map<string, string[]>): Uint32Array | null {
    const n = names.length
    const words = (n + 31) >>> 5
    const adj: number[][] = Array.from({ length: n }, () => [])
    const indegree = new Uint32Array(n)
    for (const [from, tos] of edges) {
      const fi = index.get(from)!
      for (const to of tos) {
        const ti = index.get(to)
        if (ti === undefined) continue
        adj[fi]!.push(ti) // edge from → to; closure(from) ⊇ {to} ∪ closure(to)
        indegree[ti]!++
      }
    }
    const topo = new Int32Array(n)
    let head = 0
    let tail = 0
    for (let i = 0; i < n; i++) if (indegree[i] === 0) topo[tail++] = i
    while (head < tail) {
      const v = topo[head++]!
      for (const t of adj[v]!) if (--indegree[t]! === 0) topo[tail++] = t
    }
    if (tail < n) return null // cycle — caller falls back to DFS
    const closure = new Uint32Array(n * words)
    for (let t = tail - 1; t >= 0; t--) {
      const i = topo[t]!
      const base = i * words
      for (const d of adj[i]!) {
        closure[base + (d >>> 5)]! |= 1 << (d & 31)
        const dbase = d * words
        for (let w = 0; w < words; w++) closure[base + w]! |= closure[dbase + w]!
      }
    }
    return closure
  }

  function legacyTransitive(
    name: string,
    edges: Map<string, string[]>,
    cache: Map<string, string[]>,
    stack: Set<string> = new Set(),
  ): string[] {
    const cached = cache.get(name)
    if (cached) return cached
    if (stack.has(name)) return []
    stack.add(name)
    const out = new Set<string>()
    for (const d of edges.get(name) ?? []) {
      out.add(d)
      for (const t of legacyTransitive(d, edges, cache, stack)) out.add(t)
    }
    stack.delete(name)
    const result = [...out].sort()
    cache.set(name, result)
    return result
  }

  function makeAccessor(edges: Map<string, string[]>): (name: string) => string[] {
    const closures = bitsetClosures(edges)
    const memo = new Map<string, string[]>()
    if (closures === null) {
      return (name) => legacyTransitive(name, edges, memo)
    }
    const words = (names.length + 31) >>> 5
    return (name) => {
      const cached = memo.get(name)
      if (cached) return cached
      const i = index.get(name)
      if (i === undefined) return []
      const base = i * words
      const out: string[] = []
      for (let w = 0; w < words; w++) {
        let v = closures[base + w]!
        while (v !== 0) {
          const bit = 31 - Math.clz32(v & -v)
          out.push(names[(w << 5) + bit]!)
          v &= v - 1
        }
      }
      memo.set(name, out)
      return out
    }
  }

  return {
    transitiveDeps: makeAccessor(directDeps),
    transitiveDependents: makeAccessor(directDependents),
  }
}
