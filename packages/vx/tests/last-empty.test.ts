// `vx last` before any run, and past only green ones. Before the first run
// every form says nothing has run: `--failed` said "no recorded run
// failed" and a run id pointed at a `--list` that lists nothing. Past
// green runs, `--list --failed` said "no recorded runs" with runs listed
// one flag away.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const NONE = 'vx last: no recorded runs yet — run something first\n'

let root = ''
beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-last-empty-' })
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await writeFile(path.join(root, 'packages', 'a', 'package.json'), '{"name":"a"}')
  await writeFile(
    path.join(root, 'packages', 'a', 'vx.config.mjs'),
    "export default { tasks: { build: { exec: { command: 'true' } } } }\n",
  )
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const vx = (...args: string[]): [number, string, string] => {
  const p = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd: root })
  return [p.exitCode, p.stdout.toString(), p.stderr.toString()]
}

it('before any run, every form says nothing has run', () => {
  expect([
    vx('last'),
    vx('last', '--failed'),
    vx('last', '0199'),
    vx('last', '--list'),
    vx('last', '--list', '--failed'),
  ]).toEqual([
    [1, '', NONE],
    [1, '', NONE],
    [1, '', NONE],
    [0, 'no recorded runs\n', ''],
    [0, 'no recorded runs\n', ''],
  ])
}, 30_000)

it('past a green run, --list --failed says none failed', () => {
  expect(vx('run', 'build', '--all')[0]).toBe(0)
  expect(vx('last', '--list', '--failed')).toEqual([0, 'no recorded run failed\n', ''])
}, 30_000)

it('past a run, a failed or unknown one is named as before (control)', () => {
  expect([vx('last', '--failed'), vx('last', '0199')]).toEqual([
    [1, '', 'vx last: no recorded run failed\n'],
    [1, '', 'vx last: no recorded run 0199 (vx last --list shows recent runs)\n'],
  ])
}, 30_000)
