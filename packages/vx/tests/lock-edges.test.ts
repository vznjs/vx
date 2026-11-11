// `vx lock` where a plain checkout and one writer never take it: its walk
// (`findProjectConfigs`) over a merge conflict and a linked worktree made
// inside the repo, and a second `vx lock` while one is writing.
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { acquireRunLock } from '../src/orchestrator/index.js'
import { findProjectConfigs } from '../src/workspace/workspace.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const config = (v: string) =>
  `export default { tasks: { build: { exec: { command: 'echo ${v}' } } } }\n`

let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-lock-git-', git: 'commit' })
  await addProject(root, 'a', config('base'))
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'a')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

it('a config in a merge conflict, listed once per stage, is one config and shadows nothing', async () => {
  const git = gitIn(root)
  const file = path.join(root, 'packages/a/vx.config.mjs')
  git('checkout', '-q', '-b', 'other')
  await writeFile(file, config('other'))
  git('commit', '-q', '-am', 'other')
  git('checkout', '-q', '-')
  await writeFile(file, config('main'))
  git('commit', '-q', '-am', 'main')
  expect(() => git('merge', '-q', 'other')).toThrow()
  const found = await findProjectConfigs(root)
  expect(found.configs.map((c) => c.configPath)).toEqual([file])
  expect(found.shadowed).toEqual([])
}, 30_000)

it('a linked worktree of this repository made inside it is no nested workspace', async () => {
  gitIn(root)('worktree', 'add', '-q', '.worktrees/x')
  const found = await findProjectConfigs(root)
  expect(found.nestedWorkspaces).toEqual([])
  expect(found.configs.map((c) => c.configPath)).toEqual([
    path.join(root, 'packages/a/vx.config.mjs'),
  ])
}, 30_000)

it('a second vx lock waits for the one writing, then writes what the configs say', async () => {
  const release = await acquireRunLock(root, { log: () => {}, of: 'lock' })
  const proc = Bun.spawn([process.execPath, BIN, 'lock'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let err = ''
  try {
    const reader = proc.stderr.getReader()
    const decoder = new TextDecoder()
    while (!err.includes('waiting for another vx lock')) {
      const chunk = await reader.read()
      if (chunk.done) break
      err += decoder.decode(chunk.value)
    }
    reader.releaseLock()
    expect(err).toContain('[vx] waiting for another vx lock (pid ')
    expect(await Bun.file(path.join(root, '.vx/projects.lock.json')).exists()).toBe(false)
  } finally {
    await release()
  }
  expect(await proc.exited).toBe(0)
  expect(await Bun.file(path.join(root, '.vx/projects.lock.json')).exists()).toBe(true)
}, 30_000)
