// --affected and the paths git was told to stop looking at: `git update-index
// --assume-unchanged` / `--skip-worktree`. `git diff` reports nothing for an
// edit to one, while the key hashes the file from disk (git-inputs.ts drops
// its index OID), so the task missed and --affected selected nothing.
import { rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { affectedProjects } from '../src/workspace/affected.js'
import { lock } from './helpers/orchestrator.js'
import { addProject, gitIn, gitInitCommit, makeWorkspace } from './helpers/workspace.js'

const CORE_BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

let root: string
let git: (...args: string[]) => string

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-affected-flagged-', git: false })
  for (const name of ['a', 'b']) {
    await addProject(root, name, {
      config:
        "export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: ['**'] }, cache: { outputs: { files: [] } } } } }\n",
      files: { 'src/index.js': 'export {}\n' },
    })
  }
  gitInitCommit(root)
  await lock(root)
  git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'lock')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const projects = () =>
  ['a', 'b'].map((name) => ({ name, dir: path.join(root, 'packages', name), configPath: null }))

const owners = async () =>
  [...(await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects: projects() }))].sort()

const file = (name: string) => path.join(root, 'packages', name, 'src/index.js')

it('an edit to an assume-unchanged file selects its project', async () => {
  git('update-index', '--assume-unchanged', 'packages/a/src/index.js')
  expect(await owners()).toEqual([])
  await writeFile(file('a'), 'export const x = 1\n')
  expect(await owners()).toEqual(['a'])
})

it('an edit to a skip-worktree file selects its project', async () => {
  git('update-index', '--skip-worktree', 'packages/b/src/index.js')
  await writeFile(file('b'), 'export const y = 1\n')
  expect(await owners()).toEqual(['b'])
})

it('a deleted assume-unchanged file selects its project; an absent skip-worktree one does not', async () => {
  git('update-index', '--assume-unchanged', 'packages/a/src/index.js')
  git('update-index', '--skip-worktree', 'packages/b/src/index.js')
  await unlink(file('a'))
  // Not materialized is what a sparse checkout is: no change of the user's.
  await unlink(file('b'))
  expect(await owners()).toEqual(['a'])
})

it('the run selects what its key re-hashes', async () => {
  git('update-index', '--assume-unchanged', 'packages/a/src/index.js')
  await writeFile(file('a'), 'export const x = 1\n')
  const p = Bun.spawnSync({
    cmd: [process.execPath, CORE_BIN, 'run', 'build', '--affected=HEAD', '--dry=json'],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  })
  expect(p.exitCode).toBe(0)
  const plan = JSON.parse(p.stdout.toString()) as { tasks: { id: string }[] }
  expect(plan.tasks.map((t) => t.id)).toEqual(['a#build'])
})
