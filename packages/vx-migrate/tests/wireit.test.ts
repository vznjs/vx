// A wireit workspace runs under vx with no vx.config written. The fixture
// is lit/lit's shape (2026-09-28): npm workspaces, each package's scripts
// "wireit" with the config in its package.json, cross-package
// `../pkg:script` dependencies, `clean: "if-file-deleted"` builds, external
// env and a service a test depends on.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { loadProjectConfig, planRun, run, type Logger } from '@vzn/vx'
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

async function pkg(dir: string, manifest: Record<string, unknown>): Promise<void> {
  await write(`${dir}/package.json`, JSON.stringify(manifest, null, 2))
  await write(`${dir}/src/index.ts`, `// ${String(manifest['name'])}\n`)
}

const wireitScripts = (...names: string[]) => Object.fromEntries(names.map((n) => [n, 'wireit']))

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-wireit-'))
  await write(
    'package.json',
    JSON.stringify({
      name: 'ws',
      private: true,
      workspaces: ['packages/*'],
      scripts: { lint: 'wireit' },
      wireit: { lint: { command: 'eslint .' } },
    }),
  )
  await write('.gitignore', 'development\n*.d.ts\n')
  await write('rollup-common.js', '// shared\n')
  await pkg('packages/util', {
    name: '@l/util',
    scripts: { ...wireitScripts('build'), gen: 'echo gen' },
    wireit: {
      build: {
        command: 'mkdir -p development && cp src/index.ts development/index.js',
        files: ['src/**/*.ts', '../../rollup-common.js'],
        output: ['development/**/*.js'],
        clean: 'if-file-deleted',
      },
    },
  })
  await pkg('packages/html', {
    name: '@l/html',
    dependencies: { '@l/util': '*' },
    scripts: {
      ...wireitScripts('build', 'build:ts', 'build:types', 'serve', 'test', 'test:dev'),
      prepare: 'echo never',
    },
    wireit: {
      build: { dependencies: ['build:ts', 'build:types'] },
      'build:ts': {
        command: 'mkdir -p development && cat src/index.ts > development/html.js',
        dependencies: ['../util:build', '../util:gen'],
        files: ['src/**/*.ts', 'tsconfig.json'],
        output: ['development/**/*.{js,js.map}'],
        clean: 'if-file-deleted',
        env: { MODE: 'prod', BROWSERS: { external: true } },
      },
      'build:types': {
        command: 'echo "export {}" > html.d.ts',
        dependencies: ['build:ts'],
        files: [],
        output: ['*.d.ts{,.map}'],
      },
      serve: {
        command: 'echo "listening on 8000" && sleep 30',
        service: { readyWhen: { lineMatches: 'listening on \\d+' } },
      },
      test: { dependencies: ['test:dev'] },
      'test:dev': {
        command: 'echo test',
        dependencies: ['build:ts', 'serve', { script: '../util:build', cascade: false }],
        files: [],
        output: [],
      },
    },
  })
  await write(
    'vx.workspace.mjs',
    localWorkspaceSource(['wireit()'], `import { wireit } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('wireit()', () => {
  it(
    'maps commands, cross-package edges, cache blocks, env and a service',
    async () => {
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['build', 'test'], log })
      const tasks = new Map(plan.tasks.map((t) => [t.node.id, t.node]))
      expect([...tasks.keys()].sort()).toEqual([
        '@l/html#build',
        '@l/html#build:ts',
        '@l/html#build:types',
        '@l/html#serve',
        '@l/html#test',
        '@l/html#test:dev',
        '@l/util#build',
        '@l/util#gen',
      ])
      const ts = tasks.get('@l/html#build:ts')!
      expect(ts.deps.sort()).toEqual(['@l/util#build', '@l/util#gen'])
      expect(ts.config.cache?.inputs.files).toEqual(['src/**/*.ts', 'tsconfig.json'])
      expect(ts.config.cache?.inputs.env).toEqual(['BROWSERS'])
      expect(ts.config.cache?.outputs.files).toEqual(['development/**/*.{js,js.map}'])
      expect(ts.config.exec?.env).toEqual({ passThrough: ['BROWSERS'], define: { MODE: 'prod' } })
      // A package script wireit does not own runs as itself, uncached.
      expect(tasks.get('@l/util#gen')!.config.exec?.command).toBe('echo gen')
      expect(tasks.get('@l/util#gen')!.config.cache).toBeUndefined()
      // `../../x` climbs to the workspace root.
      expect(tasks.get('@l/util#build')!.config.cache?.inputs.workspaceFiles).toEqual([
        'rollup-common.js',
      ])
      expect(tasks.get('@l/html#build')!.config.exec).toBeUndefined()
      expect(tasks.get('@l/html#serve')!.config.exec?.persistent).toEqual({
        readyWhen: 'listening on \\d+',
      })
      expect(tasks.get('@l/html#serve')!.config.cache).toBeUndefined()
      expect(tasks.get('@l/html#test:dev')!.deps.sort()).toEqual([
        '@l/html#build:ts',
        '@l/html#serve',
        '@l/util#build',
      ])
      expect(log.lines).toContain(
        "[@vzn/vx-migrate] note: the workspace root's wireit scripts (lint) are not mapped — vx has no workspace-root tasks",
      )
      expect(log.lines).toContain(
        '[@vzn/vx-migrate] @l/html#test:dev: dependency {"script":"../util:build","cascade":false} has cascade: false — vx folds every dependency\'s key, so this task re-runs when that one changes',
      )
    },
    TIMEOUT,
  )

  it(
    'caches by files and output: a hit, a hit on a non-input edit, a miss on an input edit',
    async () => {
      const opts = { cwd: root, tasks: ['@l/html#build'], log: silent(), handleSignals: false }
      const status = (r: Awaited<ReturnType<typeof run>>, id: string) =>
        r.outcomes.find((o) => o.node.id === id)!.status
      expect((await run(opts)).ok).toBe(true)
      const second = await run(opts)
      expect(status(second, '@l/html#build:ts')).toBe('cache-hit')
      expect(status(second, '@l/html#build:types')).toBe('cache-hit')
      await write('packages/html/README.md', 'not an input\n')
      expect(status(await run(opts), '@l/html#build:ts')).toBe('cache-hit')
      await write('packages/html/src/index.ts', '// v2\n')
      const fourth = await run(opts)
      expect(status(fourth, '@l/html#build:ts')).toBe('success')
      expect(await Bun.file(path.join(root, 'packages/html/development/html.js')).text()).toBe(
        '// v2\n',
      )
      // The shared file two packages up re-keys util's build.
      await write('rollup-common.js', '// shared v2\n')
      expect(status(await run(opts), '@l/util#build')).toBe('success')
    },
    TIMEOUT,
  )

  it(
    'no cache without both files and output; a negated output or a dir outside the workspace is a todo',
    async () => {
      const manifest = JSON.parse(
        await Bun.file(path.join(root, 'packages/util/package.json')).text(),
      )
      manifest.scripts = { ...manifest.scripts, a: 'wireit', b: 'wireit', c: 'wireit' }
      manifest.wireit.a = { command: 'echo a', files: ['src/**'] }
      manifest.wireit.b = { command: 'echo b', files: [], output: ['out', '!out/keep'] }
      manifest.wireit.c = { command: 'echo c', dependencies: ['../../../elsewhere:x'] }
      await write('packages/util/package.json', JSON.stringify(manifest))
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['@l/util#a', '@l/util#b', '@l/util#c'], log })
      for (const t of plan.tasks) expect(t.node.config.cache).toBeUndefined()
      expect(log.lines).toContain(
        '[@vzn/vx-migrate] @l/util#b: output "!out/keep": a negation, a path outside the package or glob syntax vx cannot take — task runs uncached; declare the exact outputs in a vx.config to cache it',
      )
      expect(log.lines.some((l) => l.includes('dependency "../../../elsewhere:x"'))).toBe(true)
    },
    TIMEOUT,
  )
  it(
    'clean: false with an output that is also an input runs uncached and keeps the file',
    async () => {
      // spectacle's examples/one-page (e9dde74): `index.html` is both, and
      // the cleaned run deleted the tracked file and failed.
      const manifest = JSON.parse(
        await Bun.file(path.join(root, 'packages/util/package.json')).text(),
      )
      manifest.scripts = { ...manifest.scripts, page: 'wireit' }
      manifest.wireit.page = {
        command: 'cat index.html > page.tmp && mv page.tmp index.html',
        clean: false,
        files: ['index.html'],
        output: ['index.html'],
      }
      await write('packages/util/package.json', JSON.stringify(manifest))
      await write('packages/util/index.html', '<p>one page</p>\n')
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      const log = silent()
      const r = await run({ cwd: root, tasks: ['@l/util#page'], log, handleSignals: false })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.node.config.cache).toBeUndefined()
      expect(await Bun.file(path.join(root, 'packages/util/index.html')).text()).toBe(
        '<p>one page</p>\n',
      )
    },
    TIMEOUT,
  )
})

describe('vx-migrate --from wireit', () => {
  it(
    'detects the wireit blocks and writes the configs wireit() runs',
    async () => {
      const plan = await planRun({ cwd: root, tasks: ['@l/html#build:ts'], log: silent() })
      const live = plan.tasks.find((t) => t.node.id === '@l/html#build:ts')!.node.config
      await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
      await symlink(CORE_PKG, path.join(root, 'node_modules', '@vzn', 'vx'), 'dir')
      const proc = Bun.spawn([process.execPath, BIN], {
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
      expect(err).toBe('')
      expect(code).toBe(0)
      expect(out).toContain('package.json wireit → vx.config.ts')
      const config = await loadProjectConfig(path.join(root, 'packages/html/vx.config.ts'))
      expect(config.tasks!['build:ts']).toEqual(live as never)
    },
    TIMEOUT,
  )
})
