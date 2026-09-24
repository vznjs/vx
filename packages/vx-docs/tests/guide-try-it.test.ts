// Chapter 10, guide/try-it: the playground on the four packages, the labs,
// and the way out to a real repository. It hosts the playground, so the
// playground page's rows moved here from learn-playground.test.ts (and the
// untagged-element row from learn-labs.test.ts): without JavaScript the
// static render holds each config's text and the table of the tasks its
// run plans; the controls are hidden; the page's scripts reach the element
// without the planner; and the element finds every piece of markup it
// reads. Its checkpoint is held to its answer, written out here, and its
// pictures to the toy model and the labs page.
//
// It reads `dist/`, which the `build` task writes; the `test` task depends
// on `build` for that reason.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { PLANNER_FILE } from '../scripts/build-playground.js'
import { CONFIG_TEXTS, ENV, FILES, TASKS } from '../src/playground/workspace.js'
import {
  PLAYGROUND_ROOT,
  envText,
  staticCells,
  staticProjects,
  staticTable,
  type Planner,
} from '../src/components/demos/model/playground-view.js'
import { rerunBy } from '../src/components/demos/model/toy-monorepo.js'
import * as P from '../src/components/guide/try-it/pictures.js'
import {
  DIST,
  SITE,
  chapterShape,
  closure,
  codeBlocks,
  content,
  decode,
  defining,
  hrefs,
  only,
  page,
  runFlags,
  sections,
  tableRows,
  text,
} from './guide-page.js'

const SLUG = 'try-it'
const ELEMENT = path.join(SITE, 'src/components/demos/playground.ts')

/** The tasks the playground runs, in its order: the toy's eight. `app`
 *  also declares `app#docs`, which the default run leaves out. */
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

/** The chapter's one question, and its answer written out. */
const CHECK = {
  id: 'playground-env',
  question: 'Which tasks rerun when you change `API_URL`?',
  summary: '4 of the 8 tasks rerun.',
  yes: [
    'api#build reruns (env API_URL changed).',
    'api#test reruns (upstream api#build moved).',
    'app#build reruns (upstream api#build moved).',
    'app#test reruns (upstream app#build moved).',
  ],
}

/** Markup as the text a reader gets, with each `<code>` in backticks. */
function spoken(html: string): string {
  return text(html.replace(/<code>([^<]*)<\/code>/g, '`$1`'))
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

describe('the playground on guide/try-it', () => {
  const html = page(`guide/${SLUG}`)
  const element = only(html, /<vx-playground\b[^>]*>([\s\S]*?)<\/vx-playground>/g)
  const staticPart = only(element, /<div class="static\b[^"]*"[^>]*>([\s\S]*)<\/div>\s*$/g)

  it('ships the task table for every task, from the config texts', async () => {
    const planner = (await import(path.join(DIST, PLANNER_FILE))) as Planner
    const configs: Record<string, unknown> = {}
    for (const [name, t] of Object.entries(CONFIG_TEXTS)) {
      configs[name] = ((await planner.evaluateConfig(t, 10_000)) as { config: unknown }).config
    }
    const rows = tableRows(only(staticPart, /(<table class="graph\b[\s\S]*?<\/table>)/g))
    expect(rows).toEqual(staticTable(staticProjects(FILES, configs), TASKS).map(staticCells))
    const plan = await planner.planPlayground({
      root: PLAYGROUND_ROOT,
      files: FILES,
      configs,
      env: ENV,
      tasks: TASKS,
    })
    expect(rows.map((r) => r[0]!).sort()).toEqual(plan.tasks.map((t) => t.id).sort())
    expect(rows.map((r) => r[0]!).sort()).toEqual([...ALL].sort())
  })

  it("ships each config's text, folded", () => {
    const configs = [
      ...staticPart.matchAll(
        /<summary>\s*<code>([^<]+)<\/code>\s*<\/summary>\s*<pre class="config\b[^"]*"[^>]*>([\s\S]*?)<\/pre>/g,
      ),
    ].map((m) => [m[1], decode(m[2]!)])
    expect(configs).toEqual(
      Object.keys(FILES)
        .filter((f) => f.endsWith('/vx.config.mjs'))
        .map((f) => [f, FILES[f]]),
    )
    expect(configs).toHaveLength(Object.keys(CONFIG_TEXTS).length)
  })

  it('keeps the controls hidden, with the starting env and task specs, and names the planner', () => {
    const attrs = (tag: string, cls: string): string =>
      only(element, new RegExp(`<${tag} class="${cls}\\b[^"]*"([^>]*)>`, 'g')).trim()
    expect(attrs('div', 'controls')).toBe('data-planner="/vx/playground/planner.js" hidden')
    expect(existsSync(path.join(DIST, PLANNER_FILE))).toBe(true)
    expect(attrs('p', 'status')).toBe('aria-live="polite" hidden')
    expect(attrs('ul', 'errors')).toBe('hidden')
    expect(attrs('table', 'results')).toBe('hidden')
    expect(attrs('p', 'order')).toBe('hidden')
    expect(attrs('div', 'static')).toBe('')
    expect(decode(only(element, /<textarea class="env\b[^>]*>([\s\S]*?)<\/textarea>/g))).toBe(
      envText(ENV),
    )
    expect(only(element, /<input class="tasks\b[^>]*value="([^"]*)"/g)).toBe(TASKS.join(' '))
    expect([...element.matchAll(/<option value="([^"]+)">/g)].map((m) => decode(m[1]!))).toEqual(
      Object.keys(FILES),
    )
  })

  it('opens on the workspace, not a lab: the element carries no lab attribute', () => {
    const tag = only(html, /<vx-playground\b([^>]*)>/g)
    expect([...tag.matchAll(/\s([\w-]+)=/g)].map((m) => m[1])).toEqual(['data-vx-demo'])
  })

  it('holds every piece of markup the element reads, once', () => {
    const source = readFileSync(ELEMENT, 'utf8')
    const selectors = [
      ...new Set([...source.matchAll(/#el(?:<\w+>)?\('([^']+)'\)/g)].map((m) => m[1]!)),
    ]
    const actions = [...source.matchAll(/action === '(\w+)'/g)].map(
      (m) => `button[data-action="${m[1]}"]`,
    )
    // Positive first: the reader found the element's reads.
    expect(selectors).toContain('.controls')
    expect(actions).toEqual([
      'button[data-action="run"]',
      'button[data-action="reset"]',
      'button[data-action="add"]',
      'button[data-action="delete"]',
    ])
    const counts = Object.fromEntries(
      [...new Set([...selectors, ...actions])].map((s) => [s, matches(element, s)]),
    )
    expect(counts).toEqual(Object.fromEntries(Object.keys(counts).map((s) => [s, 1])))
    const results = only(element, /(<table class="results\b[\s\S]*?<\/table>)/g)
    expect([/<caption>/.test(results), /<tbody>/.test(results)]).toEqual([true, true])
  })

  it("loads the element from the page's scripts, without the planner", () => {
    const found = defining(html, 'vx-playground')
    expect(found).toHaveLength(1)
    // The planner is fetched on the first Run, never bundled into the page:
    // no chunk the element reaches carries core's discovery or the config
    // evaluator, and the positive shows the markers are the planner's.
    const planner = readFileSync(path.join(DIST, PLANNER_FILE), 'utf8')
    const MARKERS = ['Duplicate package name', 'did not export a default object']
    expect(MARKERS.map((m) => planner.includes(m))).toEqual([true, true])
    for (const name of closure(found)) {
      const body = readFileSync(path.join(DIST, '_astro', name), 'utf8')
      expect({ name, found: MARKERS.filter((m) => body.includes(m)) }).toEqual({ name, found: [] })
    }
  })
})

describe('the checkpoint on guide/try-it', () => {
  const html = page(`guide/${SLUG}`)
  const el = only(html, /<vx-checkpoint\b[^>]*>([\s\S]*?)<\/vx-checkpoint>/g)

  it('asks the env question under "Check yourself"', () => {
    expect(only(el, /<fieldset class="form\b[^"]*"[^>]*data-checkpoint="([^"]+)"/g)).toBe(CHECK.id)
    const check = sections(content(html)).find((s) => s.id === 'check-yourself')!.html
    expect(check.match(/<vx-checkpoint\b/g)).toHaveLength(1)
  })

  it('states the question, and the answer without JavaScript', () => {
    expect(spoken(only(el, /<p class="question\b[^"]*">([\s\S]*?)<\/p>/g))).toBe(CHECK.question)
    const details = only(el, /<details class="answer\b[^"]*">([\s\S]*?)<\/details>/g)
    const paragraphs = [...details.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) => spoken(m[1]!))
    expect(paragraphs[0]).toBe(CHECK.summary)
    expect([...details.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => spoken(m[1]!))).toEqual(
      CHECK.yes,
    )
    const boxes = [...el.matchAll(/<input type="checkbox" value="([^"]+)"/g)].map((m) => m[1])
    expect(boxes).toEqual(ALL)
  })

  it("loads the checkpoint element from the page's scripts", () => {
    expect(defining(html, 'vx-checkpoint')).toHaveLength(1)
  })
})

chapterShape({
  slug: SLUG,
  titles: [
    'Edit, run, and read what moved',
    'One file moves four keys',
    'Break it on purpose in the labs',
  ],
  pictures: [P.loop, P.ripple, P.labs],
  rows: {
    'packages/vx/tests/playground-parity.unsafe.test.ts': [
      'the playground bundle plans what the CLI plans',
    ],
  },
  inVxNames: ['Turborepo', 'Nx'],
})

describe("the chapter's pictures and exits", () => {
  const chapter = content(page(`guide/${SLUG}`))
  const inVx = sections(chapter).find((s) => s.id === 'in-vx')!.html

  it('moves the keys the toy model says an edit in ui moves, and draws each', () => {
    expect(P.RIPPLE).toEqual(rerunBy('ui'))
    expect(P.ripple.boxes.filter((b) => b.tone === 'accent').map((b) => b.id)).toEqual(P.RIPPLE)
  })

  it('draws one card per lab the labs page holds', () => {
    const labs = readFileSync(path.join(SITE, 'src/content/docs/guide/labs.mdx'), 'utf8')
    expect(P.labs.boxes).toHaveLength(labs.match(/^## Lab \d+:/gm)!.length)
    expect(hrefs(chapter)).toContain('../labs/')
  })

  it('shows the loop before the playground it describes', () => {
    expect(chapter.indexOf('data-picture="loop"')).toBeGreaterThan(-1)
    expect(chapter.indexOf('data-picture="loop"')).toBeLessThan(chapter.indexOf('<vx-playground'))
  })

  it('leaves by the quickstart and both migrations, and plans with a documented flag', () => {
    const links = hrefs(inVx)
    for (const exit of [
      '../../quickstart/',
      '../../guides/migrate/#turborepo',
      '../../guides/migrate/#nx',
    ]) {
      expect(links).toContain(exit)
    }
    expect(runFlags().has('--dry')).toBe(true)
    // At a workspace root a bare task name refuses ("not inside a project").
    expect(runFlags().has('--all')).toBe(true)
    expect(codeBlocks(inVx, 'sh')).toEqual(['vx run build test --all --dry'])
  })

  // Item 721's app#docs made the page run `build test docs`, so the page and
  // the chapter's one command named different runs. The page runs what the
  // chapter says; app#docs stays declared, for a reader who types it.
  it("runs the task specs the chapter's command names, and leaves app#docs out of them", () => {
    const [command] = codeBlocks(inVx, 'sh')
    const specs = command!
      .split(' ')
      .slice(2)
      .filter((w) => !w.startsWith('--'))
    expect(specs).toEqual(TASKS)
    expect(CONFIG_TEXTS['app']).toContain('    docs: {')
    expect(TASKS).not.toContain('docs')
  })
})
