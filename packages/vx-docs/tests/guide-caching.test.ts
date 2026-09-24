// Chapter 5, guide/caching, teaches with the key calculator
// (demos/KeyCalculator.astro), a MODEL of vx's key fold over the toy
// monorepo. tests/key-model-core.test.ts holds the model to real vx runs;
// this holds it to a truth written out by hand, the built chapter to the
// model, and what the prose says about keys to both.

import { describe, expect, it } from 'bun:test'
import {
  TOY_SCENARIOS,
  TOY_START,
  TOY_TASKS,
  rowOf,
  runSummary,
  toyRun,
  toyRuns,
  type ToyChange,
  type ToyRun,
} from '../src/components/demos/model/toy-monorepo.js'
import * as P from '../src/components/guide/caching/pictures.js'
import {
  chapterShape,
  content,
  defining,
  only,
  page,
  prose as authored,
  section,
  sourceBlocks,
  tableRows,
  text,
} from './guide-page.js'

// The calculator's truth, by hand: per change, the last run's moved keys
// (and why), hits and stale outputs.
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

  it('has exactly the four scenarios the chapter shows, in order', () => {
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

chapterShape({
  slug: 'caching',
  titles: [
    'Same inputs give the same result',
    'A short key tells vx if anything changed',
    'A change in utils changes every key above it',
  ],
  pictures: [P.rerun, P.sameInputs, P.key, P.cascade],
  rows: {
    'packages/vx/tests/config.test.ts': [
      'requires cache.inputs.files — the one declaration vx will not infer',
    ],
    'packages/vx/tests/task-hash-derive.test.ts': [
      'the command folds in',
      'every exec and task field but the stripped one moves the key',
      'SENSITIVITY: changing package.json moves the key even with narrow globs',
      'the workspace fingerprint folds in — a lockfile bump invalidates everything',
      'SENSITIVITY: an upstream key change cascades into the dependent',
    ],
    'packages/vx/tests/git-subdir-workspace.test.ts': [
      'a first run misses and saves, a second hits and restores, an edit re-keys',
    ],
    'packages/vx/tests/execute-task.test.ts': [
      'replays the entry stdout and reports the SKIPPED exec time apart from the restore cost',
    ],
    'packages/vx/tests/git-oid.test.ts': [
      'edit changes the key; reverting restores the ORIGINAL key before any commit',
    ],
    'packages/vx-docs/tests/key-model-core.test.ts': [
      'the key model moves, hits and goes stale where vx does, step by step',
    ],
  },
})

describe('guide/caching', () => {
  const html = page('guide/caching')
  const main = content(html)
  const prose = text(main)
  const element = only(main, /<vx-key-calculator\b[^>]*>([\s\S]*?)<\/vx-key-calculator>/g)
  const table = only(element, /(<table class="static\b[\s\S]*?<\/table>)/g)
  const runOf = (id: string): ToyRun =>
    toyRuns(TOY_SCENARIOS.find((s) => s.id === id)!.changes).at(-1)!

  it('hosts the calculator and its checkpoint, and no other widget', () => {
    expect([...main.matchAll(/<vx-[\w-]+\b/g)].map((m) => m[0])).toEqual([
      '<vx-key-calculator',
      '<vx-checkpoint',
    ])
  })

  // The simple brief (2026-09-24): one small table, one column per change,
  // where the page had a table per change with every key before and after.
  it('ships one small table: each task, and whether it runs or hits after each change', () => {
    const head = [
      ...only(table, /<thead\b[^>]*>([\s\S]*?)<\/thead>/g).matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g),
    ]
    expect(head.map((m) => text(m[1]!))).toEqual([
      'Task',
      'Edit utils',
      'Edit app',
      'Change API_URL',
      'Edit a file utils does not list',
    ])
    const ids = Object.keys(SCENARIO)
    expect(tableRows(table)).toEqual(
      ALL.map((task) => [
        task,
        ...ids.map((id) => {
          const truth = SCENARIO[id]!
          const hit = truth.hit.includes(task)
          if (truth.stale.includes(task)) return hit ? 'stale hit' : 'runs, stale input'
          return hit ? 'hit' : 'runs'
        }),
      ]),
    )
  })

  it('renders what the model says, so the element and the fallback agree', () => {
    expect(TOY_SCENARIOS.map((s) => s.title)).toEqual([
      'Edit utils',
      'Edit app',
      'Change API_URL',
      'Edit a file utils does not list',
    ])
    expect(tableRows(table)).toEqual(
      TOY_TASKS.map((t, i) => [t.id, ...TOY_SCENARIOS.map((s) => rowOf(runOf(s.id).tasks[i]!)[2])]),
    )
    const live = only(element, /<table class="live\b[^"]*"[^>]*>([\s\S]*?)<\/table>/g)
    const liveHead = [...live.matchAll(/<th scope="col">([\s\S]*?)<\/th>/g)].map((m) => text(m[1]!))
    expect(liveHead).toEqual(['Task', 'Key', 'This run'])
    expect(tableRows(`<table>${live}</table>`)).toEqual(toyRun(TOY_START).tasks.map(rowOf))
  })

  it('says the stale hit plainly, in its own column', () => {
    const stale = [
      ...table.matchAll(/<td data-scenario="stale" data-outcome="([^"]+)">([\s\S]*?)<\/td>/g),
    ]
    expect(stale.map((m) => `${m[1]} ${text(m[2]!)}`)).toEqual(ALL.map(() => 'stale-hit stale hit'))
  })

  it('keeps the controls that need JavaScript hidden, with an edit button per package and the env', () => {
    expect(only(element, /<div class="controls\b[^"]*"([^>]*)>/g).trim()).toBe('hidden')
    expect(only(element, /<p class="status\b[^"]*"([^>]*)>/g).trim()).toBe(
      'aria-live="polite" hidden',
    )
    expect(only(element, /<table class="live\b[^"]*"([^>]*)>/g).trim()).toBe('hidden')
    expect(only(element, /<table class="static\b[^"]*"([^>]*)>/g).trim()).toBe('')
    expect(
      [...element.matchAll(/<button\b[^>]*data-edit="([^"]+)" aria-pressed="(\w+)"/g)].map(
        (m) => `${m[1]} ${m[2]}`,
      ),
    ).toEqual([
      'utils/src/index.ts false',
      'ui/src/index.ts false',
      'api/src/index.ts false',
      'app/src/index.ts false',
      'API_URL false',
    ])
  })

  it('says in one line that the keys come from a model a test holds to vx', () => {
    const figures = [...main.matchAll(/<figure class="vx-demo\b[^"]*">([\s\S]*?)<\/figure>/g)]
      .map((m) => m[1]!)
      .filter((f) => f.includes('<vx-key-calculator'))
    expect(figures).toHaveLength(1)
    expect(text(only(figures[0]!, /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/g))).toBe(
      'The keys come from a model of vx. A test checks it against real vx.',
    )
  })

  it("loads the element's module from the page's own scripts", () => {
    expect(defining(html, 'vx-key-calculator')).toHaveLength(1)
    expect(defining(html, 'vx-checkpoint')).toHaveLength(1)
  })

  // The pictures and the prose say which tasks a change reruns; each is held
  // to the model's run of the same change.
  it('draws and says which tasks each change reruns, as the model does', () => {
    expect(P.rerun.boxes.map((b) => `${b.id} ${b.tone}`)).toEqual(
      ALL.map((id) => `${id} ${id in SCENARIO['app']!.moved ? 'accent' : 'danger'}`),
    )
    const notes = P.rerun.notes!.map((n) => n.text)
    expect(notes).toContain('needed: 2 tasks')
    expect(notes).toContain('ran again for nothing: 6 tasks')
    expect(SCENARIO['app']!.hit).toHaveLength(6)
    expect(prose).toContain('Six of them read nothing that changed.')

    expect(P.cascade.boxes.map((b) => `${b.id} ${b.tone}`)).toEqual([
      'utils#build accent',
      'ui#build accent',
      'api#build accent',
      'app#build accent',
    ])
    expect(Object.keys(SCENARIO['utils']!.moved)).toEqual(ALL)
    expect(Object.keys(SCENARIO['app']!.moved)).toEqual(['app#build', 'app#test'])
    expect(prose).toContain('Change utils, and every key above it changes.')
    expect(prose).toContain('Change app, and only app’s keys change.')
  })

  it('places the caching checkpoint as its one check', () => {
    const checkpoint = only(main, /<vx-checkpoint\b[^>]*>([\s\S]*?)<\/vx-checkpoint>/g)
    expect(only(checkpoint, /<fieldset class="form\b[^"]*"[^>]*data-checkpoint="([^"]+)"/g)).toBe(
      'caching',
    )
    // No other check than the checkpoint.
    expect(authored(section(main, 'check-yourself'))).not.toContain('<details')
  })

  it('shows a cache block the schema defines', () => {
    expect(sourceBlocks('caching')).toEqual([
      [
        "import { defineProject } from '@vzn/vx'",
        '',
        'export default defineProject({',
        '  tasks: {',
        '    build: {',
        "      dependsOn: ['^build'],",
        "      exec: { command: 'tsc -b' },",
        '      cache: {',
        "        inputs: { files: ['src/**', 'tsconfig.json'] },",
        "        outputs: { files: ['dist/**'] },",
        '      },',
        '    },',
        '  },',
        '})',
        '',
      ].join('\n'),
    ])
    const schema = text(page('schema'))
    expect(schema).toContain('inputs.files (required)')
    expect(schema).toContain(
      'The project loader requires both inputs and outputs when cache is set',
    )
  })
})
