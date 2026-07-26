import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { findWorkspaceRoot, listProjects, loadWorkspace } from '../src/workspace/workspace.js'

describe('findWorkspaceRoot', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-ws-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('walks up from a child directory to find pnpm-workspace.yaml', async () => {
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages: []\n')
    const sub = path.join(dir, 'a', 'b', 'c')
    await mkdir(sub, { recursive: true })
    expect(await findWorkspaceRoot(sub)).toBe(dir)
  })

  it('throws clearly when no workspace root signal exists in any parent', async () => {
    await expect(findWorkspaceRoot(dir)).rejects.toThrow(/Could not find a workspace root/)
  })

  it('accepts a bare package.json as workspace root (single-project mode)', async () => {
    await writeFile(path.join(dir, 'package.json'), '{"name":"r","private":true}')
    const sub = path.join(dir, 'a', 'b', 'c')
    await mkdir(sub, { recursive: true })
    expect(await findWorkspaceRoot(sub)).toBe(dir)
  })

  it('accepts package.json with workspaces field (npm/yarn/bun)', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
    )
    const sub = path.join(dir, 'packages')
    await mkdir(sub, { recursive: true })
    expect(await findWorkspaceRoot(sub)).toBe(dir)
  })

  // Every member has its own package.json, so stopping at the first one
  // makes a run from inside a package treat that package as the whole
  // workspace — `^task` edges vanish and the cache key loses its upstream
  // fold (stale hits). The declaring ancestor must win.
  describe('walking up from a workspace MEMBER', () => {
    async function member(rootManifest: string, memberDir: string): Promise<string> {
      await writeFile(path.join(dir, 'package.json'), rootManifest)
      const abs = path.join(dir, memberDir)
      await mkdir(abs, { recursive: true })
      await writeFile(path.join(abs, 'package.json'), '{"name":"m"}')
      return abs
    }

    it('resolves a member to the root that declares it', async () => {
      const abs = await member(
        JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
        'packages/a',
      )
      expect(await findWorkspaceRoot(abs)).toBe(dir)
    })

    it("resolves a member's subdirectory to the root", async () => {
      const abs = await member(
        JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
        'packages/a',
      )
      const deep = path.join(abs, 'src', 'nested')
      await mkdir(deep, { recursive: true })
      expect(await findWorkspaceRoot(deep)).toBe(dir)
    })

    it('resolves a member of a pnpm-workspace.yaml root', async () => {
      await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
      await writeFile(path.join(dir, 'package.json'), '{"name":"r"}')
      const abs = path.join(dir, 'packages', 'a')
      await mkdir(abs, { recursive: true })
      await writeFile(path.join(abs, 'package.json'), '{"name":"m"}')
      expect(await findWorkspaceRoot(abs)).toBe(dir)
    })

    it('resolves an explicitly listed nested member past its parent package', async () => {
      // This repo's own shape: `packages/cloud/ui` is a member listed by
      // literal path, nested inside `packages/cloud`, itself a member.
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'r', workspaces: ['packages/*', 'packages/cloud/ui'] }),
      )
      const cloud = path.join(dir, 'packages', 'cloud')
      const ui = path.join(cloud, 'ui')
      await mkdir(ui, { recursive: true })
      await writeFile(path.join(cloud, 'package.json'), '{"name":"cloud"}')
      await writeFile(path.join(ui, 'package.json'), '{"name":"ui"}')
      expect(await findWorkspaceRoot(ui)).toBe(dir)
    })

    it('prefers the NEAREST declaring ancestor (nested workspace)', async () => {
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'outer', workspaces: ['inner'] }),
      )
      const inner = path.join(dir, 'inner')
      const pkg = path.join(inner, 'pkgs', 'x')
      await mkdir(pkg, { recursive: true })
      await writeFile(
        path.join(inner, 'package.json'),
        JSON.stringify({ name: 'inner', workspaces: ['pkgs/*'] }),
      )
      await writeFile(path.join(pkg, 'package.json'), '{"name":"x"}')
      expect(await findWorkspaceRoot(pkg)).toBe(inner)
    })

    it('leaves a package no glob claims in single-project mode', async () => {
      const abs = await member(
        JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
        'examples/demo',
      )
      expect(await findWorkspaceRoot(abs)).toBe(abs)
    })
  })
})

describe('listProjects', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-list-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('skips packages without a name field', async () => {
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await mkdir(path.join(dir, 'packages/a'), { recursive: true })
    await writeFile(path.join(dir, 'packages/a/package.json'), '{}') // no name -> skipped
    await mkdir(path.join(dir, 'packages/b'), { recursive: true })
    await writeFile(path.join(dir, 'packages/b/package.json'), '{"name":"b"}')

    const ws = await loadWorkspace(dir)
    const projects = await listProjects(ws)
    expect(projects.map((p) => p.name)).toEqual(['b'])
  })

  it('handles an empty pnpm-workspace.yaml gracefully', async () => {
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), '\n')
    const ws = await loadWorkspace(dir)
    expect(ws.packageGlobs).toEqual([])
    const projects = await listProjects(ws)
    expect(projects).toEqual([])
  })
})
