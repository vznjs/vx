// The chapters' checkpoints (roadmap W11, item 705;
// design/labs-checkpoints-2026-09.md § W11). A checkpoint's answer is computed
// by vx's planner, never written into the page, so the truth below is written
// out by hand: each question, and each task the answer holds with the reason
// it holds it. The planner the site ships is held to it, the built pages are
// held to it (the no-JavaScript answer is what the build computed), and the
// marking is held by pure rows with exact output.
//
// It reads `dist/`, which the `build` task writes; the `test` task depends on
// `build` for that reason.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { PLANNER_FILE } from '../scripts/build-playground.js'
import { evaluateConfigInProcess } from '../src/playground/config-eval.js'
import {
  CHECKPOINTS,
  answerCheckpoint,
  answerFromPlan,
  answerFromRuns,
  answerText,
  codeSpans,
  markAnswer,
  markLine,
  questionOf,
  verdictSentence,
  type AnswerRow,
  type CheckpointAnswer,
  type CheckpointId,
} from '../src/components/demos/model/checkpoint.js'
import type { Planner, PlaygroundTask } from '../src/components/demos/model/playground-view.js'

const DIST = path.resolve(import.meta.dir, '../dist')
const GUIDE = path.resolve(import.meta.dir, '../src/content/docs/guide')
const ELEMENT = path.resolve(import.meta.dir, '../src/components/demos/checkpoint.ts')

/** The toy workspace's tasks, in the playground's order. */
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
  form: 'edit' | 'run'
  question: string
  /** Each task in the answer, and why. */
  yes: Record<string, string>
  summary: string
}

const TRUTH: Record<string, Truth> = {
  // Chapter 3: `^build` pulls in every build app uses, and no test.
  dependencies: {
    form: 'run',
    question: 'Which tasks does `vx run app#build` run on an empty cache?',
    yes: {
      'utils#build': 'ui#build waits for it',
      'ui#build': 'app#build waits for it',
      'api#build': 'app#build waits for it',
      'app#build': 'you asked for it',
    },
    summary: '4 of the 8 tasks run.',
  },
  // Chapter 5: a change in api moves api's keys and the keys above it.
  caching: {
    form: 'edit',
    question: 'Which tasks rerun when you edit `api/src/server.ts`?',
    yes: {
      'api#build': 'packages/api/src/server.ts changed',
      'api#test': 'packages/api/src/server.ts changed, upstream api#build moved',
      'app#build': 'upstream api#build moved',
      'app#test': 'upstream app#build moved',
    },
    summary: '4 of the 8 tasks rerun.',
  },
  // Chapter 6: app's banner.txt, which no input lists.
  correctness: {
    form: 'edit',
    question: 'Which tasks rerun when you edit `app/banner.txt`?',
    yes: {},
    summary: 'No task reruns.',
  },
  'playground-env': {
    form: 'edit',
    question: 'Which tasks rerun when you change `API_URL`?',
    yes: {
      'api#build': 'env API_URL changed',
      'api#test': 'upstream api#build moved',
      'app#build': 'upstream api#build moved',
      'app#test': 'upstream app#build moved',
    },
    summary: '4 of the 8 tasks rerun.',
  },
}

/** Which chapter places which checkpoints, in order. */
const PAGES: Record<string, string[]> = {
  caching: ['caching'],
  dependencies: ['dependencies'],
  trust: ['correctness'],
  'try-it': ['playground-env'],
}

const NO_REASON = { edit: 'key unchanged', run: 'not needed by what you asked for' }
const VERB = {
  edit: { one: 'reruns', notOne: 'does not rerun', notMany: 'do not rerun' },
  run: { one: 'runs', notOne: 'does not run', notMany: 'do not run' },
}

function rowsOf(t: Truth): AnswerRow[] {
  return ALL.map((id) =>
    id in t.yes
      ? { id, yes: true, reason: t.yes[id]! }
      : { id, yes: false, reason: NO_REASON[t.form] },
  )
}

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

/** Markup as the text a reader gets, with each `<code>` in backticks. */
function text(html: string): string {
  return decode(html.replace(/<code>([^<]*)<\/code>/g, '`$1`').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every `_astro/*.js` reachable from `names` through the chunks' imports. */
function closure(names: string[]): Set<string> {
  const seen = new Set<string>()
  const queue = [...names]
  while (queue.length > 0) {
    const name = queue.pop()!
    const file = path.join(DIST, '_astro', name)
    if (seen.has(name) || !existsSync(file)) continue
    seen.add(name)
    for (const m of readFileSync(file, 'utf8').matchAll(/["'`]\.\/([\w.-]+\.js)["'`]/g)) {
      queue.push(m[1]!)
    }
  }
  return seen
}

/** The elements of `html` a selector of the form the element uses matches:
 *  `.class`, or `tag[attr="value"]`. */
function matches(html: string, selector: string): number {
  const cls = /^\.([\w-]+)$/.exec(selector)
  if (cls !== null) {
    return [...html.matchAll(/<[a-z]+\b[^>]*\bclass="([^"]*)"/g)].filter((m) =>
      m[1]!.split(/\s+/).includes(cls[1]!),
    ).length
  }
  const attr = /^([a-z]+)\[([\w-]+)="([^"]+)"\]$/.exec(selector)
  if (attr === null) throw new Error(`the row cannot read the selector ${selector}`)
  return [...html.matchAll(new RegExp(`<${attr[1]}\\b[^>]*\\b${attr[2]}="${attr[3]}"`, 'g'))].length
}

describe('the marking', () => {
  const answer: CheckpointAnswer = {
    form: 'edit',
    rows: [
      { id: 'a#build', yes: true, reason: 'src/a.ts changed' },
      { id: 'a#test', yes: true, reason: 'upstream a#build moved' },
      { id: 'b#build', yes: false, reason: 'key unchanged' },
      { id: 'b#test', yes: false, reason: 'key unchanged' },
    ],
  }

  it('marks a ticked answer right, an unticked one missed, a ticked non-answer wrong', () => {
    expect(markAnswer(answer, new Set(['a#build', 'b#build']))).toEqual([
      { id: 'a#build', yes: true, reason: 'src/a.ts changed', verdict: 'right' },
      { id: 'a#test', yes: true, reason: 'upstream a#build moved', verdict: 'missed' },
      { id: 'b#build', yes: false, reason: 'key unchanged', verdict: 'wrong' },
      { id: 'b#test', yes: false, reason: 'key unchanged', verdict: 'right' },
    ])
  })

  it('says each mark in words, with its reason, in both forms', () => {
    const marks = markAnswer(answer, new Set(['a#build', 'b#build']))
    expect(marks.map((m) => markLine('edit', m))).toEqual([
      'Right: a#build reruns (src/a.ts changed).',
      'Missed: a#test reruns (upstream a#build moved).',
      'Wrong: b#build does not rerun (key unchanged).',
      'Right: b#test does not rerun (key unchanged).',
    ])
    expect(marks.map((m) => markLine('run', m))).toEqual([
      'Right: a#build runs (src/a.ts changed).',
      'Missed: a#test runs (upstream a#build moved).',
      'Wrong: b#build does not run (key unchanged).',
      'Right: b#test does not run (key unchanged).',
    ])
  })

  it('sums the marking up in one sentence', () => {
    expect(verdictSentence(markAnswer(answer, new Set(['a#build', 'b#build'])))).toBe(
      '2 of 4 right. Missed: a#test. Wrong: b#build.',
    )
    expect(verdictSentence(markAnswer(answer, new Set(['a#build', 'a#test'])))).toBe('All 4 right.')
    expect(verdictSentence(markAnswer(answer, new Set()))).toBe(
      '2 of 4 right. Missed: a#build, a#test.',
    )
    expect(verdictSentence(markAnswer(answer, new Set(['a#build', 'a#test', 'b#test'])))).toBe(
      '3 of 4 right. Wrong: b#test.',
    )
  })

  it('writes the no-JavaScript answer: a summary, a line per task in it, the rest by reason', () => {
    expect(answerText(answer)).toEqual({
      summary: '2 of the 4 tasks rerun.',
      yes: ['a#build reruns (src/a.ts changed).', 'a#test reruns (upstream a#build moved).'],
      rest: ['b#build, b#test do not rerun (key unchanged).'],
    })
    const none: CheckpointAnswer = { form: 'edit', rows: answer.rows.slice(2) }
    expect(answerText(none)).toEqual({
      summary: 'No task reruns.',
      yes: [],
      rest: ['b#build, b#test do not rerun (key unchanged).'],
    })
    const all: CheckpointAnswer = { form: 'edit', rows: answer.rows.slice(0, 2) }
    expect(answerText(all)).toEqual({
      summary: 'All 2 tasks rerun.',
      yes: ['a#build reruns (src/a.ts changed).', 'a#test reruns (upstream a#build moved).'],
      rest: [],
    })
    const one: CheckpointAnswer = { form: 'run', rows: answer.rows.slice(1, 3) }
    expect(answerText(one)).toEqual({
      summary: '1 of the 2 tasks runs.',
      yes: ['a#test runs (upstream a#build moved).'],
      rest: ['b#build does not run (key unchanged).'],
    })
  })

  it("names a moved key's changes as core's diff gives them, and a new or unexplained one", () => {
    const task = (id: string, hash: string, n: number): PlaygroundTask => ({
      id,
      project: id.split('#')[0]!,
      task: id.split('#')[1]!,
      hash,
      cacheStatus: 'miss',
      deps: [],
      components: Array.from({ length: n }, (_, i) => ({ kind: 'file', name: `f${i}`, hash })),
    })
    const run = (tasks: PlaygroundTask[]) => ({
      ok: true as const,
      tasks,
      dispatchOrder: [],
      cached: new Set<string>(),
    })
    // A stand-in for core's join: it names two changes for a key with
    // components, and nothing for one without (a group's).
    const diff: Planner['diffKeyComponents'] = (_before, after) => ({
      entries:
        after.length === 0
          ? []
          : [
              { kind: 'file', name: 'src/a.ts', change: 'changed', before: '1', after: '2' },
              { kind: 'upstream', name: 'a#build', change: 'changed', before: '1', after: '2' },
            ],
      unchangedCount: 0,
    })
    const before = run([task('a#build', '1', 1), task('a#test', '2', 1), task('a#all', '3', 0)])
    const after = run([
      task('a#build', '1', 1),
      task('a#test', '2b', 1),
      task('a#all', '3b', 0),
      task('a#lint', '4', 1),
    ])
    expect(answerFromRuns(before, after, diff)).toEqual({
      form: 'edit',
      rows: [
        { id: 'a#build', yes: false, reason: 'key unchanged' },
        { id: 'a#test', yes: true, reason: 'src/a.ts changed, upstream a#build moved' },
        { id: 'a#all', yes: true, reason: 'its key moved' },
        { id: 'a#lint', yes: true, reason: 'the first run did not have it' },
      ],
    })
  })

  it('names each planned task for the task that asked for it', () => {
    const all = ['a#build', 'a#test', 'b#build', 'b#test']
    const planned = [
      { id: 'a#build', deps: [] },
      { id: 'b#build', deps: ['a#build'] },
    ]
    expect(answerFromPlan(all, planned, ['b#build'])).toEqual({
      form: 'run',
      rows: [
        { id: 'a#build', yes: true, reason: 'b#build waits for it' },
        { id: 'a#test', yes: false, reason: 'not needed by what you asked for' },
        { id: 'b#build', yes: true, reason: 'you asked for it' },
        { id: 'b#test', yes: false, reason: 'not needed by what you asked for' },
      ],
    })
    // A bare task name asks for every project's task of that name.
    expect(answerFromPlan(all, planned, ['build']).rows.map((r) => r.reason)).toEqual([
      'you asked for it',
      'not needed by what you asked for',
      'you asked for it',
      'not needed by what you asked for',
    ])
  })

  it('splits a sentence into its code spans', () => {
    expect(codeSpans('You edit `a.ts` and run `vx run build`.')).toEqual([
      { code: false, text: 'You edit ' },
      { code: true, text: 'a.ts' },
      { code: false, text: ' and run ' },
      { code: true, text: 'vx run build' },
      { code: false, text: '.' },
    ])
  })
})

describe('the checkpoints', () => {
  it('are the ones written out here, each placed by exactly one chapter', () => {
    const placed: Record<string, string[]> = {}
    for (const f of readdirSync(GUIDE).filter((n) => n.endsWith('.mdx'))) {
      const ids = [
        ...readFileSync(path.join(GUIDE, f), 'utf8').matchAll(/<Checkpoint id="([^"]+)"/g),
      ]
      if (ids.length > 0) placed[f.replace(/\.mdx$/, '')] = ids.map((m) => m[1]!)
    }
    expect(placed).toEqual(PAGES)
    const onPages = Object.values(PAGES).flat()
    expect([...onPages].sort()).toEqual(Object.keys(TRUTH).sort())
    expect(Object.keys(CHECKPOINTS).sort()).toEqual(Object.keys(TRUTH).sort())
  })

  it('ask the questions written out here', () => {
    for (const id of Object.keys(TRUTH)) {
      const c = CHECKPOINTS[id as CheckpointId]
      expect({ id, form: c.form, question: questionOf(c) }).toEqual({
        id,
        form: TRUTH[id]!.form,
        question: TRUTH[id]!.question,
      })
    }
  })

  // The simple brief (2026-09-24): a reader with no context gets one short
  // plain sentence, with no setup and no config to read first.
  it('ask each in one short sentence', () => {
    for (const id of Object.keys(TRUTH)) {
      const q = questionOf(CHECKPOINTS[id as CheckpointId])
      expect({
        id,
        sentences: q.split(/[.?!](?:\s|$)/).filter((x) => x.trim() !== '').length,
        short: q.split(/\s+/).length <= 12,
        asks: q.endsWith('?'),
      }).toEqual({ id, sentences: 1, short: true, asks: true })
    }
  })

  it('end on a note that names no task, so no answer hides in it', () => {
    const notes = Object.entries(CHECKPOINTS).flatMap(([id, c]) =>
      c.note === undefined ? [] : [[id, c.note.match(/\b[\w@/-]+#\w+\b/g) ?? []]],
    )
    expect(notes).toEqual([
      ['caching', []],
      ['correctness', []],
    ])
  })

  describe('answered by the planner the site ships', () => {
    let planner: Planner
    beforeAll(async () => {
      planner = (await import(path.join(DIST, PLANNER_FILE))) as Planner
    })

    it.each(Object.keys(TRUTH))('%s: every task, in the answer or not, and why', async (id) => {
      const answer = await answerCheckpoint(planner, CHECKPOINTS[id as CheckpointId])
      expect(answer).toEqual({ form: TRUTH[id]!.form, rows: rowsOf(TRUTH[id]!) })
    })

    // The planner's file system and env are module state, and a page renders
    // its checkpoints concurrently, with configs evaluated in-process as the
    // build evaluates them: asked at once, each answer is still its own.
    it('answers every checkpoint asked at once as it answers each alone', async () => {
      const inProcess = { ...planner, evaluateConfig: evaluateConfigInProcess }
      const ids = Object.keys(TRUTH)
      const answers = await Promise.all(
        ids.map((id) => answerCheckpoint(inProcess, CHECKPOINTS[id as CheckpointId])),
      )
      expect(Object.fromEntries(ids.map((id, i) => [id, answers[i]]))).toEqual(
        Object.fromEntries(
          ids.map((id) => [id, { form: TRUTH[id]!.form, rows: rowsOf(TRUTH[id]!) }]),
        ),
      )
    })
  })
})

describe('the checkpoints on the built pages', () => {
  const elements = Object.fromEntries(
    Object.keys(PAGES).map((slug) => [
      slug,
      [...page(`guide/${slug}`).matchAll(/<vx-checkpoint\b[^>]*>([\s\S]*?)<\/vx-checkpoint>/g)].map(
        (m) => m[1]!,
      ),
    ]),
  )
  const each = Object.entries(PAGES).flatMap(([slug, ids]) =>
    ids.map((id, i) => ({ slug, id, html: () => elements[slug]![i]! })),
  )

  it('place each page’s checkpoints, in order', () => {
    expect(
      Object.fromEntries(
        Object.entries(elements).map(([slug, els]) => [
          slug,
          els.map((e) => only(e, /<fieldset class="form\b[^"]*"[^>]*data-checkpoint="([^"]+)"/g)),
        ]),
      ),
    ).toEqual(PAGES)
  })

  it.each(each)('$slug, $id: the question, and the answer without JavaScript', ({ id, html }) => {
    const t = TRUTH[id]!
    const el = html()
    expect(text(only(el, /<p class="question\b[^"]*">([\s\S]*?)<\/p>/g))).toBe(t.question)
    const details = only(el, /<details class="answer\b[^"]*">([\s\S]*?)<\/details>/g)
    expect(text(only(details, /<summary>([\s\S]*?)<\/summary>/g))).toBe('Answer')
    const paragraphs = [...details.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) => text(m[1]!))
    expect(paragraphs[0]).toBe(t.summary)
    const yes = [...details.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]!))
    const verb = VERB[t.form]
    expect(yes).toEqual(Object.entries(t.yes).map(([task, why]) => `${task} ${verb.one} (${why}).`))
    const rest = [...details.matchAll(/<p class="rest\b[^"]*">([\s\S]*?)<\/p>/g)].map((m) =>
      text(m[1]!),
    )
    const others = ALL.filter((task) => !(task in t.yes))
    const not = others.length === 1 ? verb.notOne : verb.notMany
    expect(rest).toEqual(
      others.length === 0 ? [] : [`${others.join(', ')} ${not} (${NO_REASON[t.form]}).`],
    )
    const note = CHECKPOINTS[id as CheckpointId].note
    expect(paragraphs.slice(1 + rest.length)).toEqual(note === undefined ? [] : [note])
  })

  it.each(each)(
    '$slug, $id: a labelled box per task, hidden, and an empty live region',
    ({ id, html }) => {
      const el = html()
      expect(only(el, /<fieldset class="form\b[^"]*"([^>]*)>/g).trim()).toBe(
        `data-checkpoint="${id}" data-planner="/vx/playground/planner.js" hidden`,
      )
      const boxes = [
        ...el.matchAll(
          /<li>\s*<label>\s*<input type="checkbox" value="([^"]+)"\s*\/?>\s*<code>([^<]+)<\/code>\s*<\/label>\s*<\/li>/g,
        ),
      ]
      expect(boxes.map((m) => [m[1], m[2]])).toEqual(ALL.map((task) => [task, task]))
      expect(only(el, /<legend>([\s\S]*?)<\/legend>/g)).toBe(
        `Tick each task that ${TRUTH[id]!.form === 'edit' ? 'reruns' : 'runs'}.`,
      )
      expect(only(el, /(<div class="result\b[^>]*>[\s\S]*?<\/div>)/g)).toMatch(
        /^<div class="result"[^>]* aria-live="polite"><\/div>$/,
      )
    },
  )

  it('hold every piece of markup the element reads, once each', () => {
    const source = readFileSync(ELEMENT, 'utf8')
    const selectors = [
      ...new Set([...source.matchAll(/#el(?:<\w+>)?\('([^']+)'\)/g)].map((m) => m[1]!)),
    ]
    // Positive first: the reader found the element's reads.
    expect(selectors.sort()).toEqual(['.answer', '.form', '.result', 'button[data-action="check"]'])
    expect(source).toContain("querySelectorAll<HTMLInputElement>('.choices input')")
    for (const { slug, id, html } of each) {
      const el = html()
      const counts = Object.fromEntries([...selectors, '.choices'].map((s) => [s, matches(el, s)]))
      expect({ slug, id, counts }).toEqual({
        slug,
        id,
        counts: Object.fromEntries([...selectors, '.choices'].map((s) => [s, 1])),
      })
    }
  })

  it("load the element from each page's scripts, without the planner", () => {
    const planner = readFileSync(path.join(DIST, PLANNER_FILE), 'utf8')
    const MARKERS = ['Duplicate package name', 'did not export a default object']
    expect(MARKERS.map((m) => planner.includes(m))).toEqual([true, true])
    for (const slug of Object.keys(PAGES)) {
      const html = page(`guide/${slug}`)
      const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0])
      const entry = scripts.flatMap((s) =>
        [...s.matchAll(/\/_astro\/([\w.-]+\.js)/g)].map((m) => m[1]!),
      )
      const defining = [...closure(entry)].filter((name) =>
        /customElements\.define\(\s*["'`]vx-checkpoint["'`]/.test(
          readFileSync(path.join(DIST, '_astro', name), 'utf8'),
        ),
      )
      expect({ slug, defining: defining.length }).toEqual({ slug, defining: 1 })
      for (const name of closure(defining)) {
        const body = readFileSync(path.join(DIST, '_astro', name), 'utf8')
        expect({ name, found: MARKERS.filter((m) => body.includes(m)) }).toEqual({
          name,
          found: [],
        })
      }
    }
  })
})
