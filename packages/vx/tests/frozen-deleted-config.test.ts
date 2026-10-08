// `--frozen` runs what the lock records: an EDITED config still runs as
// locked, and a RENAMED one is refused (D-88). A DELETED config is neither:
// the project loads live as config-less, its locked tasks vanish, and the
// frozen run exited 0 having run only the other project's build (X-144).
import { rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

async function vx(root: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

let root: string
let config: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-h22-del-' })
  await addProject(root, 'app', {
    config: `export default { tasks: { build: { exec: { command: 'echo LOCKED-BUILD' } } } }\n`,
  })
  await addProject(root, 'lib', {
    config: `export default { tasks: { build: { exec: { command: 'echo LIB' } } } }\n`,
  })
  config = path.join(root, 'packages', 'app', 'vx.config.mjs')
  const lock = await vx(root, ['lock'])
  expect(`${lock.code}\n${lock.err}`).toStartWith('0\n')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

it('control: an edited config still runs as locked', async () => {
  await Bun.write(
    config,
    `export default { tasks: { build: { exec: { command: 'echo EDITED' } } } }\n`,
  )
  const r = await vx(root, ['run', 'build', '--all', '--frozen', '--output-logs=full'])
  expect(`${r.code}\n${r.err}`).toStartWith('0\n')
  expect(r.out).toContain('LOCKED-BUILD')
}, 30_000)

it('a deleted config the lock holds is refused, not silently dropped', async () => {
  await unlink(config)
  const r = await vx(root, ['run', 'build', '--all', '--frozen'])
  expect([r.code, r.out.includes('LIB'), r.err.trim()]).toEqual([
    1,
    false,
    'vx: vx-lock.json locks "app" at packages/app/vx.config.mjs, but it has no config now — run `vx lock` to refresh, or delete vx-lock.json',
  ])
}, 30_000)
