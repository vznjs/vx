// The playground page, playground/ (design/site-short-2026-09.md: the
// Guide's chapter 10 collapsed into it, and its rows moved with it). Without
// JavaScript the static render holds each config's text and the table of the
// tasks its run plans; the controls are hidden; the page's scripts reach the
// element without the planner; the element finds every piece of markup it
// reads; and the page's one command runs what the playground runs.
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

const SITE = path.resolve(import.meta.dir, '..')
const DIST = path.join(SITE, 'dist')
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

function page(rel: string): string {
  const file = path.join(DIST, rel, 'index.html')
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
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&')
}

function text(html: string): string {
  return decode(html.replace(/<[^>]+>/g, ''))
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

/** Each code block in `html` in the given language, as its text. Expressive
 *  Code puts one `ec-line` per source line. */
function codeBlocks(html: string, lang: string): string[] {
  return [
    ...html.matchAll(
      new RegExp(`<pre data-language="${lang}"[^>]*><code>([\\s\\S]*?)</code></pre>`, 'g'),
    ),
  ].map((m) =>
    m[1]!
      .split(/<div class="ec-line[^"]*"[^>]*>/)
      .slice(1)
      .map((line) => decode(line.replace(/<[^>]+>/g, '')).replace(/\n$/, ''))
      .join('\n'),
  )
}

/** Every `_astro/*.js` reachable from `names` through the chunks' imports. */
function closure(names: string[]): Set<string> {
  const seen = new Set<string>()
  const queue = [...names]
  while (queue.length > 0) {
    const name = queue.pop()!
    const file = path.join(DIST, '_astro', name)
    // mermaid's chunks name files it never emits (`./elk-worker.min.js`).
    if (seen.has(name) || !existsSync(file)) continue
    seen.add(name)
    for (const m of readFileSync(file, 'utf8').matchAll(/["'`]\.\/([\w.-]+\.js)["'`]/g)) {
      queue.push(m[1]!)
    }
  }
  return seen
}

/** The chunks reachable from the page's own scripts that define `<tag>`. */
function defining(html: string, tag: string): string[] {
  const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0])
  const reachable = closure(
    scripts.flatMap((s) => [...s.matchAll(/\/_astro\/([\w.-]+\.js)/g)].map((m) => m[1]!)),
  )
  const define = new RegExp(`customElements\\.define\\(\\s*["'\`]${tag}["'\`]`)
  return [...reachable].filter((name) =>
    define.test(readFileSync(path.join(DIST, '_astro', name), 'utf8')),
  )
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

describe('the playground on playground/', () => {
  const html = page('playground')
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

  // Item 721's app#docs made the page run `build test docs`, so the page and
  // its one command named different runs. The page runs what the command
  // says; app#docs stays declared, for a reader who types it.
  it('names the run it plays as one command with documented flags, app#docs left out', () => {
    const [command, ...rest] = codeBlocks(html, 'sh')
    expect(rest).toEqual([])
    expect(command).toBe('vx run build test --all --dry')
    const specs = command!
      .split(' ')
      .slice(2)
      .filter((w) => !w.startsWith('--'))
    expect(specs).toEqual(TASKS)
    // At a workspace root a bare task name refuses ("not inside a project").
    const cli = readFileSync(path.join(SITE, 'src/content/docs/cli.md'), 'utf8')
    expect(['--all', '--dry'].filter((f) => !cli.includes(`\`${f}`))).toEqual([])
    expect(CONFIG_TEXTS['app']).toContain('    docs: {')
    expect(TASKS).not.toContain('docs')
  })
})
