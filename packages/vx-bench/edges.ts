// The benches' discover source: in a real repo a lockfile plugin names each
// project by its package.json and supplies edges from what the manager
// installed. A generated workspace is never installed, so this plugin reads
// each project's manifest (core reads none), names the project by it and
// links each sibling its `dependencies` name: one read per project, as the
// lockfile plugin pays.

import path from 'node:path'
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function benchEdges(): VxPlugin {
  return definePlugin(import.meta, {
    async discover(ctx) {
      const manifests = await Promise.all(
        ctx.projects.map(
          (p) =>
            Bun.file(path.join(p.dir, 'package.json'))
              .json()
              .catch(() => ({})) as Promise<{
              name?: string
              dependencies?: Record<string, string>
            }>,
        ),
      )
      const dirOf = new Map<string, string>()
      manifests.forEach((m, i) => {
        if (typeof m.name === 'string') dirOf.set(m.name, ctx.projects[i]!.dir)
      })
      return ctx.projects.map((p, i) => {
        const m = manifests[i]!
        return {
          dir: p.dir,
          ...(typeof m.name === 'string' ? { name: m.name } : {}),
          deps: Object.keys(m.dependencies ?? {}).flatMap((n) => {
            const dir = dirOf.get(n)
            return dir === undefined ? [] : [dir]
          }),
        }
      })
    },
  })
}

/** A generated workspace's `.vx/workspace.mjs`: {@link benchEdges} and no other plugin. */
export const BENCH_WORKSPACE = `import { benchEdges } from ${JSON.stringify(import.meta.path)}\nexport default { plugins: [benchEdges()] }\n`
