// A `vp run` inside a command: Vite Task inlines it into its graph, so the
// migration writes the edges it stands for instead of a nested runner.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { loadProjectConfig } from '@vzn/vx'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const CORE_PKG = path.resolve(import.meta.dir, '../node_modules/@vzn/vx')

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
          quoted: 'vp run lint && echo "a&&b"',
          orelse: 'vp run lint && node a.js || node b.js',
          redirect: 'vp run lint && node a.js 2>&1',
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
    // Cached entries that are only a `vp run`: no command is left to cache.
    await writeFile(
      path.join(root, 'packages', 'lib', 'vite.config.ts'),
      `export default { run: { tasks: {
  all: { command: 'vp run build', cache: { input: ['src/**'], env: ['MODE'], output: ['dist/**'] } },
  bare: { command: 'vp run build', cache: { input: [], output: [] } },
  traced: { command: 'vp run build' },
} } }
`,
    )
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

  // Written with its `cache: true` and outputs, the config vx refused:
  // `cache` needs `exec`. Its inputs make it a no-op task (M 2026-11-25),
  // and with none it is a group.
  it('a cached chain is a no-op task of its inputs, or a group with none', async () => {
    const lib = (await loadProjectConfig(path.join(root, 'packages', 'lib', 'vx.config.ts'))).tasks!
    expect(lib['all']).toEqual({
      dependsOn: ['build'],
      inputs: { files: ['src/**'], env: ['MODE'] },
    })
    expect(lib['bare']).toEqual({ dependsOn: ['build'] })
    // Its trace TODO asked for \`cache: true\` there, which vx refuses.
    expect(lib['traced']).toEqual({ dependsOn: ['build'] })
    expect(out).not.toContain('lib#traced: cache')
  })

  it('a form with no edge spelling stays verbatim with a TODO', async () => {
    const ws = (await loadProjectConfig(path.join(root, 'vx.config.ts'))).tasks!
    expect(ws['dev']!.exec!.command).toBe('vp run -r --parallel dev')
    expect(ws['mix']!.exec!.command).toBe('echo a && vp run lint')
    expect(out).toContain('`vp run -r --parallel dev` runs Vite Task inside the command')
    expect(out).toContain('`vp run lint` runs Vite Task inside the command')
  })

  // Cut at every `&&`, `echo "a&&b"` was written back as `echo "a && b"`;
  // and `vp run lint && x || y`, which Vite Task runs whole in a shell (y
  // runs when lint fails), became an edge on lint that skips y instead.
  it('cuts only at a top-level `&&`, and never a chain with `||`', async () => {
    const ws = (await loadProjectConfig(path.join(root, 'vx.config.ts'))).tasks!
    expect(ws['quoted']).toEqual({ dependsOn: ['lint'], exec: { command: 'echo "a&&b"' } })
    expect(ws['redirect']).toEqual({ dependsOn: ['lint'], exec: { command: 'node a.js 2>&1' } })
    expect(ws['orelse']).toEqual({ exec: { command: 'vp run lint && node a.js || node b.js' } })
    expect(out).toContain(
      '`vp run lint && node a.js || node b.js` runs Vite Task inside the command',
    )
  })
})
