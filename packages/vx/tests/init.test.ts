// `vx init`: its flags, the hand-off of a repo with a package.json to
// @vzn/vx-migrate, and `--plugin`. The repo with none is
// init-no-manifest.test.ts; package.json scripts, Turbo and Nx are mapped,
// and tested, in packages/vx-migrate.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { migrateCommand, parseInitArgs } from '../src/cli/init.js'
import { PLUGIN_TEMPLATES } from '../src/cli/plugin-templates.js'
import { definePlugin } from '../src/index.js'
import { noticed } from './helpers/notice.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const TIMEOUT = 20_000

interface VxResult {
  code: number
  out: string
  err: string
}

async function vx(root: string, args: string[]): Promise<VxResult> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
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

const CORE_PKG = path.resolve(import.meta.dir, '..')

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  )
  // The scaffolded `.vx/workspace.ts` imports `@vzn/vx`, and a tmp dir has
  // no node_modules. This used to resolve through a machine-global
  // `bun link`, so the suite passed or failed on invisible state outside
  // the repo — a `bun install` that drops the link turns every fixture
  // here into `Unexpected while resolving package '@vzn/vx'`. Link it
  // per fixture instead: the test now carries what it needs.
  await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
  await symlink(CORE_PKG, path.join(root, 'node_modules', '@vzn', 'vx'), 'dir')
  return root
}

async function addPackage(
  root: string,
  name: string,
  scripts: Record<string, string>,
  deps?: Record<string, string>,
): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, scripts, ...(deps ? { dependencies: deps } : {}) }),
  )
  return dir
}

describe('parseInitArgs', () => {
  it('defaults', () => {
    expect(parseInitArgs([])).toEqual({ dry: false, force: false, mjs: false })
  })
  it('--mjs', () => {
    expect(parseInitArgs(['--mjs']).mjs).toBe(true)
    expect(parseInitArgs([]).mjs).toBe(false)
  })
  it('--dry and --force', () => {
    expect(parseInitArgs(['--dry', '--force'])).toEqual({ dry: true, force: true, mjs: false })
  })
  it('unknown flag errors', () => {
    expect(parseInitArgs(['--nope']).error).toContain('--nope')
  })
  it('positionals error', () => {
    expect(parseInitArgs(['turbo']).error).toContain('turbo')
  })
  it('--native and --keep: one answer, never with --plugin', () => {
    expect([
      parseInitArgs(['--native']).mode,
      parseInitArgs(['--keep']).mode,
      parseInitArgs(['--keep', '--native']).error,
      parseInitArgs(['--keep', '--plugin', 'cache']).error,
    ]).toEqual([
      'native',
      'keep',
      '--native and --keep are two answers to one question; pass one (see `vx init --help`)',
      '--keep does not combine with --plugin (see `vx init --help`)',
    ])
  })

  it('a second --plugin is refused, not dropped', () => {
    // `--plugin executor --plugin cache` wrote the cache plugin alone.
    expect([
      parseInitArgs(['--plugin', 'executor', '--plugin=cache']).error,
      parseInitArgs(['--plugin', 'cache', '--plugin', 'cache']).plugin,
    ]).toEqual([
      '--plugin takes one seam; run vx init --plugin once per seam (see `vx init --help`)',
      'cache',
    ])
  })

  // One argv shape per refusal, each named for the branch it takes. The two
  // rows above use `toContain` on the argument itself, which every branch
  // satisfies — `--dryrun` reads as `--dry` under a prefix match, and a
  // SHORT flag falls to the positional message under a `--` test, both
  // without changing what the error mentions. What separates them is WHICH
  // refusal, so that is what is asserted.
  it.each([
    [[], undefined, { dry: false, force: false, mjs: false }],
    [['--dry'], undefined, { dry: true, force: false, mjs: false }],
    // A near-miss of a known flag is an unknown flag, not a prefix of one.
    [['--dryrun'], 'unknown flag: --dryrun', undefined],
    [['--dry-run'], 'unknown flag: --dry-run', undefined],
    [['--forced'], 'unknown flag: --forced', undefined],
    [['--mjsx'], 'unknown flag: --mjsx', undefined],
    // A single dash is still a flag: it gets the flag message and the
    // pointer, not the positional one.
    [['-d'], 'unknown flag: -d', undefined],
    [['-'], 'unknown flag: -', undefined],
    // Only a bare word is a positional; it gets the pointer too, as
    // `vx lock` and `vx upgrade` give it.
    [['turbo.json'], 'unexpected argument: turbo.json', undefined],
  ])('%p', (argv, error, parsed) => {
    const out = parseInitArgs(argv as string[])
    if (error === undefined) {
      expect(out.error).toBeUndefined()
      expect(out).toEqual(parsed as never)
    } else {
      expect(out.error).toBeDefined()
      expect(out.error!.startsWith(error as string)).toBe(true)
      expect(out.error!.endsWith(' (see `vx init --help`)')).toBe(true)
    }
  })
})

describe('vx init hands a repo with a package.json to @vzn/vx-migrate', () => {
  it('a refused flag exits 1, on stderr, writing nothing', async () => {
    // `cli run() > a bad argument to init points at its help` reads the
    // MESSAGE. The exit code and the stream are the rest of the contract and
    // were held by neither: a refusal that exits 0 is a script that carries
    // on, and one on stdout is a refusal piped into whatever reads the
    // scaffold.
    const root = await makeRoot('vx-init-bogus-')
    try {
      await addPackage(root, 'app', { build: 'tsc' })
      const r = await vx(root, ['init', '--bogus'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('unknown flag: --bogus')
      expect(r.out).toBe('')
      expect(existsSync(path.join(root, '.vx/workspace.ts'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('without --keep it runs the latest vx-migrate, never an installed one, but in a source checkout', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-init-migrate-'))
    try {
      const sub = path.join(root, 'packages', 'a')
      const before = migrateCommand([sub, root], ['--dry'], 'latest', '0.0.0')
      const bin = path.join(root, 'node_modules', '@vzn', 'vx-migrate', 'src', 'bin.ts')
      await mkdir(path.dirname(bin), { recursive: true })
      await writeFile(bin, '')
      // 2026-10-16: an installed 0.0.637 ran under vx 0.0.639 and pinned
      // core back to 0.0.637. "vx init should always install latest and upgrade all".
      expect([
        before,
        migrateCommand([sub, root], [], 'latest', '0.0.0'),
        migrateCommand([sub, root], ['--force'], '0.0.640', '0.0.639'),
      ]).toEqual([
        [process.execPath, 'x', '--silent', '@vzn/vx-migrate@latest', '--dry'],
        // Found from a directory below the one that has it.
        [process.execPath, '--no-install', bin],
        [process.execPath, 'x', '--silent', '@vzn/vx-migrate@0.0.640', '--force'],
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('vx run with no vx config', () => {
  it('a run in a workspace with no vx config at all names `vx init`', async () => {
    const root = await makeRoot('vx-init-first-run-')
    await addPackage(root, 'w', { build: 'echo hi' })
    await Bun.write(path.join(root, '.vx/workspace.mjs'), 'export default {}\n')
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    try {
      const r = await vx(root, ['run', 'build', '--all'])
      expect(r.code).not.toBe(0)
      expect(`${r.out}${r.err}`).toContain(
        'No directory holds a vx.config — run `vx init` to write them, then `vx lock`',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('vx init --plugin <seam>', () => {
  it(
    "writes the seam's plugin and its test, refuses to overwrite, and names the seams",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'vx-init-plugin-'))
      try {
        await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws' }))
        const ok = await vx(root, ['init', '--plugin', 'key'])
        expect([ok.code, ok.err]).toEqual([0, ''])
        expect(ok.out.split('\n')[0]).toBe('wrote plugins/key.ts and plugins/key.test.ts')
        expect(await Bun.file(path.join(root, 'plugins', 'key.ts')).text()).toBe(
          PLUGIN_TEMPLATES['key']!.plugin,
        )
        expect(await Bun.file(path.join(root, 'plugins', 'key.test.ts')).text()).toBe(
          PLUGIN_TEMPLATES['key']!.test,
        )
        const again = await vx(root, ['init', '--plugin', 'key'])
        expect([again.code, again.err]).toEqual([
          1,
          noticed('vx init: plugins/key.ts exists. --force overwrites it\n'),
        ])
        const bad = await vx(root, ['init', '--plugin', 'nope'])
        expect([bad.code, bad.err]).toEqual([
          1,
          noticed(
            `vx init: --plugin takes a seam: one of ${Object.keys(PLUGIN_TEMPLATES).join(', ')} (got 'nope') (see \`vx init --help\`)\n`,
          ),
        ])
        const empty = await vx(root, ['init', '--plugin='])
        expect([empty.code, empty.err]).toEqual([
          1,
          noticed(
            `vx init: --plugin takes a seam: one of ${Object.keys(PLUGIN_TEMPLATES).join(', ')} (see \`vx init --help\`)\n`,
          ),
        ])
        // --dry writes nothing.
        const dry = await vx(root, ['init', '--plugin=graph', '--dry'])
        expect(dry.code).toBe(0)
        expect(existsSync(path.join(root, 'plugins', 'graph.ts'))).toBe(false)
        expect(existsSync(path.join(root, 'plugins', 'key.ts'))).toBe(true)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a plugin scaffolded under a root package.json with no name loads',
    async () => {
      // A monorepo root often has no name. The plugin took the root's
      // package as its own and `definePlugin` refused it: the scaffold's
      // own "Declare it" step failed the next verb.
      const root = await mkdtemp(path.join(os.tmpdir(), 'vx-init-plugin-noname-'))
      try {
        await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true }))
        const ok = await vx(root, ['init', '--plugin', 'key'])
        expect([ok.code, ok.err]).toEqual([0, ''])
        expect(ok.out.split('\n')[0]).toBe(
          'wrote plugins/package.json and plugins/key.ts and plugins/key.test.ts',
        )
        // What the scaffolded module's `definePlugin(import.meta, …)` reads.
        expect(definePlugin({ dir: path.join(root, 'plugins') }, { setup() {} }).name).toBe(
          'workspace-plugins',
        )
        // CONTROL: a named root keeps its name for the plugin and gets no manifest.
        await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws' }))
        await rm(path.join(root, 'plugins'), { recursive: true })
        expect((await vx(root, ['init', '--plugin', 'key'])).code).toBe(0)
        expect(existsSync(path.join(root, 'plugins', 'package.json'))).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'names the workspace file that exists and refuses --mjs (X-28)',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'vx-init-plugin-mjs-'))
      try {
        await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws' }))
        await Bun.write(path.join(root, '.vx/workspace.mjs'), 'export default {}\n')
        const mjs = await vx(root, ['init', '--plugin', 'cache', '--mjs', '--dry'])
        expect([mjs.code, mjs.out, mjs.err]).toEqual([
          1,
          '',
          noticed(
            'vx init: --mjs does not combine with --plugin: the plugin templates are TypeScript (see `vx init --help`)\n',
          ),
        ])
        const ok = await vx(root, ['init', '--plugin', 'cache', '--dry'])
        expect([ok.code, ok.err]).toEqual([0, ''])
        expect(ok.out.split('\n')[1]).toStartWith('Declare it in .vx/workspace.mjs: import {')
        // CONTROL: with no workspace file, the one a run would read first.
        await rm(path.join(root, '.vx/workspace.mjs'))
        const none = await vx(root, ['init', '--plugin', 'cache', '--dry'])
        expect(none.out.split('\n')[1]).toStartWith('Declare it in .vx/workspace.ts: import {')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
