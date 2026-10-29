import type { ProjectMeta } from './workspace.js'

export interface PackageGraph {
  /**
   * Some `discover` entry carried `deps`: a project with none is a leaf.
   * False, no plugin supplies edges and a `^task` is refused.
   */
  readonly edgeSource: boolean
  /** Projects the project builds AFTER (sorted): a `discover` plugin's `deps` and the task edges. */
  directDeps: (name: string) => string[]
  /** All projects a change can reach the project through: order edges and a plugin's `reach`. */
  transitiveDeps: (name: string) => string[]
  /** All projects a change here can reach (the reverse). */
  transitiveDependents: (name: string) => string[]
}

/**
 * `taskEdges`: project → the projects its tasks name in a cross-project
 * `dependsOn` (`e2e` → `app` from `dependsOn: ['app#build']`). A dependent
 * no plugin edge names but the task graph does; without it
 * `--filter '...app'` never selected `e2e`, and a CI that runs "what
 * changed and everything depending on it" silently left it out
 * (2026-09-10). Selection, `vx watch` and the dependency rules pass them;
 * the graph a run or `vx lock` resolves `^task` against does not (it is
 * built before configs load), so a task edge never widens a `^task` walk.
 */
export function buildPackageGraph(
  projects: ProjectMeta[],
  taskEdges?: ReadonlyMap<string, readonly string[]>,
): PackageGraph {
  const byName = new Map<string, ProjectMeta>()
  for (const p of projects) byName.set(p.name, p)

  // Two adjacencies. ORDER (`directDeps`, the `^task` walk) is a
  // `discover` plugin's `deps`, plus the task edges when passed. REACH (the transitive closures
  // `--filter pkg...` and `--affected` read) is ORDER plus a plugin's
  // `reach`, which never orders a build.
  const directDeps = new Map<string, string[]>()
  const order = new Map<string, Set<string>>()
  const reachOnly = new Map<string, readonly string[]>()
  const sorted = [...projects].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  let edgeSource = false
  for (const p of sorted) {
    const own = new Set<string>()
    for (const name of taskEdges?.get(p.name) ?? []) {
      if (name !== p.name && byName.has(name)) own.add(name)
    }
    if (p.deps !== undefined) edgeSource = true
    for (const name of p.deps ?? []) {
      if (name !== p.name && byName.has(name)) own.add(name)
    }
    if (p.reach !== undefined) {
      reachOnly.set(
        p.name,
        p.reach.filter((name) => name !== p.name && byName.has(name)),
      )
    }
    order.set(p.name, own)
    directDeps.set(p.name, [...own].sort())
  }

  // REACH and its reverse (who has an edge to X) are read only
  // by the transitive questions below, which an unscoped run never asks:
  // built on the first one, as the closures are.
  const reachDeps = new Map<string, string[]>()
  const directDependents = new Map<string, string[]>()
  /** One project's REACH list, made on first ask (`buildReach` makes them all). */
  const reachOf = (name: string): string[] => {
    let reach = reachDeps.get(name)
    if (reach === undefined) {
      const own = order.get(name)
      if (own === undefined) return []
      reach = [...new Set([...own, ...(reachOnly.get(name) ?? [])])].sort()
      reachDeps.set(name, reach)
    }
    return reach
  }
  let reachBuilt = false
  const buildReach = (): void => {
    if (reachBuilt) return
    reachBuilt = true
    for (const p of sorted) {
      const own = order.get(p.name)!
      reachDeps.set(p.name, [...new Set([...own, ...(reachOnly.get(p.name) ?? [])])].sort())
    }
    for (const [name, deps] of reachDeps) {
      for (const d of deps) {
        const arr = directDependents.get(d)
        if (arr) arr.push(name)
        else directDependents.set(d, [name])
      }
    }
    for (const arr of directDependents.values()) arr.sort()
  }

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
  // A scoped run asks one or two seeds' closures: a search from each over
  // the REACH lists it visits answers them without every project's list
  // and the whole graph's bitsets (8–13 ms at 1,000 projects for one
  // `--filter`). The same set, in the same name order; past a few asks
  // the bitsets are cheaper per question.
  const EARLY_SEARCHES = 8
  const searchDeps = (name: string): string[] => {
    const seen = new Set<string>()
    const stack = [...reachOf(name)]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (seen.has(cur)) continue
      seen.add(cur)
      for (const d of reachOf(cur)) stack.push(d)
    }
    return [...seen].sort()
  }
  function makeAccessor(
    edges: Map<string, string[]>,
    search?: (name: string) => string[],
  ): (name: string) => string[] {
    const memo = new Map<string, string[]>()
    let closures: Uint32Array | null | undefined
    const words = (names.length + 31) >>> 5
    let searched = 0
    return (name) => {
      const cached = memo.get(name)
      if (cached) return cached
      if (search !== undefined && closures === undefined && searched < EARLY_SEARCHES) {
        searched++
        const result = search(name)
        memo.set(name, result)
        return result
      }
      buildReach()
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
    edgeSource,
    directDeps: (name) => directDeps.get(name) ?? [],
    transitiveDeps: makeAccessor(reachDeps, searchDeps),
    transitiveDependents: makeAccessor(directDependents),
  }
}
