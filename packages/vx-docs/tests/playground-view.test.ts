// What the playground page computes (src/components/demos/model/playground-view.ts,
// item 700): the pure functions against hand-written truth, and the page's
// Run over the planner the site ships (`dist/playground/planner.js`, which
// playground-bundle.test.ts holds to a fresh build), through the loop the
// page teaches: run, run, edit, add a file, break a config. Core's parity
// row holds the same Run's keys to `vx run --dry=json`
// (packages/vx/tests/playground-parity.unsafe.test.ts).
//
// It reads `dist/`, which the `build` task writes; the `test` task depends
// on `build` for that reason.

import path from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import type { ProjectConfig } from '../../vx/src/config.js'
import { validateProjectConfig } from '../../vx/src/workspace/index.js'
import { PLANNER_FILE } from '../scripts/build-playground.js'
import { CONFIG_TEXTS, ENV, FILES, TASKS } from '../src/playground/workspace.js'
import {
  PLAYGROUND_ROOT,
  changeCell,
  describeChange,
  diffRuns,
  envText,
  failureSummary,
  orderLine,
  parseEnv,
  parseTasks,
  runPlayground,
  staticCells,
  staticProjects,
  staticTable,
  summarize,
  type InputDiffEntry,
  type Planner,
  type PlaygroundTask,
  type RunOutcome,
} from '../src/components/demos/model/playground-view.js'

const ALL = [
  'utils#build',
  'utils#test',
  'ui#build',
  'ui#test',
  'api#build',
  'api#test',
  'app#build',
  'app#test',
  'app#docs',
]
const BUTTON = 'packages/ui/src/button.tsx'
const BUTTON_MOVES = ['ui#build', 'ui#test', 'app#build', 'app#test']

// The static table, written out by hand.
const STATIC: [string, string, string][] = [
  ['utils#build', 'nothing', 'src/**'],
  ['utils#test', 'utils#build', 'src/**, test/**'],
  ['ui#build', 'utils#build', 'src/**'],
  ['ui#test', 'ui#build', 'src/**, test/**'],
  ['api#build', 'utils#build', 'src/**, env API_URL'],
  ['api#test', 'api#build', 'src/**, test/**'],
  ['app#build', 'ui#build, api#build', 'src/**'],
  ['app#test', 'app#build', 'src/**, test/**'],
  ['app#docs', 'nothing', 'docs/src/**'],
]

const task = (
  id: string,
  hash: string,
  cacheStatus = 'miss',
  components: PlaygroundTask['components'] = [],
): PlaygroundTask => ({
  id,
  project: id.split('#')[0]!,
  task: id.split('#')[1]!,
  hash,
  cacheStatus,
  deps: [],
  components,
})

const entry = (
  kind: string,
  name: string,
  change: InputDiffEntry['change'] = 'changed',
): InputDiffEntry => ({
  kind,
  name,
  change,
  before: change === 'added' ? null : 'b',
  after: change === 'removed' ? null : 'a',
})

let planner: Planner
let configs: Record<string, unknown>

beforeAll(async () => {
  planner = (await import(path.resolve(import.meta.dir, '../dist', PLANNER_FILE))) as Planner
  configs = {}
  for (const [name, text] of Object.entries(CONFIG_TEXTS)) {
    const r = await planner.evaluateConfig(text, 10_000)
    if (!r.ok) throw new Error(`${name}: ${r.error}`)
    configs[name] = r.config
  }
})

describe('the playground view', () => {
  it('diffs a run against the one before: new, same or moved, by task id', () => {
    const diff = planner.diffKeyComponents
    const was = [
      { kind: 'file', name: 'a/x.ts', hash: '1' },
      { kind: 'env', name: 'GONE', hash: '2' },
    ]
    const now = [
      { kind: 'file', name: 'a/x.ts', hash: '3' },
      { kind: 'file', name: 'a/new.ts', hash: '4' },
    ]
    const before = [task('a#build', '1111', 'miss', was), task('a#test', '2222', 'miss', was)]
    const after = [
      task('a#build', '1111', 'hit-local', now),
      task('a#test', '3333', 'miss', now),
      task('b#x', '4'),
    ]
    expect(diffRuns(undefined, before, diff)).toEqual([
      { id: 'a#build', key: '1111', status: 'miss', change: 'new', why: [] },
      { id: 'a#test', key: '2222', status: 'miss', change: 'new', why: [] },
    ])
    // Only a moved key is diffed: `a#build`'s components differ too, but its
    // key did not move.
    expect(diffRuns(before, after, diff)).toEqual([
      { id: 'a#build', key: '1111', status: 'hit', change: 'same', why: [] },
      {
        id: 'a#test',
        key: '3333',
        status: 'miss',
        change: 'moved',
        why: [
          { kind: 'env', name: 'GONE', change: 'removed', before: '2', after: null },
          { kind: 'file', name: 'a/new.ts', change: 'added', before: null, after: '4' },
          { kind: 'file', name: 'a/x.ts', change: 'changed', before: '1', after: '3' },
        ],
      },
      { id: 'b#x', key: '4', status: 'miss', change: 'new', why: [] },
    ])
    expect(diffRuns(undefined, [task('a#b', `${'f'.repeat(16)}0123`, 'no-cache')], diff)).toEqual([
      { id: 'a#b', key: 'f'.repeat(16), status: 'no cache', change: 'new', why: [] },
    ])
  })

  it('names a moved component in the words of its kind', () => {
    expect(
      [
        entry('file', 'packages/ui/src/button.tsx'),
        entry('file', 'packages/ui/src/new.tsx', 'added'),
        entry('file', 'packages/ui/src/old.tsx', 'removed'),
        entry('upstream', 'ui#build'),
        entry('upstream', 'api#build', 'added'),
        entry('upstream', 'api#build', 'removed'),
        entry('env', 'API_URL'),
        entry('env', 'API_URL', 'added'),
        entry('env', 'API_URL', 'removed'),
        entry('config', 'config'),
        entry('package', 'package.json'),
        entry('workspace', 'fingerprint'),
        entry('forward', 'argv'),
        entry('forward', 'argv', 'added'),
        entry('runtime', 'node --version'),
        entry('ws-runtime', 'git rev-parse HEAD'),
        entry('plugin', 'lockfile'),
        entry('someday', 'x'),
      ].map(describeChange),
    ).toEqual([
      'packages/ui/src/button.tsx changed',
      'file added: packages/ui/src/new.tsx',
      'file removed: packages/ui/src/old.tsx',
      'upstream ui#build moved',
      'upstream api#build added',
      'upstream api#build removed',
      'env API_URL changed',
      'env API_URL added',
      'env API_URL removed',
      'config changed',
      'package.json changed',
      'workspace fingerprint changed',
      'args after -- changed',
      'args after -- added',
      'output of node --version changed',
      'workspace output of git rev-parse HEAD changed',
      'plugin part lockfile changed',
      'someday x changed',
    ])
  })

  it('names at most two changes in the cell, then how many more', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((f) => entry('file', f))
    const cell = (change: 'new' | 'moved' | 'same', n: number) =>
      changeCell({ change, why: files.slice(0, n) })
    expect([cell('new', 0), cell('same', 0), cell('moved', 0)]).toEqual(['new', '', 'moved'])
    expect([1, 2, 3, 4].map((n) => cell('moved', n))).toEqual([
      'a.ts changed',
      'a.ts changed, b.ts changed',
      'a.ts changed, b.ts changed and 1 more',
      'a.ts changed, b.ts changed and 2 more',
    ])
  })

  it('says a run in one sentence', () => {
    const row = (id: string, status: string, change: 'new' | 'moved' | 'same') => ({
      id,
      key: '0',
      status,
      change,
      why: [],
    })
    expect(summarize([row('a#x', 'miss', 'new'), row('b#x', 'miss', 'new')])).toBe(
      '2 tasks: 0 hit, 2 miss. Every key is new.',
    )
    expect(summarize([row('a#x', 'hit', 'same')])).toBe('1 task: 1 hit, 0 miss. No key moved.')
    expect(
      summarize([
        row('a#x', 'hit', 'same'),
        row('b#x', 'miss', 'moved'),
        row('c#x', 'miss', 'moved'),
        row('d#x', 'no cache', 'new'),
        row('e#x', 'group', 'same'),
      ]),
    ).toBe('5 tasks: 1 hit, 2 miss, 1 no cache, 1 group. Keys moved: b#x, c#x. New: d#x.')
    expect(failureSummary(['x'], false)).toBe('The run failed.')
    expect(failureSummary(['x', 'y'], true)).toBe(
      "The run failed with 2 errors. The table is the last good run's, marked stale.",
    )
    expect(orderLine(['a#x', 'b#x'])).toBe(
      "On 2 workers, vx's scheduler dispatches them in this order: a#x, b#x.",
    )
  })

  it('parses NAME=value lines and the task specs', () => {
    expect(parseEnv('A=1\n\n# note\nB_2 = x=y \r\nA=3')).toEqual({
      ok: true,
      env: { A: '3', B_2: ' x=y ' },
    })
    expect(parseEnv('')).toEqual({ ok: true, env: {} })
    expect(parseEnv('A=1\nnot a line')).toEqual({
      ok: false,
      error: "env line 2: expected NAME=value, got 'not a line'",
    })
    expect(parseEnv('1A=x')).toEqual({
      ok: false,
      error: "env line 1: expected NAME=value, got '1A=x'",
    })
    expect(parseEnv(envText(ENV))).toEqual({ ok: true, env: ENV })
    expect(parseTasks('  build\ttest \n')).toEqual({ ok: true, tasks: ['build', 'test'] })
    expect(parseTasks(' ')).toEqual({ ok: false, error: 'name at least one task' })
  })

  it('tabulates the workspace from its config texts', () => {
    expect(staticTable(staticProjects(FILES, configs)).map(staticCells)).toEqual(STATIC)
  })

  it("resolves what each task waits for as the planner does, for the page's workspace", async () => {
    const r = await planner.planPlayground({
      root: PLAYGROUND_ROOT,
      files: FILES,
      configs,
      env: ENV,
      tasks: TASKS,
    })
    const planned = Object.fromEntries(r.tasks.map((t) => [t.id, [...t.deps].sort()]))
    const table = Object.fromEntries(
      staticTable(staticProjects(FILES, configs)).map((row) => [row.id, [...row.waitsFor].sort()]),
    )
    expect(Object.keys(table).sort()).toEqual([...ALL].sort())
    expect(table).toEqual(planned)
  })
})

describe("the page's Run, over the planner the site ships", () => {
  const ok = (o: RunOutcome) => {
    if (!o.ok) throw new Error(o.errors.join('\n'))
    return o
  }
  const statuses = (o: { tasks: PlaygroundTask[] }) =>
    Object.fromEntries(o.tasks.map((t) => [t.id, t.cacheStatus]))
  const moved = (before: PlaygroundTask[], after: PlaygroundTask[]) =>
    diffRuns(before, after, planner.diffKeyComponents)
      .filter((r) => r.change === 'moved')
      .map((r) => r.id)
  const each = (status: string, ids = ALL) => Object.fromEntries(ids.map((id) => [id, status]))
  const run = (files: Record<string, string>, cached: ReadonlySet<string>, tasks = TASKS) =>
    runPlayground(planner, { files, env: ENV, tasks, cached })

  it('misses everywhere first, saves every key, and hits everywhere on a second run', async () => {
    const first = ok(await run(FILES, new Set()))
    expect(first.tasks.map((t) => t.id)).toEqual(ALL)
    expect(statuses(first)).toEqual(each('miss'))
    expect([...first.cached].sort()).toEqual(first.tasks.map((t) => t.hash).sort())
    expect(first.cached.size).toBe(9)
    const second = ok(await run(FILES, first.cached))
    expect(statuses(second)).toEqual(each('hit-local'))
    expect(moved(first.tasks, second.tasks)).toEqual([])
    expect(summarize(diffRuns(first.tasks, second.tasks, planner.diffKeyComponents))).toBe(
      '9 tasks: 9 hit, 0 miss. No key moved.',
    )
  })

  it(`an edit to ${BUTTON} moves exactly ${BUTTON_MOVES.join(', ')}; a file no config names moves nothing`, async () => {
    const first = ok(await run(FILES, new Set()))
    const edited = { ...FILES, [BUTTON]: `${FILES[BUTTON]}// edited\n` }
    const afterEdit = ok(await run(edited, first.cached))
    expect(moved(first.tasks, afterEdit.tasks)).toEqual(BUTTON_MOVES)
    expect(statuses(afterEdit)).toEqual({
      ...each('hit-local'),
      ...each('miss', BUTTON_MOVES),
    })
    expect(summarize(diffRuns(first.tasks, afterEdit.tasks, planner.diffKeyComponents))).toBe(
      '9 tasks: 5 hit, 4 miss. Keys moved: ui#build, ui#test, app#build, app#test.',
    )
    const added = ok(await run({ ...edited, 'packages/ui/README.md': '# ui\n' }, afterEdit.cached))
    expect(moved(afterEdit.tasks, added.tasks)).toEqual([])
    expect(statuses(added)).toEqual(each('hit-local'))
  })

  it(`names what the ${BUTTON} edit moved in each key, as vx why does`, async () => {
    const first = ok(await run(FILES, new Set()))
    const edited = { ...FILES, [BUTTON]: `${FILES[BUTTON]}// edited\n` }
    const afterEdit = ok(await run(edited, first.cached))
    const named = diffRuns(first.tasks, afterEdit.tasks, planner.diffKeyComponents)
      .filter((r) => r.change === 'moved')
      .map((r) => ({
        id: r.id,
        why: r.why.map((e) => [e.kind, e.name, e.change]),
        cell: changeCell(r),
      }))
    expect(named).toEqual([
      { id: 'ui#build', why: [['file', BUTTON, 'changed']], cell: `${BUTTON} changed` },
      {
        id: 'ui#test',
        why: [
          ['file', BUTTON, 'changed'],
          ['upstream', 'ui#build', 'changed'],
        ],
        cell: `${BUTTON} changed, upstream ui#build moved`,
      },
      {
        id: 'app#build',
        why: [['upstream', 'ui#build', 'changed']],
        cell: 'upstream ui#build moved',
      },
      {
        id: 'app#test',
        why: [['upstream', 'app#build', 'changed']],
        cell: 'upstream app#build moved',
      },
    ])
  })

  it('moves its test alone for a test file, and the four above api for API_URL', async () => {
    const first = ok(await run(FILES, new Set()))
    const testEdit = {
      ...FILES,
      'packages/utils/test/index.test.ts': `${FILES['packages/utils/test/index.test.ts']}// edited\n`,
    }
    const second = ok(await run(testEdit, first.cached))
    expect(moved(first.tasks, second.tasks)).toEqual(['utils#test'])
    const third = ok(
      await runPlayground(planner, {
        files: testEdit,
        env: { API_URL: 'https://staging.example.com' },
        tasks: TASKS,
        cached: second.cached,
      }),
    )
    expect(moved(second.tasks, third.tasks)).toEqual([
      'api#build',
      'api#test',
      'app#build',
      'app#test',
    ])
  })

  it('names the project and file of a config that does not evaluate', async () => {
    const broken = CONFIG_TEXTS['api']!.replace(/\}\)\n$/, ')\n')
    const r = await run({ ...FILES, 'packages/api/vx.config.mjs': broken }, new Set())
    expect(r.ok).toBe(false)
    const errors = r.ok ? [] : r.errors
    expect(errors).toHaveLength(1)
    // The rest is the engine's: Bun says AggregateError, Chromium SyntaxError.
    expect(errors[0]).toMatch(/^api \(packages\/api\/vx\.config\.mjs\): \w+Error: \S/)
  })

  it("shows core's refusal of a config unchanged", async () => {
    const text = CONFIG_TEXTS['app']!.replace("command: 'astro build --root docs'", 'command: 42')
    const r = await run({ ...FILES, 'packages/app/vx.config.mjs': text }, new Set())
    const evaluated = await planner.evaluateConfig(text, 10_000)
    if (!evaluated.ok) throw new Error(evaluated.error)
    const core = (() => {
      try {
        validateProjectConfig(
          evaluated.config as ProjectConfig,
          `${PLAYGROUND_ROOT}/packages/app/vx.config.mjs`,
        )
      } catch (e) {
        return (e as Error).message
      }
      return 'core accepted it'
    })()
    expect(core).toContain('command')
    expect(r).toEqual({ ok: false, errors: [core] })
  })

  it('refuses a task spec no project declares, in the CLI words', async () => {
    expect(await run(FILES, new Set(), ['build', 'lint'])).toEqual({
      ok: false,
      errors: ['no projects declare task(s): lint.'],
    })
  })
})
