// The `discover` stage: a plugin names directories that become projects
// beyond the package manager's members (turbo()'s root for `//#task`).
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { discoverProjects, type VxPlugin } from '../src/orchestrator/index.js'
import type { Workspace } from '../src/workspace/index.js'

let root: string
let workspace: Workspace
const warn = (): void => {}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-discover-')))
  workspace = { root, packageGlobs: ['packages/*'] }
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws' }))
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await writeFile(path.join(root, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }))
  await mkdir(path.join(root, 'tools', 'gen'), { recursive: true })
})
afterEach(() => rm(root, { recursive: true, force: true }))

const plugin = (name: string, discover: VxPlugin['discover']): VxPlugin =>
  ({ name, discover }) as VxPlugin

const names = async (plugins: VxPlugin[]): Promise<string[]> =>
  (await discoverProjects(workspace, plugins, warn)).map(
    (p) => `${p.name}@${path.relative(root, p.dir) || '.'}`,
  )

describe('discover stage', () => {
  it('CONTROL: without the stage, only the members', async () => {
    expect(await names([])).toEqual(['a@packages/a'])
  })

  it('a named root and a manifest-less directory become projects, sorted by name', async () => {
    const seen: string[][] = []
    const p1 = plugin('p1', () => [{ dir: '.', name: 'ws' }])
    const p2 = plugin('p2', (ctx) => {
      seen.push(ctx.projects.map((m) => m.name))
      return [{ dir: path.join(root, 'tools', 'gen'), name: 'gen' }]
    })
    expect(await names([p1, p2])).toEqual(['a@packages/a', 'gen@tools/gen', 'ws@.'])
    expect(seen).toEqual([['a', 'ws']])
  })

  it('a directory already found under the same name is a no-op', async () => {
    expect(await names([plugin('p', () => [{ dir: 'packages/a', name: 'a' }])])).toEqual([
      'a@packages/a',
    ])
  })

  const refusals: Array<[string, VxPlugin['discover'], string]> = [
    ['outside the root', () => [{ dir: '..', name: 'x' }], 'outside the workspace root'],
    ['a taken name', () => [{ dir: 'tools/gen', name: 'a' }], 'the name is taken by packages/a'],
    [
      'a project under another name',
      () => [{ dir: 'packages/a', name: 'b' }],
      'already the project "a"',
    ],
    [
      'a manifest of another name',
      () => [{ dir: '.', name: 'root' }],
      'its package.json names it "ws"',
    ],
    ['no such directory', () => [{ dir: 'nope', name: 'n' }], 'no such directory'],
    ['a malformed entry', () => [{ dir: 1 } as never], 'expected { dir: string, name: string }'],
    ['not an array', () => ({}) as never, 'failed in discover: expected an array, got an object'],
  ]
  for (const [what, discover, message] of refusals) {
    it(`refuses ${what}, naming the plugin`, async () => {
      const err = await discoverProjects(workspace, [plugin('p', discover)], warn).then(
        () => null,
        (e: unknown) => e as Error,
      )
      expect(err?.message).toContain("plugin 'p'")
      expect(err?.message).toContain(message)
    })
  }
})
