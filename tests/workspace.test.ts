import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { findWorkspaceRoot, listProjects, loadWorkspace } from '../src/workspace.js'

describe('findWorkspaceRoot', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vzn-ws-'))
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

  it('throws clearly when no workspace yaml exists in any parent', async () => {
    await expect(findWorkspaceRoot(dir)).rejects.toThrow(/Could not find pnpm-workspace.yaml/)
  })
})

describe('listProjects', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vzn-list-'))
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
