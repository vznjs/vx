// The locks have no merge driver (M 2026-11-22): git's text merge marks a
// clash, a run refuses it, and `vx lock` rewrites both. A driver runs before
// theirs' configs reach disk, so one running `vx lock` would lock only ours.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { BIN, vxSync } from './helpers/vx.js'

const config = (cmd: string) =>
  `export default { tasks: { build: { exec: { command: '${cmd}' } } } }\n`

let root: string | undefined
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

const vx = (cwd: string, ...args: string[]) => vxSync(cwd, args, { bin: BIN })

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

it('vx lock --check names a conflicted dependencies lock as a conflict', async () => {
  const r = (root = await makeWorkspace({ prefix: 'vx-lock-clash-' }))
  await addProject(r, 'a', config('echo a'))
  expect(vx(r, 'lock').code).toBe(0)
  const deps = path.join(r, '.vx/dependencies.lock')
  const text = await Bun.file(deps).text()
  await Bun.write(deps, `<<<<<<< HEAD\n${text}=======\n${text}>>>>>>> theirs\n`)
  const check = vx(r, 'lock', '--check')
  expect(check.code).toBe(1)
  expect(check.err).toContain('.vx/dependencies.lock holds a git merge conflict: run `vx lock`')
})

// Two branches each edited a different project and the merge still
// clashed: every task's JSON sat in one pool at the top, side by side, so
// both branches' pool edits touched. Each project's lines merge alone.
it('git merges two branches that each edit a different project, and the lock checks', async () => {
  const r = (root = await makeWorkspace({ prefix: 'vx-lock-merge-' }))
  const git = gitIn(r)
  const two = (cmd: string) =>
    `export default { tasks: { build: { exec: { command: '${cmd}' } }, lint: { exec: { command: 'oxlint' } } } }\n`
  await addProject(r, 'a', two('echo a'))
  await addProject(r, 'b', two('echo b'))
  expect(vx(r, 'lock').code).toBe(0)
  git('add', '-A')
  git('commit', '-qm', 'base')
  git('checkout', '-qb', 'theirs')
  await Bun.write(path.join(r, 'packages/a/vx.config.mjs'), two('echo a2'))
  expect(vx(r, 'lock').code).toBe(0)
  git('commit', '-qam', 'theirs')
  git('checkout', '-q', '-')
  await Bun.write(path.join(r, 'packages/b/vx.config.mjs'), two('echo b2'))
  expect(vx(r, 'lock').code).toBe(0)
  git('commit', '-qam', 'ours')
  const merge = Bun.spawnSync({
    cmd: ['git', 'merge', '-q', '--no-edit', 'theirs'],
    cwd: r,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(`${merge.exitCode} ${merge.stdout.toString()}`).not.toContain('CONFLICT')
  expect(merge.exitCode).toBe(0)
  const check = vx(r, 'lock', '--check')
  expect(`${check.code} ${check.err}`).toBe('0 ')
  const text = await Bun.file(path.join(r, LOCK)).text()
  expect([text.includes('echo a2'), text.includes('echo b2')]).toEqual([true, true])
})
