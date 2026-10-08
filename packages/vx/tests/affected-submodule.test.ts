// --affected owners for a project that is a real submodule (`git submodule
// add`, a `.gitmodules` entry), beside affected.test's gitlink row: the
// parent's diff sees only the pointer, "modified content" and "untracked
// content", and `.gitmodules` may ask git to hide all three. Probed end to
// end; these rows pin what that row leaves undriven.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { affectedChanges, affectedProjects } from '../src/workspace/affected.js'
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

// A nested repository INSIDE a project is one path to the parent's git
// (`vendor/lib`, `emb/`), while the project's key folds every file in it.
// Per-task selection matched that path as a file against each task's
// globs: `**` claimed it, `vendor/**/*.txt` did not, and the task whose key
// moved was left out ("Nothing affected"). A project inside such a
// repository was never reached: the walk stopped at the outer project.
it('a nested repository inside a project reaches every task of it, and the projects inside', async () => {
  const lib = path.join(tmp, 'lib')
  await mkdir(path.join(lib, 'c'), { recursive: true })
  await writeFile(path.join(lib, 'c', 'f.txt'), '1\n')
  gitInitCommit(lib)
  git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'packages/a/vendor/lib')
  git('commit', '-q', '-m', 'add nested submodule')
  const changes = async (
    dirs: Record<string, string> = { a: 'packages/a', c: 'packages/a/vendor/lib/c' },
  ) => {
    const c = await affectedChanges({
      workspaceRoot: root,
      since: 'HEAD',
      projects: projects(dirs),
    })
    return { projects: [...c.projects].sort(), whole: [...c.whole].sort() }
  }
  expect(await changes()).toEqual({ projects: [], whole: [] })
  const emb = path.join(root, 'packages', 'a', 'emb')
  await mkdir(emb)
  await writeFile(path.join(emb, 'e.txt'), 'e\n')
  gitInitCommit(emb)
  expect(await changes()).toEqual({ projects: ['a'], whole: ['a'] })
  await rm(emb, { recursive: true })
  await writeFile(path.join(root, 'packages', 'a', 'vendor', 'lib', 'c', 'f.txt'), '2\n')
  expect(await changes()).toEqual({ projects: ['a', 'c'], whole: ['a', 'c'] })
  // Gone: the base's gitlink is the one side that says so.
  git('rm', '-q', '-f', 'packages/a/vendor/lib')
  expect(await changes({ a: 'packages/a' })).toEqual({ projects: ['a'], whole: ['a'] })
})
