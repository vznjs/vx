// The benches' edge source. Core reads no manifest edge: in a real repo a
// lockfile plugin supplies them from what the manager installed. A
// generated workspace is never installed, so this plugin links each
// sibling a manifest's `dependencies` name, one pass over the manifests
// core already read.

import { definePlugin, type VxPlugin } from '@vzn/vx'

export function benchEdges(): VxPlugin {
  return definePlugin(import.meta, {
    discover(ctx) {
      const dirOf = new Map(ctx.projects.map((p) => [p.name, p.dir]))
      return ctx.projects.map((p) => ({
        dir: p.dir,
        deps: Object.keys(p.packageJson.dependencies ?? {}).flatMap((n) => {
          const dir = dirOf.get(n)
          return dir === undefined ? [] : [dir]
        }),
      }))
    },
  })
}

/** A generated workspace's `.vx/workspace.mjs`: {@link benchEdges} and no other plugin. */
export const BENCH_WORKSPACE = `import { benchEdges } from ${JSON.stringify(import.meta.path)}\nexport default { plugins: [benchEdges()] }\n`
