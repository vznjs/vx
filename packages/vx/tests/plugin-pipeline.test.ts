// The pipeline stages a plugin can shape before anything runs —
// `config`, `project`, `graph` (docs/design/pipeline-2026-09.md). Each pin
// is a real `run()` / `planRun()` over a workspace file that declares the
// plugin inline, so the loader's validation, the stage hosts and the cache
// key all take part.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { planRun, run, type Logger } from '../src/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const TIMEOUT = 20_000
let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-pipeline-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function pkg(name: string, config: string): Promise<void> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
}

async function workspace(plugins: string[], prelude = ''): Promise<void> {
  await Bun.write(path.join(root, 'vx.workspace.mjs'), localWorkspaceSource(plugins, prelude))
}

function silent(): Logger & { status: string[]; started: string[]; concurrency?: number } {
  const status: string[] = []
  const started: string[] = []
  const log = {
    status,
    started,
    concurrency: undefined as number | undefined,
    runStart(info: { concurrency?: number }) {
      log.concurrency = info.concurrency
    },
    taskStart(node: { id: string }) {
      started.push(node.id)
    },
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
    runStatus() {},
    runEnd() {},
  }
  return Object.assign(log, { status: (line: string) => status.push(line) }) as never
}

const build = "export default { tasks: { build: { exec: { command: 'echo build' } } } }\n"

describe('config stage', () => {
  it(
    'a plugin edits the workspace config before it is used',
    async () => {
      await pkg('a', build)
      await workspace([`{ name: 'org/conc', config(ws) { ws.concurrency = 3 } }`])
      const log = silent()
      const summary = await run({ cwd: root, tasks: ['build'], log, handleSignals: false })
      expect(summary.ok).toBe(true)
      expect(log.concurrency).toBe(3)
    },
    TIMEOUT,
  )
})

describe('project stage', () => {
  it(
    'an injected task runs, and keys exactly like the same task written by hand',
    async () => {
      await pkg('a', build)
      // Inputs are `src/**`, not `**/*`: the config FILE differs between the
      // two arms (one declares the task, one does not), and it must not be
      // an input or the comparison would measure that instead of the hook.
      await mkdir(path.join(root, 'packages', 'a', 'src'), { recursive: true })
      await writeFile(path.join(root, 'packages', 'a', 'src', 'x.js'), 'x')
      await workspace([
        `{
          name: 'org/lint-everywhere',
          project(config, ctx) {
            config.tasks ??= {}
            config.tasks.lint = {
              exec: { command: 'echo lint ' + ctx.name },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
            }
          },
        }`,
      ])
      const injected = await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(injected.tasks.map((t) => t.node.id)).toEqual(['a#lint'])
      const summary = await run({ cwd: root, tasks: ['lint'], log: silent(), handleSignals: false })
      expect(summary.ok).toBe(true)
      expect(summary.outcomes.map((o) => [o.node.id, o.status])).toEqual([['a#lint', 'success']])

      // The same task written into the config by hand — same key.
      await workspace([])
      await pkg(
        'a',
        `export default { tasks: {
          build: { exec: { command: 'echo build' } },
          lint: { exec: { command: 'echo lint a' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } },
        } }\n`,
      )
      const byHand = await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(byHand.tasks[0]!.hash).toBe(injected.tasks[0]!.hash)
    },
    TIMEOUT,
  )

  it(
    'runs in declaration order — the second plugin sees the first one’s edit',
    async () => {
      await pkg('a', build)
      await workspace([
        `{ name: 'org/first', project(config) { config.tasks.build.description = 'first' } }`,
        `{ name: 'org/second', project(config) { config.tasks.build.description += '+second' } }`,
      ])
      const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
      expect(plan.tasks[0]!.node.config.description).toBe('first+second')
    },
    TIMEOUT,
  )

  it(
    'edits do not accumulate across runs in one process (the watch shape)',
    async () => {
      // `vx watch` calls run() repeatedly in one process. The first load of
      // a config hands the hook Bun's module object; a repeat load comes
      // from the eval cache or the worker, both fresh — so an append-style
      // edit must land exactly once per run, never twice on the second.
      await pkg('a', build)
      await workspace([
        `{ name: 'org/suffix', project(config) { config.tasks.build.description = (config.tasks.build.description ?? '') + '+x' } }`,
      ])
      const one = await planRun({ cwd: root, tasks: ['build'], log: silent() })
      const two = await planRun({ cwd: root, tasks: ['build'], log: silent() })
      expect(one.tasks[0]!.node.config.description).toBe('+x')
      expect(two.tasks[0]!.node.config.description).toBe('+x')
    },
    TIMEOUT,
  )

  it(
    'a plugin that produces an invalid task is refused like a user would be',
    async () => {
      await pkg('a', build)
      await workspace([`{ name: 'org/broken', project(config) { config.tasks.build.exec = 5 } }`])
      await expect(planRun({ cwd: root, tasks: ['build'], log: silent() })).rejects.toThrow(
        /after plugins/,
      )
    },
    TIMEOUT,
  )

  it(
    'a throwing hook aborts with the plugin and stage named',
    async () => {
      await pkg('a', build)
      await workspace([`{ name: 'org/boom', project() { throw new Error('nope') } }`])
      await expect(planRun({ cwd: root, tasks: ['build'], log: silent() })).rejects.toThrow(
        /plugin 'org\/boom' failed in project: nope/,
      )
    },
    TIMEOUT,
  )
})

describe('graph stage', () => {
  it(
    'a plugin-added edge orders the run',
    async () => {
      await pkg('a', "export default { tasks: { build: { exec: { command: 'sleep 0.05' } } } }\n")
      await pkg('b', build)
      // Insertion order would run b#build first at concurrency 1 only if it
      // sorted that way; the added edge makes the order a contract.
      await workspace([
        `{ name: 'org/edge', graph(nodes) { nodes.get('b#build').deps.push('a#build') } }`,
      ])
      const log = silent()
      const summary = await run({
        cwd: root,
        tasks: ['build'],
        concurrency: 2,
        log,
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      expect(log.started.indexOf('a#build')).toBeLessThan(log.started.indexOf('b#build'))
      const b = summary.outcomes.find((o) => o.node.id === 'b#build')!
      const a = summary.outcomes.find((o) => o.node.id === 'a#build')!
      expect(b.wallclockStartNs! >= a.wallclockEndNs!).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'an edge to a task outside the graph is refused, naming the plugin',
    async () => {
      await pkg('a', build)
      await workspace([
        `{ name: 'org/dangling', graph(nodes) { nodes.get('a#build').deps.push('zz#nope') } }`,
      ])
      await expect(planRun({ cwd: root, tasks: ['build'], log: silent() })).rejects.toThrow(
        /plugin 'org\/dangling' failed in graph: .*zz#nope/,
      )
    },
    TIMEOUT,
  )

  it(
    'a cycle introduced by a plugin is refused',
    async () => {
      await pkg('a', build)
      await pkg('b', build)
      await workspace([
        `{ name: 'org/loop', graph(nodes) {
          nodes.get('a#build').deps.push('b#build')
          nodes.get('b#build').deps.push('a#build')
        } }`,
      ])
      await expect(planRun({ cwd: root, tasks: ['build'], log: silent() })).rejects.toThrow(
        /plugin 'org\/loop' failed in graph: Cycle detected/,
      )
    },
    TIMEOUT,
  )

  it(
    'sees which tasks the user asked for',
    async () => {
      await pkg(
        'a',
        "export default { tasks: { build: { exec: { command: 'echo b' } }, test: { dependsOn: ['build'], exec: { command: 'echo t' } } } }\n",
      )
      await workspace(
        [
          `{ name: 'org/see', graph(nodes, ctx) { globalThis.__vxRequested = [...ctx.requested] } }`,
        ],
        'globalThis.__vxRequested = null\n',
      )
      await planRun({ cwd: root, tasks: ['test'], log: silent() })
      expect((globalThis as unknown as { __vxRequested: string[] }).__vxRequested).toEqual([
        'a#test',
      ])
    },
    TIMEOUT,
  )
})

describe('key stage', () => {
  it(
    'plugin material moves the key, is stable across runs, and is named in the components',
    async () => {
      await pkg(
        'a',
        "export default { tasks: { build: { exec: { command: 'echo b' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } } } }\n",
      )
      await mkdir(path.join(root, 'packages', 'a', 'src'), { recursive: true })
      await writeFile(path.join(root, 'packages', 'a', 'src', 'x.js'), 'x')
      await workspace([])
      const bare = (await planRun({ cwd: root, tasks: ['build'], log: silent() })).tasks[0]!.hash
      await workspace([`{ name: 'org/tool', key() { return { 'node-major': '22' } } }`])
      const withKey = (await planRun({ cwd: root, tasks: ['build'], log: silent() })).tasks[0]!.hash
      expect(withKey).not.toBe(bare)
      // Deterministic material → the same key on the next derivation.
      expect((await planRun({ cwd: root, tasks: ['build'], log: silent() })).tasks[0]!.hash).toBe(
        withKey,
      )
      // A different value is a different key.
      await workspace([`{ name: 'org/tool', key() { return { 'node-major': '24' } } }`])
      expect(
        (await planRun({ cwd: root, tasks: ['build'], log: silent() })).tasks[0]!.hash,
      ).not.toBe(withKey)
      // A non-string value is refused, naming plugin and stage.
      await workspace([`{ name: 'org/tool', key() { return { n: 22 } } }`])
      await expect(planRun({ cwd: root, tasks: ['build'], log: silent() })).rejects.toThrow(
        /plugin 'org\/tool' failed in key: value for 'n'/,
      )
    },
    TIMEOUT,
  )
})

describe('key stage — explainability', () => {
  it(
    'a changed plugin part is what `vx why` names',
    async () => {
      // The docs say key material is "named in vx why". Pinned by running
      // the real verb: two runs with different material, then the diff.
      await pkg(
        'a',
        "export default { tasks: { build: { exec: { command: 'echo b' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } } } }\n",
      )
      await mkdir(path.join(root, 'packages', 'a', 'src'), { recursive: true })
      await writeFile(path.join(root, 'packages', 'a', 'src', 'x.js'), 'x')
      await workspace([`{ name: 'org/tool', key() { return { 'node-major': '22' } } }`])
      await run({ cwd: root, tasks: ['build'], log: silent(), handleSignals: false })
      await workspace([`{ name: 'org/tool', key() { return { 'node-major': '24' } } }`])
      await run({ cwd: root, tasks: ['build'], log: silent(), handleSignals: false })
      const why = Bun.spawnSync({
        cmd: [process.execPath, path.resolve(import.meta.dir, '../src/bin.ts'), 'why', 'a#build'],
        cwd: root,
        env: { ...process.env, NO_COLOR: '1' },
      })
      const out = new TextDecoder().decode(why.stdout)
      expect(why.exitCode).toBe(0)
      expect(out).toContain('cache key changed')
      expect(out).toMatch(/changed +plugin +org\/tool\/node-major/)
      // A plugin that leaves the workspace is a REMOVED part, not silence.
      await workspace([])
      await run({ cwd: root, tasks: ['build'], log: silent(), handleSignals: false })
      const gone = Bun.spawnSync({
        cmd: [process.execPath, path.resolve(import.meta.dir, '../src/bin.ts'), 'why', 'a#build'],
        cwd: root,
        env: { ...process.env, NO_COLOR: '1' },
      })
      expect(new TextDecoder().decode(gone.stdout)).toMatch(
        /removed +plugin +org\/tool\/node-major/,
      )
    },
    TIMEOUT,
  )
})

describe('schedule stage', () => {
  it(
    "a plugin's weights decide which ready task runs first",
    async () => {
      // Two independent tasks, identical structure: insertion order would run
      // a#build first at concurrency 1. The plugin says b first.
      await pkg('a', build)
      await pkg('b', build)
      await workspace([
        `{ name: 'org/order', schedule() { return new Map([['a#build', 1], ['b#build', 100]]) } }`,
      ])
      const log = silent()
      const summary = await run({
        cwd: root,
        tasks: ['build'],
        concurrency: 1,
        log,
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      expect(log.started).toEqual(['b#build', 'a#build'])
      // Control: without the plugin, insertion order.
      await workspace([])
      const log2 = silent()
      await run({ cwd: root, tasks: ['build'], concurrency: 1, log: log2, handleSignals: false })
      expect(log2.started).toEqual(['a#build', 'b#build'])
    },
    TIMEOUT,
  )

  it(
    'a later plugin overrides an earlier one per task; a non-finite weight is refused',
    async () => {
      await pkg('a', build)
      await pkg('b', build)
      await workspace([
        `{ name: 'org/first', schedule() { return new Map([['a#build', 100]]) } }`,
        `{ name: 'org/second', schedule() { return new Map([['a#build', 1], ['b#build', 50]]) } }`,
      ])
      const log = silent()
      await run({ cwd: root, tasks: ['build'], concurrency: 1, log, handleSignals: false })
      expect(log.started).toEqual(['b#build', 'a#build'])
      await workspace([`{ name: 'org/nan', schedule() { return new Map([['a#build', NaN]]) } }`])
      await expect(planRun({ cwd: root, tasks: ['build'], log: silent() })).rejects.toThrow(
        /plugin 'org\/nan' failed in schedule/,
      )
    },
    TIMEOUT,
  )
})

describe('schedule-history plugin end to end', () => {
  it(
    'orders by the critical path learned from this workspace’s own run history',
    async () => {
      // Two independent chains of identical shape. Chain A is slow in
      // history, chain B trivial; with one worker the plugin must start A.
      // Insertion order (a first) would ALSO start a — so the fixture makes
      // B the slow one, and the plugin has to reverse the insertion order.
      await pkg(
        'a',
        "export default { tasks: { build: { exec: { command: 'true' } }, test: { dependsOn: ['build'], exec: { command: 'true' } } } }\n",
      )
      await pkg(
        'b',
        "export default { tasks: { build: { exec: { command: 'sleep 0.15' } }, test: { dependsOn: ['build'], exec: { command: 'sleep 0.15' } } } }\n",
      )
      const pluginPath = path.resolve(import.meta.dir, '../src/plugins/schedule-history/index.ts')
      await Bun.write(
        path.join(root, 'vx.workspace.mjs'),
        `import { scheduleHistoryPlugin } from ${JSON.stringify(pluginPath)}\n` +
          localWorkspaceSource(['scheduleHistoryPlugin()']).replace(
            'export default',
            'export default',
          ),
      )
      // Run 1 records the durations (no history yet → insertion order).
      const first = silent()
      await run({ cwd: root, tasks: ['test'], concurrency: 1, log: first, handleSignals: false })
      expect(first.started[0]).toBe('a#build')
      // Run 2: history says chain B is the critical path → B's head first.
      const second = silent()
      const summary = await run({
        cwd: root,
        tasks: ['test'],
        concurrency: 1,
        log: second,
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      expect(second.started[0]).toBe('b#build')
    },
    TIMEOUT,
  )
})

describe('zero cost when absent', () => {
  it(
    'a workspace with no stage plugins validates each config exactly once',
    async () => {
      const { validateProjectConfig } = await import('../src/workspace/project-loader.js')
      const { spyOn } = await import('bun:test')
      const mod = await import('../src/workspace/project-loader.js')
      const spy = spyOn(mod, 'validateProjectConfig')
      try {
        await pkg('a', build)
        await pkg('b', build)
        await workspace([])
        await planRun({ cwd: root, tasks: ['build'], log: silent() })
        expect(spy).toHaveBeenCalledTimes(2)
      } finally {
        spy.mockRestore()
        void validateProjectConfig
      }
    },
    TIMEOUT,
  )
})
