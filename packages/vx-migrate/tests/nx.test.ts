// An Nx repo runs under vx with no vx.config written. Every pin is a real
// `planRun` / `run` over a workspace whose only vx file declares the
// plugin. Nx itself is the fake in `helpers/fake-nx.ts`: a `.bin/nx` that
// exports `<root>/graph.json` on `graph --file=…` and counts the call, and
// the `nx` package `nx-exec` loads to run an executor — so the executor
// round trip (vx → nx-exec → runExecutor → a file on disk → the cache) is
// real, and only Nx's own graph computation is stubbed.
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { loadResolvedProjects, planRun, run, type Logger } from '@vzn/vx'
import { fakeNx, fakeNxCli, nxCalls } from './helpers/fake-nx.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { tamperMapping } from './helpers/tamper-mapping.js'
import { nx } from '../src/index.js'

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

describe('nx(): a wildcard-first output', () => {
  it(
    'stays cached under git: committed matches and the config are taken back, the rest is cleaned',
    async () => {
      const graph = structuredClone(GRAPH) as {
        graph: { nodes: Record<string, { data: { targets: Record<string, unknown> } }> }
      }
      const target = (outputs: string[]) => ({
        executor: 'nx:run-commands',
        options: { command: 'echo t' },
        outputs,
        cache: true,
      })
      graph.graph.nodes['lib']!.data.targets['test'] = target(['{projectRoot}/*.xml'])
      graph.graph.nodes['lib']!.data.targets['gen'] = target(['{projectRoot}/*.mjs'])
      graph.graph.nodes['app']!.data.targets['test'] = target(['{projectRoot}/**/*.xml'])
      await writeFile(path.join(root, 'graph.json'), JSON.stringify(graph))
      const app = path.join(root, 'packages', 'app')
      await writeFile(path.join(app, 'pom.xml'), '<project/>\n')
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      const cacheOf = async (id: string) =>
        (await planRun({ cwd: root, tasks: ['test', 'gen'], log: silent() })).tasks.find(
          (t) => t.node.id === id,
        )!.node.config.cache
      expect((await cacheOf('lib#test'))?.outputs.files).toEqual(['*.xml'])
      expect((await cacheOf('lib#gen'))?.outputs.files).toEqual(['*.mjs'])
      expect((await cacheOf('app#test'))?.outputs.files).toEqual(['**/*.xml', '!pom.xml'])
      await writeFile(
        path.join(root, 'packages', 'lib', 'vx.config.mjs'),
        'export default { tasks: {} }\n',
      )
      expect((await cacheOf('lib#gen'))?.outputs.files).toEqual(['*.mjs', '!vx.config.mjs'])
      // The clean removes what the glob reaches and git does not track.
      await mkdir(path.join(app, 'reports'), { recursive: true })
      await writeFile(path.join(app, 'reports', 'stale.xml'), '<old/>\n')
      const r = await run({ cwd: root, tasks: ['app#test'], log: silent(), handleSignals: false })
      expect(status(r, 'app#test')).toBe('success')
      expect(existsSync(path.join(app, 'pom.xml'))).toBe(true)
      expect(existsSync(path.join(app, 'reports', 'stale.xml'))).toBe(false)
    },
    TIMEOUT,
  )
})

describe('nx()', () => {
  it(
    'a ^target no project has is no edge, as under Nx',
    async () => {
      // Nx gives `^prepack` no edges when no project has the target. Passed
      // through, core refuses a `^name` no project declares (nx#32779), so
      // the mapper drops it — both the string and the object form. A
      // pattern is Nx's to expand over the workspace's target names: one
      // matching nothing is no edge, one matching `build` is `^build`.
      const graph = structuredClone(GRAPH) as {
        graph: { nodes: { app: { data: { targets: Record<string, unknown> } } } }
      }
      graph.graph.nodes.app.data.targets['test'] = {
        executor: 'nx:run-commands',
        options: { command: 'echo test' },
        dependsOn: ['^prepack', '^bui*', '^zzz*', { target: 'typecheck', dependencies: true }],
      }
      await writeFile(path.join(root, 'graph.json'), JSON.stringify(graph))
      const plan = await planRun({ cwd: root, tasks: ['test'], log: silent() })
      expect(plan.tasks.map((t) => t.node.id).sort()).toEqual(['app#test', 'lib#build'])
      const test = plan.tasks.find((t) => t.node.id === 'app#test')!.node
      expect(test.deps).toEqual(['lib#build'])
      expect(test.config.dependsOn).toEqual(['^build'])
    },
    TIMEOUT,
  )

  it(
    'plans an Nx workspace with no vx.config: executors as nx-exec lines, run-commands as shell, noop as a group',
    async () => {
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['build', 'lint', 'all'], log })
      const ids = plan.tasks.map((t) => t.node.id).sort()
      // The root's default build is no match for a bare name (X-102).
      expect(ids).toEqual(['app#all', 'app#build', 'lib#build', 'lib#lint'])
      const app = plan.tasks.find((t) => t.node.id === 'app#build')!.node
      expect(app.deps).toEqual(['lib#build'])
      // The default configuration is folded in and named.
      expect(app.config.exec?.command).toBe(
        `nx-exec @acme/compile:run --project app --target build --configuration production --options '{"writeFile":"dist/app.js","mode":"prod"}'`,
      )
      expect(app.config.cache?.inputs.files).toEqual(['src/**/*'])
      expect(app.config.cache?.outputs.files).toEqual(['dist'])
      const lint = plan.tasks.find((t) => t.node.id === 'lib#lint')!.node
      expect(lint.config.exec?.command).toBe('echo lint-ran > lint.log')
      expect(lint.config.cache).toBeUndefined()
      expect(plan.tasks.find((t) => t.node.id === 'app#all')!.node.deps).toEqual(['app#build'])
      // The graph was exported once, and the root project attached (G-55).
      expect(await nxCalls(root)).toBe(1)
      expect(log.lines.some((l) => l.includes('have no workspace package'))).toBe(false)
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
      // Nx forks an executor in the workspace root, and so does nx-exec.
      expect(realpathSync(rec.context.cwd)).toBe(realpathSync(root))
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
    'an edited project.json re-exports the graph, and the new graph is what runs',
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
      await appendFile(path.join(root, 'packages', 'lib', 'project.json'), '\n')
      const plan = await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(await nxCalls(root)).toBe(2)
      expect(plan.tasks.find((t) => t.node.id === 'lib#lint')!.node.config.exec?.command).toBe(
        'echo lint-v2 > lint.log',
      )
    },
    TIMEOUT,
  )

  // Next 26: Nx derives edges from source imports, and freshness read only
  // the manifests' mtimes, so an added `import` kept the old snapshot and an
  // edit to the imported project replayed its dependant. The second edit is
  // the one the status text alone misses: the file is already listed.
  it(
    'a source file under a project root, added or edited again, re-exports (Next 26)',
    async () => {
      await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(await nxCalls(root)).toBe(1)
      const src = path.join(root, 'packages', 'app', 'src', 'index.ts')
      await mkdir(path.dirname(src), { recursive: true })
      await writeFile(src, "import { b } from 'lib'\n")
      await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(await nxCalls(root)).toBe(2)
      await appendFile(src, "import { c } from 'lib/c'\n")
      await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(await nxCalls(root)).toBe(3)
      // Control: nothing moved, no export.
      await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(await nxCalls(root)).toBe(3)
    },
    TIMEOUT,
  )

  // The key's parts, each alone (G-21's sweep): an append moved the key by
  // the file's length, so the content hash went unheld; a same-length edit
  // is the one only the content sees. A commit leaves the status empty
  // before and after, so HEAD alone carries it.
  it(
    'a same-length edit and a new commit on a clean tree each re-export',
    async () => {
      const src = path.join(root, 'packages', 'lib', 'src', 'index.js')
      await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(await nxCalls(root)).toBe(1)
      await writeFile(src, '// bil\n')
      await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(await nxCalls(root)).toBe(2)
      const git = (...args: string[]) => {
        const r = Bun.spawnSync({
          cmd: [
            'git',
            '-c',
            'user.name=t',
            '-c',
            'user.email=t@t',
            '-c',
            'commit.gpgsign=false',
            ...args,
          ],
          cwd: root,
        })
        expect({ args, code: r.exitCode, err: r.stderr.toString() }).toEqual({
          args,
          code: 0,
          err: '',
        })
      }
      git('add', '-A')
      git('commit', '-qm', 'one')
      await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      const afterFirst = await nxCalls(root)
      await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(await nxCalls(root)).toBe(afterFirst)
      git('commit', '-q', '--allow-empty', '-m', 'two')
      await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(await nxCalls(root)).toBe(afterFirst + 1)
    },
    TIMEOUT,
  )

  it(
    'a touch alone, or a stray file at the root, does not re-export',
    async () => {
      await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(await nxCalls(root)).toBe(1)
      const later = new Date(Date.now() + 5_000)
      await utimes(path.join(root, 'packages', 'lib', 'project.json'), later, later)
      await writeFile(path.join(root, 'report.json'), '{}\n')
      await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(await nxCalls(root)).toBe(1)
    },
    TIMEOUT,
  )

  // The root project, unattached, still counted as declaring `prep`, and
  // core refused the run over lib's `^prep` (item 1051).
  it(
    'a `^target` only the unattached root declares is no edge, and the run plans',
    async () => {
      const g = structuredClone(GRAPH) as unknown as {
        graph: { nodes: Record<string, { data: { targets: Record<string, unknown> } }> }
      }
      g.graph.nodes['ws'] = {
        data: { root: '.', targets: { prep: { command: 'echo p' } } },
      } as never
      ;(g.graph.nodes['lib']!.data.targets['lint'] as Record<string, unknown>)['dependsOn'] = [
        '^prep',
      ]
      await writeFile(path.join(root, 'graph.json'), JSON.stringify(g))
      await workspace("nx({ graph: 'graph.json' })")
      const plan = await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(plan.tasks.map((t) => t.node.id)).toEqual(['lib#lint'])
    },
    TIMEOUT,
  )

  // An integrated Nx repo keeps projects out of the package manager's list:
  // analogjs's `project.json` libraries attached 1 of 21 `build` tasks until
  // nx() named each graph node's root through `discover` (G-55).
  const withRoot = () => {
    const g = structuredClone(GRAPH) as unknown as {
      graph: {
        nodes: Record<string, { data: { targets: Record<string, unknown> } }>
        dependencies: Record<string, unknown[]>
      }
    }
    g.graph.nodes['ws'] = {
      data: { root: '.', targets: { prep: { command: 'echo p' } } },
    } as never
    g.graph.nodes['tool'] = {
      data: { root: 'libs/tool', targets: { gen: { command: 'echo g > gen.txt' } } },
    } as never
    g.graph.dependencies['tool'] = []
    ;(g.graph.nodes['lib']!.data.targets['lint'] as Record<string, unknown>)['dependsOn'] = [
      { projects: ['ws'], target: 'prep' },
      { projects: ['tool'], target: 'gen' },
    ]
    return g
  }

  it(
    'a project no glob lists attaches with no vx.config: the root and a project.json-only library',
    async () => {
      await mkdir(path.join(root, 'libs', 'tool'), { recursive: true })
      await writeFile(path.join(root, 'libs', 'tool', 'project.json'), '{ "name": "tool" }')
      await writeFile(path.join(root, 'graph.json'), JSON.stringify(withRoot()))
      await workspace("nx({ graph: 'graph.json' })")
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['lint'], log })
      expect(plan.tasks.map((t) => t.node.id).sort()).toEqual(['lib#lint', 'tool#gen', 'ws#prep'])
      expect(log.lines.join('\n')).not.toContain('have no workspace package')
      const result = await run({
        cwd: root,
        tasks: ['tool#gen'],
        log: silent(),
        handleSignals: false,
      })
      expect(result.ok).toBe(true)
      // A `command` target runs from the workspace root, as under Nx.
      expect(await Bun.file(path.join(root, 'gen.txt')).text()).toBe('g\n')
    },
    TIMEOUT,
  )

  // A root package.json named after a member: the synthesized root project
  // took the member's name, and its tasks replaced the member's.
  it(
    "a root package named like a member leaves the member's tasks alone",
    async () => {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'lib', private: true }),
      )
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['lint'], log })
      expect(plan.tasks.map((t) => t.node.id)).toEqual(['lib#lint'])
      expect(plan.tasks[0]!.node.config.exec?.command).toBe('echo lint-ran > lint.log')
      expect(log.lines.join('\n')).toContain('Nx project(s) ws have no workspace package')
    },
    TIMEOUT,
  )

  // The mapper reads the root manifest: `eslint` there is keyed already.
  it(
    'an externalDependencies input the root package.json declares is no todo',
    async () => {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'ws', private: true, devDependencies: { eslint: '9' } }),
      )
      const g = structuredClone(GRAPH) as unknown as {
        graph: { nodes: Record<string, { data: { targets: Record<string, unknown> } }> }
      }
      ;(g.graph.nodes['lib']!.data.targets['build'] as Record<string, unknown>)['inputs'] = [
        '{projectRoot}/src/**/*',
        { externalDependencies: ['eslint'] },
      ]
      await writeFile(path.join(root, 'graph.json'), JSON.stringify(g))
      await workspace("nx({ graph: 'graph.json' })")
      const log = silent()
      await planRun({ cwd: root, tasks: ['lib#build'], log })
      expect(log.lines.filter((l) => l.includes('externalDependencies'))).toEqual([])
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
      await appendFile(path.join(root, 'nx.json'), '\n')
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

  describe('nx:run-commands runs as Nx runs it', () => {
    /** Adds targets to `lib` in the graph the fake `nx` exports. */
    async function libTargets(targets: Record<string, unknown>): Promise<void> {
      const g = structuredClone(GRAPH) as unknown as {
        graph: { nodes: Record<string, { data: { targets: Record<string, unknown> } }> }
      }
      Object.assign(g.graph.nodes['lib']!.data.targets, targets)
      await writeFile(path.join(root, 'graph.json'), JSON.stringify(g))
    }
    const libFile = (name: string) => Bun.file(path.join(root, 'packages', 'lib', name))

    it(
      '`commands` run in parallel: a failing check fails the task while the server beside it is up, and TERMs it (nx#28477)',
      async () => {
        // Bounded, so the run in order the old line made ends — late, with no
        // TERM ever sent. Its trap is slow and it lets go of the task's
        // stdout, so only the line's own wait keeps the task until the
        // trap is done, as Nx keeps it.
        const server =
          'exec >/dev/null 2>&1; trap "sleep 0.2; echo terminated > term.txt; exit 143" TERM; : > up; i=0; while [ $i -lt 200 ]; do i=$((i+1)); sleep 0.05; done'
        const check = 'while [ ! -f up ]; do sleep 0.01; done; echo check-failed; exit 3'
        await libTargets({
          par: {
            executor: 'nx:run-commands',
            options: { commands: [server, check], cwd: 'packages/lib' },
          },
        })
        const r = await run({ cwd: root, tasks: ['par'], log: silent(), handleSignals: false })
        expect(status(r, 'lib#par')).toBe('failed')
        expect((await libFile('term.txt').text()).trim()).toBe('terminated')
      },
      TIMEOUT,
    )

    it(
      '`commands: []` is a no-op that succeeds (nx#31345)',
      async () => {
        await libTargets({ empty: { executor: 'nx:run-commands', options: { commands: [] } } })
        const log = silent()
        const r = await run({ cwd: root, tasks: ['empty'], log, handleSignals: false })
        expect(status(r, 'lib#empty')).toBe('success')
        expect(log.lines.filter((l) => l.includes('lib#empty'))).toEqual([])
      },
      TIMEOUT,
    )

    it(
      'arguments after `vx run … --` reach every command, and an executor target’s options (nx#12165)',
      async () => {
        await libTargets({
          rcpub: {
            executor: 'nx:run-commands',
            options: {
              commands: ['echo one > one.txt', 'echo two > two.txt'],
              cwd: 'packages/lib',
            },
          },
          publish: { executor: '@acme/publish:run', options: { registry: 'x' } },
        })
        const opts = {
          cwd: root,
          tasks: ['rcpub', 'publish'],
          log: silent(),
          handleSignals: false,
          forwardArgs: ['--otp=123'],
        }
        const r = await run(opts)
        expect([status(r, 'lib#rcpub'), status(r, 'lib#publish')]).toEqual(['success', 'success'])
        expect([
          (await libFile('one.txt').text()).trim(),
          (await libFile('two.txt').text()).trim(),
        ]).toEqual(['one --otp=123', 'two --otp=123'])
        const rec = (await Bun.file(path.join(root, 'record.json')).json()) as {
          overrides: Record<string, unknown>
          target: { options: Record<string, unknown> }
        }
        // Nx's own parse of the arguments (`createOverrides`), handed to runExecutor.
        expect(rec.overrides).toEqual({ otp: 123 })
        expect(rec.target.options).toEqual({ registry: 'x' })
      },
      TIMEOUT,
    )

    it(
      'a run-commands `env` reaches the command and the key (nx#20465)',
      async () => {
        const withenv = (value: string) => ({
          withenv: {
            executor: 'nx:run-commands',
            options: {
              command: 'mkdir -p out && echo "$OUTPUT_PATH" > out/env.txt',
              cwd: 'packages/lib',
              env: { OUTPUT_PATH: value },
            },
            inputs: ['{projectRoot}/src/**/*'],
            outputs: ['{projectRoot}/out'],
            cache: true,
          },
        })
        await libTargets(withenv('abc'))
        const opts = { cwd: root, tasks: ['withenv'], log: silent(), handleSignals: false }
        expect(status(await run(opts), 'lib#withenv')).toBe('success')
        expect((await libFile('out/env.txt').text()).trim()).toBe('abc')
        expect(status(await run(opts), 'lib#withenv')).toBe('cache-hit')
        await libTargets(withenv('xyz'))
        await appendFile(path.join(root, 'packages', 'lib', 'project.json'), '\n')
        expect(status(await run(opts), 'lib#withenv')).toBe('success')
        expect((await libFile('out/env.txt').text()).trim()).toBe('xyz')
      },
      TIMEOUT,
    )

    it(
      '`readyWhen` makes the target persistent: its dependent runs once the line is printed',
      async () => {
        await libTargets({
          up: {
            executor: 'nx:run-commands',
            options: { command: 'echo "server ready"; exec sleep 60', readyWhen: 'server ready' },
          },
          after: {
            executor: 'nx:run-commands',
            options: { command: 'echo after > after.txt', cwd: 'packages/lib' },
            dependsOn: ['up'],
          },
        })
        const plan = await planRun({ cwd: root, tasks: ['after'], log: silent() })
        expect(
          plan.tasks.find((t) => t.node.id === 'lib#up')!.node.config.exec?.persistent,
        ).toEqual({
          readyWhen: 'server ready',
        })
        const r = await run({ cwd: root, tasks: ['after'], log: silent(), handleSignals: false })
        expect(status(r, 'lib#after')).toBe('success')
        expect((await libFile('after.txt').text()).trim()).toBe('after')
      },
      TIMEOUT,
    )
  })

  describe('the `.env` files Nx gives a task', () => {
    async function libTargets(targets: Record<string, unknown>): Promise<void> {
      const g = structuredClone(GRAPH) as unknown as {
        graph: { nodes: Record<string, { data: { targets: Record<string, unknown> } }> }
      }
      Object.assign(g.graph.nodes['lib']!.data.targets, targets)
      await writeFile(path.join(root, 'graph.json'), JSON.stringify(g))
    }
    const lib = (f: string) => path.join(root, 'packages', 'lib', f)
    const showenv = {
      showenv: {
        executor: 'nx:run-commands',
        options: {
          command: 'mkdir -p out && printf "%s|%s|%s" "$A" "$B" "$C" > out/env.txt',
          cwd: 'packages/lib',
        },
        inputs: ['{projectRoot}/src/**/*'],
        outputs: ['{projectRoot}/out'],
        cache: true,
      },
    }

    it(
      'load in Nx’s order, and a gitignored one is still in the key',
      async () => {
        await writeFile(path.join(root, '.env'), 'A=root\nB=root\nC=root\n')
        await writeFile(path.join(root, '.env.local'), 'C=local\n')
        await writeFile(lib('.env'), 'A=project\n')
        await writeFile(lib('.env.showenv'), 'B=target\n')
        await writeFile(path.join(root, '.gitignore'), 'dist\nnode_modules\n.vx\n.nx\n.env.local\n')
        Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
        await libTargets(showenv)
        const plan = await planRun({ cwd: root, tasks: ['showenv'], log: silent() })
        const config = plan.tasks.find((t) => t.node.id === 'lib#showenv')!.node.config
        expect(config.exec?.command).toBe(
          'nx-env --dotenv .env.showenv --dotenv .env --dotenv ../../.env.local --dotenv ../../.env -- ' +
            `'mkdir -p out && printf "%s|%s|%s" "$A" "$B" "$C" > out/env.txt'`,
        )
        expect(config.cache?.inputs.runtime).toEqual([
          'for f in .env.showenv .env ../../.env.local ../../.env; do echo "$f"; cat -- "$f" 2>/dev/null; echo; done',
        ])
        const opts = { cwd: root, tasks: ['showenv'], log: silent(), handleSignals: false }
        expect(status(await run(opts), 'lib#showenv')).toBe('success')
        expect(await Bun.file(lib('out/env.txt')).text()).toBe('project|target|local')
        expect(status(await run(opts), 'lib#showenv')).toBe('cache-hit')
        await writeFile(path.join(root, '.env.local'), 'C=local2\n')
        expect(status(await run(opts), 'lib#showenv')).toBe('success')
        expect(await Bun.file(lib('out/env.txt')).text()).toBe('project|target|local2')
      },
      TIMEOUT,
    )

    // Not a `.env` file, but the same blind spot: Nx 23's `includeIgnored`
    // hashes a gitignored path from disk, which a vx glob never sees.
    // Mapped as a glob, the task failed before it ran.
    it(
      'an includeIgnored input re-keys the task when the ignored file changes',
      async () => {
        await writeFile(lib('gen.json'), '1')
        await writeFile(path.join(root, '.gitignore'), 'dist\nnode_modules\n.vx\n.nx\ngen.json\n')
        Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
        await libTargets({
          gen: {
            executor: 'nx:run-commands',
            options: { command: 'cp gen.json out.txt', cwd: 'packages/lib' },
            inputs: [{ fileset: '{projectRoot}/gen.json', includeIgnored: true }],
            outputs: ['{projectRoot}/out.txt'],
            cache: true,
          },
        })
        const opts = { cwd: root, tasks: ['gen'], log: silent(), handleSignals: false }
        expect(status(await run(opts), 'lib#gen')).toBe('success')
        expect(status(await run(opts), 'lib#gen')).toBe('cache-hit')
        await writeFile(lib('gen.json'), '2')
        expect(status(await run(opts), 'lib#gen')).toBe('success')
        expect(await Bun.file(lib('out.txt')).text()).toBe('2')
      },
      TIMEOUT,
    )

    // Nx's `getNxEnvVariablesForTask`: `nx exec -- <cmd>` in a package
    // script reads NX_TASK_TARGET_PROJECT, and unset, it booted Nx's task
    // runner and ran the target and its dependencies again.
    it(
      'a task sees the target Nx would hand it, a run-commands env winning',
      async () => {
        await libTargets({
          tgt: {
            executor: 'nx:run-commands',
            options: {
              command:
                'printf "%s|%s|%s" "$NX_TASK_TARGET_PROJECT" "$NX_TASK_TARGET_TARGET" "$NX_TASK_TARGET_CONFIGURATION" > tgt.txt',
              cwd: 'packages/lib',
            },
            configurations: { ci: { env: { NX_TASK_TARGET_TARGET: 'mine' } } },
          },
        })
        const opts = { cwd: root, log: silent(), handleSignals: false }
        expect(status(await run({ ...opts, tasks: ['tgt'] }), 'lib#tgt')).toBe('success')
        expect(await Bun.file(lib('tgt.txt')).text()).toBe('lib|tgt|')
        expect(status(await run({ ...opts, tasks: ['tgt:ci'] }), 'lib#tgt:ci')).toBe('success')
        expect(await Bun.file(lib('tgt.txt')).text()).toBe('lib|mine|ci')
      },
      TIMEOUT,
    )
    // nx-examples' cypress shape: the metadata sits on `e2e-ci`, and Nx's
    // `getOwnerTargetForTask` loads `.env.e2e-ci` and `.env.e2e` for every
    // member of its group. The atomized task loaded only `.env.e2e`.
    it('an atomized target loads its group owner’s files', async () => {
      await writeFile(lib('.env.e2e-ci'), 'A=ci\n')
      await writeFile(lib('.env.e2e'), 'A=e2e\n')
      await writeFile(lib('.env.e2e-ci--a'), 'A=own\n')
      const g = structuredClone(GRAPH) as unknown as {
        graph: {
          nodes: Record<string, { data: { targets: Record<string, unknown>; metadata?: unknown } }>
        }
      }
      const data = g.graph.nodes['lib']!.data
      Object.assign(data.targets, {
        e2e: { executor: 'nx:run-commands', options: { command: 'echo e2e' } },
        'e2e-ci--a': { executor: 'nx:run-commands', options: { command: 'echo a' } },
        'e2e-ci': {
          executor: 'nx:noop',
          dependsOn: ['e2e-ci--a'],
          metadata: { nonAtomizedTarget: 'e2e' },
        },
      })
      data.metadata = { targetGroups: { 'E2E (CI)': ['e2e-ci--a', 'e2e-ci'] } }
      await writeFile(path.join(root, 'graph.json'), JSON.stringify(g))
      const plan = await planRun({ cwd: root, tasks: ['e2e-ci--a'], log: silent() })
      expect(plan.tasks.find((t) => t.node.id === 'lib#e2e-ci--a')!.node.config.exec?.command).toBe(
        "nx-env --dotenv .env.e2e-ci --dotenv .env.e2e -- 'cd ../.. && echo a'",
      )
    })

    it(
      'a run-commands `envFile` is loaded under them (nx#23581)',
      async () => {
        await writeFile(lib('.env.custom'), 'MSG=from-envfile\n')
        await libTargets({
          withenvfile: {
            executor: 'nx:run-commands',
            options: {
              command: 'echo "MSG=[$MSG]" > msg.txt',
              cwd: 'packages/lib',
              envFile: 'packages/lib/.env.custom',
            },
          },
        })
        const log = silent()
        const r = await run({ cwd: root, tasks: ['withenvfile'], log, handleSignals: false })
        expect(status(r, 'lib#withenvfile')).toBe('success')
        expect((await Bun.file(lib('msg.txt')).text()).trim()).toBe('MSG=[from-envfile]')
        expect(log.lines.filter((l) => l.includes('envFile'))).toEqual([])
      },
      TIMEOUT,
    )

    it(
      'reach an executor through nx-exec',
      async () => {
        await writeFile(lib('.env'), 'FROM_DOTENV=yes\n')
        const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
        expect(plan.tasks.find((t) => t.node.id === 'lib#build')!.node.config.exec?.command).toBe(
          `nx-exec @acme/compile:run --project lib --target build --options '{"writeFile":"dist/lib.js","content":"lib v1","cwd":"{projectRoot}"}' --dotenv .env`,
        )
        // lib's alone: record.json is the last executor's.
        const r = await run({
          cwd: root,
          tasks: ['lib#build'],
          log: silent(),
          handleSignals: false,
        })
        expect(r.outcomes.map((o) => [o.node.id, o.status])).toEqual([['lib#build', 'success']])
        const rec = (await Bun.file(path.join(root, 'record.json')).json()) as {
          env: Record<string, unknown>
        }
        expect(rec.env['FROM_DOTENV']).toBe('yes')
      },
      TIMEOUT,
    )

    it(
      'none under NX_LOAD_DOT_ENV_FILES=false, as Nx loads none',
      async () => {
        await writeFile(lib('.env'), 'A=project\n')
        await libTargets(showenv)
        const before = process.env['NX_LOAD_DOT_ENV_FILES']
        process.env['NX_LOAD_DOT_ENV_FILES'] = 'false'
        try {
          const plan = await planRun({ cwd: root, tasks: ['showenv'], log: silent() })
          const config = plan.tasks.find((t) => t.node.id === 'lib#showenv')!.node.config
          expect(config.exec?.command).toBe(
            'mkdir -p out && printf "%s|%s|%s" "$A" "$B" "$C" > out/env.txt',
          )
          expect(config.cache?.inputs.runtime).toBeUndefined()
        } finally {
          if (before === undefined) delete process.env['NX_LOAD_DOT_ENV_FILES']
          else process.env['NX_LOAD_DOT_ENV_FILES'] = before
        }
      },
      TIMEOUT,
    )
  })

  it(
    'without nx in node_modules the run warns once that nx-exec and nx-env need it',
    async () => {
      const line = 'nx-exec and nx-env load Nx from the workspace, and node_modules/nx is not there'
      const quiet = silent()
      await planRun({ cwd: root, tasks: ['build'], log: quiet })
      expect(quiet.lines.filter((l) => l.includes(line))).toEqual([])
      await rm(path.join(root, 'node_modules', 'nx'), { recursive: true })
      await workspace("nx({ graph: 'graph.json' })")
      const log = silent()
      await planRun({ cwd: root, tasks: ['build'], log })
      expect(log.lines.filter((l) => l.includes(line)).length).toBe(1)
    },
    TIMEOUT,
  )

  it(
    'a server executor is a persistent task with no readiness note, as Nx gates none',
    async () => {
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['serve'], log })
      const serve = plan.tasks.find((t) => t.node.id === 'lib#serve')!.node
      expect(serve.config.exec?.persistent).toEqual({})
      expect(serve.config.exec?.command).toBe(
        `nx-exec @nx/vite:dev-server --project lib --target serve --options '{"port":4200}'`,
      )
      expect(log.lines.filter((l) => l.includes('continuous target'))).toEqual([])
    },
    TIMEOUT,
  )
})

// Item 816's sweep of nx/index.ts: each row fails with one line undone.
describe('nx.json is a claimed root file (item 961)', () => {
  it('nx() claims nx.json at the root and cannot tell which tasks an edit moved', () => {
    const claim = nx().fingerprint!
    expect([...claim.files]).toEqual(['nx.json'])
    expect(claim.affected({ file: 'nx.json', before: null, after: null }, {} as never)).toBe(
      undefined,
    )
    expect(nx({ root: '/elsewhere' }).fingerprint).toBeUndefined()
  })
})

describe('nx(): what the sweep found unheld', () => {
  it(
    'nx.json `sync.globalGenerators` is said once per run',
    async () => {
      await writeFile(
        path.join(root, 'nx.json'),
        JSON.stringify({ namedInputs: {}, sync: { globalGenerators: ['@acme/tools:sync-env'] } }),
      )
      const log = silent()
      await planRun({ cwd: root, tasks: ['lint'], log })
      expect(log.lines.filter((l) => l.includes('sync.globalGenerators'))).toHaveLength(1)
    },
    TIMEOUT,
  )

  const graphWith = (edit: (g: typeof GRAPH) => void) => {
    const g = structuredClone(GRAPH)
    edit(g)
    return JSON.stringify(g)
  }

  it(
    '`root` names where nx.json and the graph live',
    async () => {
      // Nx's workspace is packages/: its node roots are relative to it.
      const g = graphWith((x) => {
        x.graph.nodes.lib.data.root = 'lib'
        x.graph.nodes.app.data.root = 'app'
        x.graph.nodes.lib.data.targets.lint.options = { command: 'echo from-sub', cwd: 'lib' }
      })
      await writeFile(path.join(root, 'packages', 'graph-sub.json'), g)
      await workspace(
        `nx({ root: ${JSON.stringify(path.join(root, 'packages'))}, graph: 'graph-sub.json' })`,
      )
      const plan = await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(plan.tasks.find((t) => t.node.id === 'lib#lint')!.node.config.exec?.command).toBe(
        'echo from-sub',
      )
    },
    TIMEOUT,
  )

  it(
    'an implicit dep no package declares is an edge, not a note',
    async () => {
      await writeFile(
        path.join(root, 'graph.json'),
        graphWith((x) => {
          ;(x.graph.dependencies.lib as unknown[]).push({
            source: 'lib',
            target: 'app',
            type: 'implicit',
          })
          ;(x.graph.nodes.lib.data.targets.lint as { dependsOn?: string[] }).dependsOn = ['^build']
        }),
      )
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['lint'], log })
      expect(log.lines.filter((l) => l.includes('implicit'))).toEqual([])
      expect(plan.tasks.find((t) => t.node.id === 'lib#lint')!.node.config.dependsOn).toEqual([
        '^build',
        'app#build',
      ])
    },
    TIMEOUT,
  )

  it(
    'a root project’s gaps are not reported: its note already says it does not run',
    async () => {
      await writeFile(
        path.join(root, 'graph.json'),
        graphWith((x) => {
          // Unattached: a directory the tree no longer has is named by no one.
          ;(x.graph.nodes.ws.data as Record<string, unknown>)['root'] = 'gone'
          ;(x.graph.nodes.ws.data.targets as Record<string, unknown>)['ci-all'] = {
            executor: 'nx:run-commands',
            options: { command: 'true', streamOutput: false },
          }
        }),
      )
      const log = silent()
      await planRun({ cwd: root, tasks: ['lint'], log })
      expect(log.lines.filter((l) => l.includes('streamOutput'))).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'with no executor or .env line, neither missing bin nor a missing nx is reported',
    async () => {
      // `echo nx-exec` names the bin but does not start with it.
      await writeFile(
        path.join(root, 'graph.json'),
        JSON.stringify({
          graph: {
            nodes: {
              lib: {
                name: 'lib',
                data: {
                  root: 'packages/lib',
                  targets: { lint: { command: 'echo nx-exec', cwd: 'packages/lib' } },
                },
              },
            },
            dependencies: {},
          },
        }),
      )
      await rm(path.join(root, 'node_modules', '.bin', 'nx-exec'))
      await rm(path.join(root, 'node_modules', '.bin', 'nx-env'))
      await rm(path.join(root, 'node_modules', 'nx'), { recursive: true })
      await workspace("nx({ graph: 'graph.json' })")
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['lint'], log })
      expect(plan.tasks.map((t) => t.node.id)).toEqual(['lib#lint'])
      expect(log.lines.filter((l) => /node_modules/.test(l))).toEqual([])
    },
    TIMEOUT,
  )

  for (const [what, rel] of [
    ['the root package.json', 'package.json'],
    ['a package’s package.json', 'packages/lib/package.json'],
  ] as const) {
    it(
      `${what} edited re-exports`,
      async () => {
        await planRun({ cwd: root, tasks: ['lint'], log: silent() })
        expect(await nxCalls(root)).toBe(1)
        await appendFile(path.join(root, rel), '\n')
        await planRun({ cwd: root, tasks: ['lint'], log: silent() })
        expect(await nxCalls(root)).toBe(2)
      },
      TIMEOUT,
    )
  }

  // A base nx.json extends is part of what Nx reads, and its edit went
  // unseen by the snapshot's freshness (item 1050).
  it(
    'a base nx.json extends, edited, re-exports',
    async () => {
      await writeFile(path.join(root, 'nx.base.json'), JSON.stringify({ namedInputs: {} }))
      await writeFile(path.join(root, 'nx.json'), JSON.stringify({ extends: './nx.base.json' }))
      await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(await nxCalls(root)).toBe(1)
      await appendFile(path.join(root, 'nx.base.json'), '\n')
      await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(await nxCalls(root)).toBe(2)
    },
    TIMEOUT,
  )

  it(
    'an export that exits 0 and writes nothing is a failure; a failure names its last three lines',
    async () => {
      const bin = path.join(root, 'node_modules', '.bin', 'nx')
      await writeFile(bin, '#!/bin/sh\nexit 0\n')
      await expect(planRun({ cwd: root, tasks: ['lint'], log: silent() })).rejects.toThrow(
        '[@vzn/vx-migrate] nx(): nx graph --file exited 0',
      )
      await writeFile(bin, '#!/bin/sh\nprintf "one\\ntwo\\nthree\\nfour\\n" >&2\nexit 7\n')
      await expect(planRun({ cwd: root, tasks: ['lint'], log: silent() })).rejects.toThrow(
        '[@vzn/vx-migrate] nx(): nx graph --file exited 7: two three four',
      )
    },
    TIMEOUT,
  )

  it(
    'a target the mapper skips is left out, not declared null',
    async () => {
      await writeFile(
        path.join(root, 'graph.json'),
        graphWith((x) => {
          ;(x.graph.nodes.lib.data.targets as Record<string, unknown>)['idle'] = {
            executor: 'nx:noop',
          }
        }),
      )
      const plan = await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(plan.tasks.map((t) => t.node.id)).toEqual(['lib#lint'])
    },
    TIMEOUT,
  )
})

// The mapping is kept under the cache dir, keyed on everything it reads
// (G-10, `mapping-cache.ts`). A hit serves the kept mapping; each input edit maps afresh. The
// kept file is tampered with between runs, so a row sees which one ran.
describe('nx(): the mapping cache', () => {
  const lint = async (): Promise<string | undefined> =>
    (await planRun({ cwd: root, tasks: ['lint'], log: silent() })).tasks.find(
      (t) => t.node.id === 'lib#lint',
    )!.node.config.exec?.command
  const tamper = (): Promise<void> => tamperMapping(root, 'nx')
  beforeEach(async () => {
    await workspace("nx({ graph: 'graph.json' })")
  })
  afterEach(() => {
    delete process.env['NX_LOAD_DOT_ENV_FILES']
  })

  it(
    'a second run serves the kept mapping',
    async () => {
      const first = await lint()
      expect(first).toBe('echo lint-ran > lint.log')
      await tamper()
      expect(await lint()).toBe('echo from-cache')
    },
    TIMEOUT,
  )

  it.each([
    [
      'the graph',
      () =>
        writeFile(
          path.join(root, 'graph.json'),
          JSON.stringify(GRAPH).replace('echo lint-ran', 'echo lint-v2'),
        ),
      'echo lint-v2 > lint.log',
    ],
    [
      'nx.json',
      () => writeFile(path.join(root, 'nx.json'), JSON.stringify({ namedInputs: { x: [] } })),
      'echo lint-ran > lint.log',
    ],
    [
      'a package manifest',
      () =>
        writeFile(
          path.join(root, 'packages', 'lib', 'package.json'),
          JSON.stringify({ name: 'lib', version: '1.0.1' }),
        ),
      'echo lint-ran > lint.log',
    ],
    [
      'the manifest of a node no package matches',
      () =>
        writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws2', private: true })),
      'echo lint-ran > lint.log',
    ],
    [
      'the installed bins',
      () => rm(path.join(root, 'node_modules', '.bin', 'nx-env')),
      'echo lint-ran > lint.log',
    ],
    [
      'a `.env` file in a project dir',
      () => writeFile(path.join(root, 'packages', 'lib', '.env'), 'A=1\n'),
      "nx-env --dotenv .env -- 'echo lint-ran > lint.log'",
    ],
  ])(
    'an edit to %s maps afresh',
    async (_what, edit, expected) => {
      await lint()
      await tamper()
      await edit()
      expect(await lint()).toBe(expected)
    },
    TIMEOUT,
  )

  // The mapper reads named inputs from nx.json's whole `extends` chain; the
  // key read only nx.json, so a base's edit replayed the old inputs.
  it(
    'an edit to the nx.json base maps afresh',
    async () => {
      await writeFile(
        path.join(root, 'base.json'),
        JSON.stringify({ namedInputs: { src: ['{projectRoot}/src/**/*'] } }),
      )
      await writeFile(path.join(root, 'nx.json'), JSON.stringify({ extends: './base.json' }))
      const g = structuredClone(GRAPH)
      g.graph.nodes.lib.data.targets.build.inputs = ['src']
      await writeFile(path.join(root, 'graph.json'), JSON.stringify(g))
      const inputs = async () =>
        (await planRun({ cwd: root, tasks: ['lib#build'], log: silent() })).tasks.find(
          (t) => t.node.id === 'lib#build',
        )!.node.config.cache?.inputs.files
      expect(await inputs()).toEqual(['src/**/*'])
      await writeFile(
        path.join(root, 'base.json'),
        JSON.stringify({ namedInputs: { src: ['{projectRoot}/lib/**/*'] } }),
      )
      expect(await inputs()).toEqual(['lib/**/*'])
    },
    TIMEOUT,
  )

  it(
    'NX_LOAD_DOT_ENV_FILES maps afresh',
    async () => {
      await writeFile(path.join(root, 'packages', 'lib', '.env'), 'A=1\n')
      await lint()
      await tamper()
      process.env['NX_LOAD_DOT_ENV_FILES'] = 'false'
      expect(await lint()).toBe('echo lint-ran > lint.log')
    },
    TIMEOUT,
  )
})

// A standalone Nx repo: the workspace root is the one project, so every
// file under it is the project's. Nx's own graph cache counted as one, and
// every run exported the graph again. Also G-21's unheld root arms: a root
// project's sources move the key, vx's snapshot under it does not.
describe('nx(): a workspace whose root is the project', () => {
  let solo: string
  const graph = {
    graph: {
      nodes: {
        solo: {
          name: 'solo',
          type: 'app',
          data: {
            root: '.',
            targets: {
              lint: { executor: 'nx:run-commands', options: { command: 'echo lint' } },
            },
          },
        },
      },
      dependencies: { solo: [] },
    },
  }
  beforeEach(async () => {
    solo = await mkdtemp(path.join(tmpdir(), 'vx-nx-solo-'))
    await writeFile(
      path.join(solo, 'package.json'),
      JSON.stringify({ name: 'solo', private: true }),
    )
    await writeFile(path.join(solo, 'nx.json'), JSON.stringify({ namedInputs: {} }))
    // The fake's call counter is the one file ignored: `.vx` and `.nx` are
    // not, so the row sees whether vx's snapshot or Nx's own graph cache
    // (the fake writes `.nx/workspace-data`, as Nx does) moves the key.
    await writeFile(path.join(solo, '.gitignore'), 'node_modules\nnx-calls\n')
    await writeFile(path.join(solo, 'graph.json'), JSON.stringify(graph))
    await mkdir(path.join(solo, 'src'), { recursive: true })
    await writeFile(path.join(solo, 'src', 'main.js'), '// v1\n')
    await fakeNx(solo)
    await fakeNxCli(solo)
    await Bun.write(
      path.join(solo, 'vx.workspace.mjs'),
      localWorkspaceSource(['nx()'], `import { nx } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
    )
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: solo })
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: solo })
  })
  afterEach(async () => {
    await rm(solo, { recursive: true, force: true })
  })

  it(
    'its own source edit re-exports; the caches vx and Nx write under it do not',
    async () => {
      const plan = await planRun({ cwd: solo, tasks: ['lint'], log: silent() })
      expect(plan.tasks.map((t) => t.node.id)).toEqual(['solo#lint'])
      expect(await nxCalls(solo)).toBe(1)
      await planRun({ cwd: solo, tasks: ['lint'], log: silent() })
      expect(await nxCalls(solo)).toBe(1)
      await writeFile(path.join(solo, 'src', 'main.js'), '// v2\n')
      await planRun({ cwd: solo, tasks: ['lint'], log: silent() })
      expect(await nxCalls(solo)).toBe(2)
    },
    TIMEOUT,
  )
})

describe('nx(): the graph snapshot, keyed and not', () => {
  const plan = (log = silent()) => planRun({ cwd: root, tasks: ['lint'], log })

  it(
    'a failed export’s note leaves with the next export that succeeds',
    async () => {
      await plan()
      const bin = path.join(root, 'node_modules', '.bin', 'nx')
      const good = await Bun.file(bin).text()
      await writeFile(bin, '#!/bin/sh\necho boom >&2\nexit 7\n')
      await appendFile(path.join(root, 'nx.json'), '\n')
      const failed = silent()
      await plan(failed)
      expect(failed.lines.some((l) => l.includes('running on the previous graph'))).toBe(true)
      // Same graph, same nx.json: only the note tells the kept mapping apart.
      await writeFile(bin, good)
      const healed = silent()
      await plan(healed)
      expect(await nxCalls(root)).toBe(2)
      expect(healed.lines.filter((l) => l.includes('running on the previous graph'))).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'a snapshot gone under a key still on disk is exported again',
    async () => {
      await plan()
      const snaps = [...new Bun.Glob('**/nx-project-graph.json').scanSync({ cwd: root, dot: true })]
      expect(snaps).toHaveLength(1)
      await rm(path.join(root, snaps[0]!))
      expect((await plan()).tasks.map((t) => t.node.id)).toEqual(['lib#lint'])
      expect(await nxCalls(root)).toBe(2)
    },
    TIMEOUT,
  )

  // A `root` outside the git worktree has no key: freshness is the newest
  // mtime among the files the graph is computed from.
  it(
    'outside git, a newer nx.json base, root or project manifest re-exports; nothing newer does not',
    async () => {
      const sub = await mkdtemp(path.join(tmpdir(), 'vx-nx-nogit-'))
      try {
        const rel = (p: string) => path.relative(sub, path.join(root, 'packages', p))
        const g = structuredClone(GRAPH) as { graph: { nodes: Record<string, unknown> } }
        const lib = g.graph.nodes['lib'] as { data: { root: string; targets: { lint: unknown } } }
        lib.data.root = rel('lib')
        lib.data.targets.lint = { command: 'echo lint' }
        ;(g.graph.nodes['app'] as { data: { root: string } }).data.root = rel('app')
        delete g.graph.nodes['ws']
        await writeFile(path.join(sub, 'graph.json'), JSON.stringify(g))
        await writeFile(path.join(sub, 'package.json'), '{"name":"nxroot","private":true}')
        await writeFile(path.join(sub, 'base.json'), '{}')
        await writeFile(
          path.join(sub, 'nx.json'),
          JSON.stringify({ extends: './base.json', namedInputs: {} }),
        )
        await fakeNx(sub)
        await fakeNxCli(sub)
        await workspace(`nx({ root: ${JSON.stringify(sub)} })`)
        await plan()
        let calls = 1
        await plan()
        expect(await nxCalls(sub)).toBe(calls)
        const past = new Date('2020-01-01')
        for (const f of [
          path.join(sub, 'base.json'),
          path.join(sub, 'package.json'),
          path.join(root, 'packages', 'lib', 'project.json'),
          path.join(root, 'packages', 'lib', 'package.json'),
        ]) {
          const later = new Date(Date.now() + 60_000)
          await utimes(f, later, later)
          await plan()
          expect([f, await nxCalls(sub)]).toEqual([f, ++calls])
          await utimes(f, past, past)
        }
      } finally {
        await rm(sub, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

// Every bench arm runs vx from a lock, real Nx repos too: nx()'s tasks are
// no vx.config, so the lock records none and a frozen run maps the graph live.
describe('nx() under vx lock and --frozen', () => {
  const vx = (...args: string[]) => {
    const p = Bun.spawnSync({
      cmd: [
        process.execPath,
        path.resolve(import.meta.dir, '..', '..', 'vx', 'src', 'bin.ts'),
        ...args,
      ],
      cwd: root,
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
    })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }

  it(
    'locks, runs frozen, and hits on the second frozen run',
    async () => {
      expect(vx('lock')).toEqual({
        code: 0,
        out: 'vx lock: locked 0 project configs → vx-lock.json (2 projects have no vx.config; their tasks are never frozen)\n',
        err: '',
      })
      const first = vx('run', 'build', '--all', '--frozen')
      expect({ code: first.code, err: first.err }).toEqual({ code: 0, err: '' })
      expect(await Bun.file(path.join(root, 'packages', 'lib', 'dist', 'lib.js')).text()).toBe(
        'lib v1',
      )
      const second = vx('run', 'build', '--all', '--frozen')
      expect({ code: second.code, err: second.err }).toEqual({ code: 0, err: '' })
      expect(second.out).toContain('2 tasks · all cached')
    },
    TIMEOUT,
  )
})

// nx()'s graph key reads the worktree through core's own `git status`
// (`DiscoverContext.worktreeChanges`): a second whole-tree walk cost refine
// ~96 ms of a 417 ms warm run (G-75). Counted by a git on PATH that logs.
describe('nx(): one git status per run', () => {
  it(
    'an unscoped and a scoped run each walk the worktree once',
    async () => {
      const bin = path.join(root, '.gitbin')
      const log = path.join(root, '.gitbin.log')
      const real = Bun.which('git')!
      await mkdir(bin)
      await writeFile(
        path.join(bin, 'git'),
        `#!/bin/sh\necho "$*" >> '${log}'\nexec '${real}' "$@"\n`,
        { mode: 0o755 },
      )
      await appendFile(path.join(root, '.gitignore'), '.gitbin*\n')
      const statuses = async (...args: string[]) => {
        await rm(log, { force: true })
        const p = Bun.spawnSync({
          cmd: [
            process.execPath,
            path.resolve(import.meta.dir, '..', '..', 'vx', 'src', 'bin.ts'),
            ...args,
          ],
          cwd: root,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            CI: '',
            GITHUB_ACTIONS: '',
            NO_COLOR: '1',
          },
        })
        expect([p.exitCode, p.stderr.toString()]).toEqual([0, expect.any(String)])
        const lines = (await Bun.file(log).text()).split('\n')
        return lines.filter((l) => /(^| )status /.test(l)).length
      }
      expect(await statuses('run', 'lint', '--all', '--dry')).toBe(1)
      expect(await nxCalls(root)).toBe(1)
      expect(await statuses('run', 'lint', '--all', '--dry')).toBe(1)
      expect(await statuses('run', 'lint', '--filter', 'lib', '--dry')).toBe(1)
      // The shared status still moves the key: an edit re-exports.
      await writeFile(path.join(root, 'packages', 'lib', 'src', 'index.js'), '// edited\n')
      expect(await statuses('run', 'lint', '--all', '--dry')).toBe(1)
      expect(await nxCalls(root)).toBe(2)
    },
    TIMEOUT,
  )
})

describe("nx(): an Nx project's tags", () => {
  it(
    "are its vx tags, a blank one dropped and a vx.config's own winning, kept with the mapping",
    async () => {
      await workspace("nx({ graph: 'graph.json' })")
      const graph = structuredClone(GRAPH) as {
        graph: { nodes: Record<string, { data: Record<string, unknown> }> }
      }
      graph.graph.nodes['lib']!.data['tags'] = ['scope:shared', '', 'type:lib']
      graph.graph.nodes['app']!.data['tags'] = ['scope:web']
      await writeFile(path.join(root, 'graph.json'), JSON.stringify(graph))
      await writeFile(
        path.join(root, 'packages', 'app', 'vx.config.mjs'),
        "export default { tags: ['mine'] }\n",
      )
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      const load = async () => {
        const projects = await loadResolvedProjects(root)
        return {
          tags: Object.fromEntries([...projects.values()].map((p) => [p.name, p.config.tags])),
          lint: projects.get('lib')!.config.tasks?.['lint']?.exec?.command,
        }
      }
      const tags = { lib: ['scope:shared', 'type:lib'], app: ['mine'] }
      expect(await load()).toEqual({ tags, lint: 'echo lint-ran > lint.log' })
      await tamperMapping(root, 'nx')
      // Served from the kept mapping (the tampered command), tags intact.
      expect(await load()).toEqual({ tags, lint: 'echo from-cache' })
    },
    TIMEOUT,
  )
})
