// A policy naming the remote in a workspace with no remote layer gets one
// line, naming the setting that asked: the workspace's `cache.policy` got
// none, and `VX_CACHE_POLICY` was called `--cache-policy`.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { workspaceWith } from './helpers/local-workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const line = (by: string) =>
  `vx: ${by} named the remote cache, but no cache plugin in .vx/workspace.* supplies one — the remote axes are off for this run`

let root: string
const run = (args: string[], env: Record<string, string> = {}) =>
  Bun.spawnSync({
    cmd: [process.execPath, BIN, 'run', 'a#build', ...args],
    cwd: root,
    env: { ...process.env, VX_CACHE_POLICY: '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
const said = (args: string[], env: Record<string, string> = {}) => {
  const p = run(args, env)
  return p.stdout.toString() + p.stderr.toString()
}

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-remote-notice-' })
  await addProject(
    root,
    'a',
    `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
  )
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('names the flag, the env var, or the workspace setting that asked for the remote', async () => {
  expect(said(['--cache-policy', 'remote:r'])).toContain(line('--cache-policy'))
  expect(said([], { VX_CACHE_POLICY: 'remote:w' })).toContain(line('VX_CACHE_POLICY'))
  expect(said([])).not.toContain('named the remote cache')
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    workspaceWith(`cache: { policy: 'remote:rw' }`),
  )
  expect(said([])).toContain(line('cache.policy'))
  // A spec that turns the remote off, or --no-cache, asks for nothing.
  expect(said(['--no-cache'])).not.toContain('named the remote cache')
  expect(said(['--cache-policy', 'remote:'])).not.toContain('named the remote cache')
}, 30_000)
