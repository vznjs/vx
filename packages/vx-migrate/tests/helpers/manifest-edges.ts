// The names and edges a lockfile plugin would supply, for fixtures with no
// lockfile. Core reads no manifest (language-agnostic core, PRs 3 and 5),
// and a written config's `pkg#task` and a mapped Turbo or Nx task's
// `^build` need both: this one names each project by its manifest, as
// vx-lockfile does, and links each sibling a manifest names, as an install
// would, a peer as reach only.

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
    async discover(ctx) {
      // Core reads no manifest: each one is read here, as a lockfile plugin reads its own.
      const manifests = await Promise.all(
        ctx.projects.map(
          async (p) =>
            ((await Bun.file(path.join(p.dir, 'package.json'))
              .json()
              .catch(() => null)) ?? {}) as Record<string, unknown>,
        ),
      )
      const nameOf = (i: number): string => {
        const n = manifests[i]!['name']
        return typeof n === 'string' && n !== '' ? n : ctx.projects[i]!.name
      }
      const dirOf = new Map(ctx.projects.map((p, i) => [nameOf(i), p.dir]))
      const named = (i: number, fields: readonly string[]): string[] => {
        const out = new Set<string>()
        for (const f of fields) {
          const v = manifests[i]![f]
          if (v === null || typeof v !== 'object') continue
          for (const n of Object.keys(v))
            if (n !== nameOf(i) && dirOf.has(n)) out.add(dirOf.get(n)!)
        }
        return [...out]
      }
      return ctx.projects.map((p, i) => ({
        dir: p.dir,
        ...(nameOf(i) === p.name ? {} : { name: nameOf(i) }),
        deps: named(i, ORDER),
        reach: named(i, ['peerDependencies']),
      }))
    },
  })
}

/** The fixture workspace file's import of {@link manifestEdges}. */
export const MANIFEST_EDGES_IMPORT = `import { manifestEdges } from ${JSON.stringify(import.meta.path)}\n`
