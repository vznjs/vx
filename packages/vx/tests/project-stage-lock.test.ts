// A plugin's `project` stage is made by `vx lock` and only read by runs
// (2026-11-11: "we never relock during runs ... it should always follow the
// lock blindly"). A run mapped turbo.json and package.json scripts afresh,
// so an edit ran without `vx lock`.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { readLockfile } from '../src/workspace/lockfile.js'
import { BIN, vx as spawnVx } from './helpers/vx.js'

const vx = (root: string, args: string[]) =>
  spawnVx(root, args, { bin: BIN, env: { VX_LOCK_REVIEW_FILES: 'false' } })

// The mapping reads `mapping.txt` at the root, as turbo() reads turbo.json,
// and logs each visit.
const MAPPER = pluginSource(
  'org/mapper',
  `{ project(config, ctx) {
      const fs = require('node:fs')
      const p = require('node:path')
      fs.appendFileSync(p.join(ctx.workspaceRoot, 'visits.log'), ctx.name + '\\n')
      if (ctx.name !== 'mapped') return
      const word = fs.readFileSync(p.join(ctx.workspaceRoot, 'mapping.txt'), 'utf8').trim()
      config.tasks = { ...config.tasks, show: { exec: { command: 'echo said-' + word } } }
    } }`,
)

let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-stage-lock-' })
  await addProject(root, 'app', {
    config: `export default { tasks: { show: { exec: { command: 'echo app' } } } }\n`,
  })
  await addProject(root, 'mapped')
  await Bun.write(path.join(root, 'mapping.txt'), 'one\n')
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([MAPPER]))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const visits = async (): Promise<string> =>
  Bun.file(path.join(root, 'visits.log'))
    .text()
    .catch(() => '')

it('a run follows the mapping vx lock made, and calls no project hook', async () => {
  const lock = await vx(root, ['lock'])
  expect(`${lock.code}\n${lock.err}`).toStartWith('0\n')
  expect(lock.out).toContain('and the tasks a plugin maps for mapped')
  const text = await Bun.file(path.join(root, '.vx/projects.lock')).text()
  // Only the final config: the plugin's mapping, not the steps that made it.
  expect(text).not.toContain('projectStage')
  const locked = (await readLockfile(root))!
  expect(JSON.stringify(locked.projects['packages/mapped'])).toContain('echo said-one')
  const afterLock = await visits()

  // Edited, not relocked: the run keeps the locked mapping and reads nothing new.
  await Bun.write(path.join(root, 'mapping.txt'), 'two\n')
  const stale = await vx(root, ['run', 'show', '--all', '--no-cache', '--output-logs', 'full'])
  expect(`${stale.code}\n${stale.err}`).toStartWith('0\n')
  expect(stale.out).toContain('said-one')
  expect(stale.out).not.toContain('said-two')
  expect(await visits()).toBe(afterLock)

  // `--check` names the drift.
  const check = await vx(root, ['lock', '--check'])
  expect(check.code).toBe(1)
  expect(check.err).toContain('packages/mapped: the plugins map it differently from the lock here')

  const relock = await vx(root, ['lock'])
  expect(`${relock.code}\n${relock.err}`).toStartWith('0\n')
  const fresh = await vx(root, ['run', 'show', '--all', '--no-cache', '--output-logs', 'full'])
  expect(`${fresh.code}\n${fresh.err}`).toStartWith('0\n')
  expect(fresh.out).toContain('said-two')
}, 60_000)

// A run never relocks; a workspace file that maps otherwise than the lock is
// refused until `vx lock` (8465d91b6), as a config edit is.
it('a plugin added after vx lock refuses the run until vx lock', async () => {
  // Locked before the plugin was declared.
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([]))
  expect((await vx(root, ['lock'])).code).toBe(0)
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([MAPPER]))
  const run = await vx(root, ['run', 'show', '--all', '--no-cache', '--output-logs', 'full'])
  expect(`${run.code}\n${run.err}`).toBe(
    '1\n✗ vx run  .vx/workspace.mjs changed since the last `vx lock` — run `vx lock`\n',
  )
  const check = await vx(root, ['lock', '--check'])
  expect(check.code).toBe(1)
  expect(check.err).toContain('packages/mapped: the plugins map it differently from the lock here')
  expect(check.err).toContain('(none) → {"tasks":{"show"')
}, 60_000)

it('and one dropped refuses the run until vx lock', async () => {
  expect((await vx(root, ['lock'])).code).toBe(0)
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([]))
  const run = await vx(root, ['run', 'show', '--all', '--no-cache', '--output-logs', 'full'])
  expect(`${run.code}\n${run.err}`).toBe(
    '1\n✗ vx run  .vx/workspace.mjs changed since the last `vx lock` — run `vx lock`\n',
  )
  const check = await vx(root, ['lock', '--check'])
  expect(check.code).toBe(1)
  expect(check.err).toContain('packages/mapped: the plugins map it differently from the lock here')
  expect(check.err).toContain('"echo said-one"}}}} → (none)')
  expect((await vx(root, ['lock'])).code).toBe(0)
  const relocked = await vx(root, ['run', 'show', '--all', '--no-cache', '--output-logs', 'full'])
  expect(relocked.out).not.toContain('said-')
}, 60_000)
