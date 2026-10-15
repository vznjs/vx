// `vx show` in a workspace with no project printed nothing and exited 0, so a
// first-time user saw a blank line where `vx run` names the fix (bug hunt
// round 3, 2026-10-15). It now says there is no project and how to get one,
// on stderr; stdout stays empty, so a script reading the list reads none.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
let root = ''

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-show-empty-'))
  await mkdir(path.join(root, '.vx'), { recursive: true })
  await writeFile(path.join(root, '.vx', 'workspace.mjs'), localWorkspaceSource())
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('vx show in an empty workspace says so and names vx init', () => {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'show'],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  })
  expect(p.exitCode).toBe(0)
  expect(p.stdout.toString()).toBe('')
  const err = p.stderr.toString()
  expect(err).toContain('no projects')
  expect(err).toContain('vx init')
}, 20_000)
