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
  affectedBy,
  joinNames,
  neededBy,
  orderSentence,
  rerunBy,
  waves,
} from '../src/components/demos/model/toy-monorepo.js'

const DIST = path.resolve(import.meta.dir, '../dist')
const PAGE = path.join(DIST, 'learn/what-is-task-orchestration/index.html')

function page(): string {
  if (!existsSync(PAGE)) throw new Error(`${PAGE} is missing: run the site's build task first`)
  return readFileSync(PAGE, 'utf8')
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

  it.each(Object.keys(CHANGE))('a change to %s affects, reruns and needs the written sets', (pkg) => {
    expect({ affected: affectedBy(pkg), rerun: rerunBy(pkg), needed: neededBy(pkg) }).toEqual(
      CHANGE[pkg]!,
    )
  })

  it('orders a run by wave, and says so', () => {
    expect(waves(rerunBy('api'))).toEqual([['api#build'], ['api#test', 'app#build'], ['app#test']])
    expect(orderSentence(rerunBy('ui'))).toBe(
      'ui#build, then ui#test and app#build together, then app#test',
    )
  })
})

describe('the graph explorer on learn/what-is-task-orchestration', () => {
  const html = page()
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
