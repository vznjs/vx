import type { ProjectMeta } from './workspace.js'

export interface PackageGraph {
  /** Immediate workspace deps the package builds AFTER (sorted): every bucket but peers. */
  directDeps: (name: string) => string[]
  /** All transitive workspace deps a change can reach the package through — peers included. */
  transitiveDeps: (name: string) => string[]
  /** All transitive workspace dependents (packages a change here can reach) — peers included. */
  transitiveDependents: (name: string) => string[]
}

/**
 * `taskEdges`: project → the projects its tasks name in a cross-project
 * `dependsOn` (`e2e` → `app` from `dependsOn: ['app#build']`). A dependent
 * the manifest does not know but the task graph does; without it
 * `--filter '...app'` never selected `e2e`, and a CI that runs "what
 * changed and everything depending on it" silently left it out
 * (2026-09-10). The `^task` walk still reads `directDeps`, which carries
 * both — a task edge IS a dependency.
 */
export function buildPackageGraph(
  projects: ProjectMeta[],
  taskEdges?: ReadonlyMap<string, readonly string[]>,
): PackageGraph {
  const byName = new Map<string, ProjectMeta>()
  for (const p of projects) byName.set(p.name, p)

  // Two adjacencies. ORDER (`directDeps`, the `^task` walk) is what the
  // package has installed for itself: dependencies, devDependencies,
  // optionalDependencies and the task edges. REACH (the transitive
  // closures `--filter pkg...` and `--affected` read) adds
  // peerDependencies: a peer is provided by the consumer, never linked
  // into the package's own node_modules, so it is not a build-order edge
  // — and peers are the one bucket that routinely cycles (medusa's
  // test-utils peers on medusa, which dev-depends on it through
  // analytics; Turbo, which reads no peers, runs it; an order edge here
  // made it a task cycle, 2026-09-11) — but a change in the peer can
  // still break the package that peers on it, so it stays affected.
  const directDeps = new Map<string, string[]>()
  const reachDeps = new Map<string, string[]>()
  for (const p of projects) {
    const order = new Set<string>()
    for (const name of taskEdges?.get(p.name) ?? []) {
      if (name !== p.name && byName.has(name)) order.add(name)
    }
    const add = (
      field: 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies',
      into: Set<string>,
    ) => {
      const obj = p.packageJson[field]
      if (!obj) return
      for (const name of Object.keys(obj)) {
        if (name !== p.name && byName.has(name)) into.add(name)
      }
    }
    add('dependencies', order)
    add('devDependencies', order)
    add('optionalDependencies', order)
    const reach = new Set(order)
    add('peerDependencies', reach)
    directDeps.set(p.name, [...order].sort())
    reachDeps.set(p.name, [...reach].sort())
  }

  // Reverse adjacency: who declares X as a workspace dep.
  const directDependents = new Map<string, string[]>()
  for (const [name, deps] of reachDeps) {
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
  // a per-query reachability search for that rare case.
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

  // Cyclic fallback: everything reachable from `name` via ≥1 edge (so a
  // node inside a cycle includes itself). Deliberately a self-contained
  // per-query search rather than a memoized recursion over sub-results:
  // in a cycle the back-edge contributes nothing, so a shared recursion
  // computes TRUNCATED closures for the nodes below it and caching those
  // makes every later answer depend on which node was asked for first.
  function reachableFrom(name: string, edges: Map<string, string[]>): string[] {
    const seen = new Set<string>()
    const stack = [...(edges.get(name) ?? [])]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (seen.has(cur)) continue
      seen.add(cur)
      for (const d of edges.get(cur) ?? []) stack.push(d)
    }
    return [...seen].sort()
  }

  // The closures are built on the FIRST query, not here: an unscoped run
  // seeds every project and never asks for a transitive set, and neither
  // does a `^task` walk (it reads `directDeps`). Building both closures
  // eagerly was 12 ms of a 240 ms warm run at 1000 projects × 30 deps
  // (profiled 2026-09-09) for answers nobody read.
  function makeAccessor(edges: Map<string, string[]>): (name: string) => string[] {
    const memo = new Map<string, string[]>()
    let closures: Uint32Array | null | undefined
    const words = (names.length + 31) >>> 5
    return (name) => {
      const cached = memo.get(name)
      if (cached) return cached
      if (closures === undefined) closures = bitsetClosures(edges)
      if (closures === null) {
        const result = reachableFrom(name, edges)
        memo.set(name, result)
        return result
      }
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
    directDeps: (name) => directDeps.get(name) ?? [],
    transitiveDeps: makeAccessor(reachDeps),
    transitiveDependents: makeAccessor(directDependents),
  }
}
