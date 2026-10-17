// Every run's footer names the run by its whole id (M, 2026-10-17: "we
// need full run id"): the id a reader copies opens that run's record.

import { Database } from 'bun:sqlite'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

let root = ''
beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-footer-run-id-' })
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await writeFile(path.join(root, 'packages', 'a', 'package.json'), '{"name":"a"}')
  await writeFile(
    path.join(root, 'packages', 'a', 'vx.config.mjs'),
    "export default { tasks: { build: { exec: { command: 'true' } }, bad: { exec: { command: 'exit 3' } } } }\n",
  )
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const vx = (...args: string[]): { code: number; out: string } => {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  })
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
}

const footerId = (out: string): string | undefined => / · run (\S+)\n/.exec(out)?.[1]

const recorded = (): string[] => {
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'), { readonly: true })
  try {
    return (db.query('SELECT DISTINCT run_id FROM invocations').all() as Array<{ run_id: string }>)
      .map((r) => r.run_id)
      .sort()
  } finally {
    db.close()
  }
}

it('a passing and a failing run each print their whole id on the info row, and vx last opens it', () => {
  const ok = vx('run', 'build', '--all')
  expect(ok.code).toBe(0)
  const okId = footerId(ok.out)
  expect(okId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  const bad = vx('run', 'bad', '--all')
  expect(bad.code).toBe(1)
  const badId = footerId(bad.out)
  expect(badId).not.toBe(okId)
  expect(recorded()).toEqual([okId!, badId!].sort())
  const opened = vx('last', okId!)
  expect(opened.code).toBe(0)
  expect(opened.out).toContain(`run ${okId} — ok`)
}, 60_000)
