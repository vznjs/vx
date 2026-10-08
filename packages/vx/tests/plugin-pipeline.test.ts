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
import { pluginSource, testPlugin } from './helpers/plugin.js'
import {
  applyConfigHooks,
  applyGraphHooks,
  applyKeyHooks,
  applyProjectHooks,
  applyScheduleHooks,
  buildAdmission,
  fingerprintClaims,
  hasHook,
} from '../src/orchestrator/plugin-host.js'
import type { VxPlugin } from '../src/orchestrator/index.js'
import type { TaskNode } from '../src/graph/index.js'

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

describe('an explicit empty group', () => {
  it(
    "a dependant's ^build finds it and runs nothing of the dependency",
    async () => {
      // The shape core itself uses: consumed as source, `build` is an
      // explicit empty group. A dependant's `install → ^build` resolves
      // to it and the plan carries nothing of the dependency's.
      await pkg('core', 'export default { tasks: { build: { dependsOn: [] } } }\n')
      const dir = path.join(root, 'packages', 'app')
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { core: 'workspace:*' } }),
      )
      await writeFile(
        path.join(dir, 'vx.config.mjs'),
        "export default { tasks: { install: { dependsOn: ['^build'] }, test: { dependsOn: ['install'], exec: { command: 'echo t' } } } }\n",
      )
      await workspace([])
      const plan = await planRun({ cwd: root, tasks: ['test'], log: silent() })
      expect(plan.tasks.map((t) => t.node.id).sort()).toEqual([
        'app#install',
        'app#test',
        'core#build',
      ])
      // The group is in the graph and does nothing: no exec, no work.
      const group = plan.tasks.find((t) => t.node.id === 'core#build')!
      expect(group.node.config.exec).toBeUndefined()
      expect(group.deps).toEqual([])
      // CONTROL: a build that does work is the same edge with a command.
      await pkg('core', "export default { tasks: { build: { exec: { command: 'echo b' } } } }\n")
      const withWork = await planRun({ cwd: root, tasks: ['test'], log: silent() })
      expect(
        withWork.tasks.find((t) => t.node.id === 'core#build')!.node.config.exec?.command,
      ).toBe('echo b')
    },
    TIMEOUT,
  )
})

describe('config stage', () => {
  it(
    'a plugin edits the workspace config before it is used',
    async () => {
      await pkg('a', build)
      await workspace([pluginSource('org/conc', `{ config(ws) { ws.concurrency = 3 } }`)])
      const log = silent()
      const summary = await run({ cwd: root, tasks: ['build'], log, handleSignals: false })
      expect(summary.ok).toBe(true)
      expect(log.concurrency).toBe(3)
    },
    TIMEOUT,
  )

  it(
    'every load in one process hands the hooks the declared config, not the last edit',
    async () => {
      // Bun keeps one module per specifier, so the workspace file's export
      // is one object per process: the CLI's selection pass and the run
      // (and each `vx watch` cycle) handed the hooks what the last load's
      // hooks had edited, and a run of `vx run` used 8 workers, not 4.
      await pkg('a', build)
      await Bun.write(
        path.join(root, 'vx.workspace.mjs'),
        localWorkspaceSource([
          pluginSource('org/double', `{ config(ws) { ws.concurrency = ws.concurrency * 2 } }`),
        ]).replace('export default {', 'export default { concurrency: 2,'),
      )
      const seen: Array<number | undefined> = []
      for (let i = 0; i < 3; i++) {
        const log = silent()
        const summary = await run({ cwd: root, tasks: ['build'], log, handleSignals: false })
        expect(summary.ok).toBe(true)
        seen.push(log.concurrency)
      }
      expect(seen).toEqual([4, 4, 4])
    },
    TIMEOUT,
  )

  it(
    'a plugin that produces an invalid workspace config is refused like a user would be',
    async () => {
      // Unchecked, `concurrency: -3` hung the run, `timeout: 'x'` timed
      // every task out and `cacheDir: 42` was a TypeError from path.resolve.
      await pkg('a', build)
      const refusal = async (edit: string): Promise<string | undefined> => {
        await workspace([
          pluginSource('org/fine', `{ config(ws) { ws.concurrency = 2 } }`),
          pluginSource('org/broken', `{ config(ws) { ${edit} } }`),
        ])
        return planRun({ cwd: root, tasks: ['build'], log: silent() }).then(
          () => undefined,
          (e: unknown) => (e as Error).message,
        )
      }
      const where = "vx.workspace (after plugin 'org/broken')"
      expect(await refusal('ws.concurrency = -3')).toBe(
        `${where}: \`concurrency\` must be a positive integer`,
      )
      expect(await refusal("ws.timeout = 'x'")).toBe(
        `${where}: \`timeout\` must be a positive integer (milliseconds)`,
      )
      expect(await refusal('ws.cacheDir = 42')).toBe(`${where}: \`cacheDir\` must be a string`)
      // CONTROL: a valid edit passes the same check.
      expect(await refusal('ws.timeout = 5000')).toBeUndefined()
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
        pluginSource(
          'org/lint-everywhere',
          `{ project(config, ctx) {
            config.tasks ??= {}
            config.tasks.lint = {
              exec: { command: 'echo lint ' + ctx.name },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
            }
          },
        }`,
        ),
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
    'visits a package with NO config file, so a plugin can give it tasks; without the stage it stays invisible',
    async () => {
      // The zero-migration shape: `b` has a package.json and scripts but never
      // wrote a vx.config — a `project` plugin maps them onto tasks.
      await pkg('a', build)
      const bDir = path.join(root, 'packages', 'b')
      await mkdir(bDir, { recursive: true })
      await writeFile(
        path.join(bDir, 'package.json'),
        JSON.stringify({ name: 'b', version: '1.0.0', scripts: { build: 'echo from-scripts' } }),
      )
      await workspace([
        pluginSource(
          'org/scripts',
          `{ project(config, ctx) {
            const scripts = ctx.packageJson.scripts ?? {}
            config.tasks ??= {}
            for (const [name, command] of Object.entries(scripts)) {
              config.tasks[name] ??= { exec: { command } }
            }
          },
        }`,
        ),
      ])
      const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
      expect(plan.tasks.map((t) => t.node.id).sort()).toEqual(['a#build', 'b#build'])
      expect(plan.tasks.find((t) => t.node.id === 'b#build')!.node.config.exec?.command).toBe(
        'echo from-scripts',
      )
      const summary = await run({
        cwd: root,
        tasks: ['build'],
        log: silent(),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      expect(summary.outcomes.map((o) => o.node.id).sort()).toEqual(['a#build', 'b#build'])

      // Control: no `project` plugin → a config-less package declares nothing
      // and is never loaded, exactly as before the stage could reach it.
      await workspace([])
      const plain = await planRun({ cwd: root, tasks: ['build'], log: silent() })
      expect(plain.tasks.map((t) => t.node.id)).toEqual(['a#build'])
    },
    TIMEOUT,
  )

  it(
    'runs in declaration order — the second plugin sees the first one’s edit',
    async () => {
      await pkg('a', build)
      await workspace([
        pluginSource(
          'org/first',
          `{ project(config) { config.tasks.build.description = 'first' } }`,
        ),
        pluginSource(
          'org/second',
          `{ project(config) { config.tasks.build.description += '+second' } }`,
        ),
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
        pluginSource(
          'org/suffix',
          `{ project(config) { config.tasks.build.description = (config.tasks.build.description ?? '') + '+x' } }`,
        ),
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
      // Two plugins in the stage: the refusal names the one whose edit broke
      // the task, not "plugins" — the fix is in THAT plugin.
      await workspace([
        pluginSource('org/fine', `{ project(config) { config.tasks.build.description = 'ok' } }`),
        pluginSource('org/broken', `{ project(config) { config.tasks.build.exec = 5 } }`),
      ])
      await expect(planRun({ cwd: root, tasks: ['build'], log: silent() })).rejects.toThrow(
        /vx\.config\.mjs \(after plugin 'org\/broken'\): tasks\.build\.exec must be an object/,
      )
    },
    TIMEOUT,
  )

  it(
    'a plugin that puts a value JSON cannot carry into a config is refused like a user would be (item 701)',
    async () => {
      // A Map where `sandbox` goes passes the schema (an object with no
      // unknown keys) and hashed as `{}`: only the JSON-data rule sees it.
      await pkg('a', build)
      await workspace([
        pluginSource(
          'org/map',
          `{ project(config) { config.tasks.build.exec.sandbox = new Map() } }`,
        ),
      ])
      const err = await planRun({ cwd: root, tasks: ['build'], log: silent() }).then(
        () => null,
        (e: unknown) => e as Error,
      )
      // From the project's own path on: the root is macOS's symlinked temp
      // dir there, and which spelling discovery reports is not this row's.
      const message = err?.message ?? ''
      expect(message.slice(message.indexOf('/packages/a/vx.config.mjs'))).toBe(
        `/packages/a/vx.config.mjs (after plugin 'org/map'): tasks.build.exec.sandbox is an instance of Map — a config must be JSON data, because the cache key folds its JSON`,
      )
    },
    TIMEOUT,
  )

  it(
    'the workspace config is not held to the JSON-data rule: its plugins are objects of functions (item 701)',
    async () => {
      await pkg('a', build)
      await workspace([
        pluginSource(
          'org/describe',
          `{ project(config) { config.tasks.build.description = 'd' } }`,
        ),
      ])
      const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
      expect(plan.tasks.map((t) => [t.node.id, t.node.config.description])).toEqual([
        ['a#build', 'd'],
      ])
    },
    TIMEOUT,
  )

  it(
    'a throwing hook aborts with the plugin and stage named',
    async () => {
      await pkg('a', build)
      await workspace([pluginSource('org/boom', `{ project() { throw new Error('nope') } }`)])
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
        pluginSource('org/edge', `{ graph(nodes) { nodes.get('b#build').deps.push('a#build') } }`),
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
        pluginSource(
          'org/dangling',
          `{ graph(nodes) { nodes.get('a#build').deps.push('zz#nope') } }`,
        ),
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
        pluginSource(
          'org/loop',
          `{ graph(nodes) {
          nodes.get('a#build').deps.push('b#build')
          nodes.get('b#build').deps.push('a#build')
        } }`,
        ),
      ])
      await expect(planRun({ cwd: root, tasks: ['build'], log: silent() })).rejects.toThrow(
        /plugin 'org\/loop' failed in graph: Cycle detected/,
      )
    },
    TIMEOUT,
  )

  it(
    'an edge a plugin drops between overlapping outputs is refused (item 981)',
    async () => {
      // Declared with the edge, `extra` adds to `gen`'s tree; the plugin
      // takes the edge away, the two run in either order, and `gen`'s
      // clean deleted `extra`'s file under a green run. The builder refuses
      // that shape; the stage did not ask again.
      await pkg(
        'a',
        `export default { tasks: {
          gen: { exec: { command: 'mkdir -p dist && echo g > dist/gen.txt' }, cache: { inputs: { files: [] }, outputs: { files: ['dist/**'] } } },
          extra: { exec: { command: 'mkdir -p dist && echo e > dist/extra.txt' }, dependsOn: ['gen'], cache: { inputs: { files: [] }, outputs: { files: ['dist/**'] } } },
        } }\n`,
      )
      await workspace([
        pluginSource('org/unedge', `{ graph(nodes) { nodes.get('a#extra').deps = [] } }`),
      ])
      // The addition shape loads only with `exclusiveOutputs` off (X-53).
      const file = path.join(root, 'vx.workspace.mjs')
      await Bun.write(
        file,
        (await Bun.file(file).text()).replace(
          'export default {',
          'export default { rules: { exclusiveOutputs: false },',
        ),
      )
      await expect(planRun({ cwd: root, tasks: ['extra'], log: silent() })).rejects.toThrow(
        /plugin 'org\/unedge' failed in graph: a#(gen|extra) and a#(gen|extra) both declare the output "dist\/\*\*"/,
      )
    },
    TIMEOUT,
  )

  it(
    'a node a plugin moves to another key is refused by name, not a TypeError (item 981)',
    async () => {
      await pkg('a', build)
      await workspace([
        pluginSource(
          'org/rekey',
          `{ graph(nodes) { const n = nodes.get('a#build'); nodes.delete('a#build'); nodes.set('zz#build', n) } }`,
        ),
      ])
      await expect(planRun({ cwd: root, tasks: ['build'], log: silent() })).rejects.toThrow(
        /plugin 'org\/rekey' failed in graph: the task a#build is stored under 'zz#build', not its own id/,
      )
    },
    TIMEOUT,
  )

  it(
    'a task config a plugin breaks is refused, naming the plugin and the field',
    async () => {
      // Unchecked, the misspelled field left the task without a command:
      // it failed with exit 1 and no reason.
      await pkg('a', build)
      await workspace([
        pluginSource('org/first', `{ graph() {} }`),
        pluginSource(
          'org/typo',
          `{ graph(nodes) { nodes.get('a#build').config.exec = { comand: 'echo x' } } }`,
        ),
      ])
      const said = await planRun({ cwd: root, tasks: ['build'], log: silent() }).then(
        () => 'planned',
        (e: Error) => e.message,
      )
      expect(said).toBe(
        `${path.join(root, 'packages/a/vx.config.mjs')} (after plugin 'org/typo'): ` +
          'tasks.build.exec has unknown field "comand" (allowed: command, env, interactive, ' +
          'persistent, remote, retries, sandbox, timeout) — did you mean command?',
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
          pluginSource(
            'org/see',
            `{ graph(nodes, ctx) { globalThis.__vxRequested = [...ctx.requested] } }`,
          ),
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
      await workspace([pluginSource('org/tool', `{ key() { return { 'node-major': '22' } } }`)])
      const withKey = (await planRun({ cwd: root, tasks: ['build'], log: silent() })).tasks[0]!.hash
      expect(withKey).not.toBe(bare)
      // Deterministic material → the same key on the next derivation.
      expect((await planRun({ cwd: root, tasks: ['build'], log: silent() })).tasks[0]!.hash).toBe(
        withKey,
      )
      // A different value is a different key.
      await workspace([pluginSource('org/tool', `{ key() { return { 'node-major': '24' } } }`)])
      expect(
        (await planRun({ cwd: root, tasks: ['build'], log: silent() })).tasks[0]!.hash,
      ).not.toBe(withKey)
      // A non-string value is refused, naming plugin and stage.
      await workspace([pluginSource('org/tool', `{ key() { return { n: 22 } } }`)])
      await expect(planRun({ cwd: root, tasks: ['build'], log: silent() })).rejects.toThrow(
        /plugin 'org\/tool' failed in key: value for 'n'/,
      )
      // A non-record return is refused too: a string used to fold its
      // characters into the key as parts named '0', '1', '2'.
      await workspace([pluginSource('org/tool', `{ key() { return 'v22' } }`)])
      await expect(planRun({ cwd: root, tasks: ['build'], log: silent() })).rejects.toThrow(
        "plugin 'org/tool' failed in key: returned a string, not a record of string values",
      )
    },
    TIMEOUT,
  )

  it(
    'an ARRAY and a NULL return are refused too, not just a string',
    async () => {
      // The row above exercises the non-record guard with ONE spelling, a
      // string, which fails on its first arm (`typeof !== 'object'`). The
      // guard has two more arms and neither had a witness, though both
      // reach the same defect the comment above describes — or worse.
      //
      // An ARRAY is an object, so `Object.entries` walks it happily and
      // folds parts named '0', '1', '2' into every key: the exact
      // character-fold the string case was written for, arriving by the
      // spelling nobody spelled.
      //
      // `null` is an object too (`typeof null === 'object'`), so it sails
      // past the first arm and `Object.entries(null)` THROWS a TypeError
      // naming neither the plugin nor the stage — the internal-error
      // failure `safe()` exists to replace, from the one return value that
      // most looks like "no material".
      //
      // Item 542 found this same `typeof [] === 'object'` trap covered on
      // both arms in `lockfile.ts`. Here it was covered on neither.
      await pkg(
        'a',
        "export default { tasks: { build: { exec: { command: 'echo b' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } } } }\n",
      )
      await mkdir(path.join(root, 'packages', 'a', 'src'), { recursive: true })
      await writeFile(path.join(root, 'packages', 'a', 'src', 'x.js'), 'x')

      await workspace([pluginSource('org/tool', `{ key() { return ['v22'] } }`)])
      await expect(planRun({ cwd: root, tasks: ['build'], log: silent() })).rejects.toThrow(
        "plugin 'org/tool' failed in key: returned an array, not a record of string values",
      )

      await workspace([pluginSource('org/tool', `{ key() { return null } }`)])
      await expect(planRun({ cwd: root, tasks: ['build'], log: silent() })).rejects.toThrow(
        "plugin 'org/tool' failed in key: returned null, not a record of string values",
      )
    },
    TIMEOUT,
  )

  it(
    'a NUL in a key part name is refused; one in a value folds',
    async () => {
      // The fold joins each part as `name\0value`, so `{ 'a\0b': 'c' }` and
      // `{ a: 'b\0c' }` folded the same bytes: two materials, one key.
      await pkg(
        'a',
        "export default { tasks: { build: { exec: { command: 'echo b' }, cache: { inputs: { files: [] }, outputs: { files: [] } } } } }\n",
      )
      await workspace([pluginSource('org/tool', `{ key() { return { 'a\\0b': 'c' } } }`)])
      await expect(planRun({ cwd: root, tasks: ['build'], log: silent() })).rejects.toThrow(
        "plugin 'org/tool' failed in key: a name on a#build holds a NUL, the fold's delimiter",
      )

      await workspace([pluginSource('org/tool', `{ key() { return { a: 'b\\0c' } } }`)])
      await planRun({ cwd: root, tasks: ['build'], log: silent() })
    },
    TIMEOUT,
  )

  it(
    'the fold is order-independent: two plugins key the same whichever is declared first',
    async () => {
      // The parts are sorted "so the fold is order-independent", and every
      // fixture declares ONE key plugin — with one contributor there is no
      // order to be independent of, so the sort had no witness. Without
      // it the parts arrive in plugin-declaration order, and moving two
      // plugins around in `vx.workspace.mjs` silently re-keys every task
      // in the workspace: a full cold rebuild for an edit that changed no
      // input.
      await pkg(
        'a',
        "export default { tasks: { build: { exec: { command: 'echo b' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } } } }\n",
      )
      await mkdir(path.join(root, 'packages', 'a', 'src'), { recursive: true })
      await writeFile(path.join(root, 'packages', 'a', 'src', 'x.js'), 'x')

      const zed = pluginSource('org/zed', `{ key() { return { m: 'z' } } }`)
      const abe = pluginSource('org/abe', `{ key() { return { m: 'a' } } }`)

      await workspace([zed, abe])
      const zedFirst = (await planRun({ cwd: root, tasks: ['build'], log: silent() })).tasks[0]!
        .hash
      await workspace([abe, zed])
      const abeFirst = (await planRun({ cwd: root, tasks: ['build'], log: silent() })).tasks[0]!
        .hash
      expect(abeFirst).toBe(zedFirst)

      // CONTROL: the material still counts — same order, different value,
      // different key. Without this the row above would pass on a fold
      // that ignored plugin parts altogether.
      await workspace([zed, pluginSource('org/abe', `{ key() { return { m: 'a2' } } }`)])
      expect(
        (await planRun({ cwd: root, tasks: ['build'], log: silent() })).tasks[0]!.hash,
      ).not.toBe(zedFirst)
    },
    TIMEOUT,
  )
})

describe('key stage — two plugins of one package', () => {
  it(
    'parts named alike are told apart, in value order, and still fold both (item 1028)',
    async () => {
      // A plugin's name is its package's, so two plugins from one package
      // returning `v` folded two parts named `org/twin/v`: the key moved,
      // but `vx why` could not say which.
      await pkg(
        'a',
        "export default { tasks: { build: { exec: { command: 'echo b' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } } } }\n",
      )
      await mkdir(path.join(root, 'packages', 'a', 'src'), { recursive: true })
      await writeFile(path.join(root, 'packages', 'a', 'src', 'x.js'), 'x')
      const twin = (v: string) => pluginSource('org/twin', `{ key() { return { v: '${v}' } } }`)
      const parts = async (...plugins: string[]) => {
        await workspace(plugins)
        const task = (await planRun({ cwd: root, tasks: ['build'], log: silent() })).tasks[0]!
        return { parts: task.node.keyParts, hash: task.hash }
      }
      const ab = await parts(twin('1'), twin('2'))
      const ba = await parts(twin('2'), twin('1'))
      const moved = await parts(twin('1'), twin('3'))
      expect({
        ab: ab.parts,
        sameKeyEitherOrder: ba.hash === ab.hash,
        moved: moved.parts,
        movedKey: moved.hash !== ab.hash,
      }).toEqual({
        ab: [
          ['org/twin/v', '1'],
          ['org/twin/v#2', '2'],
        ],
        sameKeyEitherOrder: true,
        moved: [
          ['org/twin/v', '1'],
          ['org/twin/v#2', '3'],
        ],
        movedKey: true,
      })
    },
    TIMEOUT,
  )
})

describe('fingerprint claim — a plugin keys a lockfile per project', () => {
  const BUILD =
    "export default { tasks: { build: { exec: { command: 'echo b' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } } } }\n"
  const CLAIM = (deps: string) =>
    pluginSource(
      'org/pm',
      `{ fingerprint: { files: ['pnpm-lock.yaml'], affected() { return [] } }, key(task) { return { deps: ${deps} } } }`,
    )

  it(
    'a claimed lockfile edit leaves the key alone; the plugin material is what moves it',
    async () => {
      await pkg('a', BUILD)
      await mkdir(path.join(root, 'packages', 'a', 'src'), { recursive: true })
      await writeFile(path.join(root, 'packages', 'a', 'src', 'x.js'), 'x')
      await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nv1\n')
      const hash = async () =>
        (await planRun({ cwd: root, tasks: ['build'], log: silent() })).tasks[0]!.hash

      await workspace([CLAIM("'closure-1'")])
      const claimed = await hash()
      await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nv2\n')
      expect(await hash()).toBe(claimed)
      // The plugin's per-project material moves it.
      await workspace([CLAIM("'closure-2'")])
      expect(await hash()).not.toBe(claimed)
      // CONTROL: without the claim the same lockfile edit re-keys the task.
      await workspace([])
      const bare = await hash()
      await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nv3\n')
      expect(await hash()).not.toBe(bare)
    },
    TIMEOUT,
  )

  it(
    'the claim reaches `--affected` through the CLI',
    async () => {
      // `vx run build --affected=HEAD` after a lockfile edit ran EVERY task
      // before; a claimant names the projects, and the run selects them.
      await pkg('a', BUILD)
      await pkg('b', BUILD)
      await writeFile(path.join(root, 'pnpm-lock.yaml'), 'v1\n')
      await workspace([
        pluginSource(
          'org/pm',
          `{ fingerprint: { files: ['pnpm-lock.yaml'], affected(c) { return c.after !== null && new TextDecoder().decode(c.after).includes('v2') ? ['b'] : undefined } }, key() { return undefined } }`,
        ),
      ])
      const git = (...args: string[]) => {
        const r = Bun.spawnSync({
          cmd: [
            'git',
            '-c',
            'commit.gpgsign=false',
            '-c',
            'user.email=t@vx',
            '-c',
            'user.name=t',
            ...args,
          ],
          cwd: root,
        })
        if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr))
      }
      git('add', '.')
      git('commit', '-q', '-m', 'init')
      await writeFile(path.join(root, 'pnpm-lock.yaml'), 'v2\n')
      const vx = (...args: string[]) => {
        const r = Bun.spawnSync({
          cmd: [process.execPath, path.resolve(import.meta.dir, '../src/bin.ts'), ...args],
          cwd: root,
          env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
        })
        return new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr)
      }
      const scoped = vx('run', 'build', '--affected=HEAD')
      expect(scoped).toContain('b#build')
      expect(scoped).not.toContain('a#build')
      expect(scoped).toContain('1 in run · 2 total')
      // CONTROL: bytes the plugin cannot read ("cannot tell") select both.
      await writeFile(path.join(root, 'pnpm-lock.yaml'), 'v3\n')
      const widened = vx('run', 'build', '--affected=HEAD')
      expect(widened).toContain('2 in run · 2 total')
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
      await workspace([pluginSource('org/tool', `{ key() { return { 'node-major': '22' } } }`)])
      await run({ cwd: root, tasks: ['build'], log: silent(), handleSignals: false })
      await workspace([pluginSource('org/tool', `{ key() { return { 'node-major': '24' } } }`)])
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

describe('admit stage', () => {
  // The seam a memory-packing plugin fills. Core keeps no notion of what a
  // task needs; it asks the policy at every local dispatch with what runs.
  const sleeper = "export default { tasks: { build: { exec: { command: 'sleep 0.15' } } } }\n"
  function spans(): Logger & { spans: Map<string, { start: number; end: number }> } {
    const spans = new Map<string, { start: number; end: number }>()
    return {
      spans,
      status() {},
      taskStart(node: { id: string }) {
        spans.set(node.id, { start: Bun.nanoseconds(), end: 0 })
      },
      taskStdout() {},
      taskStderr() {},
      taskComplete(node: { id: string }) {
        const s = spans.get(node.id)
        if (s) s.end = Bun.nanoseconds()
      },
    } as Logger & { spans: Map<string, { start: number; end: number }> }
  }
  const overlap = (log: ReturnType<typeof spans>, a: string, b: string): boolean => {
    const [x, y] = [log.spans.get(a)!, log.spans.get(b)!]
    return x.start < y.end && y.start < x.end
  }

  it(
    'a policy that refuses company serializes two tasks the count limit would run together',
    async () => {
      await pkg('a', sleeper)
      await pkg('b', sleeper)
      await workspace([
        pluginSource('org/solo', `{ admit(task, ctx) { return ctx.running.length === 0 } }`),
      ])
      const log = spans()
      const summary = await run({
        cwd: root,
        tasks: ['build'],
        concurrency: 2,
        log,
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      expect(overlap(log, 'a#build', 'b#build')).toBe(false)
      // The run says what the policy cost: the task it held carries the
      // wait, the one it admitted first does not.
      const waits = summary.outcomes.map((o) => o.admissionHeldMs).filter((w) => w !== undefined)
      expect(waits.length).toBe(1)
      expect(waits[0]!).toBeGreaterThanOrEqual(100)
      // CONTROL: the same two tasks with no policy overlap at concurrency 2.
      await workspace([])
      const plain = spans()
      const control = await run({
        cwd: root,
        tasks: ['build'],
        concurrency: 2,
        log: plain,
        handleSignals: false,
      })
      expect(overlap(plain, 'a#build', 'b#build')).toBe(true)
      for (const o of control.outcomes) expect(o.admissionHeldMs).toBeUndefined()
    },
    TIMEOUT,
  )

  it(
    'the policy sees the task dispatched a moment earlier, and every answering plugin must admit',
    async () => {
      await pkg('a', build)
      await pkg('b', build)
      await workspace([
        pluginSource(
          'org/witness',
          `{ admit(task, ctx) { (globalThis.__vxAsked ??= []).push([task.id, ctx.running.map((r) => r.id), ctx.concurrency]); return true } }`,
        ),
        pluginSource(
          'org/veto',
          `{ admit(task) { return task.id !== 'b#build' || (globalThis.__vxAsked ?? []).length > 1 } }`,
        ),
      ])
      const summary = await run({
        cwd: root,
        tasks: ['build'],
        concurrency: 2,
        log: silent(),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      const asked = (globalThis as { __vxAsked?: [string, string[], number][] }).__vxAsked ?? []
      // First ask: nothing running, the worker count as declared.
      expect(asked[0]).toEqual(['a#build', [], 2])
      // Second ask, same tick: a is listed already.
      expect(asked[1]).toEqual(['b#build', ['a#build'], 2])
      delete (globalThis as { __vxAsked?: unknown }).__vxAsked
    },
    TIMEOUT,
  )

  it(
    'a throwing policy is reported once and admits from then on — never a hung run',
    async () => {
      await pkg('a', build)
      await pkg('b', build)
      await workspace([pluginSource('org/boom', `{ admit() { throw new Error('boom') } }`)])
      const status: string[] = []
      const log = { ...silent(), status: (m: string) => status.push(m) } as Logger
      const summary = await run({
        cwd: root,
        tasks: ['build'],
        concurrency: 2,
        log,
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      expect(
        status.filter((m) => m.includes("plugin 'org/boom' failed in admit: boom")),
      ).toHaveLength(1)
    },
    TIMEOUT,
  )

  it(
    'an async policy is reported once and admits from then on — its rejection never ends the run',
    async () => {
      // An `async admit` answered a Promise: every task admitted, the policy
      // never ran, and a rejection ended the run with a stack, exit 1 (H-16).
      await pkg('a', build)
      await pkg('b', build)
      await workspace([
        pluginSource('org/later', `{ async admit() { return false } }`),
        pluginSource('org/boom', `{ async admit() { throw new Error('boom') } }`),
      ])
      const status: string[] = []
      const log = { ...silent(), status: (m: string) => status.push(m) } as Logger
      const summary = await run({
        cwd: root,
        tasks: ['build'],
        concurrency: 2,
        log,
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      expect(status.filter((m) => m.includes('failed in admit')).sort()).toEqual([
        "[vx] plugin 'org/boom' failed in admit: returned a Promise; admit is synchronous; admitting every task from here on",
        "[vx] plugin 'org/later' failed in admit: returned a Promise; admit is synchronous; admitting every task from here on",
      ])
    },
    TIMEOUT,
  )

  it(
    'a policy that refuses with nothing running is overridden once, by name — never a stalled run (item 1023)',
    async () => {
      // Only a completion asks the predicate again, so a refusal with
      // nothing running was final: the run ended "something it awaited
      // can never settle", exit 1, the task never run.
      await pkg('a', build)
      await pkg('b', build)
      await workspace([pluginSource('org/never', `{ admit() { return false } }`)])
      const status: string[] = []
      const log = { ...silent(), status: (m: string) => status.push(m) } as Logger
      const summary = await run({
        cwd: root,
        tasks: ['build'],
        concurrency: 2,
        log,
        handleSignals: false,
      })
      expect({
        ok: summary.ok,
        ran: summary.outcomes.map((o) => `${o.node.id}:${o.status}`).sort(),
        said: status.filter((m) => m.includes("'org/never'")).length,
      }).toEqual({ ok: true, ran: ['a#build:success', 'b#build:success'], said: 1 })
    },
    TIMEOUT,
  )

  it(
    'only an explicit `false` refuses — a policy that returns nothing admits',
    async () => {
      // The stage tests `=== false`, and that strictness is what keeps the
      // promise above ("the predicate is never the reason a task hangs")
      // true for the likeliest plugin bug there is: a branch with no
      // `return`. A truthiness test would read that `undefined` as a veto,
      // and since nothing ever un-refuses a task, the run would sit at zero
      // running tasks until the job timed out — a hang with no diagnostic.
      await pkg('a', build)
      await pkg('b', build)
      await workspace([
        pluginSource('org/mute', `{ admit(task) { if (task.id === 'never#x') return false } }`),
      ])
      const summary = await run({
        cwd: root,
        tasks: ['build'],
        concurrency: 2,
        log: silent(),
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      expect(summary.outcomes.map((o) => o.node.id).sort()).toEqual(['a#build', 'b#build'])
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
        pluginSource(
          'org/order',
          `{ schedule() { return new Map([['a#build', 1], ['b#build', 100]]) } }`,
        ),
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
        pluginSource('org/first', `{ schedule() { return new Map([['a#build', 100]]) } }`),
        pluginSource(
          'org/second',
          `{ schedule() { return new Map([['a#build', 1], ['b#build', 50]]) } }`,
        ),
      ])
      const log = silent()
      await run({ cwd: root, tasks: ['build'], concurrency: 1, log, handleSignals: false })
      expect(log.started).toEqual(['b#build', 'a#build'])
      await workspace([
        pluginSource('org/nan', `{ schedule() { return new Map([['a#build', NaN]]) } }`),
      ])
      await expect(planRun({ cwd: root, tasks: ['build'], log: silent() })).rejects.toThrow(
        /plugin 'org\/nan' failed in schedule/,
      )
      // Not a Map: a string's characters matched no task and the plugin was
      // a silent no-op.
      await workspace([pluginSource('org/str', `{ schedule() { return 'fast' } }`)])
      await expect(planRun({ cwd: root, tasks: ['build'], log: silent() })).rejects.toThrow(
        "plugin 'org/str' failed in schedule: returned a string, not a Map of task id → weight",
      )
    },
    TIMEOUT,
  )

  it(
    'a plugin that DECLINES to weigh this run is a no-op, not a refusal',
    async () => {
      // `undefined` is the one non-Map the stage must accept: a policy that
      // has nothing to say for this run (no history yet, a filter that
      // matched nothing) returns it, and the row above proves every OTHER
      // non-Map is a hard error. Without the skip a declining plugin fails
      // the run with "returned undefined, not a Map" — the stage would admit
      // no way to abstain.
      await pkg('a', build)
      await pkg('b', build)
      await workspace([pluginSource('org/quiet', `{ schedule() { return undefined } }`)])
      const log = silent()
      const summary = await run({
        cwd: root,
        tasks: ['build'],
        concurrency: 1,
        log,
        handleSignals: false,
      })
      expect(summary.ok).toBe(true)
      expect(log.started).toEqual(['a#build', 'b#build'])
    },
    TIMEOUT,
  )

  it('a weight for a task outside this run is dropped before it is checked (item 651)', async () => {
    // A history-backed policy weighs every task it has ever seen; a run with
    // a filter holds a few. The stale ids leave the map, and a junk weight on
    // one of them is not this run's refusal. Without the skip the merged map
    // carries `gone#build` and the NaN fails the run.
    const nodes = new Map([['a#build', {} as TaskNode]])
    const plugin = testPlugin('org/history', {
      schedule: () =>
        new Map([
          ['a#build', 5],
          ['gone#build', Number.NaN],
        ]),
    })
    const merged = await applyScheduleHooks([plugin], nodes, {} as never)
    expect([...merged]).toEqual([['a#build', 5]])
  })
})

describe('telemetry stage', () => {
  it(
    'a sink that handles nothing is disabled with a word, never a failed run',
    async () => {
      // Every handler is optional, so `{ nope: true }` used to be a valid
      // sink: subscribed, silent, "on".
      await pkg('a', build)
      await workspace([pluginSource('org/deaf', `{ telemetry() { return { nope: true } } }`)])
      const lines: string[] = []
      const log = Object.assign(silent(), { status: (line: string) => lines.push(line) })
      const summary = await run({ cwd: root, tasks: ['build'], log, handleSignals: false })
      expect(summary.ok).toBe(true)
      expect(lines.filter((l) => l.includes('org/deaf'))).toEqual([
        "[vx] plugin 'org/deaf' telemetry failed to initialize; disabled for this run: telemetry sink handles nothing: neither onRecord nor onRunSummary is a function",
      ])
    },
    TIMEOUT,
  )
})

describe('zero cost when absent', () => {
  it('no plugin answers `admit` → no predicate at all, so the scheduler keeps its count-only path', () => {
    // The only stage gate with nothing to observe from a run: a predicate
    // that admits everything and no predicate at all produce the same
    // schedule, the same outcomes and the same (absent) `admissionHeldMs`.
    // What differs is the path — with a predicate in hand the scheduler
    // tracks held-since state and scans its exec queue at capacity — so the
    // gate is witnessed where it is decided, by the one direct call in this
    // file.
    const nodes = new Map<string, TaskNode>()
    expect(buildAdmission([], nodes, 4, () => {})).toBeUndefined()
    // CONTROL: one answering plugin and the predicate exists.
    expect(
      buildAdmission([testPlugin('org/gate', { admit: () => true })], nodes, 4, () => {}),
    ).toBeInstanceOf(Function)
  })

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

describe('project stage context', () => {
  it(
    'ctx.projects is every package core discovered — config file or not, in the scope or out of it',
    async () => {
      // `b` has no config and is outside the scope, so the stage never
      // visits it; a plugin whose mapping needs the whole workspace still
      // sees it here, so it does not walk the workspace a second time.
      await pkg('a', build)
      const bDir = path.join(root, 'packages', 'b')
      await mkdir(bDir, { recursive: true })
      await writeFile(
        path.join(bDir, 'package.json'),
        JSON.stringify({ name: 'b', version: '1.0.0', scripts: { build: 'echo b' } }),
      )
      await workspace([
        pluginSource(
          'org/census',
          `{ project(config, ctx) {
            if (ctx.name !== 'a') return
            config.tasks.build.description = ctx.projects
              .map((p) => p.name + ':' + (p.configPath === null ? 'none' : 'config') + ':' + (p.dir === ctx.dir))
              .sort()
              .join(',')
          } }`,
        ),
      ])
      const plan = await planRun({ cwd: root, tasks: ['build'], projects: ['a'], log: silent() })
      expect(plan.tasks.map((t) => t.node.id)).toEqual(['a#build'])
      expect(plan.tasks[0]!.node.config.description).toBe('a:config:true,b:none:false')
    },
    TIMEOUT,
  )
})

describe('plugin-host, called directly', () => {
  // Every fixture above declares one plugin per stage, so a plugin that
  // lacks a hook never stood in front of one that has it.
  const bare = testPlugin('org/bare', { teardown: () => {} })
  const nodes = (): Map<string, TaskNode> => new Map([['a#build', { id: 'a#build' } as TaskNode]])

  it('a plugin without a stage is passed over; the plugin after it still answers', async () => {
    const seen: string[] = []
    const late = testPlugin('org/late', {
      config: () => void seen.push('config'),
      project: () => void seen.push('project'),
      key: () => ({ k: 'v' }),
      schedule: () => new Map([['a#build', 7]]),
      fingerprint: { files: ['pnpm-lock.yaml'], affected: () => undefined },
    })
    const plugins = [bare, late]
    const graph = nodes()
    await applyConfigHooks(plugins, {} as never, {} as never)
    await applyProjectHooks(plugins, {} as never, {} as never)
    await applyKeyHooks(plugins, graph, {} as never)
    expect({
      seen,
      keyParts: graph.get('a#build')!.keyParts,
      weights: [...(await applyScheduleHooks(plugins, graph, {} as never))],
      claims: [...fingerprintClaims(plugins)].map(([file, p]) => [file, p.name]),
    }).toEqual({
      seen: ['config', 'project'],
      keyParts: [['org/late/k', 'v']],
      weights: [['a#build', 7]],
      claims: [['pnpm-lock.yaml', 'org/late']],
    })
  })

  it('a stage counts as declared only by a plugin that declares that stage', () => {
    const admitOnly = [bare, testPlugin('org/gate', { admit: () => true })]
    const stages = ['config', 'project', 'graph', 'key', 'schedule', 'admit'] as const
    expect(stages.map((s) => [s, hasHook(admitOnly, s)])).toEqual([
      ['config', false],
      ['project', false],
      ['graph', false],
      ['key', false],
      ['schedule', false],
      ['admit', true],
    ])
  })

  it('the config stage hands each plugin the context it was given', async () => {
    const ctx = { workspaceRoot: '/ws', warn: () => {} }
    let got: unknown
    await applyConfigHooks(
      [testPlugin('org/cfg', { config: (_ws, c) => void (got = c) })],
      {} as never,
      ctx,
    )
    expect(got).toBe(ctx)
  })

  // Vite's `config` returns a partial config; written so here, the edit was
  // dropped without a word. The types refuse it; a plugin in plain JS is untyped.
  it('an in-place stage refuses a returned replacement, naming the plugin', async () => {
    const refusal = (p: Promise<unknown>): Promise<string | null> =>
      p.then(
        () => null,
        (e: Error) => e.message,
      )
    const ws = {}
    const cfg = { tasks: {} }
    const graph = nodes()
    expect([
      await refusal(
        applyConfigHooks(
          [testPlugin('org/vite', { config: (() => ({ concurrency: 2 })) as never })],
          ws as never,
          {} as never,
        ),
      ),
      await refusal(
        applyProjectHooks(
          [testPlugin('org/proj', { project: (async () => ({ tasks: {} })) as never })],
          cfg as never,
          {} as never,
        ),
      ),
      await refusal(
        applyGraphHooks(
          [testPlugin('org/graph', { graph: (() => new Map()) as never })],
          graph,
          {} as never,
        ),
      ),
    ]).toEqual([
      "plugin 'org/vite' failed in config: returned an object, which core ignores — edit the workspace config in place",
      "plugin 'org/proj' failed in project: returned an object, which core ignores — edit the project's config in place",
      "plugin 'org/graph' failed in graph: returned an object, which core ignores — edit the task graph in place",
    ])
    // CONTROL: handing back the object it was given changes nothing.
    expect(
      await refusal(
        applyConfigHooks(
          [testPlugin('org/same', { config: ((w: object) => w) as never })],
          ws as never,
          {} as never,
        ),
      ),
    ).toBeNull()
  })

  it('three parts named alike are numbered #2 and #3, in value order', async () => {
    const twin = (v: string): VxPlugin => testPlugin('org/twin', { key: () => ({ v }) })
    const graph = nodes()
    await applyKeyHooks([twin('3'), twin('1'), twin('2')], graph, {} as never)
    expect(graph.get('a#build')!.keyParts).toEqual([
      ['org/twin/v', '1'],
      ['org/twin/v#2', '2'],
      ['org/twin/v#3', '3'],
    ])
  })

  it('schedule refuses a plain object and an infinite weight, by name', async () => {
    const said = (weights: unknown): Promise<string> =>
      applyScheduleHooks(
        [testPlugin('org/w', { schedule: () => weights as Map<string, number> })],
        nodes(),
        {} as never,
      ).then(
        (m) => JSON.stringify([...m]),
        (e: Error) => e.message,
      )
    expect([
      await said({ 'a#build': 5 }),
      await said(new Map([['a#build', Infinity]])),
      await said(new Map([['a#build', 5]])),
    ]).toEqual([
      "plugin 'org/w' failed in schedule: returned an object, not a Map of task id → weight",
      "plugin 'org/w' failed in schedule: weight for a#build is not a finite number",
      '[["a#build",5]]',
    ])
  })

  it(
    'a graph the plugins broke is blamed on the last plugin that edited it',
    async () => {
      await pkg('a', build)
      await workspace([
        pluginSource('org/first', `{ graph() {} }`),
        pluginSource(
          'org/second',
          `{ graph(nodes) { nodes.get('a#build').deps.push('zz#nope') } }`,
        ),
      ])
      const said = await planRun({ cwd: root, tasks: ['build'], log: silent() }).then(
        () => 'planned',
        (e: Error) => e.message,
      )
      expect(said).toBe(
        "plugin 'org/second' failed in graph: a#build depends on 'zz#nope', which is not a task in this run's graph",
      )
    },
    TIMEOUT,
  )

  // X-15: a raw TypeError named neither the task nor the field.
  it(
    'a graph hook that nulls deps or a node is refused naming the task',
    async () => {
      await pkg('a', build)
      const said = async (edit: string) => {
        await workspace([pluginSource('org/edit', `{ graph(nodes) { ${edit} } }`)])
        return planRun({ cwd: root, tasks: ['build'], log: silent() }).then(
          () => 'planned',
          (e: Error) => e.message,
        )
      }
      expect([
        await said(`nodes.get('a#build').deps = null`),
        await said(`nodes.set('a#build', null)`),
        await said(`nodes.get('a#build').deps = []`),
      ]).toEqual([
        "plugin 'org/edit' failed in graph: a#build's deps is null, not an array of task ids",
        "plugin 'org/edit' failed in graph: 'a#build' holds null, not a task",
        'planned',
      ])
    },
    TIMEOUT,
  )

  it(
    'a node a graph hook adds is refused, naming the field, when it lacks a project or a task',
    async () => {
      await pkg('a', build)
      // Ran: `internal error in a#x: TypeError: The "path" property must be
      // of type string`, or the command and its key in vx's own cwd.
      const said = async (fields: string) => {
        await workspace([
          pluginSource(
            'org/add',
            `{ graph(nodes) {
              const dir = nodes.get('a#build').projectDir
              nodes.set('a#x', { id: 'a#x', config: { exec: { command: 'true' } }, deps: [], requested: true, ${fields} })
            } }`,
          ),
        ])
        // Sorted: a#x and a#build run concurrently, so outcome order is a race.
        return run({ cwd: root, tasks: ['build'], log: silent(), handleSignals: false }).then(
          (s) =>
            s.outcomes
              .map((o) => `${o.node.id} ${o.status}`)
              .sort()
              .join(', '),
          (e: Error) => e.message,
        )
      }
      expect([
        await said(`projectName: 'a', taskName: 'x'`),
        await said(`projectName: 'a', taskName: 'x', projectDir: 'packages/a'`),
        await said(`projectName: 'a', projectDir: dir`),
        await said(`projectName: '', taskName: 'x', projectDir: dir`),
        // CONTROL: the whole node runs.
        await said(`projectName: 'a', taskName: 'x', projectDir: dir`),
      ]).toEqual([
        "plugin 'org/add' failed in graph: a#x's projectDir is undefined, not an absolute path",
        `plugin 'org/add' failed in graph: a#x's projectDir is "packages/a", not an absolute path`,
        "plugin 'org/add' failed in graph: a#x's taskName is undefined, not a name",
        `plugin 'org/add' failed in graph: a#x's projectName is "", not a name`,
        'a#build success, a#x success',
      ])
    },
    TIMEOUT,
  )

  describe('admit', () => {
    const graph = new Map([
      ['a', { id: 'a' } as TaskNode],
      ['b', { id: 'b' } as TaskNode],
    ])
    const busy = new Set(['a'])

    it('every answering plugin is asked, not only the first', () => {
      const admit = buildAdmission(
        [
          testPlugin('org/yes', { admit: () => true }),
          testPlugin('org/solo', { admit: (_t, ctx) => ctx.running.length === 0 }),
        ],
        graph,
        2,
        () => {},
      )!
      // CONTROL: with nothing running both admit.
      expect([admit('b', busy), admit('b', new Set())]).toEqual([false, true])
    })

    it('a policy that returns nothing admits with no word, even beside a running task', () => {
      const said: string[] = []
      const admit = buildAdmission(
        [testPlugin('org/mute', { admit: () => undefined as never })],
        graph,
        2,
        (m) => said.push(m),
      )!
      expect({ busy: admit('b', busy), idle: admit('a', new Set()), said }).toEqual({
        busy: true,
        idle: true,
        said: [],
      })
    })

    it('a policy that throws admits the task it threw on, beside a running task too', () => {
      const said: string[] = []
      const admit = buildAdmission(
        [
          testPlugin('org/boom', {
            admit: () => {
              throw new Error('boom')
            },
          }),
        ],
        graph,
        2,
        (m) => said.push(m),
      )!
      expect({ first: admit('b', busy), next: admit('b', busy), said }).toEqual({
        first: true,
        next: true,
        said: ["[vx] plugin 'org/boom' failed in admit: boom; admitting every task from here on"],
      })
    })
  })
})
