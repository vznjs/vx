// K(T): the projects a task's cache key answers for, which bounds the
// `node_modules` link grant of a sandboxed task that declares `cache`
// (docs/design/linked-sibling-reads-2026-09.md, rules 4 and 5). Too wide
// and the sandbox grants a sibling whose edits would not move the key — the
// stale hit it exists to rule out; too narrow and a keyed dependency is
// denied. So the walk is held twice: row by row on hand-built graphs (R3),
// and against the key itself, computed by `run()` (R4).

import { appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { TaskConfig } from '../src/config.js'
import type { TaskNode } from '../src/graph/index.js'
import { keyedProjects } from '../src/orchestrator/keyed-projects.js'
import { run } from '../src/orchestrator/index.js'
import {
  addProject,
  FORCE,
  makeWorkspace,
  silentLogger,
  TIMEOUT,
  type Fixture,
} from './helpers/orchestrator-fixture.js'

const CACHED: TaskConfig = {
  exec: { command: 'true' },
  cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
}
const UNCACHED: TaskConfig = { exec: { command: 'true' } }
const GROUP: TaskConfig = {}
const PERSISTENT: TaskConfig = { exec: { command: 'true', persistent: {} } }

/** A graph from `id → [config, deps]`; each project's directory is `/ws/<project>`. */
function graph(spec: Record<string, [TaskConfig, string[]]>): Map<string, TaskNode> {
  const nodes = new Map<string, TaskNode>()
  for (const [id, [config, deps]] of Object.entries(spec)) {
    const [projectName, taskName] = id.split('#') as [string, string]
    nodes.set(id, {
      id,
      projectName,
      projectDir: `/ws/${projectName}`,
      taskName,
      config,
      deps,
      requested: false,
    })
  }
  return nodes
}

const keyedOf = (nodes: Map<string, TaskNode>, id: string): string[] =>
  [...keyedProjects(nodes)(nodes.get(id)!)].sort()

const withTasks = (config: TaskConfig, tasks: string[]): TaskConfig => ({
  ...config,
  cache: { ...config.cache!, inputs: { ...config.cache!.inputs, tasks } },
})

describe('the walk (R3)', () => {
  it('a group chain down to a cached `source` keys its project', () => {
    const nodes = graph({
      'app#test': [CACHED, ['app#install']],
      'app#install': [GROUP, ['ui#build']],
      'ui#build': [GROUP, ['ui#source']],
      'ui#source': [CACHED, []],
    })
    expect(keyedOf(nodes, 'app#test')).toEqual(['/ws/ui'])
  })

  it('an uncached task keys its own project and is walked through', () => {
    // The design assumed an uncached task's hash folds no files. It folds
    // every file of its project: no `cache` means no `inputs.files`, and
    // that is `**/*` (R4 below holds it to the key).
    const bare = graph({
      'app#test': [CACHED, ['ui#build']],
      'ui#build': [UNCACHED, []],
    })
    expect(keyedOf(bare, 'app#test')).toEqual(['/ws/ui'])
    const through = graph({
      'app#test': [CACHED, ['ui#build']],
      'ui#build': [UNCACHED, ['lib#source']],
      'lib#source': [CACHED, []],
    })
    expect(keyedOf(through, 'app#test')).toEqual(['/ws/lib', '/ws/ui'])
  })

  it('a group keys nothing of its own project', () => {
    const nodes = graph({
      'app#test': [CACHED, ['ui#ci']],
      'ui#ci': [GROUP, ['lib#source']],
      'lib#source': [CACHED, []],
    })
    expect(keyedOf(nodes, 'app#test')).toEqual(['/ws/lib'])
  })

  it("the task's own `cache.inputs.tasks` drops what it excludes", () => {
    const nodes = graph({
      'app#test': [withTasks(CACHED, ['^*', '!^build']), ['ui#build', 'lib#source']],
      'ui#build': [CACHED, []],
      'lib#source': [CACHED, []],
    })
    expect(keyedOf(nodes, 'app#test')).toEqual(['/ws/lib'])
  })

  it('a hop with `inputs.tasks: []` keys its own project and stops the walk there', () => {
    const nodes = graph({
      'app#test': [CACHED, ['mid#bundle']],
      'mid#bundle': [withTasks(CACHED, []), ['ui#source']],
      'ui#source': [CACHED, []],
    })
    expect(keyedOf(nodes, 'app#test')).toEqual(['/ws/mid'])
  })

  it('a transitive route through a third project', () => {
    const nodes = graph({
      'app#test': [CACHED, ['mid#build']],
      'mid#build': [CACHED, ['ui#source']],
      'ui#source': [CACHED, []],
    })
    expect(keyedOf(nodes, 'app#test')).toEqual(['/ws/mid', '/ws/ui'])
  })

  it('a persistent task has no hash: nothing beneath it reaches the key', () => {
    const nodes = graph({
      'app#test': [CACHED, ['ui#dev']],
      'ui#dev': [PERSISTENT, ['ui#source']],
      'ui#source': [CACHED, []],
    })
    expect(keyedOf(nodes, 'app#test')).toEqual([])
  })

  it('two groups over the same members share one hash: excluding one excludes both', () => {
    const nodes = graph({
      'app#test': [withTasks(CACHED, ['^*', '!ui#pack']), ['ui#pack', 'ui#pack2']],
      'ui#pack': [GROUP, ['ui#source']],
      'ui#pack2': [GROUP, ['ui#source']],
      'ui#source': [CACHED, []],
    })
    expect(keyedOf(nodes, 'app#test')).toEqual([])
  })

  it('the task itself is not counted, and a shared subgraph answers the same for each asker', () => {
    const nodes = graph({
      'app#test': [CACHED, ['app#source', 'ui#source']],
      'app#lint': [CACHED, ['ui#source']],
      'app#source': [CACHED, []],
      'ui#source': [CACHED, []],
    })
    const keyed = keyedProjects(nodes)
    expect([...keyed(nodes.get('app#lint')!)]).toEqual(['/ws/ui'])
    expect([...keyed(nodes.get('app#test')!)].sort()).toEqual(['/ws/app', '/ws/ui'])
    expect([...keyed(nodes.get('ui#source')!)]).toEqual([])
  })
})

// The source of truth is the key: for each shape, `run()` computes
// `@x/app#test`'s real hash, then every other project's `src/index.js` is
// edited in turn. The hash must move for exactly the projects K(T) names —
// both directions, so a K(T) that drifts from the hash path either way
// (wider: a sibling granted whose edit does not move the key; narrower: a
// keyed dependency denied) is red here whatever the rows above say.
describe('K(T) is what moves the key (R4)', () => {
  let fixture: Fixture
  const dirs = new Map<string, string>()
  const PROJECTS = ['@x/ui', '@x/mid', '@x/other']

  beforeAll(async () => {
    fixture = await makeWorkspace('vx-keyed-')
    dirs.set(
      '@x/ui',
      await addProject(fixture.root, '@x/ui', {
        files: { 'src/index.js': 'export const ui = 1\n' },
        config: `
          export default {
            tasks: {
              source: {
                exec: { command: 'true' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
              },
              build: { exec: { command: 'true' }, dependsOn: ['source'] },
              bare: { exec: { command: 'true' } },
              pack: { dependsOn: ['source'] },
              pack2: { dependsOn: ['source'] },
              dev: { exec: { command: 'true', persistent: {} }, dependsOn: ['source'] },
            },
          }
        `,
      }),
    )
    dirs.set(
      '@x/mid',
      await addProject(fixture.root, '@x/mid', {
        deps: { '@x/ui': 'workspace:*' },
        files: { 'src/index.js': 'export const mid = 1\n' },
        config: `
          export default {
            tasks: {
              relay: { dependsOn: ['^source'] },
              bundle: {
                exec: { command: 'true' },
                dependsOn: ['^source'],
                cache: { inputs: { files: ['src/**'], tasks: [] }, outputs: { files: [] } },
              },
            },
          }
        `,
      }),
    )
    dirs.set(
      '@x/other',
      await addProject(fixture.root, '@x/other', {
        files: { 'src/index.js': 'export const other = 1\n' },
        config: `
          export default {
            tasks: {
              source: {
                exec: { command: 'true' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
              },
            },
          }
        `,
      }),
    )
  }, TIMEOUT)

  afterAll(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  interface Shape {
    title: string
    dependsOn: string[]
    tasks?: string[]
    keyed: string[]
  }
  const shapes: Shape[] = [
    { title: 'a group chain to a cached source', dependsOn: ['install'], keyed: ['@x/ui'] },
    {
      title: 'an uncached task with no route of its own',
      dependsOn: ['@x/ui#bare'],
      keyed: ['@x/ui'],
    },
    { title: 'through an uncached task', dependsOn: ['@x/ui#build'], keyed: ['@x/ui'] },
    {
      title: "the task's own filter",
      dependsOn: ['@x/ui#build'],
      tasks: ['^*', '!^build'],
      keyed: [],
    },
    { title: 'a hop that folds nothing', dependsOn: ['@x/mid#bundle'], keyed: ['@x/mid'] },
    { title: 'a route through a third project', dependsOn: ['@x/mid#relay'], keyed: ['@x/ui'] },
    { title: 'a persistent task in between', dependsOn: ['@x/ui#dev'], keyed: [] },
    {
      title: 'two groups over the same members, one excluded',
      dependsOn: ['@x/ui#pack', '@x/ui#pack2'],
      tasks: ['^*', '!@x/ui#pack'],
      keyed: [],
    },
  ]

  const appConfig = (s: Shape): string => `
    export default {
      tasks: {
        install: { dependsOn: ['^pack'] },
        test: {
          exec: { command: 'true' },
          dependsOn: ${JSON.stringify(s.dependsOn)},
          cache: {
            inputs: { files: ['src/**']${s.tasks === undefined ? '' : `, tasks: ${JSON.stringify(s.tasks)}`} },
            outputs: { files: [] },
          },
        },
      },
    }
  `

  // Two paths derive a key: the live one folds the upstream outcomes as
  // they finish (`--force`, or any run with a remote cache), and the local
  // classify pass derives stable keys up front (stable-keys.ts), whose
  // hash a miss then saves under. K(T) must hold under both.
  const testRun = async (live: boolean) => {
    const r = await run({
      cwd: fixture.root,
      tasks: ['@x/app#test'],
      log: silentLogger(fixture),
      ...(live ? { cache: FORCE } : {}),
    })
    expect(r.ok).toBe(true)
    const test = r.outcomes.find((o) => o.node.id === '@x/app#test')!
    const nodes = new Map(r.outcomes.map((o) => [o.node.id, o.node]))
    return { hash: test.hash!, node: test.node, nodes }
  }

  /** The projects whose `src/index.js` edit moves `@x/app#test`'s key. */
  const movers = async (live: boolean, title: string): Promise<string[]> => {
    const base = (await testRun(live)).hash
    const moved: string[] = []
    for (const p of PROJECTS) {
      const file = path.join(dirs.get(p)!, 'src', 'index.js')
      const before = await readFile(file, 'utf8')
      await appendFile(file, `// ${title}\n`)
      try {
        if ((await testRun(live)).hash !== base) moved.push(p)
      } finally {
        await writeFile(file, before)
      }
    }
    return moved
  }

  for (const s of shapes) {
    it(
      s.title,
      async () => {
        await rm(path.join(fixture.root, 'packages', 'x-app'), { recursive: true, force: true })
        await addProject(fixture.root, '@x/app', {
          deps: { '@x/ui': 'workspace:*', '@x/mid': 'workspace:*' },
          files: { 'src/index.js': 'export const app = 1\n' },
          config: appConfig(s),
        })
        const { node, nodes } = await testRun(true)
        const keyed = keyedProjects(nodes)(node)
        expect(PROJECTS.filter((p) => keyed.has(dirs.get(p)!))).toEqual(s.keyed)

        expect(await movers(true, s.title)).toEqual(s.keyed)
        expect(await movers(false, s.title)).toEqual(s.keyed)
        // One key on both paths, or a `--force` or remote run saves entries
        // a plain local run never probes (a persistent upstream once split
        // them: the classify pass hashed it and the live path did not).
        expect((await testRun(false)).hash).toBe((await testRun(true)).hash)
      },
      TIMEOUT,
    )
  }
})
