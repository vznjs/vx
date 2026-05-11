import type { ProjectMeta } from './workspace.js'

export interface PackageGraph {
  byName: Map<string, ProjectMeta>
  /** Direct workspace deps for each project. */
  directDeps: Map<string, string[]>
  /** All transitive workspace deps for each project. */
  transitiveDeps: (name: string) => string[]
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

  const cache = new Map<string, string[]>()
  function transitive(name: string, stack: Set<string> = new Set()): string[] {
    const cached = cache.get(name)
    if (cached) return cached
    if (stack.has(name)) return []
    stack.add(name)
    const out = new Set<string>()
    for (const d of directDeps.get(name) ?? []) {
      out.add(d)
      for (const t of transitive(d, stack)) out.add(t)
    }
    stack.delete(name)
    const result = [...out].sort()
    cache.set(name, result)
    return result
  }

  return {
    byName,
    directDeps,
    transitiveDeps: (name) => transitive(name),
  }
}
