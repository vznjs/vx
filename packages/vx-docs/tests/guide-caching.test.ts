// Chapter 5, guide/caching, teaches with the key calculator
// (demos/KeyCalculator.astro), a MODEL of vx's key fold over the toy
// monorepo. tests/key-model-core.test.ts holds the model to real vx runs;
// this holds it to a truth written out by hand, the built chapter to the
// model, and what the prose says about keys to both.

import { describe, expect, it } from 'bun:test'
import {
  TOY_SCENARIOS,
  TOY_START,
  describeRun,
  rowOf,
  toyRun,
  toyRuns,
  type ToyChange,
  type ToyRun,
} from '../src/components/demos/model/toy-monorepo.js'
import {
  TOY,
  article,
  codeBlocks,
  competitorMentions,
  defining,
  diagram,
  diagrams,
  missingPage,
  missingRow,
  only,
  packagesNamed,
  page,
  proofs,
  proseWords,
  repoLinks,
  sectionTitles,
  siteLinks,
  tableRows,
  text,
  withoutCheckpoints,
  words,
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

describe('guide/caching', () => {
  const html = page('guide/caching')
  const main = article(html)
  const prose = text(main)
  const element = only(main, /<vx-key-calculator\b[^>]*>([\s\S]*?)<\/vx-key-calculator>/g)
  const scenarios = only(element, /<div class="scenarios\b[^"]*"[^>]*>([\s\S]*?)<\/div>/g)
  const tables = [...scenarios.matchAll(/<table data-scenario="([^"]+)"[^>]*>([\s\S]*?)<\/table>/g)]
  const runOf = (id: string): ToyRun =>
    toyRuns(TOY_SCENARIOS.find((s) => s.id === id)!.changes).at(-1)!

  it('tells the story in its section titles', () => {
    expect(sectionTitles(main)).toEqual([
      'Same inputs give the same result',
      'A short key tells vx if anything changed',
      'A change in utils changes every key above it',
      'In vx',
      'Check yourself',
    ])
  })

  it('draws four small pictures, and hosts the calculator and its checkpoint', () => {
    expect(diagrams(main)).toEqual(['rerun', 'same-inputs', 'key', 'cascade'])
    for (const name of diagrams(main)) {
      const figure = diagram(main, name)
      expect(figure).toMatch(/<svg\b[^>]*role="img"[^>]*aria-label="[^"]+"/)
      expect(text(only(figure, /<figcaption>([\s\S]*?)<\/figcaption>/g))).not.toBe('')
    }
    expect([...main.matchAll(/<vx-[\w-]+\b/g)].map((m) => m[0])).toEqual([
      '<vx-key-calculator',
      '<vx-checkpoint',
    ])
    expect(main).not.toContain('class="mermaid"')
  })

  it('keeps its prose short', () => {
    const n = proseWords(main)
    expect(n).toBeGreaterThan(100)
    expect(n).toBeLessThanOrEqual(350)
  })

  it('names only the four packages, and no other tool', () => {
    const named = packagesNamed(words(withoutCheckpoints(main)))
    expect(named.filter((n) => !TOY.includes(n))).toEqual([])
    // Positive first: the reader found the chapter's own names.
    expect(named).toEqual([...TOY].sort())
    expect(competitorMentions(main)).toEqual([])
  })

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
    const figures = [...main.matchAll(/<figure class="vx-demo\b[^"]*">([\s\S]*?)<\/figure>/g)]
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
    expect(defining(html, 'vx-key-calculator')).toHaveLength(1)
    expect(defining(html, 'vx-checkpoint')).toHaveLength(1)
  })

  // The pictures and the prose say which tasks a change reruns; each is held
  // to the model's run of the same change.
  it('draws and says which tasks each change reruns, as the model does', () => {
    const rerun = diagram(main, 'rerun')
    expect(
      [...rerun.matchAll(/<g data-task="([^"]+)" data-needed="(yes|no)"/g)].map(
        (m) => `${m[1]} ${m[2]}`,
      ),
    ).toEqual(
      ALL.map((id) => `${id} ${Object.keys(SCENARIO['app']!.moved).includes(id) ? 'yes' : 'no'}`),
    )
    const words6 = words(only(rerun, /(<svg\b[\s\S]*<\/svg>)/g))
    expect([words6.includes('needed: 2 tasks'), words6.includes('for nothing: 6 tasks')]).toEqual([
      true,
      true,
    ])
    expect(SCENARIO['app']!.hit).toHaveLength(6)
    expect(prose).toContain('Six of them read nothing that changed.')

    const cascade = diagram(main, 'cascade')
    expect(
      [...cascade.matchAll(/<g data-task="([^"]+)" data-moved="(yes|no)"/g)].map(
        (m) => `${m[1]} ${m[2]}`,
      ),
    ).toEqual(['utils#build yes', 'ui#build yes', 'api#build yes', 'app#build yes'])
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
    const { rest } = proofs(main)
    // No other check than the checkpoint.
    expect([...withoutCheckpoints(rest).matchAll(/<details>/g)]).toEqual([])
  })

  it('keeps test links out of the prose, in one collapsed list that stands on real rows', () => {
    const { list, rest } = proofs(main)
    expect(repoLinks(rest)).toEqual([])
    const claims = repoLinks(list)
    expect(claims.map((c) => c.label)).toEqual([
      'A cache block must list its input files',
      'The command is in the key',
      'The task’s settings are in the key',
      'The package’s package.json is in the key',
      'The lockfile is in the key',
      'A dependency’s key is in the key',
      'A hit puts the saved files back',
      'A hit shows the saved log',
      'Undoing an edit brings the old key back',
      'The calculator does what vx does',
    ])
    expect(claims.map(missingRow).filter((m) => m !== undefined)).toEqual([])
    const site = siteLinks(main, 'guide/caching')
    expect(site).toEqual(['learn/glossary/#cache-key'])
    expect(site.map(missingPage).filter((m) => m !== undefined)).toEqual([])
  })

  it('shows a cache block the schema defines', () => {
    expect(codeBlocks('caching')).toEqual([
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
