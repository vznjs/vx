// --affected and a file the workspace config imports where the import walk
// did not look: a workspace package it names by bare specifier (linked
// through node_modules, `workspace:*`), or a file above the workspace root
// in a repository whose subdirectory the workspace is. Its plugins shape
// every resolved config, so an edit moved every key and selected nothing.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { affectedProjects } from '../src/workspace/affected.js'
import { gitIn, gitInit } from './helpers/workspace.js'

const CONFIG =
  "export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: ['**'] }, outputs: { files: [] }, cache: true } } }\n"

let top: string
let git: (...args: string[]) => string

beforeEach(async () => {
  top = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-ws-plugin-'))
  gitInit(top)
  git = gitIn(top)
})

afterEach(async () => {
  await rm(top, { recursive: true, force: true })
})

/** A workspace at `top/<sub>` with projects a and b, its config `workspace`. */
async function workspace(sub: string, workspaceSource: string): Promise<string> {
  const root = path.join(top, sub)
  for (const name of ['a', 'b']) {
    await mkdir(path.join(root, name), { recursive: true })
    await writeFile(path.join(root, name, 'vx.config.mjs'), CONFIG)
  }
  await mkdir(path.join(root, '.vx'), { recursive: true })
  await writeFile(path.join(root, '.vx/workspace.mjs'), workspaceSource)
  return root
}

const owners = async (root: string) =>
  [
    ...(await affectedProjects({
      workspaceRoot: root,
      since: 'HEAD',
      projects: ['a', 'b'].map((name) => ({
        name,
        dir: path.join(root, name),
        configPath: path.join(root, name, 'vx.config.mjs'),
      })),
    })),
  ].sort()

it('an edit to a workspace package the workspace config imports by name selects everything', async () => {
  const root = await workspace(
    '.',
    "import { plug } from '@me/plug'\nexport default { plugins: [plug()] }\n",
  )
  await mkdir(path.join(root, 'plug'))
  await writeFile(
    path.join(root, 'plug/package.json'),
    '{"name":"@me/plug","type":"module","main":"index.mjs"}\n',
  )
  await writeFile(path.join(root, 'plug/index.mjs'), 'export const plug = () => ({})\n')
  await mkdir(path.join(root, 'node_modules/@me'), { recursive: true })
  await symlink('../../plug', path.join(root, 'node_modules/@me/plug'))
  await writeFile(path.join(root, '.gitignore'), 'node_modules\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  expect(await owners(root)).toEqual([])
  await writeFile(path.join(root, 'plug/index.mjs'), 'export const plug = () => ({ x: 1 })\n')
  expect(await owners(root)).toEqual(['a', 'b'])
})

it('an edit to a file above the root the workspace config imports selects everything', async () => {
  const root = await workspace(
    'repo/ws',
    "import { plug } from '../../shared/p.mjs'\nexport default { plugins: [plug()] }\n",
  )
  await mkdir(path.join(top, 'repo/shared'), { recursive: true })
  await writeFile(path.join(top, 'repo/shared/p.mjs'), 'export const plug = () => ({})\n')
  await writeFile(path.join(top, 'repo/shared/other.mjs'), 'export const other = 1\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  await writeFile(path.join(top, 'repo/shared/other.mjs'), 'export const other = 2\n')
  expect(await owners(root)).toEqual([])
  await writeFile(path.join(top, 'repo/shared/p.mjs'), 'export const plug = () => ({ x: 1 })\n')
  expect(await owners(root)).toEqual(['a', 'b'])
})
