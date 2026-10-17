// Every run's footer names the run as `vx last` takes it (M, 2026-10-17):
// the id a reader copies from the footer opens that run's record.

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

it('a passing and a failing run each print their id on the info row, and vx last opens it', () => {
  const ok = vx('run', 'build', '--all')
  expect(ok.code).toBe(0)
  const okId = footerId(ok.out)
  expect(okId).toMatch(/^[0-9a-f-]{13,}$/)
  const bad = vx('run', 'bad', '--all')
  expect(bad.code).toBe(1)
  const badId = footerId(bad.out)
  expect(badId).toMatch(/^[0-9a-f-]{13,}$/)
  expect(badId).not.toBe(okId)
  const list = vx('last', '--list').out
  expect(list).toContain(`  ${okId}  `)
  expect(list).toContain(`  ${badId}  `)
  expect(vx('last', okId!).code).toBe(0)
}, 60_000)
