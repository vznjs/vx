// `vx lock` writes the lock vx reads minified, a pretty `vx.lock.json`
// beside each project's config for review (2026-10-14), and
// `.vx/.gitattributes` so GitHub collapses the machine lock.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { noticed } from './helpers/notice.js'

const BIN = path.join(import.meta.dir, '..', 'src', 'bin.ts')
const CONFIG = `export default { tasks: { build: { exec: { command: 'true' } } } }\n`

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

const text = (p: string): Promise<string | null> =>
  Bun.file(p)
    .text()
    .catch(() => null)

it('writes the lock minified, a pretty review copy per config, and .vx/.gitattributes', async () => {
  const r = (root = await makeWorkspace({ prefix: 'vx-lock-review-' }))
  const dir = await addProject(r, 'a', { config: CONFIG })
  expect(vx(r, 'lock').code).toBe(0)
  const lock = (await text(path.join(r, '.vx', 'projects.lock.json')))!
  expect(lock.split('\n')).toHaveLength(2)
  expect(lock).toStartWith(
    '{"version":4,"projects":{"packages/a":{"file":"vx.config.mjs","config":',
  )
  const review = (await text(path.join(dir, 'vx.lock.json')))!
  const locked = (JSON.parse(lock) as { projects: Record<string, { config: object }> }).projects[
    'packages/a'
  ]!.config
  expect(JSON.parse(review)).toMatchObject(locked)
  expect(review).toStartWith('{\n  "tasks": {')
  expect(await text(path.join(r, '.vx', '.gitattributes'))).toBe(
    'projects.lock.json linguist-generated=true\n',
  )
  expect(vx(r, 'lock', '--check').code).toBe(0)
})

it('vx lock --check fails on a stale or missing review copy', async () => {
  const r = (root = await makeWorkspace({ prefix: 'vx-lock-review-stale-' }))
  const dir = await addProject(r, 'a', { config: CONFIG })
  expect(vx(r, 'lock').code).toBe(0)
  await Bun.write(path.join(dir, 'vx.lock.json'), '{}\n')
  const stale = vx(r, 'lock', '--check')
  expect([stale.code, stale.err]).toEqual([
    1,
    noticed(
      `vx lock --check: "a" (packages/a/vx.lock.json) is not what its config resolves to here — run 'vx lock'\n`,
    ),
  ])
  await rm(path.join(dir, 'vx.lock.json'))
  const missing = vx(r, 'lock', '--check')
  expect([missing.code, missing.err]).toEqual([
    1,
    noticed(`vx lock --check: "a" has no packages/a/vx.lock.json — run 'vx lock'\n`),
  ])
  expect(vx(r, 'lock').code).toBe(0)
  expect(vx(r, 'lock', '--check').code).toBe(0)
})

it('vx lock --check fails on a review copy whose config is gone', async () => {
  // Its config deleted, the project kept (its package.json): the copy
  // still showed reviewers tasks nothing runs, and the audit passed.
  const r = (root = await makeWorkspace({ prefix: 'vx-lock-review-orphan-' }))
  const dir = await addProject(r, 'a', { config: CONFIG })
  await addProject(r, 'b', { config: CONFIG })
  expect(vx(r, 'lock').code).toBe(0)
  await rm(path.join(dir, 'vx.config.mjs'))
  expect(vx(r, 'lock').code).toBe(0)
  const orphan = vx(r, 'lock', '--check')
  expect([orphan.code, orphan.err]).toEqual([
    1,
    noticed(`vx lock --check: packages/a/vx.lock.json has no vx.config beside it — delete it\n`),
  ])
  await rm(path.join(dir, 'vx.lock.json'))
  expect(vx(r, 'lock', '--check')).toMatchObject({ code: 0, err: '' })
})

// A directory nothing discovers once its config is gone (no package.json,
// no plugin) kept its copy too, and the audit passed: the copy then keyed
// the `**` of the project around it (2026-10-23).
it('vx lock --check names a review copy left where no project is', async () => {
  const r = (root = await makeWorkspace({ prefix: 'vx-lock-review-stray-' }))
  await addProject(r, 'a', { config: CONFIG })
  const gone = path.join(r, 'packages', 'a', 'old')
  await Bun.write(path.join(gone, 'vx.config.mjs'), CONFIG)
  expect(vx(r, 'lock').code).toBe(0)
  expect(await text(path.join(gone, 'vx.lock.json'))).not.toBeNull()
  await rm(path.join(gone, 'vx.config.mjs'))
  // `vx lock` names it too: it wrote clean, and the `--check` after it failed.
  const lock = vx(r, 'lock')
  expect([lock.code, lock.err]).toEqual([
    0,
    noticed(
      `vx lock: packages/a/old/vx.lock.json has no vx.config beside it — delete it\n`,
      'warn',
    ),
  ])
  const stray = vx(r, 'lock', '--check')
  expect([stray.code, stray.err]).toEqual([
    1,
    noticed(
      `vx lock --check: packages/a/old/vx.lock.json has no vx.config beside it — delete it\n`,
    ),
  ])
  await rm(path.join(gone, 'vx.lock.json'))
  expect(vx(r, 'lock', '--check')).toMatchObject({ code: 0, err: '' })
})

it('a committed project removed from disk leaves no stray copy to delete', async () => {
  // `rm -rf packages/b` before `git rm`: git still lists its copy, which
  // is already gone, and `vx lock` told the user to delete it.
  const r = (root = await makeWorkspace({ prefix: 'vx-lock-review-removed-' }))
  await addProject(r, 'a', { config: CONFIG })
  const dir = await addProject(r, 'b', { config: CONFIG })
  expect(vx(r, 'lock').code).toBe(0)
  gitIn(r)('add', '-A')
  gitIn(r)('commit', '-qm', 'locked')
  await rm(dir, { recursive: true })
  expect(vx(r, 'lock')).toMatchObject({ code: 0, err: '' })
  expect(vx(r, 'lock', '--check')).toMatchObject({ code: 0, err: '' })
})

it('lock.reviewFiles: false writes none and checks none; an existing .gitattributes stays', async () => {
  const r = (root = await makeWorkspace({ prefix: 'vx-lock-review-off-' }))
  const dir = await addProject(r, 'a', { config: CONFIG })
  await Bun.write(
    path.join(r, '.vx', 'workspace.mjs'),
    'export default { lock: { reviewFiles: false } }\n',
  )
  await Bun.write(path.join(r, '.vx', '.gitattributes'), 'mine\n')
  expect(vx(r, 'lock').code).toBe(0)
  expect(await text(path.join(dir, 'vx.lock.json'))).toBeNull()
  expect(vx(r, 'lock', '--check').code).toBe(0)
  expect(await text(path.join(r, '.vx', '.gitattributes'))).toBe('mine\n')
  // The variable says it too, as every setting's does.
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'lock'],
    cwd: r,
    env: { ...process.env, VX_LOCK_REVIEW_FILES: 'true' },
  })
  expect(p.exitCode).toBe(0)
  expect(await text(path.join(dir, 'vx.lock.json'))).not.toBeNull()
})

it('vx lock --check reads a review copy as JSON: a formatter may lay it out its own way', async () => {
  const r = (root = await makeWorkspace({ prefix: 'vx-lock-review-fmt-' }))
  const dir = await addProject(r, 'a', { config: CONFIG })
  expect(vx(r, 'lock').code).toBe(0)
  const file = path.join(dir, 'vx.lock.json')
  await Bun.write(file, JSON.stringify(JSON.parse((await text(file))!)))
  expect(vx(r, 'lock', '--check').code).toBe(0)
})

// A review copy is vx's own output, never read: a re-lock that rewrote
// every one (a new vx, a format change) selected every project under
// --affected, while no key moved. One inside a project's sources is a file.
it('a changed review copy selects nothing under --affected', async () => {
  const r = (root = await makeWorkspace({ prefix: 'vx-lock-review-aff-', edges: {} }))
  const cfg = `export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: ['**'] } } } }\n`
  const dir = await addProject(r, 'a', { config: cfg, files: { 'src/vx.lock.json': '1' } })
  expect(vx(r, 'lock').code).toBe(0)
  gitIn(r)('add', '-A')
  gitIn(r)('commit', '-q', '-m', 'init')
  await Bun.write(path.join(dir, 'vx.lock.json'), '{}\n')
  const none = vx(r, 'show', '--affected=HEAD')
  expect(none.err).toContain('nothing affected since HEAD')
  await Bun.write(path.join(dir, 'src/vx.lock.json'), '2')
  expect(vx(r, 'show', '--affected=HEAD').out).toContain('packages/a')
})
