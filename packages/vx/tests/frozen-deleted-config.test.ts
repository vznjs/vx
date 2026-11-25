// A run runs what the lock records and reads no config (2026-11-25): an
// EDITED or DELETED config runs as locked until `vx lock`. A project whose
// DIRECTORY is gone is refused, naming `vx lock`: its locked tasks have
// nowhere to run, and a hit would restore outputs into a directory made for
// them.
import { existsSync } from 'node:fs'
import { rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { BIN, vx as spawnVx } from './helpers/vx.js'

const vx = (root: string, args: string[]) =>
  spawnVx(root, args, {
    bin: BIN,
    env: { CI: process.env['CI'], GITHUB_ACTIONS: process.env['GITHUB_ACTIONS'] },
  })

let root: string
let config: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-h22-del-' })
  await addProject(root, 'app', {
    config: `export default { tasks: { build: { exec: { command: 'echo LOCKED-BUILD' } } } }\n`,
  })
  await addProject(root, 'lib', {
    config: `export default { tasks: { build: { exec: { command: 'echo LIB' } } } }\n`,
  })
  config = path.join(root, 'packages', 'app', 'vx.config.mjs')
  const lock = await vx(root, ['lock'])
  expect(`${lock.code}\n${lock.err}`).toStartWith('0\n')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

it('an edited config runs as locked', async () => {
  await Bun.write(
    config,
    `export default { tasks: { build: { exec: { command: 'echo EDITED' } } } }\n`,
  )
  const r = await vx(root, ['run', 'build', '--all', '--output-logs=full'])
  expect([r.code, r.out.includes('LOCKED-BUILD'), r.out.includes('EDITED'), r.err]).toEqual([
    0,
    true,
    false,
    '',
  ])
}, 30_000)

it('a deleted config the lock holds runs its locked tasks', async () => {
  await unlink(config)
  const r = await vx(root, ['run', 'build', '--all', '--output-logs=full'])
  expect([r.code, r.out.includes('LOCKED-BUILD'), r.out.includes('LIB'), r.err]).toEqual([
    0,
    true,
    true,
    '',
  ])
}, 30_000)

it('a locked project whose directory is gone is refused, not silently dropped', async () => {
  await rm(path.dirname(config), { recursive: true })
  const r = await vx(root, ['run', 'build', '--all'])
  expect([r.code, r.out.includes('LIB'), r.err.trim()]).toEqual([
    1,
    false,
    '✗ vx run  .vx/projects.lock locks packages/app ("app"), but its directory is gone — run `vx lock`',
  ])
}, 30_000)

it('the root project is named as the root, not as `.`', async () => {
  const rootConfig = path.join(root, 'vx.config.mjs')
  await Bun.write(
    rootConfig,
    `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
  )
  expect((await vx(root, ['lock'])).code).toBe(0)
  await unlink(rootConfig)
  const check = await vx(root, ['lock', '--check'])
  expect(check.code).toBe(1)
  expect(check.err).toContain(
    "✗ vx lock --check  the lock holds the workspace root project, which has no vx.config now — run 'vx lock'",
  )
}, 30_000)

it('a locked config-less project whose directory is gone is refused with the same way out', async () => {
  // A `project` plugin's tasks (turbo()'s) for a package with no config
  // file. Removed after a run saved its output, the next run hit and
  // restored that output into a directory made for it, exit 0.
  await addProject(root, 'svc', {})
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([
      pluginSource(
        'gen',
        `{ project(config, ctx) {
          if (ctx.name === 'svc') config.tasks.build = {
            exec: { command: 'mkdir -p dist && echo SVC > dist/out.txt' },
            inputs: { files: ['**'] }, outputs: { files: ['dist/**'] }, cache: true,
          }
        } }`,
      ),
    ]),
  )
  expect((await vx(root, ['lock'])).code).toBe(0)
  const svc = path.join(root, 'packages', 'svc')
  expect((await vx(root, ['run', 'build', '--filter', 'svc'])).code).toBe(0)
  await rm(svc, { recursive: true })
  const r = await vx(root, ['run', 'build', '--filter', 'svc'])
  expect([r.code, r.err.trim(), existsSync(svc)]).toEqual([
    1,
    '✗ vx run  .vx/projects.lock locks packages/svc ("svc"), but its directory is gone — run `vx lock`',
    false,
  ])
}, 30_000)
