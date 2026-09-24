// The widgets' models, held to truth written out by hand: the toy monorepo
// the graph explorer draws, the key model the key calculator runs, and the
// scheduler simulator. Each widget's built page, its no-JavaScript fallback
// and the scripts that reach its element, is held by the chapter that hosts
// it (tests/guide-<slug>.test.ts).

import { describe, expect, it } from 'bun:test'
import {
  TOY_TASKS,
  TOY_SCENARIOS,
  affectedBy,
  neededBy,
  rerunBy,
  runSummary,
  toyRuns,
  waves,
  type ToyChange,
  type ToyRun,
} from '../src/components/demos/model/toy-monorepo.js'
import {
  POLICIES,
  SIM_TASKS,
  criticalPath,
  finishTable,
  lowerBound,
  schedule,
  secs,
} from '../src/components/demos/model/scheduler-sim.js'
import { instance, priorities, SHAPES, simulate } from '../../vx-bench/schedule-policy.js'

// The truth the explorer teaches, written out by hand. The model is held to
// it, so a wrong rule in the model cannot pass by agreeing with its own
// render.
const WAVES = [
  ['utils#build'],
  ['utils#test', 'ui#build', 'api#build'],
  ['ui#test', 'api#test', 'app#build'],
  ['app#test'],
]
const EDGES = [
  'api#build→api#test',
  'api#build→app#build',
  'app#build→app#test',
  'ui#build→app#build',
  'ui#build→ui#test',
  'utils#build→api#build',
  'utils#build→ui#build',
  'utils#build→utils#test',
]
const CHANGE: Record<string, { affected: string[]; rerun: string[]; needed: string[] }> = {
  utils: {
    affected: ['utils', 'ui', 'api', 'app'],
    rerun: [
      'utils#build',
      'utils#test',
      'ui#build',
      'ui#test',
      'api#build',
      'api#test',
      'app#build',
      'app#test',
    ],
    needed: [],
  },
  ui: {
    affected: ['ui', 'app'],
    rerun: ['ui#build', 'ui#test', 'app#build', 'app#test'],
    needed: ['utils#build', 'api#build'],
  },
  api: {
    affected: ['api', 'app'],
    rerun: ['api#build', 'api#test', 'app#build', 'app#test'],
    needed: ['utils#build', 'ui#build'],
  },
  app: {
    affected: ['app'],
    rerun: ['app#build', 'app#test'],
    needed: ['utils#build', 'ui#build', 'api#build'],
  },
}

describe('the toy monorepo model', () => {
  it('has eight tasks, wired by ^build and build, in four waves', () => {
    expect(TOY_TASKS.flatMap((t) => t.dependsOn.map((d) => `${d}→${t.id}`)).sort()).toEqual(EDGES)
    expect(waves()).toEqual(WAVES)
  })

  it.each(Object.keys(CHANGE))(
    'a change to %s affects, reruns and needs the written sets',
    (pkg) => {
      expect({ affected: affectedBy(pkg), rerun: rerunBy(pkg), needed: neededBy(pkg) }).toEqual(
        CHANGE[pkg]!,
      )
    },
  )

  it('orders a run by wave', () => {
    expect(waves(rerunBy('api'))).toEqual([['api#build'], ['api#test', 'app#build'], ['app#test']])
  })
})

// The key calculator's truth, written out by hand: per change, the last run's
// moved keys (and why), hits and stale outputs. tests/key-model-core.test.ts
// holds the model to real vx runs; this holds it to what the chapter says in
// words.
const ALL = [
  'utils#build',
  'utils#test',
  'ui#build',
  'ui#test',
  'api#build',
  'api#test',
  'app#build',
  'app#test',
]
interface Truth {
  moved: Record<string, 'input' | 'upstream'>
  hit: string[]
  stale: string[]
}
const SCENARIO: Record<string, Truth> = {
  utils: {
    moved: {
      'utils#build': 'input',
      'utils#test': 'input',
      'ui#build': 'upstream',
      'ui#test': 'upstream',
      'api#build': 'upstream',
      'api#test': 'upstream',
      'app#build': 'upstream',
      'app#test': 'upstream',
    },
    hit: [],
    stale: [],
  },
  app: {
    moved: { 'app#build': 'input', 'app#test': 'input' },
    hit: ['utils#build', 'utils#test', 'ui#build', 'ui#test', 'api#build', 'api#test'],
    stale: [],
  },
  env: {
    moved: {
      'api#build': 'input',
      'api#test': 'upstream',
      'app#build': 'upstream',
      'app#test': 'upstream',
    },
    hit: ['utils#build', 'utils#test', 'ui#build', 'ui#test'],
    stale: [],
  },
  stale: { moved: {}, hit: ALL, stale: ALL },
}

function truthOf(run: ToyRun): Truth {
  return {
    moved: Object.fromEntries(
      run.tasks.filter((t) => t.moved !== undefined).map((t) => [t.id, t.moved!]),
    ),
    hit: run.tasks.filter((t) => t.hit).map((t) => t.id),
    stale: run.tasks.filter((t) => t.stale).map((t) => t.id),
  }
}

/** Stop declaring an input, then edit it. */
const UNDECLARE_THEN_EDIT: ToyChange[] = [
  { kind: 'declare', input: 'ui/tsconfig.json' },
  { kind: 'edit', input: 'ui/tsconfig.json' },
]

describe('the key model', () => {
  it.each(Object.keys(SCENARIO))('the %s change moves, hits and goes stale as written', (id) => {
    const s = TOY_SCENARIOS.find((x) => x.id === id)!
    expect(truthOf(toyRuns(s.changes).at(-1)!)).toEqual(SCENARIO[id]!)
  })

  it('has exactly the four scenarios the calculator shows, in order', () => {
    expect(TOY_SCENARIOS.map((s) => s.id)).toEqual(Object.keys(SCENARIO))
  })

  it('misses everything once after an input stops being declared, because config is in the key', () => {
    const [, undeclared] = toyRuns(TOY_SCENARIOS.find((s) => s.id === 'stale')!.changes)
    // utils#test does not read tsconfig.json: only its upstream key moved.
    expect(truthOf(undeclared!)).toEqual({
      moved: { ...SCENARIO['utils']!.moved, 'utils#test': 'upstream' },
      hit: [],
      stale: [],
    })
  })

  it('builds a wrong output from a stale upstream, even on a miss', () => {
    const stale = TOY_SCENARIOS.find((s) => s.id === 'stale')!.changes
    const after = toyRuns([...stale, { kind: 'edit', input: 'ui/src/index.ts' }]).at(-1)!
    expect(truthOf(after)).toEqual({
      moved: {
        'ui#build': 'input',
        'ui#test': 'input',
        'app#build': 'upstream',
        'app#test': 'upstream',
      },
      hit: ['utils#build', 'utils#test', 'api#build', 'api#test'],
      stale: ALL,
    })
  })

  it("counts each change's run in one line, for the live region", () => {
    expect(TOY_SCENARIOS.map((s) => [s.id, runSummary(toyRuns(s.changes).at(-1)!)])).toEqual([
      ['utils', '8 run, 0 hit.'],
      ['app', '2 run, 6 hit.'],
      ['env', '4 run, 4 hit.'],
      ['stale', '0 run, 8 hit. 8 stale.'],
    ])
  })

  it('hits the old entries when an edit is undone', () => {
    const edit: ToyChange = { kind: 'edit', input: 'utils/src/index.ts' }
    const [first, , undone] = toyRuns([edit, edit])
    expect(undone!.tasks.map((t) => t.key)).toEqual(first!.tasks.map((t) => t.key))
    expect(truthOf(undone!)).toEqual({ moved: SCENARIO['utils']!.moved, hit: ALL, stale: [] })
  })

  it('stops declaring, then edits: ui and app miss once, then every task hits and four are stale', () => {
    const [, undeclared, edited] = toyRuns(UNDECLARE_THEN_EDIT)
    const ui = ['ui#build', 'ui#test', 'app#build', 'app#test']
    expect(truthOf(undeclared!)).toEqual({
      moved: {
        'ui#build': 'input',
        'ui#test': 'upstream',
        'app#build': 'upstream',
        'app#test': 'upstream',
      },
      hit: ['utils#build', 'utils#test', 'api#build', 'api#test'],
      stale: [],
    })
    expect(truthOf(edited!)).toEqual({ moved: {}, hit: ALL, stale: ui })
  })
})

// W4 (item 685). The schedules below were traced by hand, one completion at
// a time, under the rules `runGraph` keeps (highest priority first, ties in
// enqueue order, the first-started of two simultaneous completions settles
// first) and the model's lane rule (the lowest lane free at the start).
// `task lane start end`, in seconds.
const COUNT_ON_2 = [
  'utils#build 1 0 6',
  'utils#lint 2 0 1',
  'ui#lint 2 1 3',
  'api#lint 2 3 4',
  'app#lint 2 4 6',
  'ui#build 1 6 8',
  'api#build 2 6 12',
  'app#docs 1 8 18',
  'app#build 2 12 18',
  'utils#test 1 18 21',
  'ui#test 2 18 19',
  'api#test 2 19 21',
  'app#test 1 21 27',
]
const MEDIAN_ON_2 = [
  'utils#build 1 0 6',
  'app#docs 2 0 10',
  'api#build 1 6 12',
  'ui#build 2 10 12',
  'utils#test 1 12 15',
  'app#build 2 12 18',
  'ui#lint 1 15 17',
  'app#lint 1 17 19',
  'app#test 2 18 24',
  'api#test 1 19 21',
  'utils#lint 1 21 22',
  'api#lint 1 22 23',
  'ui#test 1 23 24',
]
const CRITICAL = ['utils#build', 'api#build', 'app#build', 'app#test']
/** Workers, the bound, then tasks waiting, learned durations, no history first, true durations. */
const FINISH = [
  ['1', '48 s', '48 s', '48 s', '48 s', '48 s'],
  ['2', '24 s', '27 s', '24 s', '24 s', '24 s'],
  ['3', '24 s', '24 s', '24 s', '24 s', '24 s'],
  ['4', '24 s', '24 s', '24 s', '24 s', '24 s'],
]
const NO_HISTORY = [
  ['Every task has history', '27 s', '24 s', '24 s', '24 s'],
  ['app#docs is new', '27 s', '26 s', '24 s', '24 s'],
  ['ui#lint is new', '27 s', '24 s', '26 s', '24 s'],
]

const none = new Set<string>()
const asRows = (bars: { id: string; lane: number; start: number; end: number }[]): string[] =>
  bars.map((b) => `${b.id} ${b.lane} ${b.start / 1000} ${b.end / 1000}`)

describe('the scheduler simulator model', () => {
  it('schedules the default graph on two workers as traced by hand', () => {
    expect(asRows(schedule(SIM_TASKS, none, 'count', 2).bars)).toEqual(COUNT_ON_2)
    expect(asRows(schedule(SIM_TASKS, none, 'median', 2).bars)).toEqual(MEDIAN_ON_2)
    expect(schedule(SIM_TASKS, none, 'count', 2).makespan).toBe(27_000)
    expect(schedule(SIM_TASKS, none, 'median', 2).makespan).toBe(24_000)
    expect(criticalPath(SIM_TASKS)).toEqual({ length: 24_000, chain: CRITICAL })
    expect([1, 2, 3, 4].map((w) => lowerBound(SIM_TASKS, w))).toEqual([
      48_000, 24_000, 24_000, 24_000,
    ])
  })

  it('finishes every worker count and history case at the written times', () => {
    expect(
      finishTable(SIM_TASKS, none).map((r) => [
        String(r.workers),
        secs(r.bound),
        ...POLICIES.map((p) => secs(r.makespans[p])),
      ]),
    ).toEqual(FINISH)
    for (const [label, unknown] of [
      ['Every task has history', []],
      ['app#docs is new', ['app#docs']],
      ['ui#lint is new', ['ui#lint']],
    ] as const) {
      expect([
        label,
        ...POLICIES.map((p) => secs(schedule(SIM_TASKS, new Set(unknown), p, 2).makespan)),
      ]).toEqual(NO_HISTORY.find((r) => r[0] === label)!)
    }
  })

  // The row that keeps the site's simulator and the bench's one code: were
  // the model to grow its own copy of the dispatch loop or the ranking, the
  // bench's graphs would part them. The lanes are the model's own, so each
  // is checked to hold one task at a time.
  it("runs the bench's simulator: same starts and finish on the bench's graphs", () => {
    for (const name of ['diamond(200)', 'mixed-layered(20x40/8w)', 'monorepo(200pkg/8w)']) {
      const shape = SHAPES.find((s) => s.name === name)!
      for (const mask of [0, 0.25]) {
        const { tasks, unknown } = instance(shape, 1, mask)
        for (const p of POLICIES) {
          const bench = simulate(tasks, priorities(p, tasks, unknown), shape.workers)
          const site = schedule(tasks, unknown, p, shape.workers)
          const label = `${name}@${mask} ${p}`
          expect({
            label,
            makespan: site.makespan,
            spans: site.bars.map(({ id, start, end }) => ({ id, start, end })),
          }).toEqual({ label, makespan: bench.makespan, spans: [...bench.spans] })
          for (let lane = 1; lane <= shape.workers; lane++) {
            const inLane = site.bars.filter((b) => b.lane === lane)
            for (let i = 1; i < inLane.length; i++) {
              expect(inLane[i]!.start).toBeGreaterThanOrEqual(inLane[i - 1]!.end)
            }
          }
        }
      }
    }
  })
})
