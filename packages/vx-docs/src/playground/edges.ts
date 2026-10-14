// The page's edge source. Core reads no edge from a manifest: a repo's
// edges come from a plugin (`@vzn/vx-lockfile` reads what the manager
// installed). The page has no lockfile, so it links a sibling a manifest
// names in `dependencies`, `devDependencies` or `optionalDependencies`, as
// an install would. `tests/playground-parity.unsafe.test.ts` declares this
// same function as the CLI's `discover` plugin, so both sides plan one graph.

import type { DiscoveredProject, ProjectMeta } from '../../../vx/src/index.js'

const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

export function manifestEdges(projects: readonly ProjectMeta[]): DiscoveredProject[] {
  const dirOf = new Map(projects.map((p) => [p.name, p.dir]))
  return projects.map((p) => {
    const pkg = p.packageJson as unknown as Record<string, unknown>
    const deps = new Set<string>()
    for (const field of FIELDS) {
      const named = pkg[field]
      if (named === null || typeof named !== 'object') continue
      for (const name of Object.keys(named)) {
        const dir = dirOf.get(name)
        if (dir !== undefined && name !== p.name) deps.add(dir)
      }
    }
    return { dir: p.dir, deps: [...deps].sort() }
  })
}
