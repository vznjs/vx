// A workspace inside a member of another (`apps/tool` under `apps/*`,
// holding `apps/tool/ws` with `workspaces` of its own) resolved to the outer
// root through `apps/tool`, and the nested members ran in a workspace that
// does not list them (D-137). As npm reads it, an outer root owns a nested
// one only when it lists that directory itself.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { findWorkspaceRoot } from '../src/workspace/workspace.js'

let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-nested-root-')))
  const manifest = async (dir: string, body: object) => {
    await mkdir(path.join(root, dir), { recursive: true })
    await writeFile(path.join(root, dir, 'package.json'), JSON.stringify(body))
  }
  await manifest('.', { name: 'outer', workspaces: ['apps/*'] })
  await manifest('apps/tool', { name: 'tool' })
  await manifest('apps/tool/ws', { name: 'inner', workspaces: ['pkgs/*'] })
  await manifest('apps/tool/ws/pkgs/x', { name: 'x' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const rootFrom = async (dir: string) => {
  const found = await findWorkspaceRoot(path.join(root, dir))
  return found === root
    ? '.'
    : found
        .slice(root.length + 1)
        .split(path.sep)
        .join('/')
}

it('a nested workspace the outer root does not list is its own root', async () => {
  expect(await rootFrom('apps/tool/ws')).toBe('apps/tool/ws')
  expect(await rootFrom('apps/tool/ws/pkgs/x')).toBe('apps/tool/ws')
})

it('CONTROL: a member and a plain directory under it stay in the outer root', async () => {
  expect(await rootFrom('apps/tool')).toBe('.')
  await mkdir(path.join(root, 'apps/tool/src'), { recursive: true })
  expect(await rootFrom('apps/tool/src')).toBe('.')
})

it('CONTROL: an outer root that lists the nested one owns it', async () => {
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'outer', workspaces: ['apps/*', 'apps/tool/ws'] }),
  )
  expect(await rootFrom('apps/tool/ws')).toBe('.')
})

it('an outer root that lists the nested root and its members owns them all', async () => {
  // `apps/**` lists `apps/tool/ws` and `apps/tool/ws/pkgs/x`; from `x` the
  // nearer `ws` claimed it while `ws` itself resolved to the outer root.
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'outer', workspaces: ['apps/**'] }),
  )
  expect(await rootFrom('apps/tool/ws')).toBe('.')
  expect(await rootFrom('apps/tool/ws/pkgs/x')).toBe('.')
})

it('CONTROL: a member only the nested root lists stays with it', async () => {
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'outer', workspaces: ['apps/*', 'apps/tool/ws'] }),
  )
  expect(await rootFrom('apps/tool/ws/pkgs/x')).toBe('apps/tool/ws')
})
