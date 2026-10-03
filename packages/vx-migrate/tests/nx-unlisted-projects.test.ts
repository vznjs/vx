// An Nx project no workspace glob lists (an integrated repo's
// `project.json` library) gets a package.json and a note naming the globs
// to add (P2-15): core finds a project only by a listed package.json, so
// its migrated config never ran.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { migrateNx } from '../src/migrate-nx.js'

const node = (name: string, root: string) => ({
  name,
  data: { root, targets: { build: { command: 'tsc' } } },
})

async function plan(opts: { pnpm?: boolean; manifest?: boolean }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-unlisted-'))
  try {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'r', private: true, workspaces: ['libs/listed'] }),
    )
    if (opts.pnpm) await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
    for (const d of ['apps/ng', 'libs/ui', 'libs/listed']) {
      await mkdir(path.join(root, d), { recursive: true })
    }
    await writeFile(path.join(root, 'libs/listed/package.json'), '{"name":"listed"}')
    if (opts.manifest) await writeFile(path.join(root, 'libs/ui/package.json'), '{"name":"ui"}')
    const graph = {
      graph: {
        nodes: {
          r: node('r', '.'),
          ng: node('ng', 'apps/ng'),
          ui: node('ui', 'libs/ui'),
          listed: node('listed', 'libs/listed'),
        },
        dependencies: {},
      },
    }
    await writeFile(path.join(root, 'graph.json'), JSON.stringify(graph))
    const metas: ProjectMeta[] = [
      {
        name: 'listed',
        dir: path.join(root, 'libs/listed'),
        packageJson: { name: 'listed' },
        configPath: null,
      },
    ]
    const p = await migrateNx(root, metas, 'ts', path.join(root, 'graph.json'))
    return { extraFiles: p.extraFiles, notes: p.notes.filter((n) => n.includes('workspace glob')) }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('Nx projects no workspace glob lists', () => {
  it('each gets a package.json, and one note names the globs; the root and a listed one do not', async () => {
    expect(await plan({})).toEqual({
      extraFiles: [
        { relPath: 'apps/ng/package.json', contents: '{\n  "name": "ng",\n  "private": true\n}\n' },
        { relPath: 'libs/ui/package.json', contents: '{\n  "name": "ui",\n  "private": true\n}\n' },
      ],
      notes: [
        '2 Nx projects are in no workspace glob (a package.json is written where there was none) — vx finds a project by a package.json the workspace lists: add "apps/ng", "libs/ui" to package.json `workspaces`',
      ],
    })
  })

  it('a package.json already there is kept; pnpm names its own file', async () => {
    expect(await plan({ pnpm: true, manifest: true })).toEqual({
      extraFiles: [
        { relPath: 'apps/ng/package.json', contents: '{\n  "name": "ng",\n  "private": true\n}\n' },
      ],
      notes: [
        '2 Nx projects are in no workspace glob (a package.json is written where there was none) — vx finds a project by a package.json the workspace lists: add "apps/ng", "libs/ui" to pnpm-workspace.yaml\'s `packages`',
      ],
    })
  })
})
