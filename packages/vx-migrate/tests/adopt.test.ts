// What vx-migrate does around the mapping (src/adopt.ts): the native/keep
// choice and installing vx with the repo's manager. solidjs/solid,
// 2026-10-04: configs were written and nothing installed vx. The repo's
// own scripts are never edited (2026-10-06).

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  installArgv,
  managerArgv,
  missingPackages,
  packageManagerOf,
  parseModeAnswer,
  removeArgv,
} from '../src/adopt.js'
import { parseMigrateArgs } from '../src/migrate.js'
import { generatedPlugins } from '../src/workspace-plugins.js'

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

describe('a workspace file vx wrote', () => {
  it("is @vzn imports and argument-less calls; anything else is the user's", () => {
    const init = (body: string) =>
      `import type { WorkspaceConfig } from '@vzn/vx/config'\n${body} satisfies WorkspaceConfig\n`
    expect(
      [
        init("import { turbo } from '@vzn/vx-migrate'\n\nexport default { plugins: [turbo()] }"),
        "import { nx, nxCache } from '@vzn/vx-migrate'\n\nexport default { plugins: [nx(), nxCache()] }\n",
        'export default { plugins: [] }\n',
        "import { turbo } from '@vzn/vx-migrate'\nexport default { plugins: [turbo({})] }\n",
        "import { turbo } from 'my-turbo'\nexport default { plugins: [turbo()] }\n",
        "import { turbo, x } from '@vzn/vx-migrate'\nexport default { plugins: [turbo()] }\n",
      ].map(generatedPlugins),
    ).toEqual([
      [{ pkg: '@vzn/vx-migrate', factory: 'turbo' }],
      [
        { pkg: '@vzn/vx-migrate', factory: 'nx' },
        { pkg: '@vzn/vx-migrate', factory: 'nxCache' },
      ],
      null,
      null,
      null,
      null,
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
      // A Windows editor saves the manifest with a BOM; npm and Bun accept it.
      await writeFile(path.join(root, 'package.json'), '\uFEFF{"packageManager":"pnpm@9.15.0"}')
      const bom = packageManagerOf(root)
      await at({})
      expect([declared, locked, agent, bom, packageManagerOf(root)]).toEqual([
        'pnpm',
        'yarn',
        'bun',
        'pnpm',
        'npm',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('adds at the workspace root: pnpm -w, Yarn 1 -W, Berry without', async () => {
    const root = await tmp('vx-adopt-argv-')
    try {
      await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
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

  it('removes at the workspace root: pnpm -w, Yarn 1 -W, Berry without', async () => {
    const root = await tmp('vx-adopt-rm-')
    try {
      await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
      await writeFile(path.join(root, 'yarn.lock'), '# yarn lockfile v1\n')
      const yarn1 = removeArgv(root, 'yarn', ['@vzn/vx-migrate'])
      await writeFile(path.join(root, 'yarn.lock'), '__metadata:\n  version: 8\n')
      expect([
        removeArgv(root, 'pnpm', ['@vzn/vx-migrate']),
        yarn1,
        removeArgv(root, 'yarn', ['@vzn/vx-migrate']),
        removeArgv(root, 'bun', ['@vzn/vx-migrate']),
        removeArgv(root, 'npm', ['@vzn/vx-migrate']),
      ]).toEqual([
        ['pnpm', 'remove', '-w', '@vzn/vx-migrate'],
        ['yarn', 'remove', '-W', '@vzn/vx-migrate'],
        ['yarn', 'remove', '@vzn/vx-migrate'],
        ['bun', 'remove', '@vzn/vx-migrate'],
        ['npm', 'uninstall', '@vzn/vx-migrate'],
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
      const listedAndInstalled = missingPackages(root, wanted)
      await writeFile(
        path.join(root, 'package.json'),
        '\uFEFF' + JSON.stringify({ devDependencies: { '@vzn/vx': '*' } }),
      )
      expect([
        listedOnly,
        installedOnly,
        listedAndInstalled,
        missingPackages(root, wanted),
      ]).toEqual([
        ['@vzn/vx', '@vzn/vx-migrate'],
        ['@vzn/vx', '@vzn/vx-migrate'],
        ['@vzn/vx-migrate'],
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

/** What the fake pnpm would have installed: the native run ends with
 *  `vx lock`, which loads the plugins the workspace declares. Stand-ins, as
 *  the sandbox lets this suite read no other package but core. */
// The lockfile stand-ins are an edge source with no edges, as a real one
// is: the mapped `^build` is refused without one.
const HOOKS = {
  'vx-lockfile': '{ discover: (ctx) => ctx.projects.map((p) => ({ dir: p.dir, deps: [] })) }',
  'vx-history': '{ setup() {} }',
}

async function installPlugins(root: string): Promise<void> {
  const scope = path.join(root, 'node_modules', '@vzn')
  await mkdir(scope, { recursive: true })
  await symlink(path.resolve(import.meta.dir, '..', '..', 'vx'), path.join(scope, 'vx'))
  for (const [pkg, factories] of [
    ['vx-lockfile', ['pnpm', 'bun', 'npm', 'yarn']],
    ['vx-history', ['vxHistory']],
  ] as const) {
    await mkdir(path.join(scope, pkg))
    await writeFile(
      path.join(scope, pkg, 'package.json'),
      JSON.stringify({ name: `@vzn/${pkg}`, type: 'module', main: 'index.js' }),
    )
    await writeFile(
      path.join(scope, pkg, 'index.js'),
      "import { definePlugin } from '@vzn/vx'\n" +
        factories
          .map((f) => `export const ${f} = () => definePlugin(import.meta, ${HOOKS[pkg]})\n`)
          .join(''),
    )
  }
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

describe('vx-migrate ends with the lock', () => {
  // 2026-10-14: "vx migrate should generate lock as well". solid's
  // shape: ssr has no task Turbo runs, and gets a config all the same.
  it('writes .vx/projects.lock.json once the plugins resolve; --no-install leaves it to vx lock', async () => {
    const { root, env } = await solidShaped()
    try {
      await installPlugins(root)
      const skipped = await migrate(root, env, ['--no-install', '--dry'])
      expect(skipped.out).not.toContain('vx lock:')
      const r = await migrate(root, env, [])
      expect([r.code, r.err]).toEqual([0, ''])
      expect(r.out).toContain(
        '\n  lock      2 project configs → .vx/projects.lock.json\n\n  next  ',
      )
      expect(await Bun.file(path.join(root, '.vx/projects.lock.json')).exists()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('--no-install writes no lock: the plugins it declares are not installed', async () => {
    const { root, env } = await solidShaped()
    try {
      const r = await migrate(root, env, ['--no-install'])
      expect([r.code, r.err]).toEqual([0, ''])
      expect(r.out).not.toContain('vx lock:')
      expect(await Bun.file(path.join(root, '.vx/projects.lock.json')).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

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
        const ws = await readFile(path.join(root, '.vx/workspace.ts'), 'utf8')
        expect([
          r.code,
          await calls(root),
          pj.scripts,
          await Bun.file(path.join(root, 'packages', 'lib', 'vx.config.ts')).exists(),
          await Bun.file(path.join(root, 'packages', 'ssr', 'vx.config.ts')).exists(),
          [...ws.matchAll(/^ {4}(\w+)\(\),$/gm)].map((m) => m[1]),
          ws.includes("import { vxHistory } from '@vzn/vx-history'"),
          r.out.includes('Declare pnpm()'),
        ]).toEqual([
          0,
          'add -D -w @vzn/vx @vzn/vx-lockfile @vzn/vx-history\n',
          { build: 'turbo run build' },
          true,
          // No task Turbo runs, and still a config (2026-10-14).
          true,
          ['pnpm', 'vxHistory'],
          true,
          false,
        ])
        expect(r.out).toContain(
          '  ran       pnpm add -D -w @vzn/vx @vzn/vx-lockfile @vzn/vx-history',
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
        await writeFile(path.join(root, '.gitlab-ci.yml'), 'test:\n  script: vx run test\n')
        const r = await migrate(root, env, ['--keep'])
        const ws = await readFile(path.join(root, '.vx/workspace.ts'), 'utf8')
        expect([
          r.code,
          await calls(root),
          ws.includes("import { turbo } from '@vzn/vx-migrate'"),
          [...ws.matchAll(/^ {4}(\w+)\(\),$/gm)].map((m) => m[1]),
          ws.includes("import { github } from '@vzn/vx-ci'\nimport { gitlab } from '@vzn/vx-ci'"),
          await Bun.file(path.join(root, 'packages', 'lib', 'vx.config.ts')).exists(),
        ]).toEqual([
          0,
          'add -D -w @vzn/vx @vzn/vx-migrate @vzn/vx-lockfile @vzn/vx-history @vzn/vx-ci\n',
          true,
          ['turbo', 'pnpm', 'vxHistory', 'github', 'gitlab'],
          true,
          false,
        ])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  // 2026-10-08: native after --keep left turbo() declared and
  // @vzn/vx-migrate installed, with a note asking the user to remove them.
  it(
    'native after --keep drops turbo() and removes @vzn/vx-migrate; a turboCache() keeps it',
    async () => {
      const after = async (keepCache: boolean) => {
        const { root, env } = await solidShaped()
        try {
          const keep = await migrate(root, env, ['--keep'])
          if (keepCache) {
            const file = path.join(root, '.vx/workspace.ts')
            const ws = await readFile(file, 'utf8')
            await writeFile(
              file,
              ws
                .replace('{ turbo }', '{ turbo, turboCache }')
                .replace('    turbo(),\n', '    turbo(),\n    turboCache(),\n'),
            )
          }
          // What the fake pnpm did not: the root lists what --keep added.
          const pj = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
          pj.devDependencies = { '@vzn/vx': '*', '@vzn/vx-migrate': '*' }
          await writeFile(path.join(root, 'package.json'), JSON.stringify(pj))
          await rm(path.join(root, '.pnpm-calls'))
          const r = await migrate(root, env, [])
          const ws = await readFile(path.join(root, '.vx/workspace.ts'), 'utf8')
          return [
            keep.code,
            r.code,
            (await calls(root)).split('\n').filter((l) => l.startsWith('remove')),
            [...ws.matchAll(/^ {4}(\w+)\(\),$/gm)].map((m) => m[1]),
            ws.includes("from '@vzn/vx-migrate'"),
            r.out.includes('still declares'),
            await Bun.file(path.join(root, 'packages', 'lib', 'vx.config.ts')).exists(),
          ]
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }
      expect([await after(false), await after(true)]).toEqual([
        [0, 0, ['remove -w @vzn/vx-migrate'], ['pnpm', 'vxHistory'], false, false, true],
        // CONTROL: turboCache() still reads Turbo's remote cache from vx-migrate.
        [0, 0, [], ['turboCache', 'pnpm', 'vxHistory'], true, false, true],
      ])
    },
    TIMEOUT,
  )

  it(
    'a workspace file the user wrote is left alone, and so is @vzn/vx-migrate',
    async () => {
      const { root, env } = await solidShaped()
      try {
        const ws =
          "import { turbo } from '@vzn/vx-migrate'\nexport default { plugins: [turbo({})] }\n"
        await Bun.write(path.join(root, '.vx/workspace.ts'), ws)
        await writeFile(
          path.join(root, 'package.json'),
          JSON.stringify({ name: 'r', devDependencies: { '@vzn/vx-migrate': '*' } }),
        )
        const r = await migrate(root, env, [])
        expect([
          r.code,
          await readFile(path.join(root, '.vx/workspace.ts'), 'utf8'),
          (await calls(root)).includes('remove'),
          r.out.includes('still declares turbo()'),
        ]).toEqual([0, ws, false, true])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  // 2026-10-16: `vx init --force` on solid removed vx-migrate while
  // the workspace file, formatted with double quotes, still imported it.
  it(
    'a formatted workspace file that imports vx-migrate keeps it installed',
    async () => {
      const { root, env } = await solidShaped()
      try {
        const ws =
          'import { turboCache } from "@vzn/vx-migrate";\n\nexport default {\n  plugins: [turboCache()],\n};\n'
        await Bun.write(path.join(root, '.vx/workspace.ts'), ws)
        await writeFile(
          path.join(root, 'package.json'),
          JSON.stringify({ name: 'r', devDependencies: { '@vzn/vx-migrate': '*' } }),
        )
        const r = await migrate(root, env, ['--force'])
        expect([r.code, (await calls(root)).includes('remove')]).toEqual([0, false])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  // 2026-10-16: `vx init` on solid, whose `.vx/workspace.ts` an earlier
  // init wrote, installed only vx and vx-migrate; the lock then could not
  // find the @vzn/vx-lockfile the file imports.
  it(
    'the install takes every @vzn/vx-* package the workspace file imports',
    async () => {
      const { root, env } = await solidShaped()
      try {
        // A real workspace file: three plugins package.json does not list, one by subpath.
        const ws =
          'import { pnpm } from "@vzn/vx-lockfile";\nimport { vxHistory } from "@vzn/vx-history";\nimport { ci } from "@vzn/vx-ci/sub";\n\nexport default {\n  plugins: [pnpm(), vxHistory(), ci()],\n};\n'
        await Bun.write(path.join(root, '.vx/workspace.ts'), ws)
        await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r' }))
        const r = await migrate(root, env, [])
        const add = ((await calls(root)).split('\n')[0] ?? '').split(' ')
        expect([
          r.code,
          ['@vzn/vx-lockfile', '@vzn/vx-history', '@vzn/vx-ci'].filter((p) => !add.includes(p)),
        ]).toEqual([0, []])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  // 2026-10-16: "vx init should always install latest and upgrade all".
  it(
    'the install moves every @vzn/vx-* plugin the root lists with core',
    async () => {
      const { root, env } = await solidShaped()
      try {
        await writeFile(
          path.join(root, 'package.json'),
          JSON.stringify({
            name: 'r',
            devDependencies: {
              '@vzn/vx-otel': '0.0.637',
              // CONTROL: the repo's own link and core's platform binary stay put.
              '@vzn/vx-own': 'workspace:*',
              '@vzn/vx-linux-x64': '0.0.637',
            },
          }),
        )
        const r = await migrate(root, env, [])
        expect([r.code, (await calls(root)).split('\n')[0]]).toEqual([
          0,
          'add -D -w @vzn/vx @vzn/vx-lockfile @vzn/vx-history @vzn/vx-otel',
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
          dry.out.includes('  install   @vzn/vx @vzn/vx-lockfile @vzn/vx-history\n'),
        ]).toEqual([0, 0, '', true])
        expect(await readFile(path.join(root, 'package.json'), 'utf8')).toBe(before)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
  it(
    '--dry --format json prints the plan as one document, native and keep',
    async () => {
      const { root, env } = await solidShaped()
      try {
        const native = await migrate(root, env, ['--native', '--dry', '--format', 'json'])
        const keep = await migrate(root, env, ['--keep', '--dry', '--format=json'])
        const wet = await migrate(root, env, ['--format', 'json'])
        const plan = JSON.parse(native.out) as {
          source: string
          files: { path: string }[]
          notes: string[]
        }
        const kept = JSON.parse(keep.out) as { source: string; files: { path: string }[] }
        expect([native.code, keep.code, wet.code, await calls(root)]).toEqual([0, 0, 1, ''])
        expect([plan.source, plan.files.some((f) => f.path === '.vx/workspace.ts')]).toEqual([
          'turbo.json',
          true,
        ])
        expect(plan.notes).toContain('install: @vzn/vx @vzn/vx-lockfile @vzn/vx-history')
        expect([kept.source, kept.files.map((f) => f.path)]).toEqual([
          'turbo.json',
          ['.vx/workspace.ts', '.vx/.gitignore'],
        ])
        expect(keep.err).toContain('vx-migrate: install: ')
        expect(wet.err).toBe('vx-migrate: --format json prints the plan, so it needs --dry\n')
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
          'add -D -w @vzn/vx @vzn/vx-migrate @vzn/vx-lockfile @vzn/vx-history\n',
          0,
          'add -D -w @vzn/vx @vzn/vx-lockfile @vzn/vx-history\n',
        ])
      } finally {
        await rm(exec.root, { recursive: true, force: true })
        await rm(shell.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

// 2026-10-08: "can we make vx init the only command to run?"
describe('vx init in a Turbo repo', () => {
  const CORE_BIN = path.join(path.dirname(Bun.resolveSync('@vzn/vx', import.meta.dir)), 'bin.ts')
  const init = async (root: string, env: Record<string, string>, args: string[]) => {
    const proc = Bun.spawn([process.execPath, '--no-install', CORE_BIN, 'init', ...args], {
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

  it(
    'runs the installed vx-migrate: no terminal is native; --keep writes turbo() alone',
    async () => {
      for (const keep of [false, true]) {
        const { root, env } = await solidShaped()
        try {
          await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
          await symlink(
            path.resolve(import.meta.dir, '..'),
            path.join(root, 'node_modules', '@vzn', 'vx-migrate'),
          )
          await installPlugins(root)
          const r = await init(root, env, keep ? ['--keep'] : [])
          const ws = await readFile(path.join(root, '.vx/workspace.ts'), 'utf8')
          expect([
            r.code,
            r.err,
            r.out.includes('  tasks     '),
            await Bun.file(path.join(root, 'packages', 'lib', 'vx.config.ts')).exists(),
            ws.includes('turbo()'),
          ]).toEqual([0, '', !keep, !keep, keep])
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }
    },
    TIMEOUT,
  )
})

describe('managerArgv', () => {
  const argv = ['pnpm', 'add', '-D', '-w', '@vzn/vx']
  it('runs the manager that launched us, not the name PATH finds', () => {
    expect([
      managerArgv(argv, { npm_execpath: '/opt/pnpm/bin/pnpm' }),
      managerArgv(argv, { npm_execpath: '/opt/pnpm/dist/pnpm.cjs' }),
    ]).toEqual([
      ['/opt/pnpm/bin/pnpm', 'add', '-D', '-w', '@vzn/vx'],
      ['node', '/opt/pnpm/dist/pnpm.cjs', 'add', '-D', '-w', '@vzn/vx'],
    ])
  })
  it('keeps the name when another manager, or none, launched us (control)', () => {
    expect([
      managerArgv(argv, { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' }),
      managerArgv(argv, {}),
    ]).toEqual([argv, argv])
  })
})

describe('install when PATH holds an unrunnable manager', () => {
  // `pnpm exec vx init` under pnpm 12: PATH's pnpm has no shebang (ENOEXEC).
  // A child process, since Bun.spawn looks PATH up in the startup env.
  let said = ''
  const probe = async (execpath: string, pathPnpm = 'not a script\n') => {
    const root = await tmp('vx-adopt-enoexec-')
    await mkdir(path.join(root, 'bin'))
    await mkdir(path.join(root, 'ws'))
    await writeFile(path.join(root, 'bin', 'pnpm'), pathPnpm)
    await chmod(path.join(root, 'bin', 'pnpm'), 0o755)
    await mkdir(path.join(root, 'real'))
    // Its words are shown only on failure, so it leaves a mark instead.
    await writeFile(
      path.join(root, 'real', 'pnpm'),
      '#!/bin/sh\necho "real pnpm $*" > "$(dirname "$0")/ran"\n',
    )
    await chmod(path.join(root, 'real', 'pnpm'), 0o755)
    await writeFile(path.join(root, 'ws', 'package.json'), '{"name":"ws"}')
    await writeFile(path.join(root, 'ws', 'pnpm-lock.yaml'), '')
    await writeFile(path.join(root, 'ws', 'pnpm-workspace.yaml'), 'packages: []\n')
    await writeFile(
      path.join(root, 'probe.ts'),
      `import { install } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/adopt.ts'))}
try { await install(${JSON.stringify(path.join(root, 'ws'))}, ['@vzn/vx']) } catch (e) { console.log((e as Error).message) }
`,
    )
    const r = Bun.spawnSync([process.execPath, path.join(root, 'probe.ts')], {
      env: {
        ...process.env,
        PATH: `${path.join(root, 'bin')}:${process.env['PATH']}`,
        npm_execpath: execpath === '' ? '' : path.join(root, execpath),
        npm_config_user_agent: '',
      },
    })
    said = r.stdout.toString() + r.stderr.toString()
    const ran = path.join(root, 'real', 'ran')
    const out = existsSync(ran)
      ? readFileSync(ran, 'utf8').trim()
      : r.stdout.toString().split('\n')[0]!
    await rm(root, { recursive: true, force: true })
    return out
  }

  it('runs the pnpm that launched it', async () => {
    expect(await probe('real/pnpm')).toBe('real pnpm add -D -w @vzn/vx')
  })

  it('names minimumReleaseAgeExclude when pnpm ran and refused', async () => {
    expect(await probe('', '#!/bin/sh\nexit 1\n')).toBe(
      'installing vx failed (pnpm add -D -w @vzn/vx exited 1); run it, then vx lock; if pnpm refused a version published within its minimumReleaseAge, list @vzn/vx under minimumReleaseAgeExclude in pnpm-workspace.yaml',
    )
  })

  it('names a registry 404 and the retry, not the exit code', async () => {
    // v0.0.646's platform tarball answered 404 for minutes after publish.
    expect(
      await probe(
        '',
        '#!/bin/sh\necho " ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/@vzn%2fvx-linux-x64/-/vx-linux-x64-0.0.646.tgz: Not Found - 404" >&2\nexit 1\n',
      ),
    ).toBe(
      'installing vx failed: the npm registry does not serve @vzn/vx-linux-x64@0.0.646 yet (404), as a release can take minutes to reach it; run vx init again',
    )
  })

  it("shows the manager's own output only when it fails", async () => {
    await probe('', '#!/bin/sh\necho deprecated-noise\n')
    // Off a terminal nothing prints: the report's `ran` row names the command.
    expect(said).toBe('')
    await probe('', '#!/bin/sh\necho why-it-failed >&2\nexit 1\n')
    expect(said).toContain('why-it-failed')
  })

  it('names the spawn error when nothing else can run it', async () => {
    expect(await probe('')).toStartWith(
      'installing vx failed (pnpm add -D -w @vzn/vx exited -1: ENOEXEC',
    )
  })
})

describe('vx-migrate and the core it loads', () => {
  // `bun x @vzn/vx-migrate@latest` reuses its install directory: Bun took
  // vx-migrate 0.0.639 and kept the @vzn/vx 0.0.636 already there, a peer
  // range it does not enforce, and the run crashed on a missing export
  // before a line of its own ran (Growth, 2026-10-16: configs written by
  // one release beside another).
  it(
    'refuses a core of another release, naming both and where it loaded',
    async () => {
      const dir = await tmp('vx-migrate-skew-')
      try {
        const own = path.join(dir, 'node_modules', '@vzn', 'vx-migrate')
        const core = path.join(dir, 'node_modules', '@vzn', 'vx')
        await mkdir(path.join(core, 'src'), { recursive: true })
        await mkdir(own, { recursive: true })
        Bun.spawnSync([
          'cp',
          '-R',
          path.resolve(import.meta.dir, '..', 'src'),
          path.join(own, 'src'),
        ])
        const pkg = JSON.parse(
          await readFile(path.resolve(import.meta.dir, '..', 'package.json'), 'utf8'),
        )
        await writeFile(
          path.join(own, 'package.json'),
          JSON.stringify({ ...pkg, version: '0.0.9' }),
        )
        await writeFile(
          path.join(core, 'package.json'),
          JSON.stringify({
            name: '@vzn/vx',
            version: '0.0.8',
            type: 'module',
            exports: { '.': './src/index.ts' },
          }),
        )
        // An older core: VERSION and the error classes, none of what this release imports.
        await writeFile(
          path.join(core, 'src', 'index.ts'),
          "export const VERSION = '0.0.8'\nexport class UserError extends Error {}\nexport const isUserError = (e: unknown) => e instanceof UserError\n",
        )
        const p = Bun.spawnSync([process.execPath, path.join(own, 'src', 'bin.ts'), '--help'], {
          cwd: dir,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        expect(p.stderr.toString()).toBe(
          `vx-migrate: vx-migrate 0.0.9 loaded @vzn/vx 0.0.8 from ${path.join(realpathSync(dir), 'node_modules')}; every @vzn package releases together — install @vzn/vx@0.0.9 there, or delete that node_modules and run it again\n`,
        )
        expect(p.exitCode).toBe(1)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
