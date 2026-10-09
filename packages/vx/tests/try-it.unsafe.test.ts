// `vx init` in a Turbo or Nx repo, the temporary start the migrate guide
// shows (owner, 2026-10-02: Turbo and Nx only via migration): four
// commands, and the guide's `vx.workspace.ts` held to the one init writes.
// The run spawns npx, which a sandboxed shard cannot host — hence the
// unsafe suite.
//
// Two steps cannot run as a user runs them, and each is replaced by what it
// does: `npm install -D @vzn/vx @vzn/vx-migrate` links exactly the packages
// it names from this checkout (`@vzn/vx-migrate` is not on npm yet, and the
// workspace's `workspace:*` ranges are what `npm pack` rewrites), as does
// the `npm install -D @vzn/…` vx-migrate runs (helpers/npm-checkout.ts), and
// the Nx repo's own `nx` is a stand-in whose one verb is `graph --file`, as
// in vx-migrate's suites. Every `npx vx …` line runs verbatim.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { withNpm } from './helpers/npm.js'
import { installFromCheckout, withCheckoutNpm } from './helpers/npm-checkout.js'
import { gitIn, gitInit } from './helpers/workspace.js'

const CORE = path.resolve(import.meta.dir, '..')
const PACKAGES = path.dirname(CORE)
const REPO = path.dirname(PACKAGES)
const GUIDE = path.join(PACKAGES, 'vx-docs', 'src', 'content', 'docs', 'guides', 'migrate.md')

/** The guide's `## <name>` section: its fences of `lang`, in order. */
function guideFences(name: string, lang: string): string[] {
  const text = readFileSync(GUIDE, 'utf8')
  const start = text.indexOf(`\n## ${name}\n`)
  const section = text.slice(start, text.indexOf('\n## ', start + 1))
  return [...section.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map(
    (m) => m[1]!,
  )
}

const COMMANDS = [
  'npm install -D @vzn/vx @vzn/vx-migrate',
  'npx vx init',
  'npx vx run build --all',
  'npx vx run build --all',
]

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function tmp(tag: string): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `vx-try-${tag}-`)))
  roots.push(root)
  return root
}

const INSTALL = /^npm install -D((?: @vzn\/[\w-]+)+)$/

/** Runs one documented line in `root`; the install line links what it names. */
function step(root: string, line: string): { code: number | null; out: string } {
  const command = line.replace(/\s+#.*$/, '').trim()
  const install = INSTALL.exec(command)
  if (install !== null) {
    installFromCheckout(root, install[1]!.trim().split(' '))
    return { code: 0, out: '' }
  }
  const r = Bun.spawnSync({
    cmd: ['sh', '-c', command],
    cwd: root,
    // vx-migrate's own `npm install -D @vzn/…` (`vx init` in a Turbo or Nx
    // repo) is answered from this checkout too.
    env: withCheckoutNpm(withNpm({ ...process.env, NO_COLOR: '1', npm_config_yes: 'false' })),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
}

/** Each task's status in the last run, from `vx last --format json`. */
function lastStatuses(root: string): Record<string, string> {
  const r = Bun.spawnSync({
    cmd: [process.execPath, path.join(CORE, 'src', 'bin.ts'), 'last', '--format', 'json'],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const last = JSON.parse(r.stdout.toString()) as {
    tasks: Array<{ project: string; task: string; status: string }>
  }
  return Object.fromEntries(last.tasks.map((t) => [`${t.project}#${t.task}`, t.status]))
}

function commit(root: string): void {
  gitInit(root)
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
}

function turboRepo(): string {
  const root = tmp('turbo')
  cpSync(path.join(REPO, 'examples', 'turbo'), root, { recursive: true })
  rmSync(path.join(root, 'vx.workspace.ts'))
  return root
}

/** Two projects whose `build` targets Nx would run with run-commands. */
function nxRepo(): string {
  const root = tmp('nx')
  const target = (name: string) => ({
    executor: 'nx:run-commands',
    options: {
      command: `mkdir -p dist && cp src/index.js dist/${name}.js`,
      cwd: `packages/${name}`,
    },
    inputs: ['{projectRoot}/src/**/*'],
    outputs: ['{projectRoot}/dist'],
    cache: true,
    ...(name === 'app' ? { dependsOn: ['^build'] } : {}),
  })
  const node = (name: string) => ({
    name,
    type: name === 'app' ? 'app' : 'lib',
    data: { root: `packages/${name}`, targets: { build: target(name) } },
  })
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'nx-repo', private: true, workspaces: ['packages/*'] }),
  )
  writeFileSync(path.join(root, 'nx.json'), JSON.stringify({ targetDefaults: {} }))
  for (const name of ['lib', 'app']) {
    mkdirSync(path.join(root, 'packages', name, 'src'), { recursive: true })
    writeFileSync(
      path.join(root, 'packages', name, 'package.json'),
      JSON.stringify({
        name,
        version: '0.0.0',
        ...(name === 'app' ? { dependencies: { lib: '*' } } : {}),
      }),
    )
    writeFileSync(
      path.join(root, 'packages', name, 'src', 'index.js'),
      `export const ${name} = 1\n`,
    )
  }
  writeFileSync(
    path.join(root, 'graph.json'),
    JSON.stringify({
      graph: {
        nodes: { lib: node('lib'), app: node('app') },
        dependencies: { app: [{ source: 'app', target: 'lib', type: 'static' }], lib: [] },
      },
    }),
  )
  writeFileSync(path.join(root, '.gitignore'), 'node_modules\n.nx\n.vx\ndist\n')
  return root
}

/** The Nx repo's own `nx`, installed before vx arrives: `graph --file=<path>` only. */
function standInNx(root: string): void {
  const bin = path.join(root, 'node_modules', '.bin', 'nx')
  mkdirSync(path.dirname(bin), { recursive: true })
  writeFileSync(
    bin,
    `#!/bin/sh
case "$2" in --file=*) f="\${2#--file=}"; mkdir -p "$(dirname "$f")"; cp "$(dirname "$0")/../../graph.json" "$f" ;; *) exit 2 ;; esac
`,
  )
  chmodSync(bin, 0o755)
}

// `vx init` runs vx-migrate, native without a terminal (owner, 2026-10-08):
// the workspace file declares the npm lockfile's plugin, never turbo() or nx().
const NATIVE = `import type { WorkspaceConfig } from '@vzn/vx/config'
import { npm } from '@vzn/vx-lockfile'
import { scheduleHistoryPlugin } from '@vzn/vx-schedule-history'

export default {
  plugins: [
    npm(),
    scheduleHistoryPlugin(),
  ],
} satisfies WorkspaceConfig
`

describe('vx init in a Turbo or Nx repo: the first run builds, the second hits', () => {
  const cases: Array<[string, () => string, () => string, Record<string, string>]> = [
    ['a Turbo repo', turboRepo, () => NATIVE, { 'app#build': '', 'lib#build': '' }],
    [
      'an Nx repo',
      () => {
        const root = nxRepo()
        standInNx(root)
        return root
      },
      () => NATIVE,
      { 'app#build': '', 'lib#build': '' },
    ],
  ]

  for (const [name, make, adapt, tasks] of cases) {
    it(`${name}: the first run builds, the second hits`, () => {
      const root = make()
      const file = adapt()
      commit(root)
      const [install, init, first, second] = COMMANDS as [string, string, string, string]
      const want = (status: string) =>
        Object.fromEntries(Object.keys(tasks).map((t) => [t, status]))
      const results: Array<[string, number | null, Record<string, string> | string]> = []
      for (const [line, status] of [
        [install, ''],
        [init, 'file'],
        [first, 'success'],
        [second, 'cache-hit'],
      ] as const) {
        const r = step(root, line)
        if (r.code !== 0) {
          results.push([line, r.code, r.out.slice(-400)])
          break
        }
        results.push([
          line,
          r.code,
          status === ''
            ? ''
            : status === 'file'
              ? readFileSync(path.join(root, 'vx.workspace.ts'), 'utf8')
              : lastStatuses(root),
        ])
      }
      expect(results).toEqual([
        [install, 0, ''],
        [init, 0, file],
        [first, 0, want('success')],
        [second, 0, want('cache-hit')],
      ])
    }, 60_000)
  }
})

/** A `$ <command>` sample's command and the output below it. */
function transcript(fence: string): [string, string] {
  const [first, ...rest] = fence.split('\n')
  return [first!.replace(/^\$ /, ''), rest.join('\n')]
}

// The migrate guide shows what `vx init` and `bunx @vzn/vx-migrate` write
// and print in a Turbo and an Nx repo; each sample is held to a run.
describe('the migrate guide shows what vx init and vx-migrate write, and the native end state builds', () => {
  it('Turborepo: the workspace file, init’s output and vx-migrate’s report', () => {
    const root = turboRepo()
    commit(root)
    const [file, libConfig] = guideFences('Turborepo', 'ts')
    const [initFence, cacheLine, migrateFence] = guideFences('Turborepo', 'text')
    expect(step(root, 'npm install -D @vzn/vx').code).toBe(0)
    const [initCmd, initOut] = transcript(initFence!)
    expect(initCmd).toBe('npx vx init --keep')
    const init = step(root, initCmd)
    expect([init.code, init.out]).toEqual([0, initOut])
    expect(readFileSync(path.join(root, 'vx.workspace.ts'), 'utf8')).toBe(file!)

    mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true })
    writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'env:\n  TURBO_TOKEN: x\n')
    const cached = step(root, 'npx vx init --keep --dry --force')
    expect(cached.out.split('\n')).toContain(cacheLine!.trimEnd())
    rmSync(path.join(root, '.github'), { recursive: true })

    const [migrateCmd, migrateOut] = transcript(migrateFence!)
    expect(migrateCmd).toBe('bunx @vzn/vx-migrate')
    expect(migrate(root)).toEqual([0, migrateOut])
    expect(readFileSync(path.join(root, 'packages', 'lib', 'vx.config.ts'), 'utf8')).toBe(
      libConfig!,
    )
    expect(endState(root, 'turbo', 'turbo.json')).toEqual(BUILT)
  }, 60_000)

  it('Nx: the workspace file, init’s output and vx-migrate’s report', () => {
    const root = nxRepo()
    standInNx(root)
    commit(root)
    const [file, libConfig] = guideFences('Nx', 'ts')
    const [initFence, migrateFence] = guideFences('Nx', 'text')
    expect(step(root, 'npm install -D @vzn/vx').code).toBe(0)
    const [initCmd, initOut] = transcript(initFence!)
    expect(initCmd).toBe('npx vx init --keep')
    const init = step(root, initCmd)
    expect([init.code, init.out]).toEqual([0, initOut])
    expect(readFileSync(path.join(root, 'vx.workspace.ts'), 'utf8')).toBe(file!)
    const [migrateCmd, migrateOut] = transcript(migrateFence!)
    expect(migrateCmd).toBe('bunx @vzn/vx-migrate')
    expect(migrate(root)).toEqual([0, migrateOut])
    expect(readFileSync(path.join(root, 'packages', 'lib', 'vx.config.ts'), 'utf8')).toBe(
      libConfig!,
    )
    expect(endState(root, 'nx', 'nx.json')).toEqual(BUILT)
  }, 60_000)
})

const BUILT = [
  ['success', 'success'],
  ['cache-hit', 'cache-hit'],
]

/** `bunx @vzn/vx-migrate` as bunx runs it: bunx names itself in
 *  `npm_config_user_agent`, and the report's `next:` line names the runner.
 *  Its `npm` calls are recorded, then done as `step` does them. */
function migrate(root: string): [number | null, string] {
  const bin = mkdtempSync(path.join(os.tmpdir(), 'vx-try-npm-'))
  const calls = path.join(bin, 'calls')
  writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "$@" >> "${calls}"\n`)
  chmodSync(path.join(bin, 'npm'), 0o755)
  try {
    const r = Bun.spawnSync({
      cmd: [process.execPath, path.join(PACKAGES, 'vx-migrate', 'src', 'bin.ts')],
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env['PATH']}`,
        NO_COLOR: '1',
        npm_config_user_agent: `bun/${Bun.version}`,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const lines = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []
    for (const line of lines) {
      const removed = /^uninstall((?: @vzn\/[\w-]+)+)$/.exec(line)
      if (removed === null) {
        expect(step(root, `npm ${line}`).code).toBe(0)
        continue
      }
      const manifest = path.join(root, 'package.json')
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
        devDependencies?: Record<string, string>
      }
      for (const name of removed[1]!.trim().split(' ')) {
        delete pkg.devDependencies?.[name]
        rmSync(path.join(root, 'node_modules', name), { force: true })
      }
      writeFileSync(manifest, JSON.stringify(pkg, null, 2))
    }
    return [r.exitCode, r.stdout.toString()]
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
}

/** The guide's last step: vx-migrate already took the plugin out of
 *  `vx.workspace.ts`; the tool's config deleted, two builds on the written
 *  configs alone, each run's statuses for app and lib. */
function endState(root: string, plugin: 'turbo' | 'nx', config: string): string[][] {
  expect(readFileSync(path.join(root, 'vx.workspace.ts'), 'utf8')).not.toContain(`${plugin}()`)
  rmSync(path.join(root, config))
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'native')
  return [0, 1].map(() => {
    expect(step(root, 'npx vx run build --all').code).toBe(0)
    const s = lastStatuses(root)
    return [s['app#build']!, s['lib#build']!]
  })
}

// The from-Turborepo and from-Nx posts show the file `vx init` writes: the
// guide's, which the rows above hold to a run.
describe('the migration posts show the file vx init writes', () => {
  const blog = path.join(PACKAGES, 'vx-docs', 'src', 'content', 'docs', 'blog')
  const firstTs = (name: string): string =>
    /```ts\n([\s\S]*?)```/.exec(readFileSync(path.join(blog, name), 'utf8'))?.[1] ?? ''
  it('from-turborepo', () => {
    expect(firstTs('from-turborepo.md')).toBe(guideFences('Turborepo', 'ts')[0]!)
  })

  it('from-nx', () => {
    expect(firstTs('from-nx.md')).toBe(guideFences('Nx', 'ts')[0]!)
  })
})
