// Chapter 4, guide/concurrency, teaches with the scheduler simulator
// (demos/SchedulerSim.astro, item 685). The simulator ranks ready tasks with
// vx's own code and its dispatch loop is held to the real scheduler by
// vx-bench's tests/schedule-policy.test.ts. This holds the model to a
// schedule traced by hand, the built chapter to the model, and every number
// the prose says to what the model computes.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_PAIR,
  DEFAULT_WORKERS,
  POLICIES,
  SIM_TASKS,
  criticalPath,
  describeSchedule,
  finishTable,
  lowerBound,
  schedule,
  secs,
} from '../src/components/demos/model/scheduler-sim.js'
import {
  instance,
  pluginPriorities,
  priorities,
  SHAPES,
  simulate,
} from '../../vx-bench/schedule-policy.js'
import * as P from '../src/components/guide/concurrency/pictures.js'
import {
  DIST,
  chapterShape,
  content,
  defining,
  only,
  page,
  section,
  sourceBlocks,
  tableRows,
  text,
} from './guide-page.js'

// The schedules below were traced by hand, one completion at a time, under
// the rules `runGraph` keeps (highest priority first, ties in enqueue
// order, the first-started of two simultaneous completions settles first)
// and the model's lane rule (the lowest lane free at the start).
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
/** A task new to the history, on two workers: the same four policies. */
const NO_HISTORY = [
  ['Every task has history', '27 s', '24 s', '24 s', '24 s'],
  ['app#docs is new', '27 s', '26 s', '24 s', '24 s'],
  ['ui#lint is new', '27 s', '24 s', '26 s', '24 s'],
]

const none = new Set<string>()
/** The eight build and test tasks of chapters 2 and 3: the pictures' graph. */
const EIGHT = SIM_TASKS.filter((t) => /#(build|test)$/.test(t.id))
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

chapterShape({
  slug: 'concurrency',
  titles: [
    'Tasks that don’t need each other run together',
    'Each worker runs one task at a time',
    'The longest chain sets the finish line',
    'Start the longest chain first',
  ],
  pictures: [P.together, P.workers, P.chain],
  rows: {
    'packages/vx/tests/scheduler.test.ts': [
      'respects the concurrency cap',
      'prefers the task that blocks the most downstream work',
      'counts TRANSITIVE dependents, deduplicated across a diamond',
      'ties break in graph-insertion order (topo from buildTaskGraph)',
    ],
    'packages/vx/tests/cgroup.test.ts': [
      'parallelism: the cores capped by the quota, rounded UP, never below one',
    ],
    'packages/vx/tests/show-info.test.ts': ['names where the worker count comes from'],
    'packages/vx-schedule-history/tests/schedule-history.test.ts': [
      'a node with dependents folds the max downstream chain',
    ],
    'packages/vx-bench/tests/schedule-policy.test.ts': [
      'reproduces the real dispatch order, start times and makespan',
    ],
  },
})

describe('guide/concurrency', () => {
  const html = page('guide/concurrency')
  const main = content(html)
  const prose = text(main)
  const element = only(main, /<vx-scheduler-sim\b[^>]*>([\s\S]*?)<\/vx-scheduler-sim>/g)
  const charts = [
    ...element.matchAll(/<div class="chart\b[^"]*" data-slot="(\d)">([\s\S]*?<\/svg>)/g),
  ]
  const bars = (chart: string): string[] =>
    [
      ...chart.matchAll(
        /<g class="bar[^"]*" data-task="([^"]+)" data-lane="(\d+)" data-start="(\d+)" data-end="(\d+)"/g,
      ),
    ].map((m) => `${m[1]} ${m[2]} ${Number(m[3]) / 1000} ${Number(m[4]) / 1000}`)
  const critical = (chart: string): string[] =>
    [...chart.matchAll(/<g class="bar is-critical[^"]*" data-task="([^"]+)"/g)].map((m) => m[1]!)

  it('hosts the simulator and no other widget', () => {
    expect([...main.matchAll(/<vx-[\w-]+\b/g)].map((m) => m[0])).toEqual(['<vx-scheduler-sim'])
  })

  // The chapter's one comparison: the eight build and test tasks on one
  // worker, then on two. The picture computes it from the model; the truth
  // is written here, and the model is held to it.
  it('draws its one comparison from the model: one worker, then two', () => {
    const runs = [1, 2].map((w) => schedule(EIGHT, none, 'count', w))
    expect(runs.map((r) => r.makespan)).toEqual([32_000, 24_000])
    expect(P.RUNS).toEqual(runs)
    // One box per task per run, in the lane the model put it, in time order.
    const x0 = P.workers.boxes[0]!.x
    const scale = (P.workers.boxes[1]!.x - x0) / (runs[0]!.bars[1]!.start / 1000)
    const drawn = P.workers.boxes.map((b) => {
      const [workers, id] = b.id.split('/') as [string, string]
      return `${workers} ${id} ${b.title} ${Math.round((b.x - x0) / scale)}`
    })
    expect(drawn.sort()).toEqual(
      runs
        .flatMap((r) => r.bars.map((b) => `${r.workers} ${b.id} ${b.id} ${b.start / 1000}`))
        .sort(),
    )
    expect(drawn).toHaveLength(16)
    const notes = P.workers.notes!.map((n) => n.text)
    expect([notes.includes('32 s'), notes.includes('24 s')]).toEqual([true, true])
    // The chain is what the picture highlights.
    const highlighted = P.workers.boxes.filter((b) => b.tone === 'accent').map((b) => b.title)
    expect([...new Set(highlighted)]).toEqual(CRITICAL)
  })

  it('draws the chain the model finds, and the two builds that start together', () => {
    expect(criticalPath(EIGHT)).toEqual({ length: 24_000, chain: CRITICAL })
    expect(P.chain.boxes.map((b) => b.id)).toEqual(CRITICAL)
    for (const id of ['ui#build', 'api#build']) {
      expect(SIM_TASKS.find((t) => t.id === id)!.deps).toEqual(['utils#build'])
    }
    expect(P.together.arrows!.map((a) => `${a.from}→${a.to}`)).toEqual([
      'utils#build→ui#build',
      'utils#build→api#build',
    ])
  })

  it('draws two Gantt charts of the default graph, with the hand-traced bars', () => {
    expect(charts.map((c) => c[1])).toEqual(['0', '1'])
    expect(bars(charts[0]![2]!)).toEqual(COUNT_ON_2)
    expect(bars(charts[1]![2]!)).toEqual(MEDIAN_ON_2)
    for (const c of charts) expect(critical(c[2]!).sort()).toEqual([...CRITICAL].sort())
    expect(only(charts[0]![2]!, /<svg\b[^>]*aria-label="([^"]*)"/g)).toBe(
      'Tasks waiting on 2 workers finishes at 27 s: worker 1 runs utils#build 0–6 s, ' +
        'ui#build 6–8 s, app#docs 8–18 s, utils#test 18–21 s, app#test 21–27 s; worker 2 ' +
        'runs utils#lint 0–1 s, ui#lint 1–3 s, api#lint 3–4 s, app#lint 4–6 s, api#build ' +
        '6–12 s, app#build 12–18 s, ui#test 18–19 s, api#test 19–21 s.',
    )
    expect(charts.map((c) => only(c[2]!, /data-bound="(\d+)"/g))).toEqual(['24000', '24000'])
    expect(charts.map((c) => only(c[2]!, /data-done="(\d+)"/g))).toEqual(['27000', '24000'])
    expect(
      charts.map((c) => text(only(c[2]!, /<p class="chart-title\b[^"]*">([\s\S]*?)<\/p>/g))),
    ).toEqual([
      'Tasks waiting (vx with no plugin): done at 27 s',
      'Learned durations (vx with @vzn/vx-schedule-history): done at 24 s',
    ])
    expect(text(only(element, /<p class="bounds\b[^"]*">([\s\S]*?)<\/p>/g))).toBe(
      'No order can finish before 24 s. The critical path, utils#build → api#build → ' +
        'app#build → app#test, takes 24 s, and 48 s of work spread over 2 workers takes 24 s.',
    )
  })

  it('renders what the model computes, so the fallback and the element agree', () => {
    for (const [slot, policy] of DEFAULT_PAIR.entries()) {
      const sched = schedule(SIM_TASKS, none, policy, DEFAULT_WORKERS)
      const svg = only(charts[slot]![2]!, /(<svg\b[\s\S]*<\/svg>)/g)
      expect(bars(svg)).toEqual(asRows(sched.bars))
      expect(svg).toMatch(/^<svg\b[^>]*role="img"/)
      expect(only(svg, /^<svg\b[^>]*aria-label="([^"]*)"/g)).toBe(describeSchedule(sched))
    }
  })

  it('states the finish times and the durations in tables', () => {
    const finish = only(element, /(<table class="finish\b[\s\S]*?<\/table>)/g)
    expect(tableRows(finish)).toEqual(FINISH)
    expect(only(finish, /<tr data-workers="2" class="([^"]*)"/g)).toContain('is-selected')
    const tasks = tableRows(only(element, /(<table class="tasks\b[\s\S]*?<\/table>)/g))
    expect(tasks.map((r) => r.slice(0, 3))).toEqual(
      SIM_TASKS.map((t) => [
        t.id,
        t.deps.length === 0 ? 'nothing' : t.deps.join(', '),
        `${t.dur / 1000} s`,
      ]),
    )
  })

  it('keeps the controls that need JavaScript hidden in the static page', () => {
    expect(only(element, /<div class="controls\b[^"]*"([^>]*)>/g).trim()).toBe('hidden')
    expect(only(element, /<p class="status\b[^"]*"([^>]*)>/g).trim()).toBe(
      'aria-live="polite" hidden',
    )
    const jsOnly = [...element.matchAll(/<\w+\b[^>]*class="js-only\b[^"]*"[^>]*>/g)].map(
      (m) => m[0],
    )
    // The No history heading, and per task a duration field and a box.
    expect(jsOnly).toHaveLength(1 + 2 * SIM_TASKS.length)
    for (const tag of jsOnly) expect(tag).toMatch(/\shidden(?=[\s>=])/)
    expect(
      [...element.matchAll(/<select name="policy" data-slot="(\d)"/g)].map((m) => m[1]),
    ).toEqual(['0', '1'])
  })

  // On this graph counting only DIRECT dependents ranks every task the same
  // way, so no schedule above can tell the two apart.
  it('ranks the default graph as vx does: by the tasks waiting, or by the chain ahead', () => {
    expect(Object.fromEntries(priorities('count', SIM_TASKS, none))).toEqual({
      ...Object.fromEntries(SIM_TASKS.map((t) => [t.id, 0])),
      'utils#build': 7,
      'ui#build': 3,
      'api#build': 3,
      'app#build': 1,
    })
    const ahead = pluginPriorities('oracle', SIM_TASKS, none)!
    expect(
      ['utils#build', 'app#docs', 'utils#lint', 'ui#lint', 'api#lint', 'app#lint'].map(
        (id) => ahead.get(id)! / 1000,
      ),
    ).toEqual([24, 10, 1, 2, 1, 2])
    expect(prose).toContain('vx starts the task that the most others wait on')
    expect(prose).toContain('starts the one with the longest chain ahead, learned from past runs')
  })

  it('answers its one check as the model does', () => {
    expect(text(section(main, 'check-yourself'))).toContain(
      'No. The longest chain still runs one task after another.',
    )
    for (const p of DEFAULT_PAIR) expect(schedule(EIGHT, none, p, 3).makespan).toBe(24_000)
    expect(criticalPath(EIGHT).length).toBe(24_000)
  })

  it('shows the flag the CLI defines', () => {
    expect(sourceBlocks('concurrency')).toEqual(['vx run build test --concurrency 4\n'])
    const flag = [...page('cli').matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
      .map((r) => [...r[1]!.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((c) => text(c[1]!)))
      .filter((cells) => cells[0] === '--concurrency <n>')
    expect(flag.map((cells) => cells.slice(0, 3))).toEqual([
      ['--concurrency <n>', 'int or <n>%', 'cores, capped by the cgroup quota'],
    ])
    expect(prose).toContain('--concurrency sets how many workers run, by default one per CPU core:')
  })

  // The element's chunk must be the bench's simulator over vx's ranking, and
  // nothing the platform provides: a `Bun`, `process` or `node:` left in it
  // would throw in a browser, where no row here runs it.
  it("loads the element from the page's scripts, with the bench's code and no platform", () => {
    const names = defining(html, 'vx-scheduler-sim')
    expect(names).toHaveLength(1)
    const chunk = readFileSync(path.join(DIST, '_astro', names[0]!), 'utf8')
    // It imports nothing, so what it holds is all it runs.
    expect(chunk).not.toMatch(/\bimport\s*[{("'`*\w]/)
    expect(chunk).toContain('simulate: the graph has a cycle')
    expect(chunk.match(/\bBun\b|\bprocess\b|node:|bun:|import\.meta/g)).toBeNull()
  })
})
