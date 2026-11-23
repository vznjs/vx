// X-143: `vx lock` listed projects with core's discovery alone, while a
// run discovers through the plugin `discover` stage. A project such a
// plugin adds, with its own vx.config, was never locked: `vx lock
// --check` said up to date and a run from the lock refused it.
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { readLockfile } from '../src/workspace/lockfile.js'
import { BIN, vx as spawnVx } from './helpers/vx.js'

const vx = (root: string, args: string[], bin?: string) => spawnVx(root, args, { bin })

let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-h22-ld-' })
  await addProject(root, 'app', {
    config: `export default { tasks: { build: { exec: { command: 'echo app' } } } }\n`,
  })
  // A manifest-less tool directory a `discover` plugin names, with its own config.
  await mkdir(path.join(root, 'tools', 'gen'), { recursive: true })
  await Bun.write(
    path.join(root, 'tools', 'gen', 'vx.config.mjs'),
    `export default { tasks: { build: { exec: { command: 'echo gen' } } } }\n`,
  )
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([
      pluginSource('org/tools', `{ discover() { return [{ dir: 'tools/gen', name: 'gen' }] } }`),
    ]),
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

it('control: a run sees the discovered project', async () => {
  const r = await vx(root, ['run', 'build', '--all'])
  expect(`${r.code}\n${r.err}`).toStartWith('0\n')
  expect(r.out).toContain('gen#build')
}, 30_000)

it('vx lock freezes the discovered project, so lock --check && run succeeds', async () => {
  const lock = await vx(root, ['lock'])
  expect(`${lock.code}\n${lock.err}`).toStartWith('0\n')
  const check = await vx(root, ['lock', '--check'])
  expect(`${check.code}\n${check.err}`).toStartWith('0\n')
  const locked = Object.keys((await readLockfile(root))!.projects)
  // By directory: a project with a config is locked whoever names it.
  expect(locked.sort()).toEqual(['packages/app', 'tools/gen'])
  const run = await vx(root, ['run', 'build', '--all'], BIN)
  expect(`${run.code}\n${run.err}`).toStartWith('0\n')
  expect(run.out).toContain('gen#build')
}, 30_000)

it('the bare-project note names only projects a plugin gives tasks', async () => {
  // solidjs/solid after vx-migrate: solid-ssr has no task Turbo runs, so no
  // vx.config, and `vx lock` counted it among projects with no vx.config
  // without naming it, though it had no task.
  await addProject(root, 'empty')
  await addProject(root, 'mapped')
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([
      pluginSource('org/tools', `{ discover() { return [{ dir: 'tools/gen', name: 'gen' }] } }`),
      pluginSource(
        'org/mapper',
        `{ project(config, ctx) { if (ctx.name === 'mapped') config.tasks = { build: { exec: { command: 'echo m' } } } } }`,
      ),
    ]),
  )
  const lock = await vx(root, ['lock'])
  expect(`${lock.code}\n${lock.err}`).toStartWith('0\n')
  expect(lock.out).toBe(
    '✓ vx lock  2 project configs → .vx/projects.lock, .vx/dependencies.lock (and the tasks a plugin maps for mapped)\n',
  )
  const check = await vx(root, ['lock', '--check'])
  expect(check.out).toBe('✓ vx lock --check  up to date (2 projects; mapped by a plugin: mapped)\n')
  const json = await vx(root, ['lock', '--check', '--format', 'json'])
  // The mapping is locked and audited too (2026-11-11).
  expect(JSON.parse(json.out)).toMatchObject({ audited: 3, notAudited: 0 })
}, 30_000)
