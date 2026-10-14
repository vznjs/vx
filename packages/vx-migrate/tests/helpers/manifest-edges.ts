// The edges a lockfile plugin would supply, for fixtures with no lockfile.
// Core reads no manifest edge (language-agnostic core, PR 3), and a mapped
// Turbo or Nx task's `^build` needs an edge source: this one links each
// sibling a manifest names, as an install would, a peer as reach only.

import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { definePlugin, type VxPlugin } from '@vzn/vx'

const ORDER = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

function origin(): { dir: string } {
  const dir = path.join(tmpdir(), `vx-migrate-test-edges-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'vx-test-manifest-edges' }))
  return { dir }
}

export function manifestEdges(): VxPlugin {
  return definePlugin(origin(), {
    discover(ctx) {
      const dirOf = new Map(ctx.projects.map((p) => [p.name, p.dir]))
      const named = (p: (typeof ctx.projects)[number], fields: readonly string[]): string[] => {
        const pkg = p.packageJson as unknown as Record<string, unknown>
        const out = new Set<string>()
        for (const f of fields) {
          const v = pkg[f]
          if (v === null || typeof v !== 'object') continue
          for (const n of Object.keys(v)) if (n !== p.name && dirOf.has(n)) out.add(dirOf.get(n)!)
        }
        return [...out]
      }
      return ctx.projects.map((p) => ({
        dir: p.dir,
        deps: named(p, ORDER),
        reach: named(p, ['peerDependencies']),
      }))
    },
  })
}

/** The fixture workspace file's import of {@link manifestEdges}. */
export const MANIFEST_EDGES_IMPORT = `import { manifestEdges } from ${JSON.stringify(import.meta.path)}\n`
