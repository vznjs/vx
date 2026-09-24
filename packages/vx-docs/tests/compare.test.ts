// "vx, Turborepo, Nx, Bazel" (compare/, the Reference's choosing page; Learn
// W7, item 689): the model's data, the filter against hand-written truth,
// and the built page against both. The page's promise is that every claim is
// sourced, so the data rows hold the sources too: a cell per tool, a link per
// cell, other tools' links to their own docs, vx's links to a built page or
// to the test row that holds the claim, and every performance figure to
// benchmarks.md.
//
// It reads `dist/`, which the `build` task writes, and the imported
// benchmarks page, which the `import` task writes; the `test` task depends
// on both.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  CHECKPOINT,
  CHOICES,
  MAP_X,
  MAP_Y,
  NEEDS,
  TOOLS,
  TOOL_NAME,
  evaluate,
  mapSentence,
  verdictSentences,
  type Tool,
} from '../src/components/demos/model/choosing.js'

const DIST = path.resolve(import.meta.dir, '../dist')
const REPO = path.resolve(import.meta.dir, '../../..')
const BASE = (process.env['BASE_PATH'] ?? '/vx').replace(/\/?$/, '/')
const GH = 'https://github.com/vznjs/vx/blob/main/'
const OTHER_HOSTS: Record<Exclude<Tool, 'vx'>, string> = {
  turbo: 'turborepo.com',
  nx: 'nx.dev',
  bazel: 'bazel.build',
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

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every `_astro/*.js` the page loads, followed through the chunks' own
 *  static and dynamic imports. */
function reachableScripts(html: string): Set<string> {
  const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0])
  const seen = new Set<string>()
  const queue = scripts.flatMap((s) =>
    [...s.matchAll(/\/_astro\/([\w.-]+\.js)/g)].map((m) => m[1]!),
  )
  while (queue.length > 0) {
    const name = queue.pop()!
    const file = path.join(DIST, '_astro', name)
    if (seen.has(name) || !existsSync(file)) continue
    seen.add(name)
    const body = readFileSync(file, 'utf8')
    for (const m of body.matchAll(/["'`]\.\/([\w.-]+\.js)["'`]/g)) queue.push(m[1]!)
  }
  return seen
}

// The truth the matrix teaches, written out by hand: which tools meet each
// need, and the choices in page order. The filter rows below are held to it,
// so a wrong entry in the model cannot pass by agreeing with its own render.
const FITS: Record<string, Tool[]> = {
  'no-bun': ['turbo', 'nx', 'bazel'],
  windows: ['turbo', 'nx', 'bazel'],
  caught: ['vx', 'bazel'],
  'no-input-lists': ['turbo', 'nx'],
  'remote-exec': ['vx', 'bazel'],
  'keep-config': ['vx'],
  polyglot: ['nx', 'bazel'],
  mature: ['turbo', 'nx', 'bazel'],
  'ts-plugins': ['vx', 'nx'],
}
const CHOICE_IDS = [
  'inputs',
  'proof',
  'config',
  'extension',
  'runtime',
  'languages',
  'remote-cache',
  'remote-exec',
  'scheduling',
  'process',
  'adoption',
  'maturity',
]

const sources = CHOICES.flatMap((c) =>
  TOOLS.flatMap((t) => c.cells[t].sources.map((s) => ({ choice: c.id, tool: t, ...s }))),
)

describe('the choosing model', () => {
  it('has a cell per tool for every choice, each with what it chose, buys, costs and a source', () => {
    expect(CHOICES.map((c) => c.id)).toEqual(CHOICE_IDS)
    const gaps: string[] = []
    for (const c of CHOICES) {
      if (c.title === '' || c.question === '') gaps.push(`${c.id}: title or question`)
      expect(Object.keys(c.cells).sort()).toEqual([...TOOLS].sort())
      for (const t of TOOLS) {
        const cell = c.cells[t]
        for (const field of ['chose', 'buys', 'costs'] as const) {
          if (cell[field].trim() === '') gaps.push(`${c.id}/${t}: ${field}`)
        }
        if (cell.sources.length === 0) gaps.push(`${c.id}/${t}: no source`)
      }
      // "Choose another tool if…" names another tool, at least once.
      if (c.otherIf.length === 0) gaps.push(`${c.id}: no other-tool row`)
      for (const o of c.otherIf)
        if ((o.tool as Tool) === 'vx') gaps.push(`${c.id}: otherIf names vx`)
    }
    expect(gaps).toEqual([])
  })

  it("links every other tool's cell to that tool's own docs, and nothing else", () => {
    const wrong = sources
      .filter((s) => s.tool !== 'vx')
      .filter((s) => {
        const url = new URL(s.href)
        return url.protocol !== 'https:' || url.host !== OTHER_HOSTS[s.tool as Exclude<Tool, 'vx'>]
      })
      .map((s) => `${s.choice}/${s.tool}: ${s.href}`)
    expect(wrong).toEqual([])
  })

  it("links vx's cells to a site page, or to a test row that exists", () => {
    const wrong: string[] = []
    for (const s of sources.filter((x) => x.tool === 'vx')) {
      if (s.href.startsWith(GH)) {
        const file = path.join(REPO, s.href.slice(GH.length))
        if (!existsSync(file)) wrong.push(`${s.choice}: ${s.href} does not exist`)
        else if (s.row === undefined || !readFileSync(file, 'utf8').includes(`'${s.row}'`)) {
          wrong.push(`${s.choice}: ${s.href} has no row "${s.row}"`)
        }
      } else if (/^[a-z]+:/.test(s.href) || s.href.startsWith('/') || !s.href.includes('/')) {
        wrong.push(`${s.choice}: ${s.href} is neither a site path nor a vx test`)
      }
    }
    expect(wrong).toEqual([])
    // Both kinds are in use, so neither branch above is vacuous.
    expect(sources.filter((s) => s.tool === 'vx' && s.href.startsWith(GH)).length).toBe(7)
    expect(sources.filter((s) => s.tool === 'vx' && !s.href.startsWith(GH)).length).toBeGreaterThan(
      10,
    )
  })

  it('rules each need in for the tools written out by hand', () => {
    expect(Object.fromEntries(NEEDS.map((n) => [n.id, [...n.fits]]))).toEqual(FITS)
    for (const n of NEEDS) for (const id of n.decidedBy) expect(CHOICE_IDS).toContain(id)
  })

  it('filters to the choices that decide the ticked needs, and names what rules each tool out', () => {
    const none = evaluate([])
    expect(none.choices).toEqual(CHOICE_IDS)
    expect(none.fits).toEqual(['vx', 'turbo', 'nx', 'bazel'])

    const caught = evaluate(['caught'])
    expect(caught.choices).toEqual(['inputs', 'proof'])
    expect(caught.fits).toEqual(['vx', 'bazel'])
    expect(caught.ruledOutBy).toEqual({ vx: [], turbo: ['caught'], nx: ['caught'], bazel: [] })

    const nobody = evaluate(['keep-config', 'no-bun'])
    expect(nobody.choices).toEqual(['runtime', 'adoption'])
    expect(nobody.fits).toEqual([])
    expect(nobody.ruledOutBy).toEqual({
      vx: ['no-bun'],
      turbo: ['keep-config'],
      nx: ['keep-config'],
      bazel: ['keep-config'],
    })
    expect(verdictSentences(nobody)[0]).toBe('No tool meets every need you ticked.')

    // Two needs decide one choice: it favours only the tools that meet both.
    const both = evaluate(['caught', 'no-input-lists'])
    expect(both.choices).toEqual(['inputs', 'proof'])
    expect(both.favours).toEqual({ inputs: [], proof: ['vx', 'bazel'] })
    expect(both.fits).toEqual([])

    const three = evaluate(['windows', 'no-input-lists', 'ts-plugins'])
    expect(three.choices).toEqual(['inputs', 'extension', 'runtime'])
    expect(three.fits).toEqual(['nx'])
    expect(three.favours).toEqual({
      inputs: ['turbo', 'nx'],
      extension: ['vx', 'nx'],
      runtime: ['turbo', 'nx', 'bazel'],
    })
  })
})

describe('the choosing page', () => {
  const html = page('compare')
  const main = only(html, /<main\b[^>]*>([\s\S]*?)<\/main>/g)
  const element = only(html, /<vx-choosing-matrix\b[^>]*>([\s\S]*?)<\/vx-choosing-matrix>/g)

  it('shows every choice, every cell and every other-tool row without JavaScript', () => {
    const missing: string[] = []
    for (const c of CHOICES) {
      const group = only(
        element,
        new RegExp(`<tbody id="choice-${c.id}"[^>]*>([\\s\\S]*?)</tbody>`, 'g'),
      )
      const said = text(group)
      const expected = [
        c.title,
        c.question,
        ...TOOLS.flatMap((t) => [c.cells[t].chose, c.cells[t].buys, c.cells[t].costs]),
        ...c.otherIf.map((o) => `${TOOL_NAME[o.tool]}: ${o.when}`),
      ]
      for (const e of expected) if (!said.includes(e)) missing.push(`${c.id}: ${e}`)
      expect([...group.matchAll(/<tr data-tool="(\w+)"/g)].map((m) => m[1])).toEqual([...TOOLS])
    }
    expect(missing).toEqual([])
  })

  it('carries every source link, and every site link lands on a built page and anchor', () => {
    const hrefs = new Set([...element.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]!))
    const wrong: string[] = []
    for (const s of sources) {
      const site = !s.href.startsWith('https://')
      const href = site ? `${BASE}${s.href}` : s.href
      if (!hrefs.has(href)) wrong.push(`not on the page: ${href}`)
      if (!site) continue
      const [slug, anchor] = s.href.split('#') as [string, string | undefined]
      const file = path.join(DIST, slug, 'index.html')
      if (!existsSync(file)) wrong.push(`no page: ${s.href}`)
      else if (anchor !== undefined && !readFileSync(file, 'utf8').includes(`id="${anchor}"`)) {
        wrong.push(`no anchor: ${s.href}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it("sends every outside link on the page to a tool's own docs or to vx's repository", () => {
    const outside = [...main.matchAll(/<a\b[^>]*href="(https?:[^"]+)"/g)].map((m) => new URL(m[1]!))
    expect(outside.length).toBeGreaterThan(60)
    const hosts = new Set(
      outside.map((u) =>
        u.host === 'github.com' ? u.pathname.split('/').slice(0, 3).join('/') : u.host,
      ),
    )
    expect([...hosts].sort()).toEqual(['/vznjs/vx', 'bazel.build', 'nx.dev', 'turborepo.com'])
    expect(outside.every((u) => u.protocol === 'https:')).toBe(true)
  })

  it('shows each need with the tools it rules in, as the hand-written truth says', () => {
    const table = only(element, /<table class="needs\b[^"]*">([\s\S]*?)<\/table>/g)
    const rows = [...table.matchAll(/<tr data-need="([\w-]+)"[^>]*>([\s\S]*?)<\/tr>/g)]
    expect(rows.map((r) => r[1])).toEqual(Object.keys(FITS))
    for (const [, id, row] of rows) {
      const cells = [
        ...row!.matchAll(/<td data-tool="(\w+)"[^>]*class="(fit|out)[^"]*"[^>]*>([^<]*)</g),
      ]
      expect(cells.map((c) => c[1])).toEqual([...TOOLS])
      expect(
        cells.filter((c) => c[2] === 'fit' && c[3]!.trim() === 'fits').map((c) => c[1]),
      ).toEqual(FITS[id!]!)
    }
  })

  it('keeps the controls that need JavaScript hidden in the static page', () => {
    expect(only(element, /<div class="controls\b[^"]*"([^>]*)>/g).trim()).toBe('hidden')
    expect(only(element, /<p class="status\b[^"]*"([^>]*)>/g).trim()).toBe(
      'aria-live="polite" hidden',
    )
    const jsOnly = [...element.matchAll(/<\w+\b[^>]*class="js-only\b[^"]*"[^>]*>/g)].map(
      (m) => m[0],
    )
    // The heading of the box column, and a box per need.
    expect(jsOnly).toHaveLength(1 + NEEDS.length)
    for (const tag of jsOnly) expect(tag).toMatch(/\shidden(?=[\s>=])/)
    const decides = [...element.matchAll(/<tr class="decides\b[^"]*"([^>]*)>/g)].map((m) => m[1]!)
    expect(decides).toHaveLength(CHOICES.length)
    for (const attrs of decides) expect(attrs).toMatch(/\shidden\b/)
    // Nothing a reader without JavaScript needs starts hidden.
    expect(element).not.toMatch(/<tbody\b[^>]*\shidden\b/)
  })

  it('places each tool on the diagram where the hand-written truth says', () => {
    const svg = only(main, /<div class="map\b[^"]*"[^>]*>([\s\S]*?)<\/div>/g)
    const at = Object.fromEntries(
      [...svg.matchAll(/<g class="tool" data-tool="(\w+)" data-x="(\d)" data-y="(\d)">/g)].map(
        (m) => [m[1], [Number(m[2]), Number(m[3])]],
      ),
    )
    expect(at).toEqual({ vx: [2, 2], turbo: [0, 0], nx: [1, 1], bazel: [2, 3] })
    expect(MAP_X.choice).toBe('inputs')
    expect(MAP_Y.choice).toBe('proof')
    expect(text(only(svg, /aria-label="([^"]+)"/g))).toBe(mapSentence())
    expect(mapSentence()).toContain(
      'Bazel: declared for every task; a local sandbox, on by default',
    )
    for (const label of [...MAP_X.levels, ...MAP_Y.levels]) {
      expect(text(svg)).toContain(label.split(' ')[0]!)
    }
  })

  it("states what vx's choices cost, and when each other tool is the better choice", () => {
    const section = (heading: string): string =>
      text(
        only(
          main,
          new RegExp(`<h2 id="[^"]+">${heading}</h2>[\\s\\S]*?(<ul>[\\s\\S]*?</ul>)`, 'g'),
        ),
      )
    const costs = section('What vx’s choices cost')
    for (const phrase of [
      'Bun only.',
      'Bun 1.4 or later',
      'Pre-alpha.',
      '0.1.0 is not cut',
      'Explicit inputs are work.',
      'A small ecosystem.',
      'Nothing distributed ships.',
      'No first-party cloud.',
    ]) {
      expect(costs).toContain(phrase)
    }
    const better = section('When another tool is the better choice')
    for (const tool of ['Turborepo,', 'Nx,', 'Bazel,']) expect(better).toContain(tool)
  })

  it('answers the checkpoint with what the matrix computes for its two needs', () => {
    expect(CHECKPOINT).toEqual(['mature', 'caught'])
    const v = evaluate(CHECKPOINT)
    expect(v.fits).toEqual(['bazel'])
    expect(v.ruledOutBy).toEqual({ vx: ['mature'], turbo: ['caught'], nx: ['caught'], bazel: [] })
    const question = text(only(main, /<p class="checkpoint-question\b[^"]*">([\s\S]*?)<\/p>/g))
    for (const id of CHECKPOINT) expect(question).toContain(NEEDS.find((n) => n.id === id)!.label)
    const answer = only(main, /<details>([\s\S]*?)<\/details>/g)
    const paragraphs = [...answer.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => text(m[1]!))
    expect(paragraphs).toEqual([
      'Bazel meets every need you ticked.',
      'vx is ruled out by “A stable release with a published support policy”.',
      'Turborepo is ruled out by “Undeclared inputs must be caught on our own machines”.',
      'Nx is ruled out by “Undeclared inputs must be caught on our own machines”.',
      "The choices that decide it: how a task's inputs are found, what checks the key and maturity and ecosystem.",
    ])
    expect(paragraphs.slice(0, 4)).toEqual(verdictSentences(v))
  })

  // A figure on this page is a claim about speed, and the site's rule is
  // that every one comes from benchmarks.md, as printed there.
  it('quotes only figures benchmarks.md measured', () => {
    const bench = path.join(import.meta.dir, '../src/content/docs/benchmarks.md')
    if (!existsSync(bench)) throw new Error(`${bench} is missing: run the site's import task first`)
    const measured = readFileSync(bench, 'utf8')
    const figures = [...text(main).matchAll(/\d[\d,.]*\s?(?:ms|s)\b|\d[\d.]*×/g)].map((m) => m[0])
    expect(figures.length).toBeGreaterThanOrEqual(4)
    expect(figures.filter((f) => !measured.includes(f))).toEqual([])
  })

  it("loads the element from the page's scripts, with no platform in its chunk", () => {
    const defining = [...reachableScripts(html)].filter((name) =>
      /customElements\.define\(\s*["'`]vx-choosing-matrix["'`]/.test(
        readFileSync(path.join(DIST, '_astro', name), 'utf8'),
      ),
    )
    expect(defining).toHaveLength(1)
    const chunk = readFileSync(path.join(DIST, '_astro', defining[0]!), 'utf8')
    expect(chunk).toContain('ruled out by')
    expect(chunk.match(/\bBun\.\w|\bprocess\.\w|["'`](?:node|bun):|import\.meta/g)).toBeNull()
  })
})
