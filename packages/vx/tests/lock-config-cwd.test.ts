// A project config evaluated with the invoking directory as process.cwd():
// a config reading it made the lock depend on where `vx lock` ran, and
// `vx lock --check` from a subdirectory failed a lock written at the root.
// It evaluates with the workspace root as its cwd, wherever vx runs.
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { loadProjectConfigs } from '../src/workspace/project-loader.js'

const BIN = path.join(import.meta.dir, '..', 'src', 'bin.ts')
const CONFIG =
  "export default { tasks: { build: { exec: { command: 'echo ' + process.cwd() } } } }\n"

let root: string | undefined
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function workspace(): Promise<string> {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-lock-config-cwd-')))
  await Bun.write(path.join(root, '.vx/workspace.mjs'), 'export default {}\n')
  await Bun.write(path.join(root, 'a', 'vx.config.mjs'), CONFIG)
  return root
}

const vx = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd, stderr: 'pipe' })
  return { code: p.exitCode, err: p.stderr.toString() }
}

it('vx lock --check from a subdirectory passes a lock written at the root', async () => {
  const r = await workspace()
  expect(vx(r, 'lock').code).toBe(0)
  expect(vx(path.join(r, 'a'), 'lock', '--check')).toMatchObject({ code: 0 })
  // And the other way round.
  expect(vx(path.join(r, 'a'), 'lock').code).toBe(0)
  expect(vx(r, 'lock', '--check')).toMatchObject({ code: 0 })
}, 30_000)

it('loadProjectConfigs evaluates in the root it is given and puts the cwd back', async () => {
  const r = await workspace()
  const before = process.cwd()
  process.chdir(path.join(r, 'a'))
  try {
    const [config] = await loadProjectConfigs([path.join(r, 'a', 'vx.config.mjs')], r)
    expect(config!.tasks?.['build']?.exec?.command).toBe(`echo ${r}`)
    expect(process.cwd()).toBe(path.join(r, 'a'))
  } finally {
    process.chdir(before)
  }
})
