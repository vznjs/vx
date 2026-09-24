// The playground page (learn/playground, item 700): what the build shipped.
// Without JavaScript the page must teach on its own, so the static render
// holds the workspace's file list, each config's text and the task table;
// the controls are hidden; the page's scripts reach the element; and the
// element finds every piece of markup it reads. The table's truth is
// written out by hand in playground-view.test.ts; here the page is held to
// the view module that row holds.
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

const DIST = path.resolve(import.meta.dir, '../dist')
const ELEMENT = path.resolve(import.meta.dir, '../src/components/demos/playground.ts')

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

describe('the playground on learn/playground', () => {
  const html = page('learn/playground')
  const element = only(html, /<vx-playground\b[^>]*>([\s\S]*?)<\/vx-playground>/g)
  const staticPart = only(element, /<div class="static\b[^"]*"[^>]*>([\s\S]*)<\/div>\s*$/g)

  it('ships the task table for every task, from the config texts', async () => {
    const planner = (await import(path.join(DIST, PLANNER_FILE))) as Planner
    const configs: Record<string, unknown> = {}
    for (const [name, t] of Object.entries(CONFIG_TEXTS)) {
      configs[name] = ((await planner.evaluateConfig(t, 10_000)) as { config: unknown }).config
    }
    const table = only(staticPart, /(<table class="graph\b[\s\S]*?<\/table>)/g)
    const rows = tableRows(table)
    expect(rows).toEqual(staticTable(staticProjects(FILES, configs)).map(staticCells))
    const plan = await planner.planPlayground({
      root: PLAYGROUND_ROOT,
      files: FILES,
      configs,
      env: ENV,
      tasks: TASKS,
    })
    expect(rows.map((r) => r[0]!).sort()).toEqual(plan.tasks.map((t) => t.id).sort())
  })

  it("ships the workspace's files and each config's text", () => {
    const list = only(staticPart, /<ul class="file-list\b[^"]*"[^>]*>([\s\S]*?)<\/ul>/g)
    expect([...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]!))).toEqual(
      Object.keys(FILES),
    )
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
    const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0])
    const entry = scripts.flatMap((s) =>
      [...s.matchAll(/\/_astro\/([\w.-]+\.js)/g)].map((m) => m[1]!),
    )
    const defining = [...closure(entry)].filter((name) =>
      /customElements\.define\(\s*["'`]vx-playground["'`]/.test(
        readFileSync(path.join(DIST, '_astro', name), 'utf8'),
      ),
    )
    expect(defining).toHaveLength(1)
    // The planner is fetched on the first Run, never bundled into the page:
    // no chunk the element reaches carries core's discovery or the config
    // evaluator, and the positive shows the markers are the planner's.
    const planner = readFileSync(path.join(DIST, PLANNER_FILE), 'utf8')
    const MARKERS = ['Duplicate package name', 'did not export a default object']
    expect(MARKERS.map((m) => planner.includes(m))).toEqual([true, true])
    for (const name of closure(defining)) {
      const body = readFileSync(path.join(DIST, '_astro', name), 'utf8')
      expect({ name, found: MARKERS.filter((m) => body.includes(m)) }).toEqual({ name, found: [] })
    }
  })
})
