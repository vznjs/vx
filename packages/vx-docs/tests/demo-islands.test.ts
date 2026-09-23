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

describe('the affected-graph demo on learn/what-is-task-orchestration', () => {
  const html = page()
  const element = only(html, /<vx-affected-graph\b[^>]*>([\s\S]*?)<\/vx-affected-graph>/g)

  it('ships the graph as static SVG inside the element', () => {
    const svg = only(element, /(<svg\b[\s\S]*<\/svg>)/g)
    expect([...svg.matchAll(/data-node="([^"]+)"/g)].map((m) => m[1]).sort()).toEqual([
      'api',
      'app',
      'ui',
    ])
    expect(
      [...svg.matchAll(/data-from="([^"]+)" data-to="([^"]+)"/g)]
        .map((m) => `${m[1]}→${m[2]}`)
        .sort(),
    ).toEqual(['app→api', 'app→ui'])
    expect(
      [...svg.matchAll(/<text\b[^>]*class="name\b[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]).sort(),
    ).toEqual(['api', 'app', 'ui'])
    // Without JavaScript the SVG is one image with a name, not three dead buttons.
    expect(svg).toMatch(/^<svg\b[^>]*role="img"/)
    expect(svg).not.toContain('role="button"')
  })

  it('says what depends on what, and what each change affects, in the caption', () => {
    // Expressive Code wraps every code block in a <figure> too.
    const figures = [...html.matchAll(/<figure class="vx-demo\b[^"]*">([\s\S]*?)<\/figure>/g)]
      .map((m) => m[1]!)
      .filter((f) => f.includes('<vx-affected-graph'))
    expect(figures).toHaveLength(1)
    const figure = figures[0]!
    expect(text(only(figure, /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/g))).toBe(
      'The build tasks of a toy monorepo. An arrow points from a task to the task it depends on: ' +
        'app depends on ui and api, and ui and api depend on nothing. ' +
        'So a change to ui affects ui and app; a change to api affects api and app; ' +
        'a change to app affects app alone.',
    )
  })

  it("loads the element's module from the page's own scripts", () => {
    const defining = [...reachableScripts(html)].filter((name) =>
      /customElements\.define\(\s*["'`]vx-affected-graph["'`]/.test(
        readFileSync(path.join(DIST, '_astro', name), 'utf8'),
      ),
    )
    expect(defining).toHaveLength(1)
  })
})
