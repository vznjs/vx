// What `npm publish` uploads is a 1.0 contract surface: a file missing from
// a tarball is a package that installs and then cannot load. Each package
// scripts/build-npm.ts emits (@vzn/vx and every plugin) is packed with
// `npm pack --dry-run --json`, and its file list is compared with
// `tests/contract/pack/<package>.txt`. A stray test or fixture, a file over
// SIZE_CAP, or an `exports` / `bin` target the tarball lacks fails, naming
// the file. Then the packed @vzn/vx and @vzn/vx-migrate are installed with
// npm into a Turbo repo and `turbo()` runs it: a build, then a hit.
//
// `.unsafe`: the emitted packages carry the repo-root README and LICENSE,
// which a sandboxed task may not read, and the install reaches the registry
// for @vzn/vx's own dependencies.
//
// Regenerate after a deliberate change, then review the diff:
//   VX_UPDATE_CONTRACT=1 bun test tests/npm-pack.unsafe.test.ts

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { emitMainPackage, emitPluginPackages } from '../scripts/build-npm.ts'
import { gitIn, gitInit } from './helpers/workspace.js'

const RECORDS = path.join(import.meta.dir, 'contract', 'pack')
/** No single file a package ships is this large; the largest today is under 100 KiB. */
const SIZE_CAP = 512 * 1024
/** What never belongs in a tarball. */
const STRAY = /(^|\/)(tests?|__tests__|fixtures?)\/|\.test\.[cm]?[jt]s$/

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-pack-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const out = path.join(root, 'npm')
const packages = [
  { name: '@vzn/vx', dir: await emitMainPackage({ version: '9.9.9', outDir: out }) },
  ...(await emitPluginPackages({ version: '9.9.9', outDir: out })),
]

interface Packed {
  files: Array<{ path: string; size: number }>
}

function npm(cwd: string, ...args: string[]): { code: number | null; out: string } {
  const r = Bun.spawnSync({ cmd: ['npm', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
}

function packed(dir: string): Packed['files'] {
  const r = npm(dir, 'pack', '--dry-run', '--json')
  expect(r.code).toBe(0)
  return (JSON.parse(r.out.slice(r.out.indexOf('['))) as Packed[])[0]!.files
}

const update = process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true'

describe('the npm tarballs', () => {
  for (const { name, dir } of packages) {
    const file = path.join(RECORDS, `${name.replace('@vzn/', '')}.txt`)

    it(`${name}: its file list agrees with tests/contract/pack/, no strays, none too large`, () => {
      const files = packed(dir)
      const live =
        files
          .map((f) => f.path)
          .sort()
          .join('\n') + '\n'
      if (update) writeFileSync(file, live)
      expect({
        stray: files.filter((f) => STRAY.test(f.path)).map((f) => f.path),
        oversize: files.filter((f) => f.size > SIZE_CAP).map((f) => `${f.path} (${f.size} B)`),
      }).toEqual({ stray: [], oversize: [] })
      expect(live).toBe(readFileSync(file, 'utf8'))
    })

    it(`${name}: every exports and bin target is in the tarball`, () => {
      const list = new Set(packed(dir).map((f) => f.path))
      const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        exports?: unknown
        bin?: Record<string, string>
      }
      const targets: string[] = []
      const walk = (v: unknown): void => {
        if (typeof v === 'string') targets.push(v)
        else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) walk(x)
      }
      walk(manifest.exports)
      walk(manifest.bin)
      expect(targets.length).toBeGreaterThan(0)
      expect(targets.map((t) => t.replace(/^\.\//, '')).filter((t) => !list.has(t))).toEqual([])
    })
  }

  it('a record exists for each package, and none for another', () => {
    const recorded = readdirSync(RECORDS)
      .map((f) => f.replace(/\.txt$/, ''))
      .sort()
    expect(recorded).toEqual(packages.map((p) => p.name.replace('@vzn/', '')).sort())
  })

  it('installed from the tarballs with npm, turbo() builds a Turbo repo, then hits', () => {
    const tgz = path.join(root, 'tgz')
    mkdirSync(tgz)
    for (const name of ['@vzn/vx', '@vzn/vx-migrate']) {
      const { dir } = packages.find((p) => p.name === name)!
      expect(npm(dir, 'pack', '--pack-destination', tgz).code).toBe(0)
    }
    const repo = path.join(root, 'repo')
    const write = (rel: string, text: string): void => {
      mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
      writeFileSync(path.join(repo, rel), text)
    }
    write(
      'package.json',
      JSON.stringify({ name: 'turbo-repo', private: true, workspaces: ['packages/*'] }),
    )
    write(
      'turbo.json',
      JSON.stringify({
        tasks: { build: { dependsOn: ['^build'], inputs: ['src/**'], outputs: ['dist/**'] } },
      }),
    )
    for (const [name, deps] of [
      ['lib', {}],
      ['app', { lib: '*' }],
    ] as const) {
      write(
        `packages/${name}/package.json`,
        JSON.stringify({
          name,
          version: '0.0.0',
          dependencies: deps,
          scripts: { build: 'mkdir -p dist && cp src/index.js dist/' },
        }),
      )
      write(`packages/${name}/src/index.js`, `export const ${name} = 1\n`)
    }
    write('.gitignore', 'node_modules\ndist\n.vx\n')
    write(
      'vx.workspace.ts',
      "import { defineWorkspace } from '@vzn/vx'\nimport { turbo } from '@vzn/vx-migrate'\n\nexport default defineWorkspace({ plugins: [turbo()] })\n",
    )
    gitInit(repo)
    gitIn(repo)('add', '-A')
    gitIn(repo)('commit', '-q', '-m', 'init')
    const tarballs = ['vzn-vx-9.9.9.tgz', 'vzn-vx-migrate-9.9.9.tgz'].map((f) => path.join(tgz, f))
    const install = npm(repo, 'install', '-D', '--no-audit', '--no-fund', ...tarballs)
    expect([install.code, install.code === 0 ? '' : install.out]).toEqual([0, ''])
    const statuses = (): Record<string, string> => {
      const r = Bun.spawnSync({
        cmd: ['npx', 'vx', 'last', '--format', 'json'],
        cwd: repo,
        stdout: 'pipe',
      })
      const last = JSON.parse(r.stdout.toString()) as {
        tasks: Array<{ project: string; task: string; status: string }>
      }
      return Object.fromEntries(last.tasks.map((t) => [`${t.project}#${t.task}`, t.status]))
    }
    const run = (): number | null =>
      Bun.spawnSync({
        cmd: ['npx', 'vx', 'run', 'build', '--all'],
        cwd: repo,
        stdout: 'pipe',
        stderr: 'pipe',
      }).exitCode
    expect(run()).toBe(0)
    expect(statuses()).toEqual({ 'app#build': 'success', 'lib#build': 'success' })
    expect(run()).toBe(0)
    expect(statuses()).toEqual({ 'app#build': 'cache-hit', 'lib#build': 'cache-hit' })
  }, 180_000)
})
