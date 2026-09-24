// A Learn widget is a custom element that enhances static markup
// (src/components/Demo.astro). The static markup is the page a reader
// without JavaScript gets, and the design's rule is that it teaches on its
// own (design/site-teaches-2026-09.md, principle 4). Nothing an author
// sees with JavaScript on proves that, so this reads what the build
// shipped: the fallback is in the HTML, and the page's own scripts reach
// the module that defines the element.
//
// It reads `dist/`, which the `build` task writes; the `test` task depends
// on `build` for that reason.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  TOY_PACKAGES,
  TOY_TASKS,
  TOY_SCENARIOS,
  TOY_START,
  affectedBy,
  describeRun,
  joinNames,
  neededBy,
  orderSentence,
  rerunBy,
  rowOf,
  toyRun,
  toyRuns,
  waves,
  type ToyChange,
  type ToyRun,
} from '../src/components/demos/model/toy-monorepo.js'
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
  type SimTask,
} from '../src/components/demos/model/scheduler-sim.js'
import {
  instance,
  pluginPriorities,
  priorities,
  SHAPES,
  simulate,
} from '../../vx-bench/schedule-policy.js'

const DIST = path.resolve(import.meta.dir, '../dist')

function page(slug: string): string {
  const file = path.join(DIST, slug, 'index.html')
  if (!existsSync(file)) throw new Error(`${file} is missing: run the site's build task first`)
  return readFileSync(file, 'utf8')
}

function only(html: string, re: RegExp): string {
  const found = [...html.matchAll(re)]
  expect(found).toHaveLength(1)
  return found[0]![1]!
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The rows of a table's body: each row's cells as text, header cell first. */
function tableRows(table: string): string[][] {
  const body = only(table, /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/g)
  return [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => text(c[1]!)),
  )
}

/** Every `_astro/*.js` the page loads, followed through the chunks' own
 *  static and dynamic imports. Names only; the files sit in `dist/_astro/`.
 *  The loader imports an element only on demand, so "the page references
 *  the element" means reachable, not a `<script src>` of its own. */
function reachableScripts(html: string): Set<string> {
  const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0])
  const seen = new Set<string>()
  const queue = scripts.flatMap((s) =>
    [...s.matchAll(/\/_astro\/([\w.-]+\.js)/g)].map((m) => m[1]!),
  )
  while (queue.length > 0) {
    const name = queue.pop()!
    const file = path.join(DIST, '_astro', name)
    // mermaid's chunks name files it never emits (`./elk-worker.min.js`).
    if (seen.has(name) || !existsSync(file)) continue
    seen.add(name)
    const body = readFileSync(file, 'utf8')
    for (const m of body.matchAll(/["'`]\.\/([\w.-]+\.js)["'`]/g)) queue.push(m[1]!)
  }
  return seen
}

// The truth the explorer teaches, written out by hand. The model is held to
// it, and the built page to both, so a wrong rule in the model cannot pass
// by agreeing with its own render.
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

  it('orders a run by wave, and says so', () => {
    expect(waves(rerunBy('api'))).toEqual([['api#build'], ['api#test', 'app#build'], ['app#test']])
    expect(orderSentence(rerunBy('ui'))).toBe(
      'ui#build, then ui#test and app#build together, then app#test',
    )
  })
})

describe('the graph explorer on learn/what-is-task-orchestration', () => {
  const html = page('learn/what-is-task-orchestration')
  const element = only(html, /<vx-graph-explorer\b[^>]*>([\s\S]*?)<\/vx-graph-explorer>/g)
  const svg = only(element, /(<svg\b[\s\S]*<\/svg>)/g)
  const table = only(element, /(<table\b[\s\S]*?<\/table>)/g)

  it('ships the task graph as static SVG inside the element, one row per wave', () => {
    const nodes = [
      ...svg.matchAll(/<g\b[^>]*data-task="([^"]+)" data-pkg="([^"]+)" data-wave="(\d+)"/g),
    ].map((m) => `${m[1]} ${m[2]} ${m[3]}`)
    expect(nodes.sort()).toEqual(
      WAVES.flatMap((w, i) => w.map((id) => `${id} ${id.split('#')[0]} ${i + 1}`)).sort(),
    )
    expect(
      [...svg.matchAll(/data-from="([^"]+)" data-to="([^"]+)"/g)]
        .map((m) => `${m[1]}→${m[2]}`)
        .sort(),
    ).toEqual(EDGES)
    expect(
      [...svg.matchAll(/<text\b[^>]*class="wave\b[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]),
    ).toEqual(['wave 1', 'wave 2', 'wave 3', 'wave 4'])
    // Without JavaScript the SVG is one image with a name, not dead buttons.
    expect(svg).toMatch(/^<svg\b[^>]*role="img"/)
    expect(svg).not.toContain('role="button"')
  })

  it("states each change's run, what it needs first and the order, in a table", () => {
    expect(tableRows(table)).toEqual([
      [
        'utils',
        'utils#build, utils#test, ui#build, ui#test, api#build, api#test, app#build and app#test',
        'nothing',
        'utils#build, then utils#test, ui#build and api#build together, ' +
          'then ui#test, api#test and app#build together, then app#test',
      ],
      [
        'ui',
        'ui#build, ui#test, app#build and app#test',
        'utils#build and api#build',
        'ui#build, then ui#test and app#build together, then app#test',
      ],
      [
        'api',
        'api#build, api#test, app#build and app#test',
        'utils#build and ui#build',
        'api#build, then api#test and app#build together, then app#test',
      ],
      [
        'app',
        'app#build and app#test',
        'utils#build, ui#build and api#build',
        'app#build, then app#test',
      ],
    ])
  })

  it('renders what the model says, so the element and the fallback agree', () => {
    expect([...svg.matchAll(/data-task="([^"]+)"/g)].map((m) => m[1])).toEqual(
      TOY_TASKS.map((t) => t.id),
    )
    expect(tableRows(table)).toEqual(
      TOY_PACKAGES.map((p) => [
        p.id,
        joinNames(rerunBy(p.id)),
        neededBy(p.id).length === 0 ? 'nothing' : joinNames(neededBy(p.id)),
        orderSentence(rerunBy(p.id)),
      ]),
    )
  })

  it('names the waves in the caption', () => {
    // Expressive Code wraps every code block in a <figure> too.
    const figures = [...html.matchAll(/<figure class="vx-demo\b[^"]*">([\s\S]*?)<\/figure>/g)]
      .map((m) => m[1]!)
      .filter((f) => f.includes('<vx-graph-explorer'))
    expect(figures).toHaveLength(1)
    expect(text(only(figures[0]!, /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/g))).toBe(
      'The build and test tasks of a four-package monorepo. An arrow goes from a task to a task ' +
        'that needs it, so the first must finish before the second starts. Tasks in the same ' +
        'wave do not need each other and can run at the same time: wave 1 is utils#build; ' +
        'wave 2 is utils#test, ui#build and api#build; wave 3 is ui#test, api#test and ' +
        'app#build; wave 4 is app#test. The table says what a change to each package makes ' +
        'vx run build test --affected run.',
    )
  })

  it('keeps the controls that need JavaScript hidden in the static page', () => {
    expect(only(element, /<div class="controls\b[^"]*"([^>]*)>/g).trim()).toBe('hidden')
    expect([...element.matchAll(/<button\b[^>]*data-pkg="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'utils',
      'ui',
      'api',
      'app',
    ])
    expect(only(element, /<p class="status\b[^"]*"([^>]*)>/g).trim()).toBe(
      'aria-live="polite" hidden',
    )
  })

  it("loads the element's module from the page's own scripts", () => {
    const defining = [...reachableScripts(html)].filter((name) =>
      /customElements\.define\(\s*["'`]vx-graph-explorer["'`]/.test(
        readFileSync(path.join(DIST, '_astro', name), 'utf8'),
      ),
    )
    expect(defining).toHaveLength(1)
  })
})

// The key calculator's truth, written out by hand: per change, the last run's
// moved keys (and why), hits and stale outputs. tests/key-model-core.test.ts
// holds the model to real vx runs; this holds it, and the page, to what the
// page says in words.
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

  it('has exactly the four scenarios the page shows, in order', () => {
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

describe('the key calculator on learn/caching', () => {
  const html = page('learn/caching')
  const element = only(html, /<vx-key-calculator\b[^>]*>([\s\S]*?)<\/vx-key-calculator>/g)
  const scenarios = only(element, /<div class="scenarios\b[^"]*"[^>]*>([\s\S]*?)<\/div>/g)
  const tables = [...scenarios.matchAll(/<table data-scenario="([^"]+)"[^>]*>([\s\S]*?)<\/table>/g)]
  const runOf = (id: string): ToyRun =>
    toyRuns(TOY_SCENARIOS.find((s) => s.id === id)!.changes).at(-1)!

  it('ships one static table per scenario, each row saying what the key and the run did', () => {
    expect(tables.map((t) => t[1])).toEqual(Object.keys(SCENARIO))
    for (const [, id, table] of tables) {
      const truth = SCENARIO[id!]!
      const rows = tableRows(`<table>${table}</table>`)
      expect(rows.map((r) => [r[0], r[3], r[4]])).toEqual(
        ALL.map((task) => [
          task,
          truth.moved[task] === 'input'
            ? 'moved: own input'
            : truth.moved[task] === 'upstream'
              ? 'moved: upstream key'
              : 'same',
          `${truth.stale.includes(task) ? (truth.hit.includes(task) ? 'stale hit' : 'runs, on a stale input') : truth.hit.includes(task) ? 'hit' : 'runs'}`,
        ]),
      )
      // A key that is `same` shows one digest twice; a moved one, two.
      for (const r of rows) expect(r[1] === r[2]).toBe(r[3] === 'same')
    }
  })

  it('renders what the model says, so the element and the fallback agree', () => {
    for (const [, id, table] of tables) {
      expect(tableRows(`<table>${table}</table>`)).toEqual(runOf(id!).tasks.map(rowOf))
      const caption = only(table!, /<caption\b[^>]*>([\s\S]*?)<\/caption>/g)
      const s = TOY_SCENARIOS.find((x) => x.id === id)!
      expect(text(caption)).toBe(`${s.title}. ${describeRun(runOf(id!))}`)
    }
    const live = only(element, /<table class="live\b[^"]*"[^>]*>([\s\S]*?)<\/table>/g)
    expect(tableRows(`<table>${live}</table>`)).toEqual(toyRun(TOY_START).tasks.map(rowOf))
  })

  it('says the stale hit plainly, in the stale table', () => {
    const [, , stale] = tables.find((t) => t[1] === 'stale')!
    expect(text(only(stale!, /<caption\b[^>]*>([\s\S]*?)<\/caption>/g))).toBe(
      'Stop declaring utils/tsconfig.json, run, then edit it. No key moved. The run hits all 8 ' +
        'tasks. utils#build, utils#test, ui#build, ui#test, api#build, api#test, app#build and ' +
        'app#test are stale hits: no key saw the change, so the cache replays outputs built ' +
        'before it.',
    )
  })

  it('keeps the controls that need JavaScript hidden, with a toggle per input', () => {
    expect(only(element, /<div class="controls\b[^"]*"([^>]*)>/g).trim()).toBe('hidden')
    expect(only(element, /<p class="status\b[^"]*"([^>]*)>/g).trim()).toBe(
      'aria-live="polite" hidden',
    )
    expect(only(element, /<table class="live\b[^"]*"([^>]*)>/g).trim()).toBe('hidden')
    const toggles = (attr: string): string[] =>
      [
        ...element.matchAll(
          new RegExp(`<button\\b[^>]*${attr}="([^"]+)" aria-pressed="(\\w+)"`, 'g'),
        ),
      ].map((m) => `${m[1]} ${m[2]}`)
    expect(toggles('data-edit')).toEqual([
      'utils/src/index.ts false',
      'utils/tsconfig.json false',
      'ui/src/index.ts false',
      'ui/tsconfig.json false',
      'api/src/index.ts false',
      'api/tsconfig.json false',
      'app/src/index.ts false',
      'app/tsconfig.json false',
      'API_URL false',
    ])
    expect(toggles('data-declare')).toEqual([
      'utils/tsconfig.json true',
      'ui/tsconfig.json true',
      'api/tsconfig.json true',
      'app/tsconfig.json true',
      'API_URL true',
    ])
    expect(
      [...element.matchAll(/<button\b[^>]*data-scenario="([^"]+)"/g)].map((m) => m[1]),
    ).toEqual(Object.keys(SCENARIO))
  })

  it('says in its caption that the keys come from a model', () => {
    const figures = [...html.matchAll(/<figure class="vx-demo\b[^"]*">([\s\S]*?)<\/figure>/g)]
      .map((m) => m[1]!)
      .filter((f) => f.includes('<vx-key-calculator'))
    expect(figures).toHaveLength(1)
    expect(text(only(figures[0]!, /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/g))).toBe(
      "A model of vx's key fold, not vx itself: the playground page runs the real planner in the " +
        'browser. The keys are digests the model computes, shortened to seven hex ' +
        "digits; vx's are xxHash3. Which keys move, which tasks hit and which hits are stale is " +
        'what vx does on the same workspace, and a test runs vx to check it. Each table starts ' +
        'from a first run on an empty cache.',
    )
  })

  it("loads the element's module from the page's own scripts", () => {
    const defining = [...reachableScripts(html)].filter((name) =>
      /customElements\.define\(\s*["'`]vx-key-calculator["'`]/.test(
        readFileSync(path.join(DIST, '_astro', name), 'utf8'),
      ),
    )
    expect(defining).toHaveLength(1)
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
const withSeconds = (id: string, seconds: number): SimTask[] =>
  SIM_TASKS.map((t) => (t.id === id ? { ...t, dur: seconds * 1000 } : t))

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

describe('the scheduler simulator on learn/scheduling', () => {
  const html = page('learn/scheduling')
  const element = only(html, /<vx-scheduler-sim\b[^>]*>([\s\S]*?)<\/vx-scheduler-sim>/g)
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

  it('draws two Gantt charts of the default graph, with the hand-traced bars', () => {
    expect(charts.map((c) => c[1])).toEqual(['0', '1'])
    expect(bars(charts[0]![2]!)).toEqual(COUNT_ON_2)
    expect(bars(charts[1]![2]!)).toEqual(MEDIAN_ON_2)
    for (const c of charts) expect(critical(c[2]!).sort()).toEqual([...CRITICAL].sort())
    // A screen reader gets the chart as one sentence per worker.
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
      // Without JavaScript the chart is one image whose name says every bar.
      expect(svg).toMatch(/^<svg\b[^>]*role="img"/)
      expect(only(svg, /^<svg\b[^>]*aria-label="([^"]*)"/g)).toBe(describeSchedule(sched))
    }
  })

  it('states the finish times and the durations in tables', () => {
    const finish = only(element, /(<table class="finish\b[\s\S]*?<\/table>)/g)
    expect(tableRows(finish)).toEqual(FINISH)
    expect(only(finish, /<tr data-workers="2" class="([^"]*)"/g)).toContain('is-selected')
    expect(tableRows(only(html, /(<table class="no-history\b[\s\S]*?<\/table>)/g))).toEqual(
      NO_HISTORY,
    )
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

  it('draws the Mermaid diagram from the same tasks, edges and critical path', () => {
    const diagram = only(html, /<pre class="mermaid"[^>]*>([\s\S]*?)<\/pre>/g)
    const ids = new Map(
      [...diagram.matchAll(/(\w+)\["(\w+#\w+) · (\d+) s"\]/g)].map((m) => [m[1]!, m[2]!]),
    )
    const named = [...diagram.matchAll(/"(\w+#\w+) · (\d+) s"/g)].map((m) => `${m[1]} ${m[2]}`)
    expect(named.sort()).toEqual(SIM_TASKS.map((t) => `${t.id} ${t.dur / 1000}`).sort())
    const edges = [...diagram.matchAll(/^\s*(\w+)\b[^\n]*? --> (\w+)/gm)].map(
      (m) => `${ids.get(m[1]!)}→${ids.get(m[2]!)}`,
    )
    expect(edges.sort()).toEqual(SIM_TASKS.flatMap((t) => t.deps.map((d) => `${d}→${t.id}`)).sort())
    const marked = only(diagram, /class ([\w,]+) critical/g)
      .split(',')
      .map((k) => ids.get(k))
    expect(marked).toEqual(CRITICAL)
  })

  // On this graph counting only DIRECT dependents ranks every task the same
  // way, so no schedule above can tell the two apart (a sweep mutation that
  // made core's count direct survived them). The prose names the counts.
  it('walks through the rankings vx computes for the default graph', () => {
    const prose = text(html)
    expect(Object.fromEntries(priorities('count', SIM_TASKS, none))).toEqual({
      ...Object.fromEntries(SIM_TASKS.map((t) => [t.id, 0])),
      'utils#build': 7,
      'ui#build': 3,
      'api#build': 3,
      'app#build': 1,
    })
    expect(prose).toContain('utils#build has seven tasks waiting on it')
    const ahead = pluginPriorities('oracle', SIM_TASKS, none)!
    expect(
      ['utils#build', 'app#docs', 'utils#lint', 'ui#lint', 'api#lint', 'app#lint'].map(
        (id) => ahead.get(id)! / 1000,
      ),
    ).toEqual([24, 10, 1, 2, 1, 2])
    expect(prose).toContain(
      'utils#build has 24 seconds ahead of it, app#docs 10, and each lint 1 or 2',
    )
  })

  it('answers the checkpoint with the chain and times the simulator gives', () => {
    const answer = only(html, /<details>([\s\S]*?)<\/details>/g)
    const paragraphs = [...answer.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => text(m[1]!))
    expect(paragraphs).toHaveLength(2)
    const named = (p: string): string[] => [...new Set(p.match(/\b\w+#\w+\b/g))]
    // Three workers finish the default graph at the chain's length.
    expect(named(paragraphs[0]!)).toEqual(CRITICAL)
    expect(paragraphs[0]).toContain('24 seconds')
    expect(FINISH[2]).toEqual(['3', '24 s', '24 s', '24 s', '24 s', '24 s'])
    // api#build at 3 s: the same chain, now 21 s, and three workers reach it
    // under both charts' policies.
    expect(named(paragraphs[1]!)).toEqual([
      'api#build',
      ...CRITICAL.filter((id) => id !== 'api#build'),
    ])
    expect(paragraphs[1]).toContain('drops to 21 seconds')
    expect(paragraphs[1]).toContain('three workers finish in 21')
    const faster = withSeconds('api#build', 3)
    expect(criticalPath(faster)).toEqual({ length: 21_000, chain: CRITICAL })
    for (const p of DEFAULT_PAIR) expect(schedule(faster, none, p, 3).makespan).toBe(21_000)
  })

  // The element's chunk must be the bench's simulator over vx's ranking, and
  // nothing the platform provides: a `Bun`, `process` or `node:` left in it
  // would throw in a browser, where no row here runs it.
  it("loads the element from the page's scripts, with the bench's code and no platform", () => {
    const defining = [...reachableScripts(html)].filter((name) =>
      /customElements\.define\(\s*["'`]vx-scheduler-sim["'`]/.test(
        readFileSync(path.join(DIST, '_astro', name), 'utf8'),
      ),
    )
    expect(defining).toHaveLength(1)
    const chunk = readFileSync(path.join(DIST, '_astro', defining[0]!), 'utf8')
    // It imports nothing, so what it holds is all it runs.
    expect(chunk).not.toMatch(/\bimport\s*[{("'`*\w]/)
    expect(chunk).toContain('simulate: the graph has a cycle')
    expect(chunk.match(/\bBun\b|\bprocess\b|node:|bun:|import\.meta/g)).toBeNull()
  })
})
