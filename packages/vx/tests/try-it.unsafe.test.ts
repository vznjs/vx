// `vx init` in a Turbo or Nx repo, the temporary start the migrate guide
// shows (2026-10-02: Turbo and Nx only via migration): four
// commands, and the guide's `.vx/workspace.ts` held to the one init writes.
// The run spawns bunx, which a sandboxed shard cannot host — hence the
// unsafe suite.
//
// Two steps cannot run as a user runs them, and each is replaced by what it
// does: `npm install -D @vzn/vx @vzn/vx-migrate` links exactly the packages
// it names from this checkout (`@vzn/vx-migrate` is not on npm yet, and the
// workspace's `workspace:*` ranges are what `npm pack` rewrites), as does
// the `npm install -D @vzn/…` vx-migrate runs (helpers/npm-checkout.ts), and
// the Nx repo's own `nx` is a stand-in whose one verb is `graph --file`, as
// in vx-migrate's suites. Every `bunx @vzn/vx …` line runs verbatim.

import {
  cpSync,
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
const GUIDE = path.join(
  PACKAGES,
  '..',
  'private',
  'vx-docs',
  'src',
  'content',
  'docs',
  'docs',
  'migrate.mdx',
)

/** The guide's `## <name>` section. */
function guideSection(name: string): string {
  const text = readFileSync(GUIDE, 'utf8')
  const start = text.indexOf(`\n## ${name}\n`)
  return text.slice(start, text.indexOf('\n## ', start + 1))
}

/** The `<Deeper … title="<title>">` block of the guide's `## <section>`. */
function guideBlock(section: string, title: string): string {
  const text = guideSection(section)
  const start = text.indexOf(`title="${title}">`)
  return start === -1 ? '' : text.slice(start, text.indexOf('</Deeper>', start))
}

/** `text`'s fences of `lang`, in order. */
function fences(text: string, lang: string): string[] {
  return [...text.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1]!)
}

const COMMANDS = [
  'npm install -D @vzn/vx @vzn/vx-migrate',
  'bunx @vzn/vx init',
  'bunx @vzn/vx run build --all',
  'bunx @vzn/vx run build --all',
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
  // A Turbo repo before vx: the example's own .vx is what init writes.
  rmSync(path.join(root, '.vx'), { recursive: true })
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
  writeFileSync(path.join(root, '.gitignore'), 'node_modules\n.nx\n.vx/cache/\ndist\n')
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

// `vx init` runs vx-migrate, native without a terminal (2026-10-08):
// the workspace file declares the npm lockfile's plugin, never turbo() or nx().
const NATIVE = `import type { WorkspaceConfig } from '@vzn/vx/config'
import { vxHistory } from '@vzn/vx-history'
import { npm } from '@vzn/vx-lockfile'

export default {
  plugins: [
    npm(),
    vxHistory(),
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
              ? readFileSync(path.join(root, '.vx/workspace.ts'), 'utf8')
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

const SGR = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')

/** An `ansi` sample as a run with colour off prints it: the report opens
 *  on a blank line the sample leaves out. */
function printedPlain(fence: string): string {
  return versionless(`\n${fence.replace(SGR, '')}`)
}

/**
 * A report as any release prints it. Its title names the version (a
 * checkout's is 0.0.0, the guide's a release), and a release pins each
 * install. The guide's reader runs vx-migrate through bun x, so a release
 * also installs @vzn/vx and @vzn/vx-migrate; here both are installed
 * first, so a checkout installs neither and removes the vx-migrate a
 * native run no longer needs. A coloured title row is padded to the
 * report's width.
 */
function versionless(out: string): string {
  return out
    .replace(/^  (vx-migrate|vx init) \S+ *$/m, '  $1')
    .replace(/^  ran +npm uninstall @vzn\/vx-migrate\n/m, '')
    .replace(
      /^(  ran +npm install -D )(.*)$/gm,
      (_, ran: string, pkgs: string) =>
        ran +
        pkgs
          .split(' ')
          .map((p) => p.replace(/(.)@\d\S*$/, '$1'))
          .filter((p) => p !== '@vzn/vx' && p !== '@vzn/vx-migrate')
          .join(' '),
    )
}

// The migrate guide shows what `vx init` writes and prints in a Turbo and an
// Nx repo, both ways (`--native`, and `--keep` then vx-migrate); each sample
// is held to a run.
const INIT_NATIVE = 'bunx @vzn/vx init --native'
const INIT_KEEP = 'bunx @vzn/vx init --keep'

/** The block's ts fence that declares `type`: the workspace file or a project's. */
function tsFence(block: string, type: 'WorkspaceConfig' | 'ProjectConfig'): string {
  return fences(block, 'ts').filter((f) => f.includes(`satisfies ${type}`))[0]!
}

// Each runner's samples sit in two Patterns blocks of its section.
const WRITES = 'What init prints and writes'
const KEEP = 'Check the mapping first'

describe('the migrate guide shows what vx init and vx-migrate write, and the native end state builds', () => {
  it('Turborepo: init --native writes the configs the guide shows', () => {
    const root = turboRepo()
    commit(root)
    const block = guideBlock('Turborepo', WRITES)
    expect(fences(block, 'sh').map((f) => f.trim())).toEqual([INIT_NATIVE])
    const [out] = fences(block, 'ansi').map(printedPlain)
    // `vx init` runs the installed vx-migrate (else the registry's, through bun x).
    expect(step(root, 'npm install -D @vzn/vx @vzn/vx-migrate').code).toBe(0)
    const init = step(root, INIT_NATIVE)
    expect([init.code, versionless(init.out)]).toEqual([0, out!])
    expect(readFileSync(path.join(root, '.vx/workspace.ts'), 'utf8')).toBe(
      tsFence(block, 'WorkspaceConfig'),
    )
    expect(readFileSync(path.join(root, 'packages', 'lib', 'vx.config.ts'), 'utf8')).toBe(
      tsFence(block, 'ProjectConfig'),
    )
    expect(endState(root, 'turbo', 'turbo.json')).toEqual(BUILT)
  }, 60_000)

  it('Nx: init --native writes the config the guide shows', () => {
    const root = nxRepo()
    standInNx(root)
    commit(root)
    const block = guideBlock('Nx', WRITES)
    expect(fences(block, 'sh').map((f) => f.trim())).toEqual([INIT_NATIVE])
    const [out] = fences(block, 'ansi').map(printedPlain)
    expect(step(root, 'npm install -D @vzn/vx @vzn/vx-migrate').code).toBe(0)
    const init = step(root, INIT_NATIVE)
    expect([init.code, versionless(init.out)]).toEqual([0, out!])
    expect(readFileSync(path.join(root, 'packages', 'lib', 'vx.config.ts'), 'utf8')).toBe(
      tsFence(block, 'ProjectConfig'),
    )
    expect(endState(root, 'nx', 'nx.json')).toEqual(BUILT)
  }, 60_000)

  it('Turborepo: init --keep writes the workspace file and prints the report shown, then vx-migrate ends native', () => {
    const root = turboRepo()
    commit(root)
    const block = guideBlock('Turborepo', KEEP)
    expect(fences(block, 'sh').map((f) => f.trim())).toEqual([INIT_KEEP])
    const [out] = fences(block, 'ansi').map(printedPlain)
    const cacheLine = /^`(turboCache\(\): [^`]*)`$/m.exec(block)?.[1]
    expect(cacheLine).toBeDefined()
    expect(step(root, 'npm install -D @vzn/vx @vzn/vx-migrate').code).toBe(0)
    const init = step(root, INIT_KEEP)
    expect([init.code, versionless(init.out)]).toEqual([0, out!])
    expect(readFileSync(path.join(root, '.vx/workspace.ts'), 'utf8')).toBe(
      tsFence(block, 'WorkspaceConfig'),
    )

    mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true })
    writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'env:\n  TURBO_TOKEN: x\n')
    const cached = step(root, 'bunx @vzn/vx init --keep --dry --force')
    expect(cached.out.split('\n').map((l) => l.trim())).toContain(cacheLine!.trim())
    rmSync(path.join(root, '.github'), { recursive: true })

    expect(migrate(root)[0]).toBe(0)
    expect(endState(root, 'turbo', 'turbo.json')).toEqual(BUILT)
  }, 60_000)

  it('Nx: init --keep writes the workspace file and prints the report shown, then vx-migrate ends native', () => {
    const root = nxRepo()
    standInNx(root)
    commit(root)
    const block = guideBlock('Nx', KEEP)
    expect(fences(block, 'sh').map((f) => f.trim())).toEqual([INIT_KEEP])
    const [out] = fences(block, 'ansi').map(printedPlain)
    expect(step(root, 'npm install -D @vzn/vx @vzn/vx-migrate').code).toBe(0)
    const init = step(root, INIT_KEEP)
    expect([init.code, versionless(init.out)]).toEqual([0, out!])
    expect(readFileSync(path.join(root, '.vx/workspace.ts'), 'utf8')).toBe(
      tsFence(block, 'WorkspaceConfig'),
    )
    expect(migrate(root)[0]).toBe(0)
    expect(endState(root, 'nx', 'nx.json')).toEqual(BUILT)
  }, 60_000)
})

const BUILT = [
  ['success', 'success'],
  ['cache-hit', 'cache-hit'],
]

/** `bunx @vzn/vx-migrate` as bunx runs it: bunx names itself in
 *  `npm_config_user_agent`, and the report's `next:` line names the runner.
 *  Its `npm` calls go to this checkout, so the lock runs on installed plugins. */
function migrate(root: string): [number | null, string] {
  const r = Bun.spawnSync({
    cmd: [process.execPath, path.join(PACKAGES, 'vx-migrate', 'src', 'bin.ts')],
    cwd: root,
    env: withCheckoutNpm({
      ...process.env,
      NO_COLOR: '1',
      npm_config_user_agent: `bun/${Bun.version}`,
    }),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return [r.exitCode, versionless(r.stdout.toString())]
}

/** The guide's last step: vx-migrate already took the plugin out of
 *  `.vx/workspace.ts`; the tool's config deleted, two builds on the written
 *  configs alone, each run's statuses for app and lib. */
function endState(root: string, plugin: 'turbo' | 'nx', config: string): string[][] {
  expect(readFileSync(path.join(root, '.vx/workspace.ts'), 'utf8')).not.toContain(`${plugin}()`)
  rmSync(path.join(root, config))
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'native')
  return [0, 1].map(() => {
    expect(step(root, 'bunx @vzn/vx run build --all').code).toBe(0)
    const s = lastStatuses(root)
    return [s['app#build']!, s['lib#build']!]
  })
}

// The from-Turborepo and from-Nx posts show the file `vx init --keep` writes:
// the guide's, which the rows above hold to a run.
describe('the migration posts show the file vx init writes', () => {
  const blog = path.join(PACKAGES, '..', 'private', 'vx-docs', 'src', 'content', 'docs', 'blog')
  const firstTs = (name: string): string =>
    /```ts\n([\s\S]*?)```/.exec(readFileSync(path.join(blog, name), 'utf8'))?.[1] ?? ''
  it('from-turborepo', () => {
    expect(firstTs('from-turborepo.md')).toBe(
      tsFence(guideBlock('Turborepo', KEEP), 'WorkspaceConfig'),
    )
  })

  it('from-nx', () => {
    expect(firstTs('from-nx.md')).toBe(tsFence(guideBlock('Nx', KEEP), 'WorkspaceConfig'))
  })
})
