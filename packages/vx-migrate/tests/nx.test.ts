// An Nx repo runs under vx with no vx.config written. Every pin is a real
// `planRun` / `run` over a workspace whose only vx file declares the
// plugin. Nx itself is the fake in `helpers/fake-nx.ts`: a `.bin/nx` that
// exports `<root>/graph.json` on `graph --file=…` and counts the call, and
// the `nx` package `nx-exec` loads to run an executor — so the executor
// round trip (vx → nx-exec → runExecutor → a file on disk → the cache) is
// real, and only Nx's own graph computation is stubbed.
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { planRun, run, type Logger } from '@vzn/vx'
import { fakeNx, fakeNxCli, nxCalls } from './helpers/fake-nx.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const TIMEOUT = 30_000

/** The graph the fake `nx graph --file` exports. */
const GRAPH = {
  graph: {
    nodes: {
      lib: {
        name: 'lib',
        type: 'lib',
        data: {
          root: 'packages/lib',
          targets: {
            build: {
              executor: '@acme/compile:run',
              options: { writeFile: 'dist/lib.js', content: 'lib v1', cwd: '{projectRoot}' },
              inputs: ['{projectRoot}/src/**/*'],
              outputs: ['{projectRoot}/dist'],
              cache: true,
            },
            lint: {
              executor: 'nx:run-commands',
              options: { command: 'echo lint-ran > lint.log', cwd: 'packages/lib' },
            },
            serve: { executor: '@nx/vite:dev-server', options: { port: 4200 } },
            // Depends on serve, so serve's readiness note is reported (602).
            e2e: {
              executor: 'nx:run-commands',
              options: { command: 'echo e2e' },
              dependsOn: ['serve'],
            },
          },
        },
      },
      app: {
        name: 'app',
        type: 'app',
        data: {
          root: 'packages/app',
          targets: {
            build: {
              executor: '@acme/compile:run',
              options: { writeFile: 'dist/app.js', mode: 'dev' },
              configurations: { production: { mode: 'prod' } },
              defaultConfiguration: 'production',
              inputs: ['{projectRoot}/src/**/*'],
              outputs: ['{projectRoot}/dist'],
              dependsOn: ['^build'],
              cache: true,
            },
            all: { executor: 'nx:noop', dependsOn: ['build'] },
          },
        },
      },
      // The root project: targets with no package to attach to.
      ws: {
        name: 'ws',
        type: 'app',
        data: {
          root: '.',
          targets: { 'ci-all': { executor: 'nx:run-commands', options: { command: 'true' } } },
        },
      },
    },
    dependencies: { lib: [], app: [{ source: 'app', target: 'lib', type: 'static' }], ws: [] },
  },
}

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

async function pkg(name: string, deps?: Record<string, string>): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', ...(deps ? { dependencies: deps } : {}) }),
  )
  await writeFile(path.join(dir, 'project.json'), JSON.stringify({ name }))
  await writeFile(path.join(dir, 'src', 'index.js'), `// ${name}\n`)
  return dir
}

async function workspace(plugin = 'nx()'): Promise<void> {
  await Bun.write(
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource([plugin], `import { nx } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
  )
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-plugin-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'nx.json'), JSON.stringify({ namedInputs: {} }))
  await writeFile(path.join(root, '.gitignore'), 'dist\nnode_modules\n.vx\n.nx\nlint.log\n')
  await writeFile(path.join(root, 'graph.json'), JSON.stringify(GRAPH))
  await pkg('lib')
  await pkg('app', { lib: 'workspace:*' })
  await fakeNx(root)
  await fakeNxCli(root)
  await workspace()
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const status = (r: Awaited<ReturnType<typeof run>>, id: string) =>
  r.outcomes.find((o) => o.node.id === id)!.status

describe('nx()', () => {
  it(
    'plans an Nx workspace with no vx.config: executors as nx-exec lines, run-commands as shell, noop as a group',
    async () => {
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['build', 'lint', 'all'], log })
      const ids = plan.tasks.map((t) => t.node.id).sort()
      expect(ids).toEqual(['app#all', 'app#build', 'lib#build', 'lib#lint'])
      const app = plan.tasks.find((t) => t.node.id === 'app#build')!.node
      expect(app.deps).toEqual(['lib#build'])
      // The default configuration is folded in and named.
      expect(app.config.exec?.command).toBe(
        `nx-exec @acme/compile:run --project app --target build --configuration production --options '{"writeFile":"dist/app.js","mode":"prod"}'`,
      )
      expect(app.config.cache?.inputs.files).toEqual(['src/**/*'])
      expect(app.config.cache?.outputs.files).toEqual(['dist/**'])
      const lint = plan.tasks.find((t) => t.node.id === 'lib#lint')!.node
      expect(lint.config.exec?.command).toBe('echo lint-ran > lint.log')
      expect(lint.config.cache).toBeUndefined()
      expect(plan.tasks.find((t) => t.node.id === 'app#all')!.node.deps).toEqual(['app#build'])
      // The graph was exported once, and the root project is a note.
      expect(await nxCalls(root)).toBe(1)
      expect(log.lines.some((l) => l.includes('Nx project(s) ws have no workspace package'))).toBe(
        true,
      )
    },
    TIMEOUT,
  )

  it(
    'runs: the executor through nx-exec writes the output, the second run is a cache hit, run-commands ran',
    async () => {
      const opts = { cwd: root, tasks: ['build', 'lint'], log: silent(), handleSignals: false }
      const first = await run(opts)
      expect(first.ok).toBe(true)
      expect(status(first, 'lib#build')).toBe('success')
      expect(status(first, 'app#build')).toBe('success')
      expect(await Bun.file(path.join(root, 'packages', 'lib', 'dist', 'lib.js')).text()).toBe(
        'lib v1',
      )
      expect(await Bun.file(path.join(root, 'packages', 'app', 'dist', 'app.js')).text()).toBe(
        'executor wrote this',
      )
      expect((await Bun.file(path.join(root, 'packages', 'lib', 'lint.log')).text()).trim()).toBe(
        'lint-ran',
      )
      // What nx-exec handed Nx for the last executor: the command line's target.
      const rec = (await Bun.file(path.join(root, 'record.json')).json()) as {
        target: { executor: string; options: Record<string, unknown> }
        context: { cwd: string }
      }
      expect(rec.target.executor).toBe('@acme/compile:run')
      expect(rec.context.cwd).toMatch(/packages\/(app|lib)$/)
      const second = await run(opts)
      expect(status(second, 'lib#build')).toBe('cache-hit')
      expect(status(second, 'app#build')).toBe('cache-hit')
      // The mapping was read once per run and nx exported the graph once: the
      // snapshot was fresh for the second run.
      expect(await nxCalls(root)).toBe(1)
    },
    TIMEOUT,
  )

  it(
    'a project.json newer than the snapshot re-exports the graph, and the new graph is what runs',
    async () => {
      await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(await nxCalls(root)).toBe(1)
      // Same inputs: no export.
      await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(await nxCalls(root)).toBe(1)
      // A target changes and the file that declares it is touched.
      const changed = structuredClone(GRAPH)
      changed.graph.nodes.lib.data.targets.lint.options.command = 'echo lint-v2 > lint.log'
      await writeFile(path.join(root, 'graph.json'), JSON.stringify(changed))
      const later = new Date(Date.now() + 5_000)
      await utimes(path.join(root, 'packages', 'lib', 'project.json'), later, later)
      const plan = await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(await nxCalls(root)).toBe(2)
      expect(plan.tasks.find((t) => t.node.id === 'lib#lint')!.node.config.exec?.command).toBe(
        'echo lint-v2 > lint.log',
      )
    },
    TIMEOUT,
  )

  it(
    'graph: <file> reads an exported graph and never runs nx',
    async () => {
      await rm(path.join(root, 'node_modules', '.bin', 'nx'))
      await workspace("nx({ graph: 'graph.json' })")
      const plan = await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(plan.tasks.map((t) => t.node.id)).toEqual(['lib#lint'])
      expect(await nxCalls(root)).toBe(0)
    },
    TIMEOUT,
  )

  it(
    'no nx and no snapshot is a UserError that names the way out',
    async () => {
      await rm(path.join(root, 'node_modules', '.bin', 'nx'))
      await expect(planRun({ cwd: root, tasks: ['lint'], log: silent() })).rejects.toThrow(
        /no node_modules\/\.bin\/nx — install nx, or export a graph/,
      )
    },
    TIMEOUT,
  )

  it(
    'a failed export with a snapshot in hand warns and runs on the previous graph',
    async () => {
      await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      await writeFile(
        path.join(root, 'node_modules', '.bin', 'nx'),
        '#!/bin/sh\necho boom >&2\nexit 7\n',
      )
      const later = new Date(Date.now() + 5_000)
      await utimes(path.join(root, 'nx.json'), later, later)
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['lint'], log })
      expect(plan.tasks.map((t) => t.node.id)).toEqual(['lib#lint'])
      expect(
        log.lines.some((l) => /nx graph --file exited 7: boom — running on the previous/.test(l)),
      ).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a package’s own vx.config wins over the graph, task by task',
    async () => {
      await writeFile(
        path.join(root, 'packages', 'lib', 'vx.config.mjs'),
        `export default { tasks: { lint: { exec: { command: 'echo mine > lint.log' } } } }\n`,
      )
      const plan = await planRun({ cwd: root, tasks: ['lint', 'build'], log: silent() })
      const lint = plan.tasks.find((t) => t.node.id === 'lib#lint')!.node
      expect(lint.config.exec?.command).toBe('echo mine > lint.log')
      // build still comes from the graph.
      expect(
        plan.tasks.find((t) => t.node.id === 'lib#build')!.node.config.exec?.command,
      ).toContain('nx-exec @acme/compile:run')
    },
    TIMEOUT,
  )

  it(
    'without the nx-exec bin in node_modules/.bin the run warns once, naming the fix',
    async () => {
      await rm(path.join(root, 'node_modules', '.bin', 'nx-exec'))
      const log = silent()
      await planRun({ cwd: root, tasks: ['build'], log })
      expect(
        log.lines.filter((l) => l.includes('`nx-exec`, which is not in node_modules/.bin')).length,
      ).toBe(1)
      // The control: with the bin there, no such line.
      const quiet = silent()
      await fakeNxCli(root).catch(() => {})
      await planRun({ cwd: root, tasks: ['build'], log: quiet })
      expect(quiet.lines.some((l) => l.includes('not in node_modules/.bin'))).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'persistence is Nx’s `continuous`, never the target name: a cached `dev` caches like `gen` (nx#32610)',
    async () => {
      const g = structuredClone(GRAPH) as unknown as {
        graph: { nodes: Record<string, { data: { targets: Record<string, unknown> } }> }
      }
      const cached = (out: string) => ({
        executor: 'nx:run-commands',
        options: { command: `mkdir -p ${out} && echo ${out} > ${out}/o.txt`, cwd: 'packages/lib' },
        inputs: ['{projectRoot}/src/**/*'],
        outputs: [`{projectRoot}/${out}`],
        cache: true,
      })
      Object.assign(g.graph.nodes['lib']!.data.targets, {
        dev: cached('dev-out'),
        gen: cached('gen-out'),
        tail: {
          executor: 'nx:run-commands',
          options: { command: 'echo tailing' },
          continuous: true,
        },
        preview: { executor: '@nx/vite:dev-server', options: {}, continuous: false },
      })
      await writeFile(path.join(root, 'graph.json'), JSON.stringify(g))
      const plan = await planRun({
        cwd: root,
        tasks: ['dev', 'gen', 'tail', 'preview', 'serve'],
        log: silent(),
      })
      const shape = Object.fromEntries(
        plan.tasks.map((t) => [
          t.node.id,
          {
            persistent: t.node.config.exec?.persistent !== undefined,
            cached: !!t.node.config.cache,
          },
        ]),
      )
      expect(shape).toEqual({
        'lib#dev': { persistent: false, cached: true },
        'lib#gen': { persistent: false, cached: true },
        'lib#tail': { persistent: true, cached: false },
        // An explicit `continuous: false` is Nx's word, over the executor table.
        'lib#preview': { persistent: false, cached: false },
        // No `continuous` on a known server executor: the table decides.
        'lib#serve': { persistent: true, cached: false },
      })
      const opts = { cwd: root, tasks: ['dev'], log: silent(), handleSignals: false }
      expect(status(await run(opts), 'lib#dev')).toBe('success')
      expect(status(await run(opts), 'lib#dev')).toBe('cache-hit')
    },
    TIMEOUT,
  )

  it(
    'a server executor is a persistent task, reported once for all its tasks',
    async () => {
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['serve'], log })
      const serve = plan.tasks.find((t) => t.node.id === 'lib#serve')!.node
      expect(serve.config.exec?.persistent).toEqual({})
      expect(serve.config.exec?.command).toBe(
        `nx-exec @nx/vite:dev-server --project lib --target serve --options '{"port":4200}'`,
      )
      expect(
        log.lines.filter((l) => l.includes('lib#serve: a continuous target (or a server executor)'))
          .length,
      ).toBe(1)
    },
    TIMEOUT,
  )
})
