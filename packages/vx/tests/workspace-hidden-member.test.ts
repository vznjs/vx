// A package under a dot directory (`packages/.template`) is no member of
// `packages/*`: discovery skips dot directories, as npm, pnpm and Bun do.
// The root walk claimed it anyway (`Bun.Glob#match` has no `dot: false`),
// so a run from inside it found the outer workspace, which does not list
// it, and failed "not inside a project"; npm takes it as its own root.
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
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-hidden-member-')))
  await manifest('packages/a', { name: 'a' })
  await manifest('packages/.tpl', { name: 'tpl' })
  await manifest('packages/a/node_modules/dep', { name: 'dep' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const rel = (dir: string) => path.relative(root, dir).split(path.sep).join('/') || '.'

const listed = async () =>
  (await listProjects(await loadWorkspace(root))).map((p) => rel(p.dir)).sort()

for (const globs of [['packages/*'], ['packages/**'], ['packages/{a,.tpl}']]) {
  it(`a root listing ${JSON.stringify(globs)} claims only the members it lists`, async () => {
    await manifest('.', { name: 'outer', workspaces: globs })
    expect(await listed()).toEqual(['packages/a'])
    expect(rel(await findWorkspaceRoot(path.join(root, 'packages/a')))).toBe('.')
    expect(rel(await findWorkspaceRoot(path.join(root, 'packages/.tpl')))).toBe('packages/.tpl')
    expect(rel(await findWorkspaceRoot(path.join(root, 'packages/a/node_modules/dep')))).toBe(
      'packages/a/node_modules/dep',
    )
  })
}

it('a pattern that names the dot directory claims it, as discovery lists it', async () => {
  await manifest('.', { name: 'outer', workspaces: ['packages/.tpl', 'packages/a'] })
  expect(await listed()).toEqual(['packages/.tpl', 'packages/a'])
  expect(rel(await findWorkspaceRoot(path.join(root, 'packages/.tpl')))).toBe('.')
})
