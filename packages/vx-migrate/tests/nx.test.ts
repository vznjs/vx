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
    'a ^target no project has is no edge, as under Nx',
    async () => {
      // Nx gives `^prepack` no edges when no project has the target. Passed
      // through, core refuses a `^name` no project declares (nx#32779), so
      // the mapper drops it — both the string and the object form. A
      // pattern matching nothing is legal in both and stays.
      const graph = structuredClone(GRAPH) as {
        graph: { nodes: { app: { data: { targets: Record<string, unknown> } } } }
      }
      graph.graph.nodes.app.data.targets['test'] = {
        executor: 'nx:run-commands',
        options: { command: 'echo test' },
        dependsOn: ['^prepack', '^bui*', '^build', { target: 'typecheck', dependencies: true }],
      }
      await writeFile(path.join(root, 'graph.json'), JSON.stringify(graph))
      const plan = await planRun({ cwd: root, tasks: ['test'], log: silent() })
      expect(plan.tasks.map((t) => t.node.id).sort()).toEqual(['app#test', 'lib#build'])
      const test = plan.tasks.find((t) => t.node.id === 'app#test')!.node
      expect(test.deps).toEqual(['lib#build'])
      expect(test.config.dependsOn).toEqual(['^bui*', '^build'])
    },
    TIMEOUT,
  )

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
        const later = new Date(Date.now() + 5_000)
        await utimes(path.join(root, 'packages', 'lib', 'project.json'), later, later)
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

// Item 816's sweep of nx/index.ts: each row fails with one line undone.
describe('nx(): what the sweep found unheld', () => {
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
    'the mapper’s notes are reported: an implicit dep no package declares',
    async () => {
      await writeFile(
        path.join(root, 'graph.json'),
        graphWith((x) => {
          ;(x.graph.dependencies.lib as unknown[]).push({
            source: 'lib',
            target: 'app',
            type: 'implicit',
          })
        }),
      )
      const log = silent()
      await planRun({ cwd: root, tasks: ['lint'], log })
      expect(log.lines.filter((l) => l.includes('implicit Nx dep'))).toEqual([
        '[@vzn/vx-migrate] 1 implicit Nx dep not representable (lib → app); review dependsOn',
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

  // One file per row: a file dated in the future stays newer than every
  // snapshot after it, so a second touch in the same row proves nothing.
  for (const [what, rel] of [
    ['the root package.json', 'package.json'],
    ['a package’s package.json', 'packages/lib/package.json'],
  ] as const) {
    it(
      `${what} newer than the snapshot re-exports`,
      async () => {
        await planRun({ cwd: root, tasks: ['lint'], log: silent() })
        expect(await nxCalls(root)).toBe(1)
        const later = new Date(Date.now() + 5_000)
        await utimes(path.join(root, rel), later, later)
        await planRun({ cwd: root, tasks: ['lint'], log: silent() })
        expect(await nxCalls(root)).toBe(2)
      },
      TIMEOUT,
    )
  }

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
