// A Vite Task `cache.env` wildcard (`VITE_*`) matches names in the run's
// environment; so does core's, so a written config keeps it as written. A
// `!` entry core cannot make is a TODO.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { loadProjectConfig } from '@vzn/vx'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const CORE_PKG = path.resolve(import.meta.dir, '../node_modules/@vzn/vx')

describe('vx-migrate (vite-task): env wildcards', () => {
  let root: string
  let out: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-vte-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'ws', private: true, devDependencies: { 'vite-plus': '^1.1.0' } }),
    )
    await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
    await symlink(CORE_PKG, path.join(root, 'node_modules', '@vzn', 'vx'), 'dir')
    await writeFile(path.join(root, '.gitignore'), 'node_modules\n')
    const lib = path.join(root, 'packages', 'lib')
    await mkdir(path.join(lib, 'src'), { recursive: true })
    await writeFile(path.join(lib, 'package.json'), JSON.stringify({ name: 'lib' }))
    await writeFile(
      path.join(lib, 'src', 'index.ts'),
      'export const u = import.meta.env.VITE_LIB_URL\n',
    )
    const app = path.join(root, 'packages', 'app')
    await mkdir(path.join(app, 'src'), { recursive: true })
    await writeFile(
      path.join(app, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { lib: 'workspace:*' } }),
    )
    await writeFile(
      path.join(app, 'src', 'main.ts'),
      'export const a = [import.meta.env.VITE_API_URL, import.meta.env.VITE_SECRET]\n',
    )
    await writeFile(
      path.join(app, 'vite.config.ts'),
      `export default { run: { tasks: { build: { command: 'vp build', cache: {
  env: ['VITE_*', '!VITE_SECRET'], untrackedEnv: ['NOPE_*'], input: ['src/**'], output: ['dist/**'],
} } } } }\n`,
    )
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
    const proc = Bun.spawn([process.execPath, BIN, '--no-install'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('keeps a wildcard as written, and names a `!` entry it cannot make', async () => {
    const app = (await loadProjectConfig(path.join(root, 'packages', 'app', 'vx.config.ts'))).tasks!
    expect(app['build']!.exec!.env).toEqual({ passThrough: ['NOPE_*'] })
    expect(app['build']!.inputs!.env).toEqual(['VITE_*'])
    expect(out).toContain(
      'cache.env "!VITE_SECRET": vx has no exclusion, so "VITE_*" still takes VITE_SECRET',
    )
  })
})
