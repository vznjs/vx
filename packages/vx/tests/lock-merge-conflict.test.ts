// The locks have no merge driver (M 2026-11-22): git's text merge marks a
// clash, a run refuses it, and `vx lock` rewrites both. A driver runs before
// theirs' configs reach disk, so one running `vx lock` would lock only ours.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.join(import.meta.dir, '..', 'src', 'bin.ts')
const config = (cmd: string) =>
  `export default { tasks: { build: { exec: { command: '${cmd}' } } } }\n`

let root: string | undefined
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

function vx(cwd: string, ...args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

const LOCK = '.vx/projects.lock'

it('registers no merge driver; a clashing merge refuses runs until vx lock rewrites it', async () => {
  const r = (root = await makeWorkspace({ prefix: 'vx-lock-clash-' }))
  const git = gitIn(r)
  await addProject(r, 'a', config('echo base'))
  expect(vx(r, 'lock').code).toBe(0)
  expect(git('config', '--local', '--list')).not.toContain('merge.vx-lock')
  git('add', '-A')
  git('commit', '-qm', 'base')
  git('checkout', '-qb', 'theirs')
  await addProject(r, 'a', config('echo theirs'))
  expect(vx(r, 'lock').code).toBe(0)
  git('commit', '-qam', 'theirs')
  git('checkout', '-q', '-')
  await addProject(r, 'a', { files: { 'other.txt': 'x' } })
  await Bun.write(path.join(r, 'packages/a/vx.config.mjs'), config('echo ours'))
  expect(vx(r, 'lock').code).toBe(0)
  git('add', '-A')
  git('commit', '-qm', 'ours')
  const merge = Bun.spawnSync({
    cmd: ['git', 'merge', '-q', 'theirs'],
    cwd: r,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(merge.exitCode).not.toBe(0)
  expect(await Bun.file(path.join(r, LOCK)).text()).toContain('<<<<<<<')
  const refused = vx(r, 'run', '--all', 'build')
  expect(refused.code).not.toBe(0)
  expect(refused.err).toContain('vx lock')
  // The config is the user's to settle; then `vx lock` writes both locks whole.
  await Bun.write(path.join(r, 'packages/a/vx.config.mjs'), config('echo merged'))
  expect(vx(r, 'lock').code).toBe(0)
  expect(await Bun.file(path.join(r, LOCK)).text()).not.toContain('<<<<<<<')
  expect(await Bun.file(path.join(r, '.vx/dependencies.lock')).text()).not.toContain('<<<<<<<')
  expect(await Bun.file(path.join(r, LOCK)).text()).toContain('echo merged')
  expect(vx(r, 'run', '--all', 'build').code).toBe(0)
})
