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

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

async function vx(root: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', VX_LOCK_REVIEW_FILES: 'false' },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

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
  const locked = await Bun.file(path.join(root, '.vx/projects.lock.json')).json()
  expect(locked.projectStage.plugins).toEqual(['org/mapper'])
  expect(Object.keys(locked.projectStage.configs)).toEqual(['packages/app', 'packages/mapped'])
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
  expect(check.err).toContain(
    'packages/mapped: the `project` stage maps it differently from the lock here',
  )

  const relock = await vx(root, ['lock'])
  expect(`${relock.code}\n${relock.err}`).toStartWith('0\n')
  const fresh = await vx(root, ['run', 'show', '--all', '--no-cache', '--output-logs', 'full'])
  expect(`${fresh.code}\n${fresh.err}`).toStartWith('0\n')
  expect(fresh.out).toContain('said-two')
}, 60_000)

it('a run follows the lock blindly when the plugins change: one added maps nothing until vx lock', async () => {
  // Locked before the plugin was declared.
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([]))
  expect((await vx(root, ['lock'])).code).toBe(0)
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([MAPPER]))
  const run = await vx(root, ['run', 'show', '--all', '--no-cache', '--output-logs', 'full'])
  expect(`${run.code}\n${run.err}`).toStartWith('0\n')
  expect(run.out).toContain('app#show')
  expect(run.out).not.toContain('said-')
  expect(await visits()).toBe('')
  const check = await vx(root, ['lock', '--check'])
  expect(check.code).toBe(1)
  expect(check.err).toContain("the lock holds no `project` stage of plugin 'org/mapper'")
}, 60_000)

it('and one dropped still runs what it mapped until vx lock', async () => {
  expect((await vx(root, ['lock'])).code).toBe(0)
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([]))
  const run = await vx(root, ['run', 'show', '--all', '--no-cache', '--output-logs', 'full'])
  expect(`${run.code}\n${run.err}`).toStartWith('0\n')
  expect(run.out).toContain('said-one')
  const check = await vx(root, ['lock', '--check'])
  expect(check.code).toBe(1)
  expect(check.err).toContain(
    "the lock holds the `project` stage of 'org/mapper', which no plugin fills now",
  )
  expect((await vx(root, ['lock'])).code).toBe(0)
  const relocked = await vx(root, ['run', 'show', '--all', '--no-cache', '--output-logs', 'full'])
  expect(relocked.out).not.toContain('said-')
}, 60_000)
