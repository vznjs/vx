// Two Vite Task tasks over the same output, or one reading another's output
// with no edge between them: Vite Task runs both, while core refuses the
// pair ("both write", "reads ... another task's output"), and the migrated
// workspace would not lock. The Turbo and Nx mappers resolve them with the
// shared-output passes; Vite Task now does too. Found by a vite.config fuzz
// through `vx lock`.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const CORE = path.resolve(import.meta.dir, '..', '..', 'vx', 'src', 'bin.ts')
const CORE_PKG = path.resolve(import.meta.dir, '../node_modules/@vzn/vx')

let root: string
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a migrated workspace with shared or read outputs locks', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-vtso-'))
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
  await symlink(CORE_PKG, path.join(root, 'node_modules', '@vzn', 'vx'), 'dir')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'ws',
      workspaces: ['packages/*'],
      devDependencies: { 'vite-plus': '1' },
    }),
  )
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(
    path.join(dir, 'vite.config.ts'),
    `export default { run: { tasks: {
      build: { command: 'b', cache: { input: ['src/**'], output: ['out/**'] } },
      pack: { command: 'p', cache: { input: ['src/**'], output: ['out/**'] } },
      lint: { command: 'l', cache: { input: ['src/**', 'gen/**'], output: [] } },
      gen: { command: 'g', cache: { input: ['src/**'], output: ['gen/**'] } },
    } } }`,
  )
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const mig = Bun.spawnSync([process.execPath, BIN, '--no-install', '--from', 'vite-task'], {
    cwd: root,
    env,
  })
  expect(mig.exitCode).toBe(0)
  await writeFile(path.join(root, '.vx', 'workspace.ts'), 'export default {}\n')
  const lock = Bun.spawnSync([process.execPath, CORE, 'lock'], { cwd: root, env })
  expect(lock.stdout.toString() + lock.stderr.toString()).toContain('✓ vx lock')
})
