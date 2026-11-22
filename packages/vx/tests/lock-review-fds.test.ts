// `vx lock` wrote every project's review copy at once: in a 400-project
// workspace under macOS's default `ulimit -n 256` its first lock, and every
// lock after a change that moves each resolved config, failed with EMFILE.
// The loads are bounded for that limit (project-loader.ts); the copies now
// are too.

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

it('writes 400 review copies under a 256-descriptor limit', async () => {
  const r = (root = await makeWorkspace({ prefix: 'vx-lock-fds-' }))
  for (let i = 0; i < 400; i++) await addProject(r, `p${i}`, { config: CONFIG })
  const p = Bun.spawnSync({
    cmd: ['sh', '-c', 'ulimit -n 256 && exec "$0" "$1" lock', process.execPath, BIN],
    cwd: r,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(p.stderr.toString()).not.toContain('EMFILE')
  expect(p.exitCode).toBe(0)
  expect(await Bun.file(path.join(r, 'packages', 'p399', 'vx.lock.json')).exists()).toBe(true)
}, 60_000)
