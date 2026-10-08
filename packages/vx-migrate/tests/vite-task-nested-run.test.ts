// A `vp run` inside a command: Vite Task inlines it into its graph, so the
// migration writes the edges it stands for instead of a nested runner.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { loadProjectConfig } from '@vzn/vx'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const CORE_PKG = path.resolve(import.meta.dir, '..', '..', 'vx')

describe('vx-migrate (vite-task): nested `vp run`', () => {
  let root: string
  let out: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-vtn-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'ws',
        devDependencies: { 'vite-plus': '^1.1.0' },
        scripts: {
          build: 'vp run -r build',
          ci: 'vpr lint && vp run -w check && node report.js',
          web: 'vp run --filter app build',
          dev: 'vp run -r --parallel dev',
          mix: 'echo a && vp run lint',
          lint: 'oxlint',
          check: 'tsc',
        },
      }),
    )
    await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
    await symlink(CORE_PKG, path.join(root, 'node_modules', '@vzn', 'vx'), 'dir')
    for (const [name, scripts] of [
      ['lib', { build: 'tsc' }],
      ['app', { build: 'vite build', dev: 'vite', test: 'vp run lib#build && vitest' }],
    ] as const) {
      await mkdir(path.join(root, 'packages', name), { recursive: true })
      await writeFile(
        path.join(root, 'packages', name, 'package.json'),
        JSON.stringify({ name, scripts }),
      )
    }
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

  it('a chain of them is a group of its edges; what follows stays the command', async () => {
    const ws = (await loadProjectConfig(path.join(root, 'vx.config.ts'))).tasks!
    expect(ws['build']).toEqual({ dependsOn: ['app#build', 'lib#build'] })
    expect(ws['web']).toEqual({ dependsOn: ['app#build'] })
    expect(ws['ci']).toEqual({
      dependsOn: ['lint', 'ws#check'],
      exec: { command: 'node report.js' },
    })
    const app = (await loadProjectConfig(path.join(root, 'packages', 'app', 'vx.config.ts'))).tasks!
    expect(app['test']).toEqual({ dependsOn: ['lib#build'], exec: { command: 'vitest' } })
  })

  it('a form with no edge spelling stays verbatim with a TODO', async () => {
    const ws = (await loadProjectConfig(path.join(root, 'vx.config.ts'))).tasks!
    expect(ws['dev']!.exec!.command).toBe('vp run -r --parallel dev')
    expect(ws['mix']!.exec!.command).toBe('echo a && vp run lint')
    expect(out).toContain('`vp run -r --parallel dev` runs Vite Task inside the command')
    expect(out).toContain('`vp run lint` runs Vite Task inside the command')
  })
})
