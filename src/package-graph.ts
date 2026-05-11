import type { ProjectMeta } from './workspace.js'

export interface PackageGraph {
  byName: Map<string, ProjectMeta>
  /** Direct workspace deps for each project. */
  directDeps: Map<string, string[]>
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

  const depsCache = new Map<string, string[]>()
  function transitive(
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
      for (const t of transitive(d, edges, cache, stack)) out.add(t)
    }
    stack.delete(name)
    const result = [...out].sort()
    cache.set(name, result)
    return result
  }
  const dependentsCache = new Map<string, string[]>()

  return {
    byName,
    directDeps,
    transitiveDeps: (name) => transitive(name, directDeps, depsCache),
    transitiveDependents: (name) => transitive(name, directDependents, dependentsCache),
  }
}
