// The workspace config's bytecode bundle (workspace/config-bytecode.ts),
// driven through bin.ts as a user's run drives it: a plugin package that
// imports `@vzn/vx` from node_modules, a plugin verb that reports where it
// ran from. The bundle must run what the source runs, and step aside the
// moment the source could run differently.

import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const CORE_PKG = path.resolve(import.meta.dir, '..')
const TIMEOUT = 30_000

let root: string
let plugin: string
beforeEach(async () => {
  root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-config-bytecode-')))
  await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
  await symlink(CORE_PKG, path.join(root, 'node_modules', '@vzn', 'vx'))
  plugin = path.join(root, 'node_modules', 'vx-probe')
  await mkdir(plugin, { recursive: true })
  await writeFile(
    path.join(plugin, 'package.json'),
    JSON.stringify({ name: 'vx-probe', type: 'module', exports: './index.ts' }),
  )
  await writeProbe("'one'")
  await mkdir(path.join(root, '.vx', 'cache'), { recursive: true })
  await writeFile(
    path.join(root, '.vx', 'workspace.ts'),
    "import probe from 'vx-probe'\nexport default { plugins: [probe()] }\n",
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeProbe(value: string, extra = ''): Promise<void> {
  await writeFile(
    path.join(plugin, 'index.ts'),
    `import { definePlugin } from '@vzn/vx'\n${extra}\n` +
      `const value: string = ${value}\n` +
      `export default (preset?: string) => definePlugin(import.meta, { commands: { probe: { description: 'probe', run() {\n` +
      `  console.log(JSON.stringify({ value: preset ?? value, dir: import.meta.dir, dirname: __dirname, url: import.meta.url,\n` +
      `    bundled: (new Error().stack ?? '').includes('/compiled/workspace-') }))\n  return 0\n` +
      `} } } })\n`,
  )
}

interface Probe {
  value: string
  dir: string
  dirname: string
  url: string
  bundled: boolean
}

function probe(): Probe {
  const p = Bun.spawnSync([process.execPath, BIN, 'probe'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(p.exitCode, p.stderr.toString()).toBe(0)
  return JSON.parse(p.stdout.toString().trim().split('\n').at(-1)!) as Probe
}

const compiled = (): Promise<string[]> =>
  readdir(path.join(root, '.vx', 'cache', 'compiled')).catch(() => [])

describe('workspace config bytecode', () => {
  it(
    'the second load runs the bundle, which sees the source file’s own location',
    async () => {
      const first = probe()
      expect(first.bundled).toBe(false)
      expect((await compiled()).some((f) => f.endsWith('.js.jsc'))).toBe(true)
      const second = probe()
      expect(second).toEqual({ ...first, bundled: true })
      expect(second.dir).toBe(plugin)
      expect(second.dirname).toBe(plugin)
      expect(second.url).toBe(`file://${path.join(plugin, 'index.ts')}`)
    },
    TIMEOUT,
  )

  it(
    'an edit to an imported plugin file is run, not the bundle of its old bytes',
    async () => {
      probe()
      expect(probe()).toMatchObject({ value: 'one', bundled: true })
      await writeProbe("'two'")
      expect(probe()).toMatchObject({ value: 'two', bundled: false })
      expect(probe()).toMatchObject({ value: 'two', bundled: true })
    },
    TIMEOUT,
  )

  it(
    'a bare import that now resolves elsewhere loads the source',
    async () => {
      probe()
      expect(probe().bundled).toBe(true)
      const moved = path.join(root, 'vendor', 'vx-probe')
      await mkdir(path.dirname(moved), { recursive: true })
      await Bun.$`cp -R ${plugin} ${moved}`.quiet()
      await writeFile(
        path.join(moved, 'index.ts'),
        (await Bun.file(path.join(plugin, 'index.ts')).text()).replace("'one'", "'vendored'"),
      )
      await rm(plugin, { recursive: true })
      await symlink(moved, plugin)
      expect(probe()).toMatchObject({ value: 'vendored', bundled: false, dir: moved })
    },
    TIMEOUT,
  )

  // The source load is Bun resolving each specifier anew: a file added where
  // it now looks first is what runs, though every bundled file is unchanged.
  for (const [spec, bundled, added] of [
    ['./preset', 'preset.js', 'preset.ts'],
    ['./preset.js', 'preset.ts', 'preset.js'],
    ['./preset', 'preset/index.js', 'preset/index.ts'],
  ] as const) {
    it(
      `a relative '${spec}' that now resolves to ${added}, not ${bundled}, loads the source`,
      async () => {
        await mkdir(path.dirname(path.join(root, '.vx', bundled)), { recursive: true })
        await writeFile(path.join(root, '.vx', bundled), "export default 'old'\n")
        await writeFile(
          path.join(root, '.vx', 'workspace.ts'),
          `import probe from 'vx-probe'\nimport preset from '${spec}'\nexport default { plugins: [probe(preset)] }\n`,
        )
        probe()
        expect(probe()).toMatchObject({ value: 'old', bundled: true })
        await writeFile(path.join(root, '.vx', added), "export default 'new'\n")
        expect(probe()).toMatchObject({ value: 'new', bundled: false })
        expect(probe()).toMatchObject({ value: 'new', bundled: true })
      },
      TIMEOUT,
    )
  }

  for (const [what, extra] of [
    ['top-level await', 'await Promise.resolve()'],
    ['a computed require', "const spec = './x.js'; if (Date.now() < 0) require(spec)"],
    ['an import.meta field beyond its location', 'if (import.meta.env === undefined) throw 0'],
  ] as const) {
    it(
      `${what} is never bundled`,
      async () => {
        await writeProbe("'one'", extra)
        probe()
        expect(probe().bundled).toBe(false)
        expect((await compiled()).some((f) => f.endsWith('.js'))).toBe(false)
      },
      TIMEOUT,
    )
  }

  it(
    'a fresh workspace with no cache yet gets no bundle',
    async () => {
      await rm(path.join(root, '.vx', 'cache'), { recursive: true })
      probe()
      expect(probe().bundled).toBe(false)
      expect(await compiled()).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'the bundle stays out of git under a cache dir elsewhere and no .vx/.gitignore',
    async () => {
      const cacheDir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-bytecode-cache-')))
      try {
        await writeFile(path.join(root, '.gitignore'), 'node_modules\n')
        await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws' }))
        await writeFile(
          path.join(root, 'vx.config.mjs'),
          "export default { name: 'ws', tasks: { hi: { exec: { command: 'true' } } } }\n",
        )
        const env = { ...process.env, VX_CACHE_DIR: cacheDir }
        const vx = (...args: string[]): void => {
          const p = Bun.spawnSync([process.execPath, BIN, ...args], {
            cwd: root,
            env,
            stderr: 'pipe',
          })
          expect(p.exitCode, p.stderr.toString()).toBe(0)
        }
        expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root }).exitCode).toBe(0)
        vx('lock')
        vx('run', 'hi')
        vx('run', 'hi')
        expect((await compiled()).some((f) => f.endsWith('.json'))).toBe(true)
        const status = Bun.spawnSync(['git', 'status', '--porcelain', '-uall'], { cwd: root })
        const lines = status.stdout.toString().split('\n')
        expect(lines.filter((l) => l.includes('.vx/cache/compiled'))).toEqual([])
      } finally {
        await rm(cacheDir, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
