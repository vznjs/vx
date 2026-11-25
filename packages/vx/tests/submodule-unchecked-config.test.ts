// A clone skips submodules by default (actions/checkout too): a locked
// project or nested workspace inside one is not on disk. It is not gone:
// `vx lock` there dropped it from the committed lock, and the lock flipped
// between machines. A run and `vx lock` name `git submodule update --init`.
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { uncheckedSubmoduleSync } from '../src/util/git-ignored.ts'
import { gitIn, gitInitCommit, makeWorkspace } from './helpers/workspace.js'
import { BIN, vx as spawnVx } from './helpers/vx.js'

const HI = `export default { tasks: { hi: { exec: { command: 'echo hi' } } } }\n`

const vx = (root: string, args: string[]) => spawnVx(root, args, { bin: BIN })

let root: string
let repos: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-submodule-', workspaceFile: false })
  repos = `${root}-repos`
  await Bun.write(path.join(repos, 'sub/pkg/vx.config.mjs'), HI)
  await Bun.write(path.join(repos, 'ws/.vx/workspace.mjs'), 'export default {}\n')
  gitInitCommit(path.join(repos, 'sub'))
  gitInitCommit(path.join(repos, 'ws'))
  await Bun.write(path.join(root, 'vx.config.mjs'), HI)
  const git = gitIn(root)
  for (const [from, at] of [
    ['sub', 'vendor/sub'],
    ['ws', 'vendor/ws'],
  ])
    git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', path.join(repos, from!), at!)
  const lock = await vx(root, ['lock'])
  expect(`${lock.code}\n${lock.err}`).toStartWith('0\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  // As a clone that skipped them: an empty directory, no `.git`.
  git('submodule', 'deinit', '-q', '-f', '--all')
})
afterEach(async () => {
  for (const dir of [root, repos])
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

it('names the outermost submodule not checked out above a directory', async () => {
  expect(uncheckedSubmoduleSync(root, 'vendor/sub/pkg')).toBe('vendor/sub')
  expect(uncheckedSubmoduleSync(root, 'vendor/ws')).toBe('vendor/ws')
  expect(uncheckedSubmoduleSync(root, 'packages')).toBeNull()
  gitIn(root)('submodule', 'update', '-q', '--init', 'vendor/sub')
  expect(uncheckedSubmoduleSync(root, 'vendor/sub/pkg')).toBeNull()
}, 30_000)

it('a vendored copy with files but no .git is not a submodule left out', async () => {
  await mkdir(path.join(root, 'vendor/sub/pkg'), { recursive: true })
  await Bun.write(path.join(root, 'vendor/sub/pkg/vx.config.mjs'), HI)
  expect(uncheckedSubmoduleSync(root, 'vendor/sub/pkg')).toBeNull()
}, 30_000)

it('a run that needs a project in it names git submodule update', async () => {
  const r = await vx(root, ['run', 'hi', '--all'])
  expect([r.code, r.err.trim()]).toEqual([
    1,
    '✗ vx run  vendor/sub/pkg is in submodule vendor/sub, which is not checked out, but this run needs its vx.config.mjs — run `git submodule update --init vendor/sub`',
  ])
}, 30_000)

it('vx lock and its --check refuse, naming git submodule update, the lock untouched', async () => {
  const lockFile = path.join(root, '.vx/projects.lock')
  const before = await Bun.file(lockFile).text()
  const said =
    'vendor/sub, vendor/ws are submodules not checked out, so vx lock cannot read what the lock holds there — run `git submodule update --init vendor/sub vendor/ws`'
  for (const args of [['lock'], ['lock', '--check']]) {
    const r = await vx(root, args)
    expect([args.join(' '), r.code, r.err.includes(said), r.err.includes('vx lock`')]).toEqual([
      args.join(' '),
      1,
      true,
      false,
    ])
  }
  expect(await Bun.file(lockFile).text()).toBe(before)
}, 30_000)
