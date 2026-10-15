// The workspace edges the mappers reason about. Core reads no manifest
// edge: a run's `^task` follows a plugin's (`@vzn/vx-lockfile`'s, from the
// lockfile the manager wrote from these manifests). Turbo and Nx draw
// package edges from the same manifests, so the mappers read them here: a
// dependency, dev or optional entry whose key names a workspace package
// orders it; a peer on one only reaches it.

import type { PackageMeta } from './packages.js'

export interface ManifestGraph {
  /** Packages this one builds after, sorted. */
  directDeps(name: string): readonly string[]
  /** Every package a change reaches this one through, sorted. */
  transitiveDeps(name: string): readonly string[]
  /** Every package a change here reaches, sorted. */
  transitiveDependents(name: string): readonly string[]
}

const ORDER_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

export function manifestGraph(metas: readonly PackageMeta[]): ManifestGraph {
  const names = new Set(metas.map((m) => m.name))
  const order = new Map<string, string[]>()
  const reach = new Map<string, string[]>()
  const dependents = new Map<string, string[]>()
  const keys = (field: unknown): string[] =>
    field !== null && typeof field === 'object' ? Object.keys(field) : []
  for (const m of metas) {
    const pkg = m.packageJson as unknown as Record<string, unknown>
    const own = new Set<string>()
    for (const f of ORDER_FIELDS) for (const k of keys(pkg[f])) if (names.has(k)) own.add(k)
    own.delete(m.name)
    const all = new Set(own)
    for (const k of keys(pkg['peerDependencies'])) if (names.has(k) && k !== m.name) all.add(k)
    order.set(m.name, [...own].sort())
    reach.set(m.name, [...all].sort())
    for (const d of all) {
      const list = dependents.get(d)
      if (list === undefined) dependents.set(d, [m.name])
      else list.push(m.name)
    }
  }
  const closure = (edges: ReadonlyMap<string, readonly string[]>) => {
    const memo = new Map<string, readonly string[]>()
    return (name: string): readonly string[] => {
      let out = memo.get(name)
      if (out !== undefined) return out
      const seen = new Set<string>()
      const stack = [...(edges.get(name) ?? [])]
      while (stack.length > 0) {
        const n = stack.pop()!
        if (seen.has(n)) continue
        seen.add(n)
        stack.push(...(edges.get(n) ?? []))
      }
      memo.set(name, (out = [...seen].sort()))
      return out
    }
  }
  return {
    directDeps: (name) => order.get(name) ?? [],
    transitiveDeps: closure(reach),
    transitiveDependents: closure(dependents),
  }
}
