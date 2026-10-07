// `vx-migrate` on a Vite Task workspace (vite-plus's `vp run`): each
// `vite.config` `run.tasks` entry and package.json script → the vx task the
// written config loads.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { loadProjectConfig } from '@vzn/vx'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const CORE_PKG = path.resolve(import.meta.dir, '..', '..', 'vx')

async function vx(
  root: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, BIN, '--no-install', ...args], {
    cwd: root,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

async function pkg(root: string, name: string, json: object, viteConfig?: string): Promise<void> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, ...json }))
  if (viteConfig !== undefined) await writeFile(path.join(dir, 'vite.config.ts'), viteConfig)
}

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-vt-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'ws', private: true, devDependencies: { 'vite-plus': '^1.1.0' } }),
  )
  await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
  await symlink(CORE_PKG, path.join(root, 'node_modules', '@vzn', 'vx'), 'dir')
  await writeFile(
    path.join(root, 'vite.config.ts'),
    `export default {
  run: {
    cache: { scripts: false },
    tasks: {
      'check-all': { command: 'oxlint .', cache: { input: ['**/*.ts', '!dist/**'], output: [] } },
    },
  },
}
`,
  )
  await pkg(root, 'tool', { scripts: { build: 'tsc' } })
  await pkg(
    root,
    'lib',
    {
      scripts: {
        prebuild: 'echo never',
        lint: 'eslint .',
        prelint: 'echo pre',
        postinstall: 'node x',
      },
    },
    `export default {
  run: {
    tasks: {
      build: {
        command: ['tsc', 'node copy.mjs'],
        cache: {
          env: ['NODE_ENV', 'VITE_*', 'DEBUG', '!DEBUG'],
          untrackedEnv: ['CI', 'GH_TOKEN'],
          input: ['src/**', '!src/**/*.test.ts', { pattern: 'tsconfig.base.json', base: 'workspace' }],
          output: ['dist/**', '!dist/cache/**'],
        },
      },
    },
  },
}
`,
  )
  await pkg(
    root,
    'app',
    {
      dependencies: { lib: 'workspace:*' },
      devDependencies: { tool: 'workspace:*' },
      scripts: { dev: 'vite' },
    },
    `export default ({ mode }) => ({
  run: {
    tasks: {
      build: { command: 'vp build --mode ' + mode, dependsOn: [{ task: 'build', from: 'dependencies' }] },
      e2e: { command: 'vitest run', cwd: 'tests/e2e', dependsOn: ['build', 'lib#lint'], cache: false },
      typecheck: { command: 'tsc --noEmit', cache: { input: [{ auto: true }, '!dist/**'], output: [] } },
      all: { command: [], dependsOn: ['build', 'e2e'] },
      lintAll: 'eslint .',
    },
  },
})
`,
  )
  return root
}

describe('vx-migrate (vite-task)', () => {
  let root: string
  let result: { code: number; out: string; err: string }
  beforeAll(async () => {
    root = await makeWorkspace()
    result = await vx(root, [])
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const load = async (name: string) =>
    (await loadProjectConfig(path.join(root, 'packages', name, 'vx.config.ts'))).tasks!

  it('detects vite-plus and writes every package’s config and the root’s', () => {
    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    for (const f of [
      'packages/app/vx.config.ts',
      'packages/lib/vx.config.ts',
      'packages/tool/vx.config.ts',
      'vx.config.ts',
    ])
      expect(result.out).toContain(f)
  })

  it('maps a task’s command, env, inputs and outputs', async () => {
    const lib = await load('lib')
    expect(lib['build']).toEqual({
      exec: {
        command: 'tsc && node copy.mjs',
        env: { passThrough: ['NODE_ENV', 'CI', 'GH_TOKEN'] },
      },
      cache: {
        inputs: {
          files: ['src/**', '!src/**/*.test.ts'],
          workspaceFiles: ['tsconfig.base.json'],
          env: ['NODE_ENV'],
        },
        outputs: { files: ['dist/**', '!dist/cache/**'] },
      },
    })
    expect(result.out).toContain('cache.env "VITE_*": vx takes exact env names')
  })

  it('maps package.json scripts uncached, with their pre/post hooks folded in', async () => {
    const lib = await load('lib')
    // Hooks ride around a script; `build` is a task, so `prebuild` is a script of its own.
    expect(Object.keys(lib).sort()).toEqual(['build', 'lint', 'prebuild'])
    expect(lib['lint']!.cache).toBeUndefined()
    expect(lib['lint']!.exec!.command).toContain('echo pre')
    expect(lib['lint']!.exec!.command).toContain('eslint .')
  })

  it('maps dependsOn: `from` the dependencies alone names the edges when a devDependency also defines the task', async () => {
    const app = await load('app')
    expect(app['build']!.dependsOn).toEqual(['lib#build'])
    expect(app['e2e']!.dependsOn).toEqual(['build', 'lib#lint'])
    expect(app['all']).toEqual({ dependsOn: ['build', 'e2e'] })
  })

  it('evaluates a function config in build mode; cwd becomes a cd; cache: false and traced files are uncached', async () => {
    const app = await load('app')
    expect(app['build']!.exec!.command).toBe('vp build --mode production')
    expect(app['build']!.cache).toBeUndefined()
    expect(app['e2e']!.exec!.command).toBe('cd tests/e2e && vitest run')
    expect(app['e2e']!.cache).toBeUndefined()
    expect(app['typecheck']!.cache).toBeUndefined()
    expect(app['lintAll']!.exec!.command).toBe('eslint .')
    expect(result.out).toContain("cache: Vite Task traced this task's inputs and outputs")
    expect(result.out).toContain(
      'cache: Vite Task traced this task\'s inputs and vx infers none — add `cache: { inputs: { files: [...] }, outputs: { files: [...] } }` with the real ones (declared so far: `{"outputs":{"files":[]}}`)',
    )
  })

  it('a root task keys the workspace’s files', async () => {
    const ws = (await loadProjectConfig(path.join(root, 'vx.config.ts'))).tasks!
    expect(ws['check-all']!.cache).toEqual({
      inputs: { files: [], workspaceFiles: ['**/*.ts', '!dist/**'] },
      outputs: { files: [] },
    })
  })

  it('`from` covering every field that defines the task is `^task`', async () => {
    const r = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-vt-'))
    try {
      await writeFile(path.join(r, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
      await writeFile(path.join(r, 'package.json'), JSON.stringify({ name: 'r', private: true }))
      await mkdir(path.join(r, 'node_modules', '@vzn'), { recursive: true })
      await symlink(CORE_PKG, path.join(r, 'node_modules', '@vzn', 'vx'), 'dir')
      await pkg(r, 'a', { scripts: { build: 'tsc' } })
      await pkg(
        r,
        'b',
        { dependencies: { a: 'workspace:*' } },
        `export default { run: { tasks: { build: { command: 'tsc', dependsOn: [{ task: 'build', from: 'dependencies' }] } } } }\n`,
      )
      const res = await vx(r, ['--from', 'vite-task'])
      expect(res.code).toBe(0)
      const b = (await loadProjectConfig(path.join(r, 'packages', 'b', 'vx.config.ts'))).tasks!
      expect(b['build']!.dependsOn).toEqual(['^build'])
    } finally {
      await rm(r, { recursive: true, force: true })
    }
  })
})
