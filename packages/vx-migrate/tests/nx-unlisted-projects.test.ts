// An Nx project no package-manager member holds (an integrated repo's
// `project.json` library) is found by its vx.config: its config names it as
// Nx does. Writing it a package.json and asking for workspace globs made
// pnpm install each library's own ranges in single-version repos
// (transloco, angular-three) and hoist a slashed name into a library's
// source (ngxtension).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { migrateNx } from '../src/migrate-nx.js'

const node = (name: string, root: string) => ({
  name,
  data: { root, targets: { build: { command: 'tsc' } } },
})

it('an unlisted project is named in its config; no package.json, no note', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-unlisted-'))
  try {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'r', private: true, workspaces: ['libs/listed'] }),
    )
    for (const d of ['apps/ng', 'libs/ui', 'libs/listed', 'libs/a/computed'])
      await mkdir(path.join(root, d), { recursive: true })
    await writeFile(path.join(root, 'libs/listed/package.json'), '{"name":"listed"}')
    await writeFile(path.join(root, 'libs/ui/package.json'), '{"name":"ui"}')
    const graph = {
      graph: {
        nodes: {
          r: node('r', '.'),
          ng: node('ng', 'apps/ng'),
          ui: node('ui', 'libs/ui'),
          listed: node('listed', 'libs/listed'),
          'a/computed': node('a/computed', 'libs/a/computed'),
        },
        dependencies: {},
      },
    }
    await writeFile(path.join(root, 'graph.json'), JSON.stringify(graph))
    const metas: PackageMeta[] = [
      {
        name: 'listed',
        dir: path.join(root, 'libs/listed'),
        packageJson: { name: 'listed' },
        configPath: null,
      },
    ]
    const p = await migrateNx(root, metas, 'ts', path.join(root, 'graph.json'))
    expect({
      extraFiles: p.extraFiles,
      notes: p.notes.filter((n) => n.includes('workspace glob') || n.includes('package.json')),
      named: Object.fromEntries(p.projects.map((x) => [x.name, x.writeName === true])),
    }).toEqual({
      extraFiles: [],
      notes: [],
      named: { r: false, ng: true, ui: true, listed: false, 'a/computed': true },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('init on an unlisted project writes no package.json and locks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-members-'))
  try {
    await writeFile(
      path.join(root, 'package.json'),
      '{"name":"r","private":true,"workspaces":["apps/*"]}\n',
    )
    await writeFile(path.join(root, 'nx.json'), '{}\n')
    await mkdir(path.join(root, '.nx', 'workspace-data'), { recursive: true })
    await mkdir(path.join(root, 'apps', 'e2e'), { recursive: true })
    await writeFile(
      path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
      JSON.stringify({ nodes: { e2e: node('e2e', 'apps/e2e') }, dependencies: {} }),
    )
    const bin = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
    const proc = Bun.spawn([process.execPath, '--no-install', bin, '--no-install'], {
      cwd: root,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = Bun.stripANSI(await new Response(proc.stdout).text())
    expect(await proc.exited).toBe(0)
    expect(out).not.toContain('package.json is written')
    expect(out).not.toContain('workspace glob')
    expect(await Bun.file(path.join(root, 'apps/e2e/package.json')).exists()).toBe(false)
    expect(await Bun.file(path.join(root, 'apps/e2e/vx.config.ts')).text()).toContain("name: 'e2e'")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
