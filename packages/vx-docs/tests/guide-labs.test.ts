// The labs (guide/labs, item 704; design/labs-checkpoints-2026-09.md § W10),
// a tool page after the Guide's last chapter.
// Each of labs 1 to 3 is a `<vx-playground data-lab="<id>">` opened on a
// state from src/playground/labs.ts, with numbered steps the reader runs in
// it. These rows hold the page to the model and the model to hand-written
// truth: what every step moves, and the words each cell says, are written
// out below, never computed from labs.ts. Core's parity rows hold the same
// steps to `vx run --dry=json` (packages/vx/tests/playground-parity.unsafe.test.ts).
// Lab 4 is a guided exercise in the scheduler simulator on the same page,
// and its numbers are held here to the simulator's model.
//
// It reads `dist/`, which the `build` task writes; the `test` task depends
// on `build` for that reason.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { PLANNER_FILE } from '../scripts/build-playground.js'
import { evaluateConfigInProcess } from '../src/playground/config-eval.js'
import { ENV, FILES, TASKS } from '../src/playground/workspace.js'
import { LABS, LAB_IDS, LAB_STEPS, applyEdits, type LabId } from '../src/playground/labs.js'
import {
  PLAYGROUND_ROOT,
  changeCell,
  configTextsOf,
  diffRuns,
  envText,
  runPlayground,
  staticCells,
  staticProjects,
  staticTable,
  summarize,
  type Planner,
  type PlaygroundTask,
} from '../src/components/demos/model/playground-view.js'
import {
  SIM_TASKS,
  criticalPath,
  lowerBound,
  schedule,
  type SimTask,
} from '../src/components/demos/model/scheduler-sim.js'

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

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')
}

function text(html: string): string {
  return decode(html.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

function tableRows(table: string): string[][] {
  const body = only(table, /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/g)
  return [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => text(c[1]!)),
  )
}

/** The part of a page from the `<h2>` with this id to the next `<h2>`. */
function section(html: string, id: string): string {
  const start = html.indexOf(`<h2 id="${id}"`)
  expect(start).toBeGreaterThan(-1)
  const end = html.indexOf('<h2 ', start + 1)
  return html.slice(start, end === -1 ? undefined : end)
}

/** The text of each item of the section's numbered list: the lab's steps. */
function steps(sectionHtml: string): string[] {
  const list = only(sectionHtml, /<ol>([\s\S]*?)<\/ol>/g)
  return [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]!))
}

// ---- hand-written truth ----

const REFUSAL =
  'ui#build and ui#bundle both declare the output "dist/**" in cache.outputs.files — ' +
  "vx cleans a task's declared outputs before it runs and before a cache-hit restore, so " +
  "whichever of these runs second DELETES the other's output and the run still reports " +
  'success. Give each task its own output path.'

const UI_CHAIN = ['ui#build', 'ui#test', 'app#build', 'app#test']
const API_CHAIN = ['api#build', 'api#test', 'app#build', 'app#test']

interface Truth {
  /** The live region's sentence after the Run, or the one error. */
  said: string
  /** Each moved key's cell, in table order. */
  moved: Record<string, string>
  /** What the step's text on the page must hold. */
  prose: string[]
}

const upstream = (first: string, cell: string): Record<string, string> => ({
  [first]: cell,
  [first.replace('#build', '#test')]: `upstream ${first} moved`,
  'app#build': `upstream ${first} moved`,
  'app#test': 'upstream app#build moved',
})

const TRUTH: Record<LabId, Truth[]> = {
  'unlisted-file': [
    {
      said: '9 tasks: 0 hit, 9 miss. Every key is new.',
      moved: {},
      prose: ['all nine tasks miss'],
    },
    {
      said: '9 tasks: 9 hit, 0 miss. No key moved.',
      moved: {},
      prose: ['No key moves', 'all nine tasks hit'],
    },
    {
      said: `9 tasks: 5 hit, 4 miss. Keys moved: ${UI_CHAIN.join(', ')}.`,
      moved: upstream('ui#build', 'config changed, file added: packages/ui/notes.md'),
      prose: [
        'Four keys move',
        'ui#build says config changed, file added: packages/ui/notes.md',
        'ui#test and app#build say upstream ui#build moved',
        'app#test says upstream app#build moved',
      ],
    },
    {
      said: `9 tasks: 5 hit, 4 miss. Keys moved: ${UI_CHAIN.join(', ')}.`,
      moved: upstream('ui#build', 'packages/ui/notes.md changed'),
      prose: ['The same four keys move', 'ui#build now says packages/ui/notes.md changed'],
    },
  ],
  'undeclared-read': [
    {
      said: '9 tasks: 0 hit, 9 miss. Every key is new.',
      moved: {},
      prose: ['All nine tasks miss'],
    },
    {
      said: '9 tasks: 9 hit, 0 miss. No key moved.',
      moved: {},
      prose: ['No key moves', 'all nine tasks hit', 'That is a stale hit'],
    },
    {
      said: `9 tasks: 5 hit, 4 miss. Keys moved: ${API_CHAIN.join(', ')}.`,
      moved: upstream('api#build', 'config changed'),
      prose: ['Four keys move', 'api#build says config changed', 'denies the read of config.json'],
    },
    {
      said: `9 tasks: 5 hit, 4 miss. Keys moved: ${API_CHAIN.join(', ')}.`,
      moved: upstream('api#build', 'config changed, file added: packages/api/config.json'),
      prose: [
        'The same four keys move',
        'api#build says config changed, file added: packages/api/config.json',
      ],
    },
    {
      said: `9 tasks: 5 hit, 4 miss. Keys moved: ${API_CHAIN.join(', ')}.`,
      moved: upstream('api#build', 'packages/api/config.json changed'),
      prose: ['The four keys move', 'api#build says packages/api/config.json changed'],
    },
  ],
  'shared-output': [
    { said: REFUSAL, moved: {}, prose: ['There is no table', REFUSAL] },
    {
      said: '10 tasks: 0 hit, 10 miss. Every key is new.',
      moved: {},
      prose: ['Ten tasks plan, and all ten miss', 'ui#bundle now waits for ui#build'],
    },
    { said: '10 tasks: 10 hit, 0 miss. No key moved.', moved: {}, prose: ['All ten tasks hit'] },
    {
      said: '10 tasks: 5 hit, 5 miss. Keys moved: ui#build, ui#test, ui#bundle, app#build, app#test.',
      moved: {
        'ui#build': 'packages/ui/src/button.tsx changed',
        'ui#test': 'packages/ui/src/button.tsx changed, upstream ui#build moved',
        'ui#bundle': 'packages/ui/src/button.tsx changed, upstream ui#build moved',
        'app#build': 'upstream ui#build moved',
        'app#test': 'upstream app#build moved',
      },
      prose: [
        'Five keys move: ui#build, ui#test, ui#bundle, app#build and app#test',
        'ui#bundle says packages/ui/src/button.tsx changed, upstream ui#build moved',
      ],
    },
  ],
}

const SECTION: Record<LabId, string> = {
  'unlisted-file': 'lab-1-a-file-no-config-mentions',
  'undeclared-read': 'lab-2-an-input-the-task-reads-but-does-not-declare',
  'shared-output': 'lab-3-two-tasks-one-output',
}

// What each lab adds to the playground's workspace, and what it asks to run.
const ADDED_FILES: Record<LabId, string[]> = {
  'unlisted-file': ['packages/ui/notes.md'],
  'undeclared-read': ['packages/api/config.json'],
  'shared-output': [],
}
const TASK_FIELD: Record<LabId, string> = {
  'unlisted-file': 'build test docs',
  'undeclared-read': 'build test docs',
  'shared-output': 'build test docs bundle',
}

// The playground's static table, by hand (as playground-view.test.ts has it).
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
const LAB_STATIC: Record<LabId, [string, string, string][]> = {
  'unlisted-file': STATIC,
  'undeclared-read': STATIC,
  'shared-output': [...STATIC.slice(0, 4), ['ui#bundle', 'nothing', 'src/**'], ...STATIC.slice(4)],
}

let planner: Planner

beforeAll(async () => {
  planner = (await import(path.join(DIST, PLANNER_FILE))) as Planner
})

/** A Run of every state a lab's steps reach, as the page does them. */
async function walk(lab: LabId): Promise<{ said: string; moved: Record<string, string> }[]> {
  const { env, tasks } = LABS[lab]
  let files = LABS[lab].files
  let cached = new Set<string>()
  let last: PlaygroundTask[] | undefined
  const out: { said: string; moved: Record<string, string> }[] = []
  for (const edits of [[], ...LAB_STEPS[lab]]) {
    files = applyEdits(files, edits)
    const o = await runPlayground(planner, { files, env, tasks, cached })
    if (!o.ok) {
      out.push({ said: o.errors.join('\n'), moved: {} })
      continue
    }
    const rows = diffRuns(last, o.tasks, planner.diffKeyComponents)
    out.push({
      said: summarize(rows),
      moved: Object.fromEntries(
        rows.filter((r) => r.change === 'moved').map((r) => [r.id, changeCell(r)]),
      ),
    })
    last = o.tasks
    cached = o.cached
  }
  return out
}

describe('the labs on guide/labs', () => {
  const html = page('guide/labs')

  for (const lab of LAB_IDS) {
    it(`${lab}: every state its steps reach evaluates`, async () => {
      let files = LABS[lab].files
      for (const edits of [[], ...LAB_STEPS[lab]]) {
        files = applyEdits(files, edits)
        const texts = configTextsOf(files)
        expect(Object.keys(texts)).toEqual(['utils', 'ui', 'api', 'app'])
        for (const [name, t] of Object.entries(texts)) {
          const r = await planner.evaluateConfig(t, 10_000)
          expect({ name, ok: r.ok }).toEqual({ name, ok: true })
        }
      }
    })

    it(`${lab}: each step gives what the page says, and the model agrees by hand`, async () => {
      const truth = TRUTH[lab]
      expect(await walk(lab)).toEqual(truth.map(({ said, moved }) => ({ said, moved })))
      const said = steps(section(html, SECTION[lab]))
      expect(said).toHaveLength(truth.length)
      // The page names a cell as "<task> says <cell>" in its own words, so
      // each phrase is checked against the step's text with the code spans'
      // "the cell for" wording folded away.
      const flat = said.map((s) => s.replace(/the cells? for /gi, '').replace(/\s+/g, ' '))
      for (const [i, t] of truth.entries()) {
        for (const phrase of t.prose) {
          expect({ step: i + 1, holds: phrase, in: flat[i]!.includes(phrase) }).toEqual({
            step: i + 1,
            holds: phrase,
            in: true,
          })
        }
      }
    })

    it(`${lab}: the static render is the lab's start state`, async () => {
      const element = only(
        html,
        new RegExp(
          `<vx-playground\\b[^>]*data-lab="${lab}"[^>]*>([\\s\\S]*?)</vx-playground>`,
          'g',
        ),
      )
      const staticPart = only(element, /<div class="static\b[^"]*"[^>]*>([\s\S]*)<\/div>\s*$/g)
      const list = only(staticPart, /<ul class="file-list\b[^"]*"[^>]*>([\s\S]*?)<\/ul>/g)
      const files = [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]!))
      expect(files).toEqual(Object.keys(LABS[lab].files))
      expect(files.filter((f) => !(f in FILES))).toEqual(ADDED_FILES[lab])
      const configs = [
        ...staticPart.matchAll(
          /<summary>\s*<code>([^<]+)<\/code>\s*<\/summary>\s*<pre class="config\b[^"]*"[^>]*>([\s\S]*?)<\/pre>/g,
        ),
      ].map((m) => [m[1], decode(m[2]!)])
      expect(configs).toEqual(
        files.filter((f) => f.endsWith('/vx.config.mjs')).map((f) => [f, LABS[lab].files[f]]),
      )
      const rows = tableRows(only(staticPart, /(<table class="graph\b[\s\S]*?<\/table>)/g))
      expect(rows).toEqual(LAB_STATIC[lab])
      const evaluated: Record<string, unknown> = {}
      for (const [name, t] of Object.entries(configTextsOf(LABS[lab].files))) {
        evaluated[name] = ((await planner.evaluateConfig(t, 10_000)) as { config: unknown }).config
      }
      expect(rows).toEqual(staticTable(staticProjects(LABS[lab].files, evaluated)).map(staticCells))
      expect(only(element, /<input class="tasks\b[^>]*value="([^"]*)"/g)).toBe(TASK_FIELD[lab])
      expect(decode(only(element, /<textarea class="env\b[^>]*>([\s\S]*?)<\/textarea>/g))).toBe(
        envText(ENV),
      )
    })
  }

  it('holds the three playgrounds, one per lab, in lab order', () => {
    expect(
      [...html.matchAll(/<vx-playground\b([^>]*)>/g)].map(
        (m) => /\bdata-lab="([^"]*)"/.exec(m[1]!)?.[1],
      ),
    ).toEqual(['unlisted-file', 'undeclared-read', 'shared-output'])
  })

  it('answers the checkpoint with what the planner moves', async () => {
    const { env, tasks } = LABS['unlisted-file']
    const start = LABS['unlisted-file'].files
    const declared = applyEdits(start, [
      {
        file: 'packages/ui/vx.config.mjs',
        replace: "inputs: { files: ['src/**', 'test/**'] }",
        with: "inputs: { files: ['src/**', 'test/**', 'notes.md'] }",
      },
    ])
    const edited = applyEdits(declared, [{ file: 'packages/ui/notes.md', append: 'Edited.\n' }])
    let cached = new Set<string>()
    const runs: PlaygroundTask[][] = []
    for (const files of [start, declared, edited]) {
      const o = await runPlayground(planner, { files, env, tasks, cached })
      if (!o.ok) throw new Error(o.errors.join('\n'))
      runs.push(o.tasks)
      cached = o.cached
    }
    const moved = (i: number): Record<string, string> =>
      Object.fromEntries(
        diffRuns(runs[i - 1], runs[i]!, planner.diffKeyComponents)
          .filter((r) => r.change === 'moved')
          .map((r) => [r.id, changeCell(r)]),
      )
    expect([moved(1), moved(2)]).toEqual([
      { 'ui#test': 'config changed, file added: packages/ui/notes.md' },
      { 'ui#test': 'packages/ui/notes.md changed' },
    ])
    const answer = text(only(html, /<details>\s*<summary>Answer<\/summary>([\s\S]*?)<\/details>/g))
    expect([...new Set(answer.match(/\b\w+#\w+\b/g))]).toEqual(['ui#test'])
    expect(answer).toContain('config changed, file added: packages/ui/notes.md')
    expect(answer).toContain('packages/ui/notes.md changed')
  })
})

// ---- several playgrounds on one page ----

// The bundle's file system and env are module state, so two plans in flight
// at once would read each other's files; the bundle queues them. The configs
// are evaluated in-process first, so the two plans start in the same tick:
// a Worker's timing staggers them and hid the race.
describe('two playgrounds planning at once', () => {
  // The second workspace differs in a file the first lacks and in the env,
  // the two things a plan reads from the shared state at key time.
  const other = {
    files: { ...FILES, 'packages/ui/src/icon.tsx': 'export const Icon = () => null\n' },
    env: { API_URL: 'https://staging.example.com' },
  }
  const noApi = Object.fromEntries(
    Object.entries(FILES).filter(([f]) => !f.startsWith('packages/api/')),
  )
  let configs: Record<string, unknown>

  beforeAll(async () => {
    configs = {}
    for (const [name, t] of Object.entries(configTextsOf(FILES))) {
      const r = await evaluateConfigInProcess(t)
      if (!r.ok) throw new Error(`${name}: ${r.error}`)
      configs[name] = r.config
    }
  })

  const plan = (files: Record<string, string>, env: Record<string, string>) =>
    planner.planPlayground({ root: PLAYGROUND_ROOT, files, configs, env, tasks: TASKS })
  const keys = (r: { tasks: PlaygroundTask[] }): Record<string, string> =>
    Object.fromEntries(r.tasks.map((t) => [t.id, t.hash]))

  it('each plans its own workspace, as it does alone', async () => {
    const alone = [keys(await plan(FILES, ENV)), keys(await plan(other.files, other.env))]
    const moved = Object.keys(alone[1]!).filter((id) => alone[0]![id] !== alone[1]![id])
    expect(moved.sort()).toEqual([
      'api#build',
      'api#test',
      'app#build',
      'app#test',
      'ui#build',
      'ui#test',
    ])
    const together = await Promise.all([plan(FILES, ENV), plan(other.files, other.env)])
    expect(together.map(keys)).toEqual(alone)
  })

  it('a discovery and a plan each read their own workspace', async () => {
    const [projects, planned] = await Promise.all([
      planner.listPlaygroundProjects({ root: PLAYGROUND_ROOT, files: noApi }),
      plan(FILES, ENV),
    ])
    expect(projects.map((p) => p.name).sort()).toEqual(['app', 'ui', 'utils'])
    expect(planned.tasks.map((t) => t.id).sort()).toEqual([
      'api#build',
      'api#test',
      'app#build',
      'app#docs',
      'app#test',
      'ui#build',
      'ui#test',
      'utils#build',
      'utils#test',
    ])
  })
})

// ---- `data-lab`: the element opens on its lab's state ----

class FakeNode {
  hidden = false
  value = ''
  disabled = false
  textContent = ''
  dataset: Record<string, string> = {}
  children: { value: string }[] = []
  listeners = new Map<string, (e: unknown) => void>()
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, fn)
  }
  replaceChildren(...children: { value: string }[]): void {
    this.children = children
  }
  focus(): void {}
}

class FakeElement extends FakeNode {
  parts = new Map<string, FakeNode>()
  querySelector(selector: string): FakeNode {
    let node = this.parts.get(selector)
    if (node === undefined) this.parts.set(selector, (node = new FakeNode()))
    return node
  }
}

type Mounted = FakeElement & { connectedCallback(): void }

describe('<vx-playground data-lab>', () => {
  const defined = new Map<string, new () => Mounted>()
  const saved = {
    HTMLElement: (globalThis as Record<string, unknown>)['HTMLElement'],
    customElements: (globalThis as Record<string, unknown>)['customElements'],
    Option: (globalThis as Record<string, unknown>)['Option'],
  }

  beforeAll(async () => {
    Object.assign(globalThis, {
      HTMLElement: FakeElement,
      customElements: {
        define: (name: string, cls: new () => Mounted) => defined.set(name, cls),
      },
      Option: class {
        constructor(
          public text: string,
          public value: string,
        ) {}
      },
    })
    await import('../src/components/demos/playground.js')
  })

  afterAll(() => Object.assign(globalThis, saved))

  function mount(lab?: string): Mounted {
    const el = new (defined.get('vx-playground')!)()
    if (lab !== undefined) el.dataset['lab'] = lab
    el.connectedCallback()
    return el
  }
  const fileList = (el: Mounted): string[] => el.querySelector('.file').children.map((o) => o.value)
  const reset = (el: Mounted): void =>
    el.listeners.get('click')!({
      target: { closest: () => ({ dataset: { action: 'reset' } }) },
    })

  it("opens on its lab's files, and Reset restores its lab's env and task specs", () => {
    for (const lab of LAB_IDS) {
      const el = mount(lab)
      const files = fileList(el)
      expect({ lab, added: files.filter((f) => !(f in FILES)) }).toEqual({
        lab,
        added: ADDED_FILES[lab],
      })
      expect(files).toEqual(Object.keys(LABS[lab].files))
      expect(el.querySelector('.editor').value).toBe(LABS[lab].files[files[0]!]!)
      reset(el)
      expect({ lab, tasks: el.querySelector('.tasks').value }).toEqual({
        lab,
        tasks: TASK_FIELD[lab],
      })
      expect(el.querySelector('.env').value).toBe(envText(ENV))
      expect(fileList(el)).toEqual(files)
    }
  })

  it('without the attribute, opens on the workspace, as chapter 10’s playground does', () => {
    const el = mount()
    expect(fileList(el)).toEqual(Object.keys(FILES))
    reset(el)
    expect(el.querySelector('.tasks').value).toBe('build test docs')
    const tag = only(page('guide/try-it'), /<vx-playground\b([^>]*)>/g)
    expect([...tag.matchAll(/\s([\w-]+)=/g)].map((m) => m[1])).toEqual(['data-vx-demo', 'class'])
  })

  it('refuses a lab it does not know', () => {
    expect(() => mount('no-such-lab')).toThrow("no playground lab 'no-such-lab'")
  })
})

// ---- lab 4, in the simulator on the same page ----

describe('lab 4 on guide/labs', () => {
  const html = page('guide/labs')
  const none = new Set<string>()
  const docsAt = (seconds: number): SimTask[] =>
    SIM_TASKS.map((t) => (t.id === 'app#docs' ? { ...t, dur: seconds * 1000 } : t))
  const at = (tasks: SimTask[], workers: number) => {
    const count = schedule(tasks, none, 'count', workers)
    return {
      chain: criticalPath(tasks).chain,
      path: criticalPath(tasks).length / 1000,
      bound: lowerBound(tasks, workers) / 1000,
      count: count.makespan / 1000,
      docsStarts: count.bars.find((b) => b.id === 'app#docs')!.start / 1000,
      median: schedule(tasks, none, 'median', workers).makespan / 1000,
    }
  }
  const CHAIN = ['utils#build', 'api#build', 'app#build', 'app#test']

  it('each step gives the numbers the page says, by hand', () => {
    expect([at(docsAt(10), 2), at(docsAt(20), 2), at(docsAt(30), 2), at(docsAt(30), 3)]).toEqual([
      { chain: CHAIN, path: 24, bound: 24, count: 27, docsStarts: 8, median: 24 },
      { chain: CHAIN, path: 24, bound: 29, count: 30, docsStarts: 8, median: 29 },
      { chain: ['app#docs'], path: 30, bound: 34, count: 38, docsStarts: 8, median: 34 },
      { chain: ['app#docs'], path: 30, bound: 30, count: 32, docsStarts: 2, median: 30 },
    ])
    const said = steps(section(html, 'lab-4-a-bad-order'))
    expect(said).toHaveLength(4)
    const PROSE = [
      ['starts app#docs at 8 seconds and finishes at 27', 'finishes at 24'],
      ['24 seconds', 'at least 29', 'Tasks waiting finishes at 30, and learned durations at 29'],
      ['app#docs alone takes 30 seconds', 'The bound is 34', 'starts app#docs at 8 seconds'],
      ['starts app#docs at 2 seconds', 'finishes at 32', 'finishes at 30'],
    ]
    for (const [i, phrases] of PROSE.entries()) {
      for (const p of phrases) {
        expect({ step: i + 1, holds: p, in: said[i]!.includes(p) }).toEqual({
          step: i + 1,
          holds: p,
          in: true,
        })
      }
    }
    expect(said[2]).toContain('The run finishes at 38')
    expect(said[2]).toContain('finishes at 34, on the bound')
  })

  it('holds the simulator it steps through, in its own section', () => {
    expect(section(html, 'lab-4-a-bad-order').match(/<vx-scheduler-sim\b/g)).toHaveLength(1)
    expect(html.match(/<vx-scheduler-sim\b/g)).toHaveLength(1)
  })
})
