// Bun reads `\` in a module path as a separator: a package under `a\b`
// had its vite.config looked for under `a/b`, and the migration stopped.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { loadProjectConfig } from '@vzn/vx'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const CORE_PKG = path.resolve(import.meta.dir, '..', '..', 'vx')

let root: string
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('reads a vite.config under a directory whose name holds a backslash', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-vtb-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'ws', private: true, devDependencies: { 'vite-plus': '^1.1.0' } }),
  )
  await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
  await symlink(CORE_PKG, path.join(root, 'node_modules', '@vzn', 'vx'), 'dir')
  const dir = path.join(root, 'packages', 'a\\b')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'ab' }))
  await writeFile(
    path.join(dir, 'vite.config.ts'),
    `
      const command: string = 'tsc'
      export default { run: { tasks: { build: { command, cache: false } } } }
    `,
  )
  const proc = Bun.spawn([process.execPath, BIN, '--no-install'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const err = await new Response(proc.stderr).text()
  expect({ code: await proc.exited, err }).toEqual({ code: 0, err: '' })
  const tasks = (await loadProjectConfig(path.join(dir, 'vx.config.ts'))).tasks!
  expect(tasks['build']!.exec!.command).toBe('tsc')
})
