// The page's `discover` source. Core reads no manifest: a repo's names and
// edges come from a plugin (`@vzn/vx-lockfile` reads what the manager
// installed). The page has no lockfile, so it reads each project's
// package.json, names the project by its `name` and links a sibling it names
// in `dependencies`, `devDependencies` or `optionalDependencies`, as an
// install would. `tests/playground-parity.unsafe.test.ts` declares this same
// function as the CLI's `discover` plugin, so both sides plan one graph.

import type { DiscoveredProject } from '../../../vx/src/index.js'

const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

export async function manifestEdges(
  projects: ReadonlyArray<{ readonly dir: string }>,
): Promise<DiscoveredProject[]> {
  const manifests = await Promise.all(
    projects.map(async (p) => {
      try {
        const pkg: unknown = JSON.parse(await Bun.file(`${p.dir}/package.json`).text())
        return pkg !== null && typeof pkg === 'object' ? (pkg as Record<string, unknown>) : {}
      } catch {
        return {}
      }
    }),
  )
  const dirOf = new Map<string, string>()
  manifests.forEach((pkg, i) => {
    if (typeof pkg['name'] === 'string') dirOf.set(pkg['name'], projects[i]!.dir)
  })
  return projects.map((p, i) => {
    const pkg = manifests[i]!
    const name = typeof pkg['name'] === 'string' ? pkg['name'] : undefined
    const deps = new Set<string>()
    for (const field of FIELDS) {
      const named = pkg[field]
      if (named === null || typeof named !== 'object') continue
      for (const dep of Object.keys(named)) {
        const dir = dirOf.get(dep)
        if (dir !== undefined && dep !== name) deps.add(dir)
      }
    }
    return { dir: p.dir, ...(name === undefined ? {} : { name }), deps: [...deps].sort() }
  })
}
