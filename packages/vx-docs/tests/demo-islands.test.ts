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

  it('answers the checkpoint with the run the explorer shows for ui', () => {
    const answer = only(html, /<details>([\s\S]*?)<\/details>/g)
    const paragraphs = [...answer.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1]!)
    expect(paragraphs).toHaveLength(2)
    const named = (p: string): string[] => [...new Set(p.match(/\b\w+#\w+\b/g))].sort()
    expect(named(paragraphs[0]!)).toEqual([...rerunBy('ui')].sort())
    expect(named(paragraphs[0]!)).toEqual([...CHANGE['ui']!.rerun].sort())
    // The second names what the run needs from the cache, the tasks that need
    // it, and the two that stay out.
    expect(named(paragraphs[1]!)).toEqual(
      [...neededBy('ui'), 'ui#build', 'app#build', 'utils#test', 'api#test'].sort(),
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

const CHECKPOINT: ToyChange[] = [
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

  it('answers the checkpoint: ui and app miss once, then every task hits and four are stale', () => {
    const [, undeclared, edited] = toyRuns(CHECKPOINT)
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
      "A model of vx's key fold, not vx itself: the real planner runs in the browser in a later " +
        'step of this site. The keys are digests the model computes, shortened to seven hex ' +
        "digits; vx's are xxHash3. Which keys move, which tasks hit and which hits are stale is " +
        'what vx does on the same workspace, and a test runs vx to check it. Each table starts ' +
        'from a first run on an empty cache.',
    )
  })

  it('answers the checkpoint with what the model does', () => {
    const answer = only(html, /<details>([\s\S]*?)<\/details>/g)
    const paragraphs = [...answer.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1]!)
    expect(paragraphs).toHaveLength(3)
    const named = (p: string): string[] => [...new Set(p.match(/\b\w+#\w+\b/g))].sort()
    const [, undeclared, edited] = toyRuns(CHECKPOINT)
    const ids = (run: ToyRun, pick: (t: ToyRun['tasks'][number]) => boolean): string[] =>
      run.tasks
        .filter(pick)
        .map((t) => t.id)
        .sort()
    expect(named(paragraphs[0]!)).toEqual(ids(undeclared!, (t) => !t.hit))
    expect(named(paragraphs[1]!)).toEqual(ids(edited!, (t) => t.hit && !t.stale))
    expect(named(paragraphs[2]!)).toEqual(ids(edited!, (t) => t.hit && t.stale))
    expect(ids(edited!, (t) => t.hit)).toEqual([...ALL].sort())
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
