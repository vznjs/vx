// A plugin's `discover` hook names projects by `{ dir, name }`, and
// `namedProject` refuses what discovery cannot hold: no row held any of its
// six refusals. Each is compared whole.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { namedProject, type ProjectMeta, type Workspace } from '../src/workspace/workspace.js'

let root: string
let workspace: Workspace
let known: ProjectMeta[]

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-named-'))
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await mkdir(path.join(root, 'packages', 'b'), { recursive: true })
  await writeFile(path.join(root, 'packages', 'b', 'package.json'), '{"name":"bee"}')
  workspace = { root, packageGlobs: ['packages/*'] }
  known = [
    {
      name: 'a',
      dir: path.join(root, 'packages', 'a'),
      packageJson: { name: 'a' },
      configPath: null,
    },
  ]
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const refusal = (named: unknown): Promise<string> =>
  namedProject(workspace, known, named as { dir: string; name: string }, 'p').then(
    () => 'accepted',
    (err: Error) => err.message.replaceAll(root, '<root>'),
  )

describe('a plugin-named project discovery cannot hold is refused, whole', () => {
  it('a shape that is not { dir, name }', async () => {
    expect(await refusal({ dir: 'x' })).toBe(
      `plugin 'p' named project {"dir":"x"}: expected { dir: string, name: string }`,
    )
  })

  it('a directory outside the workspace', async () => {
    expect(await refusal({ dir: '../out', name: 'out' })).toBe(
      `plugin 'p' named project "out" at ${path.dirname(root)}/out: outside the workspace root`,
    )
  })

  it("another project's directory", async () => {
    expect(await refusal({ dir: 'packages/a', name: 'other' })).toBe(
      `plugin 'p' named project "other" at packages/a: already the project "a"`,
    )
  })

  it("another project's name", async () => {
    expect(await refusal({ dir: 'packages/b', name: 'a' })).toBe(
      `plugin 'p' named project "a" at packages/b: the name is taken by packages/a`,
    )
  })

  it('a directory that does not exist', async () => {
    expect(await refusal({ dir: 'packages/none', name: 'none' })).toBe(
      `plugin 'p' named project "none" at packages/none: no such directory`,
    )
  })

  it('a name its package.json does not give', async () => {
    expect(await refusal({ dir: 'packages/b', name: 'b' })).toBe(
      `plugin 'p' named project "b" at packages/b: its package.json names it "bee"`,
    )
  })

  it('CONTROL: a directory it can hold is accepted, and one known already is no new project', async () => {
    expect(await refusal({ dir: 'packages/b', name: 'bee' })).toBe('accepted')
    expect(await namedProject(workspace, known, { dir: 'packages/a', name: 'a' }, 'p')).toBeNull()
  })
})
