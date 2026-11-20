// An Nx project no workspace glob lists (an integrated repo's
// `project.json` library) gets a package.json and a note naming the globs
// to add (P2-15): core finds a project only by a listed package.json, so
// its migrated config never ran.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { migrateNx } from '../src/migrate-nx.js'

const node = (name: string, root: string) => ({
  name,
  data: { root, targets: { build: { command: 'tsc' } } },
})

async function plan(opts: {
  pnpm?: boolean
  pnpmLock?: boolean
  manifest?: boolean
  globs?: string[]
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-unlisted-'))
  try {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'r', private: true, workspaces: opts.globs ?? ['libs/listed'] }),
    )
    if (opts.pnpm) await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
    if (opts.pnpmLock)
      await writeFile(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
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
    const metas: PackageMeta[] = [
      {
        name: 'listed',
        dir: path.join(root, 'libs/listed'),
        packageJson: { name: 'listed' },
        configPath: null,
      },
    ]
    const p = await migrateNx(
      root,
      metas,
      'ts',
      path.join(root, 'graph.json'),
      false,
      false,
      opts.globs ?? ['libs/listed'],
    )
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

  // spartan: an Nx repo on pnpm with no pnpm-workspace.yaml was told to edit
  // package.json `workspaces`, which pnpm never reads.
  it('pnpm with no pnpm-workspace.yaml is told to create it', async () => {
    expect((await plan({ pnpmLock: true })).notes).toEqual([
      '2 Nx projects are in no workspace glob (a package.json is written where there was none) — vx finds a project by a package.json the workspace lists: add "apps/ng", "libs/ui" to pnpm-workspace.yaml\'s `packages` (create the file: pnpm reads no package.json `workspaces`)',
    ])
  })

  it('one a glob already lists gets its package.json and no note', async () => {
    // analog, 2026-11-20: `apps/*` lists its e2e projects, which had no
    // package.json; the note said to add them to the globs.
    expect(await plan({ globs: ['libs/listed', 'apps/*', '!apps/skip'] })).toEqual({
      extraFiles: [
        { relPath: 'apps/ng/package.json', contents: '{\n  "name": "ng",\n  "private": true\n}\n' },
        { relPath: 'libs/ui/package.json', contents: '{\n  "name": "ui",\n  "private": true\n}\n' },
      ],
      notes: [
        '1 Nx project is in no workspace glob (a package.json is written where there was none) — vx finds a project by a package.json the workspace lists: add "libs/ui" to package.json `workspaces`',
      ],
    })
    expect((await plan({ globs: ['libs/*', 'apps/*'] })).notes).toEqual([])
  })
})

it('names the install a package.json under a glob calls for', async () => {
  // The manager's lockfile lists no member the written package.json made,
  // and the lockfile plugin refused `vx lock` after `vx init`.
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
    expect(out.replace(/\s+/g, ' ')).toContain(
      'a package.json is written in "apps/e2e", which a workspace glob lists: run your package manager\'s install, so its lockfile lists them, then vx lock',
    )
    expect(out).not.toContain('no workspace glob')
    expect(await Bun.file(path.join(root, 'apps/e2e/package.json')).exists()).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ngxtension: the Nx project `ngxtension/computed` got a package.json of
// that name, which pnpm hoisted to node_modules/.pnpm/node_modules/ngxtension/computed,
// through the `ngxtension` link into the library's source; its build then
// failed on the dangling link left there. The manifest takes a valid name,
// and the config keeps the Nx one its dependants spell.
it('a project whose Nx name is no package name gets a valid one, and the config keeps its own', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-npmname-'))
  try {
    await writeFile(path.join(root, 'package.json'), '{"name":"r","private":true}\n')
    await mkdir(path.join(root, 'libs/a/computed'), { recursive: true })
    await mkdir(path.join(root, 'libs/b'), { recursive: true })
    const graph = {
      graph: {
        nodes: {
          'a/computed': node('a/computed', 'libs/a/computed'),
          b: node('b', 'libs/b'),
        },
        dependencies: {},
      },
    }
    await writeFile(path.join(root, 'graph.json'), JSON.stringify(graph))
    const p = await migrateNx(root, [], 'ts', path.join(root, 'graph.json'), false, false, [])
    expect(p.extraFiles.map((f) => [f.relPath, JSON.parse(f.contents).name])).toEqual([
      ['libs/a/computed/package.json', '@a/computed'],
      ['libs/b/package.json', 'b'],
    ])
    expect(p.projects.map((x) => [x.name, x.writeName === true])).toEqual([
      ['a/computed', true],
      ['b', false],
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
