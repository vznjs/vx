// --affected owners across moves, deletes and nesting, as Turbo and Nx
// own a change: a renamed or moved file counts for both its old and new
// project, a moved project is selected where it now lives, a deleted one
// selects nothing, and a nested project owns its own files, not its
// parent. Probed end to end on a pnpm-style chain; these rows pin it.
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { affectedProjects } from '../src/workspace/affected.js'
import { gitIn, gitInitCommit } from './helpers/workspace.js'

let root: string
let git: (...args: string[]) => string

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-aff-moves-')))
  for (const p of ['a', 'b', 'c']) {
    await mkdir(path.join(root, 'packages', p), { recursive: true })
    await writeFile(path.join(root, 'packages', p, 'x.txt'), `${p}\n`)
  }
  gitInitCommit(root)
  git = gitIn(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const projectsAt = (dirs: Record<string, string>) =>
  Object.entries(dirs).map(([name, dir]) => ({
    name,
    dir: path.join(root, dir),
    packageJson: { name } as never,
    configPath: null,
  }))

const commit = (message: string) => {
  git('add', '-A')
  git('commit', '-q', '-m', message)
}

const owners = async (projects: ReturnType<typeof projectsAt>) =>
  [...(await affectedProjects({ workspaceRoot: root, since: 'HEAD~1', projects }))].sort()

const ABC = { a: 'packages/a', b: 'packages/b', c: 'packages/c' }

it('a file renamed inside a project selects that project alone', async () => {
  git('mv', 'packages/c/x.txt', 'packages/c/y.txt')
  commit('rename')
  expect(await owners(projectsAt(ABC))).toEqual(['c'])
})

it('a file moved between projects selects both', async () => {
  git('mv', 'packages/c/x.txt', 'packages/b/moved.txt')
  commit('move')
  expect(await owners(projectsAt(ABC))).toEqual(['b', 'c'])
})

it('a deleted file selects the project it left', async () => {
  git('rm', '-q', 'packages/a/x.txt')
  commit('delete')
  expect(await owners(projectsAt(ABC))).toEqual(['a'])
})

it('a moved project is selected where it now lives', async () => {
  await rename(path.join(root, 'packages', 'c'), path.join(root, 'packages', 'cc'))
  commit('move project')
  expect(await owners(projectsAt({ ...ABC, c: 'packages/cc' }))).toEqual(['c'])
})

it('a deleted project selects nothing that remains', async () => {
  git('rm', '-rq', 'packages/c')
  commit('drop c')
  expect(await owners(projectsAt({ a: 'packages/a', b: 'packages/b' }))).toEqual([])
})

it('a nested project owns its files; its parent owns the rest', async () => {
  await mkdir(path.join(root, 'packages', 'b', 'nested'), { recursive: true })
  await writeFile(path.join(root, 'packages', 'b', 'nested', 'f.txt'), '1\n')
  commit('nest')
  const nested = projectsAt({ ...ABC, n: 'packages/b/nested' })
  await writeFile(path.join(root, 'packages', 'b', 'nested', 'f.txt'), '2\n')
  commit('nested change')
  expect(await owners(nested)).toEqual(['n'])
  await writeFile(path.join(root, 'packages', 'b', 'x.txt'), 'b2\n')
  commit('parent change')
  expect(await owners(nested)).toEqual(['b'])
  // CONTROL: the same directory, no longer a project, is the parent's.
  await writeFile(path.join(root, 'packages', 'b', 'nested', 'f.txt'), '3\n')
  commit('unlisted nested change')
  expect(await owners(projectsAt(ABC))).toEqual(['b'])
})

it('a change outside every project selects none', async () => {
  await writeFile(path.join(root, 'README.md'), 'r\n')
  commit('readme')
  expect(await owners(projectsAt(ABC))).toEqual([])
})
