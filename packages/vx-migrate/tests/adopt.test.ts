// What vx-migrate does around the mapping (src/adopt.ts): the native/keep
// choice and installing vx with the repo's manager. solidjs/solid,
// 2026-10-04: configs were written and nothing installed vx. The repo's
// own scripts are never edited (owner, 2026-10-06).

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { installArgv, missingPackages, packageManagerOf, parseModeAnswer } from '../src/adopt.js'
import { parseMigrateArgs } from '../src/migrate.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

describe('the adoption mode', () => {
  it('--native and --keep set it; both is refused, and none leaves it to the prompt', () => {
    expect([
      parseMigrateArgs(['--native']).mode,
      parseMigrateArgs(['--keep']).mode,
      parseMigrateArgs([]).mode,
      parseMigrateArgs(['--keep', '--native']).error,
      parseMigrateArgs(['--no-install']).noInstall,
    ]).toEqual([
      'native',
      'keep',
      undefined,
      '--native and --keep are two answers to one question; pass one',
      true,
    ])
  })

  it('the answer: empty or EOF is native, 2 is keep, anything else asks again', () => {
    expect(['', null, '1', 'native', ' 2 ', 'keep', 'x'].map(parseModeAnswer)).toEqual([
      'native',
      'native',
      'native',
      'native',
      'keep',
      'keep',
      undefined,
    ])
  })
})

describe('the package manager', () => {
  it('packageManager wins, then the lockfile, then the runner, then npm', async () => {
    const root = await tmp('vx-adopt-pm-')
    try {
      const at = (pj: object) => writeFile(path.join(root, 'package.json'), JSON.stringify(pj))
      await at({ packageManager: 'pnpm@9.15.0' })
      await writeFile(path.join(root, 'yarn.lock'), '')
      const declared = packageManagerOf(root)
      await at({})
      const locked = packageManagerOf(root)
      await rm(path.join(root, 'yarn.lock'))
      const agent = packageManagerOf(root, 'bun/1.4.2 npm/? node/v24')
      expect([declared, locked, agent, packageManagerOf(root)]).toEqual([
        'pnpm',
        'yarn',
        'bun',
        'npm',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('adds at the workspace root: pnpm -w, Yarn 1 -W, Berry without', async () => {
    const root = await tmp('vx-adopt-argv-')
    try {
      await writeFile(path.join(root, 'yarn.lock'), '# yarn lockfile v1\n')
      const yarn1 = installArgv(root, 'yarn', ['@vzn/vx'])
      await writeFile(path.join(root, 'yarn.lock'), '__metadata:\n  version: 8\n')
      expect([
        installArgv(root, 'pnpm', ['@vzn/vx']),
        yarn1,
        installArgv(root, 'yarn', ['@vzn/vx']),
        installArgv(root, 'bun', ['@vzn/vx']),
        installArgv(root, 'npm', ['@vzn/vx']),
      ]).toEqual([
        ['pnpm', 'add', '-D', '-w', '@vzn/vx'],
        ['yarn', 'add', '-D', '-W', '@vzn/vx'],
        ['yarn', 'add', '-D', '@vzn/vx'],
        ['bun', 'add', '-d', '@vzn/vx'],
        ['npm', 'install', '-D', '@vzn/vx'],
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a package is adopted only listed AND installed', async () => {
    const root = await tmp('vx-adopt-missing-')
    const wanted = ['@vzn/vx', '@vzn/vx-migrate']
    try {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ devDependencies: { '@vzn/vx': '*' } }),
      )
      const listedOnly = missingPackages(root, wanted)
      // Installed but unlisted: a package.json reset after an earlier run.
      await mkdir(path.join(root, 'node_modules', '@vzn', 'vx-migrate'), { recursive: true })
      await writeFile(path.join(root, 'node_modules', '@vzn', 'vx-migrate', 'package.json'), '{}')
      const installedOnly = missingPackages(root, wanted)
      await mkdir(path.join(root, 'node_modules', '@vzn', 'vx'), { recursive: true })
      await writeFile(path.join(root, 'node_modules', '@vzn', 'vx', 'package.json'), '{}')
      expect([listedOnly, installedOnly, missingPackages(root, wanted)]).toEqual([
        ['@vzn/vx', '@vzn/vx-migrate'],
        ['@vzn/vx', '@vzn/vx-migrate'],
        ['@vzn/vx-migrate'],
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('given its own version, one installed at another is missing too', async () => {
    const root = await tmp('vx-adopt-skew-')
    try {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ devDependencies: { '@vzn/vx': '*', '@vzn/vx-lockfile': '*' } }),
      )
      for (const [p, v] of [
        ['vx', '0.0.511'],
        ['vx-lockfile', '0.0.512'],
      ]) {
        await mkdir(path.join(root, 'node_modules', '@vzn', p!), { recursive: true })
        await writeFile(
          path.join(root, 'node_modules', '@vzn', p!, 'package.json'),
          JSON.stringify({ version: v }),
        )
      }
      const wanted = ['@vzn/vx', '@vzn/vx-lockfile']
      expect([missingPackages(root, wanted), missingPackages(root, wanted, '0.0.512')]).toEqual([
        [],
        ['@vzn/vx'],
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

/**
 * A pnpm Turbo repo with no vx installed, and a fake `pnpm` first on PATH
 * that records its argv: the install is the repo's manager, not a download.
 */
async function solidShaped(): Promise<{ root: string; env: Record<string, string> }> {
  const root = await tmp('vx-adopt-e2e-')
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', private: true, scripts: { build: 'turbo run build' } }, null, 2) +
      '\n',
  )
  await writeFile(
    path.join(root, 'turbo.json'),
    JSON.stringify({ tasks: { build: { dependsOn: ['^build'], outputs: ['dist/**'] } } }),
  )
  for (const [name, scripts] of [
    ['lib', { build: 'tsc' }],
    ['ssr', {}],
  ] as const) {
    await mkdir(path.join(root, 'packages', name), { recursive: true })
    await writeFile(
      path.join(root, 'packages', name, 'package.json'),
      JSON.stringify({ name, scripts }),
    )
  }
  const bin = path.join(root, '.fake-bin')
  await mkdir(bin)
  await writeFile(path.join(bin, 'pnpm'), `#!/bin/sh\necho "$@" >> "${root}/.pnpm-calls"\n`)
  await chmod(path.join(bin, 'pnpm'), 0o755)
  const env = { ...process.env, PATH: `${bin}:${process.env['PATH']}` } as Record<string, string>
  return { root, env }
}

async function migrate(root: string, env: Record<string, string>, args: string[]) {
  // --no-install, as the bin's shebang runs it.
  const proc = Bun.spawn([process.execPath, '--no-install', BIN, ...args], {
    cwd: root,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out, err, code }
}

const calls = (root: string) => readFile(path.join(root, '.pnpm-calls'), 'utf8').catch(() => '')

describe('vx-migrate on a pnpm Turbo repo with no vx installed', () => {
  it(
    'no terminal: native, vx installed with pnpm, its built-in plugins declared, scripts untouched',
    async () => {
      const { root, env } = await solidShaped()
      try {
        const r = await migrate(root, env, [])
        const pj = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
          scripts: Record<string, string>
        }
        const ws = await readFile(path.join(root, 'vx.workspace.ts'), 'utf8')
        expect([
          r.code,
          await calls(root),
          pj.scripts,
          await Bun.file(path.join(root, 'packages', 'lib', 'vx.config.ts')).exists(),
          await Bun.file(path.join(root, 'packages', 'ssr', 'vx.config.ts')).exists(),
          [...ws.matchAll(/^ {4}(\w+)\(\),$/gm)].map((m) => m[1]),
          ws.includes("import { scheduleHistoryPlugin } from '@vzn/vx-schedule-history'"),
          r.out.includes('Declare pnpm()'),
        ]).toEqual([
          0,
          'add -D -w @vzn/vx @vzn/vx-lockfile @vzn/vx-schedule-history\n',
          { build: 'turbo run build' },
          true,
          false,
          ['pnpm', 'scheduleHistoryPlugin'],
          true,
          false,
        ])
        expect(r.out).toContain(
          'note: installed @vzn/vx @vzn/vx-lockfile @vzn/vx-schedule-history (pnpm add -D -w',
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    '--keep installs the plugin packages and adds the plugins to the file vx init writes',
    async () => {
      const { root, env } = await solidShaped()
      try {
        await mkdir(path.join(root, '.github', 'workflows'), { recursive: true })
        const r = await migrate(root, env, ['--keep'])
        const ws = await readFile(path.join(root, 'vx.workspace.ts'), 'utf8')
        expect([
          r.code,
          await calls(root),
          ws.includes("import { turbo } from '@vzn/vx-migrate'"),
          [...ws.matchAll(/^ {4}(\w+)\(\),$/gm)].map((m) => m[1]),
          ws.includes("import { github } from '@vzn/vx-ci'"),
          await Bun.file(path.join(root, 'packages', 'lib', 'vx.config.ts')).exists(),
        ]).toEqual([
          0,
          'add -D -w @vzn/vx @vzn/vx-migrate @vzn/vx-lockfile @vzn/vx-schedule-history @vzn/vx-ci\n',
          true,
          ['turbo', 'pnpm', 'scheduleHistoryPlugin', 'github'],
          true,
          false,
        ])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    '--dry and --no-install leave package.json and the manager alone',
    async () => {
      const { root, env } = await solidShaped()
      try {
        const before = await readFile(path.join(root, 'package.json'), 'utf8')
        const dry = await migrate(root, env, ['--dry'])
        const noInstall = await migrate(root, env, ['--no-install', '--force'])
        expect([
          dry.code,
          noInstall.code,
          await calls(root),
          dry.out.includes(
            'note: would install @vzn/vx @vzn/vx-lockfile @vzn/vx-schedule-history (dry run)',
          ),
        ]).toEqual([0, 0, '', true])
        expect(await readFile(path.join(root, 'package.json'), 'utf8')).toBe(before)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

// nartc/mapper, 2026-10-07: every executor target is an `nx-exec` line,
// and a native migration installed vx alone, so `bunx @vzn/vx-migrate`
// left lint failing with `nx-exec: not found` (exit 127).
describe('vx-migrate on a pnpm Nx repo', () => {
  async function nxShaped(target: Record<string, unknown>) {
    const root = await tmp('vx-adopt-nx-')
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "libs/*"\n')
    await writeFile(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
    await writeFile(path.join(root, 'package.json'), '{"name":"r","private":true}\n')
    await writeFile(path.join(root, 'nx.json'), '{}\n')
    await mkdir(path.join(root, 'libs', 'a'), { recursive: true })
    await writeFile(path.join(root, 'libs', 'a', 'package.json'), '{"name":"a"}\n')
    await mkdir(path.join(root, '.nx', 'workspace-data'), { recursive: true })
    await writeFile(
      path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
      JSON.stringify({
        nodes: { a: { name: 'a', data: { root: 'libs/a', targets: { lint: target } } } },
        dependencies: {},
      }),
    )
    const bin = path.join(root, '.fake-bin')
    await mkdir(bin)
    await writeFile(path.join(bin, 'pnpm'), `#!/bin/sh\necho "$@" >> "${root}/.pnpm-calls"\n`)
    await chmod(path.join(bin, 'pnpm'), 0o755)
    const env = { ...process.env, PATH: `${bin}:${process.env['PATH']}` } as Record<string, string>
    return { root, env }
  }

  it(
    'installs @vzn/vx-migrate when a written task runs nx-exec, not when none does',
    async () => {
      const exec = await nxShaped({ executor: '@nx/eslint:lint', options: {} })
      // CONTROL: a run-commands target is its own shell line.
      const shell = await nxShaped({ command: 'eslint .' })
      try {
        const r = await migrate(exec.root, exec.env, [])
        const c = await migrate(shell.root, shell.env, [])
        expect([r.code, await calls(exec.root), c.code, await calls(shell.root)]).toEqual([
          0,
          'add -D -w @vzn/vx @vzn/vx-migrate @vzn/vx-lockfile @vzn/vx-schedule-history\n',
          0,
          'add -D -w @vzn/vx @vzn/vx-lockfile @vzn/vx-schedule-history\n',
        ])
      } finally {
        await rm(exec.root, { recursive: true, force: true })
        await rm(shell.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
