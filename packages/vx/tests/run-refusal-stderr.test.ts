// A run that refuses to start (a requested task no project declares)
// says so on stderr as `vx run: …`, the way `--dry` and every other
// refusal does. It printed "No projects declare task(s): …" through the
// status logger, to stdout, into whatever a script piped there.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { rm } from 'node:fs/promises'
import { makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

let root = ''
beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-refusal-' })
  await mkdir(path.join(root, 'packages', 'app'), { recursive: true })
  await writeFile(path.join(root, 'packages', 'app', 'package.json'), '{"name":"app"}')
  await writeFile(
    path.join(root, 'packages', 'app', 'vx.config.mjs'),
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

it('a run and its --dry refuse an undeclared task alike: one stderr line, exit 1', () => {
  const line = 'vx run: no projects declare task(s): biuld. Did you mean build?\n'
  expect(vx('run', 'biuld', '--all')).toEqual([1, '', line])
  expect(vx('run', 'biuld', '--all', '--dry')).toEqual([1, '', line])
}, 30_000)

// Agent trial 3: an agent added a task to a vx.config and ran it. The run
// reads the lock, so it refused with no word that the lock was the cause.
it('a task the lock does not hold yet names `vx lock` as the fix', async () => {
  const lock = Bun.spawnSync({
    cmd: [process.execPath, path.resolve(import.meta.dir, '..', 'src', 'bin.ts'), 'lock'],
    cwd: root,
    env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false' },
  })
  expect(lock.exitCode).toBe(0)
  await writeFile(
    path.join(root, 'packages', 'app', 'vx.config.mjs'),
    "export default { tasks: { build: { exec: { command: 'true' } }, lint: { exec: { command: 'true' } } } }\n",
  )
  const p = Bun.spawnSync({
    cmd: [
      process.execPath,
      path.resolve(import.meta.dir, '..', 'src', 'bin.ts'),
      'run',
      'lint',
      '--all',
    ],
    cwd: root,
  })
  expect(p.exitCode).toBe(1)
  expect(p.stderr.toString()).toBe(
    'vx run: no projects declare task(s): lint. Tasks: build. A run reads the lock: after editing a vx.config, run `vx lock`.\n',
  )
}, 30_000)
