// --affected owners for a project that is a real submodule (`git submodule
// add`, a `.gitmodules` entry), beside affected.test's gitlink row: the
// parent's diff sees only the pointer, "modified content" and "untracked
// content", and `.gitmodules` may ask git to hide all three. Probed end to
// end; these rows pin what that row leaves undriven.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { affectedProjects } from '../src/workspace/affected.js'
import { gitIn, gitInitCommit } from './helpers/workspace.js'

let tmp: string
let root: string
let git: (...args: string[]) => string
let sub: (...args: string[]) => string

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-aff-sub-')))
  const upstream = path.join(tmp, 'up')
  await mkdir(upstream)
  await writeFile(path.join(upstream, 'f.txt'), '1\n')
  gitInitCommit(upstream)
  root = path.join(tmp, 'ws')
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await writeFile(path.join(root, 'packages', 'a', 'x.txt'), 'a\n')
  gitInitCommit(root)
  git = gitIn(root)
  git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'packages/sub')
  git('commit', '-q', '-m', 'add submodule')
  sub = gitIn(path.join(root, 'packages', 'sub'))
  sub('config', 'user.email', 'test@vx.local')
  sub('config', 'user.name', 'vx test')
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const projects = (dirs: Record<string, string>) =>
  Object.entries(dirs).map(([name, dir]) => ({
    name,
    dir: path.join(root, dir),
    packageJson: { name } as never,
    configPath: null,
  }))

const owners = async (since: string) =>
  [
    ...(await affectedProjects({
      workspaceRoot: root,
      since,
      projects: projects({ a: 'packages/a', sub: 'packages/sub' }),
    })),
  ].sort()

it('CONTROL: a clean submodule selects nothing', async () => {
  expect(await owners('HEAD')).toEqual([])
})

it('an edit inside a submodule selects its project', async () => {
  await writeFile(path.join(root, 'packages', 'sub', 'f.txt'), '2\n')
  expect(await owners('HEAD')).toEqual(['sub'])
})

it('an untracked file inside a submodule selects its project', async () => {
  await writeFile(path.join(root, 'packages', 'sub', 'new.txt'), 'n\n')
  expect(await owners('HEAD')).toEqual(['sub'])
})

it('a moved submodule pointer selects its project, committed or not', async () => {
  await writeFile(path.join(root, 'packages', 'sub', 'f.txt'), '2\n')
  sub('commit', '-q', '-a', '-m', 'bump')
  expect(await owners('HEAD')).toEqual(['sub'])
  git('add', 'packages/sub')
  git('commit', '-q', '-m', 'bump pointer')
  expect(await owners('HEAD~1')).toEqual(['sub'])
  expect(await owners('HEAD')).toEqual([])
})

it('`.gitmodules` asking git to ignore the submodule hides none of it', async () => {
  git('config', '-f', '.gitmodules', 'submodule.packages/sub.ignore', 'all')
  git('commit', '-q', '-a', '-m', 'ignore sub')
  await writeFile(path.join(root, 'packages', 'sub', 'new.txt'), 'n\n')
  expect(await owners('HEAD')).toEqual(['sub'])
  await writeFile(path.join(root, 'packages', 'sub', 'f.txt'), '2\n')
  sub('commit', '-q', '-a', '-m', 'bump')
  expect(await owners('HEAD')).toEqual(['sub'])
})
