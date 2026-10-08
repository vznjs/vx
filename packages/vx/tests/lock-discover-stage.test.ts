// X-143: `vx lock` listed projects with core's discovery alone, while a
// run (and `--frozen`) discovers through the plugin `discover` stage. A
// project such a plugin adds, with its own vx.config, was never locked:
// `vx lock --check` said up to date and the frozen run refused it.
import { mkdir, rm } from 'node:fs/promises'
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
    env: { ...process.env, NO_COLOR: '1' },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

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
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource([
      pluginSource('org/tools', `{ discover() { return [{ dir: 'tools/gen', name: 'gen' }] } }`),
    ]),
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

it('control: a live run sees the discovered project', async () => {
  const r = await vx(root, ['run', 'build', '--all'])
  expect(`${r.code}\n${r.err}`).toStartWith('0\n')
  expect(r.out).toContain('gen#build')
}, 30_000)

it('vx lock freezes the discovered project, so lock --check && run --frozen succeeds', async () => {
  const lock = await vx(root, ['lock'])
  expect(`${lock.code}\n${lock.err}`).toStartWith('0\n')
  const check = await vx(root, ['lock', '--check'])
  expect(`${check.code}\n${check.err}`).toStartWith('0\n')
  const locked = Object.keys((await Bun.file(path.join(root, 'vx-lock.json')).json()).projects)
  expect(locked).toEqual(['app', 'gen'])
  const frozen = await vx(root, ['run', 'build', '--all', '--frozen'])
  expect(`${frozen.code}\n${frozen.err}`).toStartWith('0\n')
}, 30_000)
