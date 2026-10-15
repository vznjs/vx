// `vx lock` writes the lock vx reads minified, a pretty `vx.lock.json`
// beside each project's config for review (M, 2026-10-14), and
// `.vx/.gitattributes` so GitHub collapses the machine lock.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

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
    '{"version":3,"projects":{"packages/a":{"file":"vx.config.mjs","config":',
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
    `vx lock --check: "a" (packages/a/vx.lock.json) is not what its config resolves to here — run 'vx lock'\n`,
  ])
  await rm(path.join(dir, 'vx.lock.json'))
  const missing = vx(r, 'lock', '--check')
  expect([missing.code, missing.err]).toEqual([
    1,
    `vx lock --check: "a" has no packages/a/vx.lock.json — run 'vx lock'\n`,
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
    `vx lock --check: packages/a/vx.lock.json has no vx.config beside it — delete it\n`,
  ])
  await rm(path.join(dir, 'vx.lock.json'))
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
