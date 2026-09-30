// The README and the site's landing lead with "Try it on your repo": four
// commands and the one `vx.workspace.ts` that `vx init` writes. This runs
// them as written on a Turbo repo and an Nx repo, and holds the shown file
// to the written one, so a step that drifts from what works fails here,
// naming the line. The page reads outside packages/vx (README.md,
// the site), and the run spawns npx, which a sandboxed shard cannot host —
// hence the unsafe suite.
//
// Two steps cannot run as a user runs them, and each is replaced by what it
// does: `npm install -D @vzn/vx @vzn/vx-migrate` links exactly the packages
// it names from this checkout (`@vzn/vx-migrate` is not on npm yet, and the
// workspace's `workspace:*` ranges are what `npm pack` rewrites), and the
// Nx repo's own `nx` is a stand-in whose one verb is `graph --file`, as in
// vx-migrate's suites. Every `npx vx …` line runs verbatim.

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { gitIn, gitInit } from './helpers/workspace.js'

const CORE = path.resolve(import.meta.dir, '..')
const PACKAGES = path.dirname(CORE)
const REPO = path.dirname(PACKAGES)
const README = path.join(REPO, 'README.md')
const LANDING = path.join(PACKAGES, 'vx-docs', 'src', 'pages', 'index.astro')

interface Steps {
  workspaceFile: string
  commands: string[]
}

/** The README's "Try it on your repo": its `ts` fence and its `sh` fence's lines. */
function readmeSteps(): Steps {
  const text = readFileSync(README, 'utf8')
  const start = text.indexOf('## Try it on your repo')
  const section = text.slice(start, text.indexOf('\n## ', start + 1))
  const ts = /```ts\n([\s\S]*?)```/.exec(section)?.[1] ?? ''
  const sh = /```sh\n([\s\S]*?)```/.exec(section)?.[1] ?? ''
  return { workspaceFile: ts, commands: sh.split('\n').filter((l) => l.trim() !== '') }
}

/** The landing's `workspaceFile` and `tryCommands` template literals. */
function landingSteps(): Steps {
  const text = readFileSync(LANDING, 'utf8')
  const literal = (name: string): string =>
    new RegExp(`const ${name} = \`([\\s\\S]*?)\``).exec(text)?.[1] ?? ''
  return {
    workspaceFile: literal('workspaceFile').trimEnd() + '\n',
    commands: literal('tryCommands')
      .split('\n')
      .filter((l) => l.trim() !== ''),
  }
}

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
    mkdirSync(path.join(root, 'node_modules', '@vzn'), { recursive: true })
    mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true })
    for (const name of install[1]!.trim().split(' ')) {
      const dir = name.slice('@vzn/'.length)
      symlinkSync(path.join(PACKAGES, dir), path.join(root, 'node_modules', '@vzn', dir))
      const bins = (
        JSON.parse(readFileSync(path.join(PACKAGES, dir, 'package.json'), 'utf8')) as {
          bin?: Record<string, string>
        }
      ).bin
      for (const [bin, rel] of Object.entries(bins ?? {})) {
        symlinkSync(path.join(PACKAGES, dir, rel), path.join(root, 'node_modules', '.bin', bin))
      }
    }
    return { code: 0, out: '' }
  }
  const r = Bun.spawnSync({
    cmd: ['sh', '-c', command],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', npm_config_yes: 'false' },
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

describe('the README and landing "Try it on your repo" steps run as written', () => {
  const readme = readmeSteps()

  it('the landing shows the README steps', () => {
    expect(landingSteps()).toEqual(readme)
  })

  it('the README gives an install, vx init, two runs, and the file init writes', () => {
    expect(readme.workspaceFile).toContain('plugins: [turbo()]')
    const bare = readme.commands.map((l) => l.replace(/\s+#.*$/, '').trim())
    expect(bare.map((l) => INSTALL.test(l))).toEqual([true, false, false, false])
    expect(bare[1]).toBe('npx vx init')
  })

  const cases: Array<[string, () => string, (file: string) => string, Record<string, string>]> = [
    ['a Turbo repo', turboRepo, (f) => f, { 'app#build': '', 'lib#build': '' }],
    [
      'an Nx repo',
      () => {
        const root = nxRepo()
        standInNx(root)
        return root
      },
      // The README's own words: `in an Nx repo, nx for turbo`.
      (f) =>
        f
          .replace('import { turbo }', 'import { nx }')
          .replace('plugins: [turbo()]', 'plugins: [nx()]'),
      { 'app#build': '', 'lib#build': '' },
    ],
  ]

  for (const [name, make, adapt, tasks] of cases) {
    it(`${name}: the first run builds, the second hits`, () => {
      const root = make()
      const file = adapt(readme.workspaceFile)
      expect(file).not.toContain(name === 'a Turbo repo' ? 'plugins: [nx()]' : 'plugins: [turbo()]')
      commit(root)
      const [install, init, first, second] = readme.commands as [string, string, string, string]
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

/** A `$ <command>` sample's command and the output below it. */
function transcript(fence: string): [string, string] {
  const [first, ...rest] = fence.split('\n')
  return [first!.replace(/^\$ /, ''), rest.join('\n')]
}

// The migrate guide shows what `vx init` and `bunx @vzn/vx-migrate` write
// and print in a Turbo and an Nx repo; each sample is held to a run.
describe('the migrate guide shows what vx init and vx-migrate write', () => {
  it('Turborepo: the workspace file, init’s output and vx-migrate’s report', () => {
    const root = turboRepo()
    commit(root)
    const [file] = guideFences('Turborepo', 'ts')
    const [initFence, cacheLine, migrateFence] = guideFences('Turborepo', 'text')
    expect(step(root, 'npm install -D @vzn/vx').code).toBe(0)
    const [initCmd, initOut] = transcript(initFence!)
    expect(initCmd).toBe('npx vx init')
    const init = step(root, initCmd)
    expect([init.code, init.out]).toEqual([0, initOut])
    expect(readFileSync(path.join(root, 'vx.workspace.ts'), 'utf8')).toBe(file!)

    mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true })
    writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'env:\n  TURBO_TOKEN: x\n')
    const cached = step(root, 'npx vx init --dry --force')
    expect(cached.out.split('\n')).toContain(cacheLine!.trimEnd())
    rmSync(path.join(root, '.github'), { recursive: true })

    const [migrateCmd, migrateOut] = transcript(migrateFence!)
    expect(migrateCmd).toBe('bunx @vzn/vx-migrate')
    const migrate = Bun.spawnSync({
      cmd: [process.execPath, path.join(PACKAGES, 'vx-migrate', 'src', 'bin.ts')],
      cwd: root,
      env: { ...process.env, NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect([migrate.exitCode, migrate.stdout.toString()]).toEqual([0, migrateOut])
  }, 60_000)

  it('Nx: the workspace file', () => {
    const root = nxRepo()
    commit(root)
    const [file] = guideFences('Nx', 'ts')
    expect(step(root, 'npm install -D @vzn/vx').code).toBe(0)
    expect(step(root, 'npx vx init').code).toBe(0)
    expect(readFileSync(path.join(root, 'vx.workspace.ts'), 'utf8')).toBe(file!)
  }, 60_000)
})
