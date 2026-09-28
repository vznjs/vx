// A moon workspace runs under vx with no vx.config written, and
// `vx-migrate --from moon` writes what `moon()` runs. The two fixtures are
// real repos' shapes: moon 1's (moonrepo/examples: name-inherited task
// files, `local: true`, file groups) and moon 2's (moonrepo/moon:
// `inheritedBy`, `.moon/toolchains.yml`). Every expected value here is
// what `moon query tasks` (1.41.7 and 2.5.5) printed for the same files.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { loadProjectConfig, planRun, run, type Logger } from '@vzn/vx'
import { parseMigrateArgs } from '../src/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const CORE_PKG = path.resolve(import.meta.dir, '..', '..', 'vx')
const TIMEOUT = 30_000

let root: string

function silent(): Logger & { lines: string[] } {
  const lines: string[] = []
  const log = {
    lines,
    status: (line: string) => lines.push(line),
    runStart() {},
    taskStart() {},
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
    runStatus() {},
    runEnd() {},
  }
  return log as unknown as Logger & { lines: string[] }
}

async function write(rel: string, text: string): Promise<void> {
  const file = path.join(root, rel)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
}

async function pkg(dir: string, name: string, deps?: Record<string, string>): Promise<void> {
  await write(`${dir}/package.json`, JSON.stringify({ name, dependencies: deps }))
  await write(`${dir}/src/index.ts`, `// ${name}\n`)
}

async function workspace(prefix: string): Promise<void> {
  root = await mkdtemp(path.join(tmpdir(), prefix))
  await write('package.json', JSON.stringify({ name: 'ws', private: true }))
  await write('pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n  - "packages/*"\n')
  await write('.gitignore', 'dist\nlib\n')
  await write(
    'vx.workspace.mjs',
    localWorkspaceSource(['moon()'], `import { moon } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
  )
}

function git(): void {
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
}

/** moonrepo/examples, cut to two projects: moon 1 inherits task files by name. */
async function moon1(): Promise<void> {
  await workspace('vx-moon1-')
  await write(
    '.moon/workspace.yml',
    `projects:
  web: 'apps/web'
  core: 'packages/core'
`,
  )
  await write('.moon/toolchain.yml', `node:\n  packageManager: 'pnpm'\n`)
  await write(
    '.moon/tasks/node.yml',
    `implicitDeps:
  - '^:build'
implicitInputs:
  - 'package.json'
fileGroups:
  configs:
    - '*.{js,json}'
  sources:
    - 'src/**/*'
    - 'types/**/*'
  tests:
    - 'tests/**/*.test.*'
tasks:
  format:
    command:
      - 'prettier'
      - '--ignore-path'
      - '@in(0)'
      - '--check'
      - '.'
    inputs:
      - '/.prettierignore'
      - '@globs(sources)'
      - '@globs(configs)'
  test:
    command: 'echo test'
    inputs:
      - '@globs(sources)'
      - '@globs(tests)'
`,
  )
  await write(
    '.moon/tasks/node-library.yml',
    `tasks:
  build:
    command: 'mkdir -p lib && cp src/index.ts lib/index.js'
    inputs:
      - '@globs(sources)'
      - 'tsconfig.*.json'
`,
  )
  await write('.prettierignore', 'lib\n')
  await pkg('packages/core', '@x/lib')
  await write(
    'packages/core/moon.yml',
    `type: 'library'
tasks:
  build:
    outputs:
      - 'lib'
`,
  )
  await pkg('apps/web', '@x/web', { '@x/lib': 'workspace:*' })
  await write(
    'apps/web/moon.yml',
    `type: 'application'
workspace:
  inheritedTasks:
    exclude: ['test']
fileGroups:
  app:
    - 'next.config.*'
tasks:
  build:
    command: 'mkdir -p dist && cat src/index.ts > dist/out.js'
    inputs:
      - '@group(app)'
      - '@group(sources)'
    outputs:
      - 'dist'
  dev:
    command: 'next dev'
    local: true
  start:
    command: 'next start'
    deps:
      - 'build'
    local: true
`,
  )
  git()
}

/** moonrepo/moon's shape: moon 2 inherits by `inheritedBy`, and merges on the final options. */
async function moon2(): Promise<void> {
  await workspace('vx-moon2-')
  await write(
    '.moon/workspace.yml',
    `projects:\n  - 'packages/*'\nremote:\n  host: 'grpcs://cache.example.dev'\n`,
  )
  await write('.moon/toolchains.yml', '{}\n')
  await write('.eslintrc.json', '{}\n')
  await write(
    '.moon/tasks/all.yml',
    `fileGroups:
  sources: ['src/**/*', 'lib/*.js']
implicitInputs: ['package.json']
tasks:
  lint:
    command: 'eslint @in(1)'
    inputs: ['@globs(sources)', '/.eslintrc.json', '$LINT_MODE']
  build:
    command: ['tsc', '--build', 'some arg']
    inputs: ['@group(sources)']
    outputs: ['dist']
    options:
      runFromWorkspaceRoot: true
`,
  )
  await write(
    '.moon/tasks/sub/lib.yml',
    `inheritedBy:
  layers: ['library']
  order: 2
implicitDeps: ['^:build']
tasks:
  build:
    args: ['--verbose']
    env: { MODE: 'lib' }
    outputs: ['types']
  pack:
    command: 'pack $project $task'
    deps: ['build']
    options: { cache: false }
`,
  )
  await write(
    '.moon/tasks/tagged.yml',
    `inheritedBy:
  tags: { and: ['x'], not: ['skip'] }
tasks:
  tagged:
    command: 'echo tagged'
    inputs: []
`,
  )
  await pkg('packages/a', '@s/a')
  await write(
    'packages/a/moon.yml',
    `layer: library
tags: ['x']
tasks:
  build:
    inputs: ['extra/**']
    options: { mergeInputs: 'replace', mergeArgs: 'prepend' }
    args: ['--first']
  dev:
    command: 'serve'
    preset: 'server'
  check:
    extends: 'lint'
    args: ['--strict']
`,
  )
  await pkg('packages/b', '@s/b', { '@s/a': '*' })
  await write(
    'packages/b/moon.yml',
    `layer: library
tags: ['x', 'skip']
workspace:
  inheritedTasks:
    exclude: ['lint']
    rename: { pack: 'bundle' }
tasks:
  test:
    command: 'noop'
    deps: ['a:build', '~:build']
`,
  )
  await pkg('packages/c', '@s/c')
  await write(
    'packages/c/moon.yml',
    `layer: application
dependsOn: ['a']
tasks:
  start:
    command: 'node .'
    deps: ['^:build']
    options: { persistent: true, cache: false }
`,
  )
  git()
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function tasksOf(ids: string[]) {
  const plan = await planRun({ cwd: root, tasks: ids, log: silent() })
  return new Map(plan.tasks.map((t) => [t.node.id, t.node]))
}

describe('moon() — moon 1 (moonrepo/examples)', () => {
  it(
    'inherits node.yml by platform and node-library.yml by type; groups, tokens and edges map',
    async () => {
      await moon1()
      const tasks = await tasksOf(['build', 'format', 'test', 'dev', 'start'])
      expect([...tasks.keys()].sort()).toEqual([
        '@x/lib#build',
        '@x/lib#format',
        '@x/lib#test',
        '@x/web#build',
        '@x/web#dev',
        '@x/web#format',
        '@x/web#start',
      ])
      const lib = tasks.get('@x/lib#build')!.config
      expect(lib.exec?.command).toBe('mkdir -p lib && cp src/index.ts lib/index.js')
      // `@globs(sources)` then the file's own glob, then the implicit input.
      expect(lib.cache?.inputs.files).toEqual([
        'src/**/*',
        'types/**/*',
        'tsconfig.*.json',
        'package.json',
      ])
      expect(lib.cache?.outputs.files).toEqual(['lib'])

      const format = tasks.get('@x/web#format')!
      // `@in(0)` is the first input, `/.prettierignore`, from the project dir.
      expect(format.config.exec?.command).toBe(
        'prettier --ignore-path ../../.prettierignore --check .',
      )
      expect(format.config.cache?.inputs.workspaceFiles).toEqual(['.prettierignore'])
      expect(format.config.cache?.inputs.files).toEqual([
        'src/**/*',
        'types/**/*',
        '*.{js,json}',
        'package.json',
      ])
      // implicitDeps `^:build` reaches lib.
      expect(format.deps).toEqual(['@x/lib#build'])

      const web = tasks.get('@x/web#build')!
      expect(web.config.cache?.inputs.files).toEqual([
        'next.config.*',
        'src/**/*',
        'types/**/*',
        'package.json',
      ])
      expect(web.deps).toEqual(['@x/lib#build'])
      // `local: true` is persistent and uncached, as moon 1 reads it.
      const dev = tasks.get('@x/web#dev')!.config
      expect(dev.exec?.persistent).toBeDefined()
      expect(dev.cache).toBeUndefined()
      expect(tasks.get('@x/web#start')!.deps.sort()).toEqual(['@x/lib#build', '@x/web#build'])
    },
    TIMEOUT,
  )

  it(
    'runs and caches by the mapped blocks: a hit, then a miss on an input edit only',
    async () => {
      await moon1()
      const opts = { cwd: root, tasks: ['build'], log: silent(), handleSignals: false }
      const status = (r: Awaited<ReturnType<typeof run>>, id: string) =>
        r.outcomes.find((o) => o.node.id === id)!.status
      const first = await run(opts)
      expect(first.ok).toBe(true)
      expect(await Bun.file(path.join(root, 'apps/web/dist/out.js')).text()).toBe('// @x/web\n')
      const second = await run(opts)
      expect(status(second, '@x/lib#build')).toBe('cache-hit')
      expect(status(second, '@x/web#build')).toBe('cache-hit')
      await write('apps/web/README.md', 'not an input\n')
      expect(status(await run(opts), '@x/web#build')).toBe('cache-hit')
      await write('apps/web/src/index.ts', '// v2\n')
      const fourth = await run(opts)
      expect(status(fourth, '@x/web#build')).toBe('success')
      expect(status(fourth, '@x/lib#build')).toBe('cache-hit')
      expect(await Bun.file(path.join(root, 'apps/web/dist/out.js')).text()).toBe('// v2\n')
    },
    TIMEOUT,
  )

  it(
    'a task with no inputs keys every project file, as moon hashes it',
    async () => {
      await moon1()
      await write(
        'packages/core/moon.yml',
        `type: 'library'
tasks:
  gen:
    command: 'mkdir -p lib && cat notes.txt > lib/gen.txt'
    outputs: ['lib/gen.txt']
`,
      )
      await write('packages/core/notes.txt', 'one\n')
      git()
      const opts = { cwd: root, tasks: ['@x/lib#gen'], log: silent(), handleSignals: false }
      expect((await run(opts)).ok).toBe(true)
      expect((await run(opts)).outcomes[0]!.status).toBe('cache-hit')
      await write('packages/core/notes.txt', 'two\n')
      const third = await run(opts)
      expect(third.outcomes[0]!.status).toBe('success')
      expect(await Bun.file(path.join(root, 'packages/core/lib/gen.txt')).text()).toBe('two\n')
    },
    TIMEOUT,
  )
  it(
    'a .env input, gitignored, is keyed by the probe: an edit to it misses',
    async () => {
      await moon1()
      await write('.gitignore', 'dist\nlib\n.env\n')
      await write(
        'packages/core/moon.yml',
        `type: 'library'
tasks:
  gen:
    command: 'mkdir -p lib && cat .env > lib/env.txt'
    inputs: ['src/**/*', '.env']
    outputs: ['lib/env.txt']
`,
      )
      await write('packages/core/.env', 'A=1\n')
      git()
      const opts = { cwd: root, tasks: ['@x/lib#gen'], log: silent(), handleSignals: false }
      expect((await run(opts)).ok).toBe(true)
      expect((await run(opts)).outcomes[0]!.status).toBe('cache-hit')
      await write('packages/core/.env', 'A=2\n')
      expect((await run(opts)).outcomes[0]!.status).toBe('success')
      expect(await Bun.file(path.join(root, 'packages/core/lib/env.txt')).text()).toBe('A=2\n')
    },
    TIMEOUT,
  )
  it(
    'inferTasksFromScripts: scripts are tasks under moon.yml; a command resets args; dev/start/serve are local',
    async () => {
      // adobe/leonardo's shape (moon 1.41 printed each value below).
      await moon1()
      await write(
        '.moon/toolchain.yml',
        `node:\n  packageManager: 'pnpm'\n  inferTasksFromScripts: true\n`,
      )
      await write(
        'packages/core/package.json',
        JSON.stringify({
          name: '@x/lib',
          scripts: {
            start: 'node .',
            test: 'node --test',
            'test:types': 'tsd',
            prepublishOnly: 'x',
          },
        }),
      )
      await write(
        'packages/core/moon.yml',
        `type: 'library'
tasks:
  test:
    command: ['node', '--test', 'test/*.test.js']
  test-types:
    command: ['pnpm', 'test:types']
  serve:
    command: 'vite preview'
`,
      )
      git()
      const tasks = await tasksOf([
        '@x/lib#start',
        '@x/lib#test',
        '@x/lib#test-types',
        '@x/lib#serve',
      ])
      const cmd = (id: string) => tasks.get(id)!.config.exec?.command
      expect(cmd('@x/lib#start')).toBe('pnpm run start')
      expect(cmd('@x/lib#test')).toBe("node --test 'test/*.test.js'")
      expect(cmd('@x/lib#test-types')).toBe('pnpm test:types')
      for (const id of ['@x/lib#start', '@x/lib#serve']) {
        expect(tasks.get(id)!.config.exec?.persistent).toBeDefined()
        expect(tasks.get(id)!.config.cache).toBeUndefined()
      }
      expect(tasks.get('@x/lib#test')!.config.exec?.persistent).toBeUndefined()
      const all = await planRun({ cwd: root, tasks: ['prepublishOnly'], log: silent() })
      expect(all.tasks).toEqual([])
    },
    TIMEOUT,
  )
})

describe('moon() — moon 2 (moonrepo/moon)', () => {
  it(
    'inheritedBy, order, final-option merges, rename, extends, noop and moon.yml dependsOn',
    async () => {
      await moon2()
      const tasks = await tasksOf([
        'build',
        'lint',
        'check',
        'tagged',
        'pack',
        'bundle',
        'test',
        'start',
        'dev',
      ])
      expect([...tasks.keys()].sort()).toEqual([
        '@s/a#build',
        '@s/a#check',
        '@s/a#dev',
        '@s/a#lint',
        '@s/a#pack',
        '@s/a#tagged',
        '@s/b#build',
        '@s/b#bundle',
        '@s/b#test',
        '@s/c#build',
        '@s/c#lint',
        '@s/c#start',
      ])
      const cmd = (id: string) => tasks.get(id)!.config.exec?.command
      // a's `mergeArgs: prepend` applies to every layer's args, not only its own.
      expect(cmd('@s/a#build')).toBe("cd ../.. && tsc --first --verbose --build 'some arg'")
      expect(cmd('@s/b#build')).toBe("cd ../.. && tsc --build 'some arg' --verbose")
      expect(cmd('@s/c#build')).toBe("cd ../.. && tsc --build 'some arg'")
      expect(cmd('@s/a#check')).toBe('eslint ../../.eslintrc.json --strict')
      expect(cmd('@s/b#bundle')).toBe('pack b bundle')
      const a = tasks.get('@s/a#build')!.config
      expect(a.cache?.inputs.files).toEqual(['extra/**', 'package.json'])
      expect(a.cache?.outputs.files).toEqual(['dist', 'types'])
      expect(a.exec?.env?.define).toEqual({ MODE: 'lib' })
      const lint = tasks.get('@s/a#lint')!.config
      expect(lint.cache?.inputs.env).toEqual(['LINT_MODE'])
      expect(lint.exec?.env?.passThrough).toEqual(['LINT_MODE'])
      expect(tasks.get('@s/a#tagged')!.config.cache?.inputs.files).toEqual(['package.json'])
      expect(tasks.get('@s/a#pack')!.config.cache).toBeUndefined()
      expect(tasks.get('@s/b#test')!.config.exec).toBeUndefined()
      expect(tasks.get('@s/b#test')!.deps.sort()).toEqual(['@s/a#build', '@s/b#build'])
      // c's package.json names no dependency; its moon.yml `dependsOn` does.
      expect(tasks.get('@s/c#start')!.deps).toEqual(['@s/a#build'])
      expect(tasks.get('@s/a#dev')!.config.exec?.persistent).toBeDefined()
    },
    TIMEOUT,
  )

  it(
    'an edge to a task with no vx form is dropped with a todo, not a refused run',
    async () => {
      await moon2()
      await write(
        'packages/c/moon.yml',
        `layer: application
tasks:
  odd:
    command: 'gen @meta(title)'
  use:
    command: 'echo use'
    deps: ['odd']
`,
      )
      git()
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['@s/c#use'], log })
      expect(plan.tasks.map((t) => t.node.id)).toEqual(['@s/c#use'])
      expect(log.lines).toContain(
        '[@vzn/vx-migrate] @s/c#odd: the command uses a moon token vx has no form for — task skipped; write the command by hand',
      )
      expect(log.lines).toContain(
        '[@vzn/vx-migrate] @s/c#use: edge "odd": that task has no vx form — edge dropped',
      )
      expect(log.lines).toContain(
        "[@vzn/vx-migrate] note: moon's remote cache (grpcs://cache.example.dev) speaks Bazel REAPI — `reapi()` from @vzn/vx-reapi stores vx artifacts on the same server under vx keys",
      )
    },
    TIMEOUT,
  )
})

describe('vx-migrate --from moon', () => {
  async function cli(args: string[]) {
    await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
    await symlink(CORE_PKG, path.join(root, 'node_modules', '@vzn', 'vx'), 'dir')
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
    return { out, err, code }
  }

  it(
    'detects .moon/workspace.yml and writes the configs moon() runs',
    async () => {
      await moon1()
      const live = await tasksOf(['build'])
      const r = await cli([])
      expect(r.err).toBe('')
      expect(r.code).toBe(0)
      expect(`${r.out}${r.err}`).toContain('.moon/workspace.yml → vx.config.ts')
      const config = await loadProjectConfig(path.join(root, 'apps/web/vx.config.ts'))
      expect(config.tasks!.build).toEqual(live.get('@x/web#build')!.config as never)
    },
    TIMEOUT,
  )

  it(
    'a second runner checked in needs --from, and names both',
    async () => {
      await moon1()
      await write('turbo.json', '{"tasks":{}}')
      const r = await cli([])
      expect(r.code).toBe(1)
      expect(r.err).toBe(
        'vx-migrate: both turbo.json and a moon workspace are present — pass --from turbo or --from moon\n',
      )
    },
    TIMEOUT,
  )

  it('parses --from moon', () => {
    expect(parseMigrateArgs(['--from', 'moon'])).toEqual({
      dry: false,
      force: false,
      mjs: false,
      from: 'moon',
    })
  })
})
