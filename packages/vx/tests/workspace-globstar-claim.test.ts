// `packages/**` lists `packages` itself when it holds a manifest: discovery
// scans `packages/**/package.json`, and npm reads the glob the same way
// (`npm prefix` there answers the outer root). The root walk matched the
// directory against `packages/**`, which needs a segment below `packages`,
// so a run from `packages` took it as its own workspace: two roots and two
// caches for one tree.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { findWorkspaceRoot, listProjects, loadWorkspace } from '../src/workspace/workspace.js'

let root: string

const manifest = async (dir: string, body: object) => {
  await mkdir(path.join(root, dir), { recursive: true })
  await writeFile(path.join(root, dir, 'package.json'), JSON.stringify(body))
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-globstar-claim-')))
  await manifest('packages', { name: 'group' })
  await manifest('packages/a', { name: 'a' })
  await manifest('other', { name: 'other' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const rel = (dir: string) => path.relative(root, dir).split(path.sep).join('/') || '.'

for (const glob of ['packages/**', 'packages/**/']) {
  it(`a root listing ${glob} claims packages itself, as discovery lists it`, async () => {
    await manifest('.', { name: 'outer', workspaces: [glob] })
    const listed = (await listProjects(await loadWorkspace(root))).map((p) => rel(p.dir)).sort()
    expect(listed).toEqual(['packages', 'packages/a'])
    expect(rel(await findWorkspaceRoot(path.join(root, 'packages')))).toBe('.')
    expect(rel(await findWorkspaceRoot(path.join(root, 'packages/a')))).toBe('.')
    expect(rel(await findWorkspaceRoot(path.join(root, 'other')))).toBe('other')
  })
}
