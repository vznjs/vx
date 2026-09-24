// The landing page is the whole story (design/site-short-2026-09.md § The
// shape, § Laws): the hero, the one picture with its six callouts, the one
// benchmark, and the four pillars. These rows read the page as it shipped,
// `dist/index.html`, which the `build` task writes, and the picture as data
// (src/components/landing/one-run.ts). What the design says is written out
// here by hand, never read from the module it holds.
//
// The measurements are not checked here: `@vzn/vx-bench#check.site` holds
// the benchRows block and the graph's size to results.json.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { CALLOUTS, oneRun } from '../src/components/landing/one-run.js'
import { narrowOf, type Picture } from '../src/components/guide/diagram/diagram.js'

const DIST = path.resolve(import.meta.dir, '../dist')
const BASE = (process.env['BASE_PATH'] ?? '/vx').replace(/\/?$/, '/')

// Every section below the hero, top to bottom.
const SECTIONS = ['one-run', 'bench', 'pillars']

// The six lines under the picture, as the design writes them, each at the
// anchor the old chapters redirect to.
const LINES = [
  ['tasks', '1 Tasks. app builds after what it uses.'],
  ['parallel', '2 Parallel. ui and api build at once.'],
  ['cache', '3 Cache. Unchanged work comes back from the cache.'],
  ['changed', '4 Only what changed. You edited app; only app runs.'],
  ['sandbox', '5 Sandbox. A read you did not declare fails the task.'],
  ['plugins', '6 Plugins. Swap the cache, runner or telemetry. No fork.'],
]

// The picture, as the design draws it: box → tone and label (and sub line),
// arrows, frames, and the words of its notes by tone.
const BOXES = [
  'api ok: api#build / from cache',
  'app accent: app#build / you edited app',
  'cache default: cache',
  'graph default: graph',
  'key default: key',
  'otel default: OpenTelemetry',
  'remote default: remote cache',
  'run default: run',
  'schedule default: schedule',
  'secrets muted: ../secrets.env',
  'telemetry default: telemetry',
  'ui ok: ui#build / from cache',
  'utils ok: utils#build / from cache',
]
const ARROWS = [
  'api → app default',
  'app → secrets danger: ✕ denied',
  'otel → telemetry default dashed',
  'remote → cache default dashed',
  'ui → app default',
  'utils → api default',
  'utils → ui default',
]
const FRAMES = ['default: a run’s stages', 'default: at once', 'link: sandbox']
const STAGES = ['graph', 'key', 'schedule', 'run', 'cache', 'telemetry']

// The four pillars, in order: title, and the Docs page each links.
const PILLARS = [
  ['Correctness', 'caching/'],
  ['Sandbox', 'guides/sandboxing/'],
  ['Extensibility', 'guides/plugins/'],
  ['Freedom', 'guides/migrate/'],
]

// Every internal link the page carried before the short site (the built
// page at 094c80f3), without the base path, and the reason each one the
// page no longer carries went. A link to a page that exists is kept unless
// a reason is written here.
const OLD_LINKS = [
  '',
  'architecture/',
  'benchmarks/',
  'benchmarks/#five-real-turbo-repos-2026-09-11',
  'benchmarks/#how-the-overhead-scales-with-the-workspace-2026-09-10',
  'blog/',
  'cli/',
  'cli/#vx-init',
  'compare/',
  'comparison/',
  'guide/affected/',
  'guide/caching/',
  'guide/concurrency/',
  'guide/dependencies/',
  'guide/inside-vx/',
  'guide/many-machines/',
  'guide/tasks/',
  'guide/trust/',
  'guide/try-it/',
  'guide/why/',
  'guides/caching/',
  'guides/mcp/',
  'guides/plugins/',
  'guides/remote-caching/',
  'guides/remote-execution/',
  'guides/sandboxing/',
  'logo-mark.svg',
  'migrate/from-nx/',
  'migrate/from-turborepo/',
  'parity/',
  'quickstart/',
  'schema/',
]
const CHAPTER = 'the Guide collapsed into this page; the chapter redirects to its line'
const REMOVED: Record<string, string> = {
  'architecture/': 'internals, reached from the Reference; the footer lists what a user reads',
  'benchmarks/#five-real-turbo-repos-2026-09-11': 'the #real panel went; one benchmark stays',
  'benchmarks/#how-the-overhead-scales-with-the-workspace-2026-09-10':
    'the #scale panel went; one benchmark stays',
  'cli/#vx-init': 'the migrate section went; the quickstart runs vx init',
  'comparison/': 'the footer links compare/, the page that says when to pick another tool',
  'guide/affected/': CHAPTER,
  'guide/caching/': CHAPTER,
  'guide/concurrency/': CHAPTER,
  'guide/dependencies/': CHAPTER,
  'guide/inside-vx/': CHAPTER,
  'guide/many-machines/': CHAPTER,
  'guide/tasks/': CHAPTER,
  'guide/trust/': CHAPTER,
  'guide/try-it/': 'the playground moved to playground/, which the footer links',
  'guide/why/': CHAPTER,
  'guides/caching/': 'the Docs became six pages; the footer links them',
  'guides/mcp/': 'the Docs became six pages; the footer links them',
  'guides/remote-caching/': 'the Docs became six pages; the footer links them',
  'guides/remote-execution/': 'the Docs became six pages; the footer links them',
  'migrate/from-nx/': 'the freedom card links the one migration page',
  'migrate/from-turborepo/': 'the freedom card links the one migration page',
}

function page(): string {
  const file = path.join(DIST, 'index.html')
  if (!existsSync(file)) throw new Error(`${file} is missing: run the site's build task first`)
  return readFileSync(file, 'utf8')
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

function section(html: string, id: string): string {
  const found = [
    ...html.matchAll(new RegExp(`<section\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</section>`, 'g')),
  ]
  expect(found).toHaveLength(1)
  return found[0]![1]!
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)].map((m) => m[1]!)
}

/** Every `href` on the page, `<link>` included, but astro's hashed assets. */
function allHrefs(html: string): string[] {
  return [...html.matchAll(/\shref="([^"]*)"/g)]
    .map((m) => m[1]!)
    .filter((h) => !h.startsWith(`${BASE}_astro/`))
}

/** The built file an internal link lands on, and whether its anchor is there. */
function resolves(link: string): string | undefined {
  const [slug, anchor] = link.split('#') as [string, string | undefined]
  const file =
    slug === '' || slug.endsWith('/') ? path.join(DIST, slug, 'index.html') : path.join(DIST, slug)
  if (!existsSync(file)) return `no file for ${link}`
  if (anchor !== undefined && !readFileSync(file, 'utf8').includes(`id="${anchor}"`)) {
    return `no anchor for ${link}`
  }
  return undefined
}

/** What a picture says, apart from where: boxes, arrows and frames as sorted
 *  lines, and its notes' words per tone, in order. */
function says(p: Picture): {
  boxes: string[]
  arrows: string[]
  frames: string[]
  notes: string[]
} {
  const words = new Map<string, string[]>()
  for (const n of p.notes ?? []) {
    const tone = n.tone ?? 'muted'
    words.set(tone, [...(words.get(tone) ?? []), ...n.text.split(/\s+/)])
  }
  return {
    boxes: p.boxes
      .map((b) => `${b.id} ${b.tone ?? 'default'}: ${b.label}${b.sub ? ` / ${b.sub}` : ''}`)
      .sort(),
    arrows: (p.arrows ?? [])
      .map(
        (a) =>
          `${a.from} → ${a.to} ${a.tone ?? 'default'}${a.dashed ? ' dashed' : ''}${a.label ? `: ${a.label}` : ''}`,
      )
      .sort(),
    frames: (p.frames ?? []).map((f) => `${f.tone ?? 'default'}: ${f.label}`).sort(),
    notes: [...words].map(([tone, w]) => `${tone}: ${w.join(' ')}`).sort(),
  }
}

describe('the landing page', () => {
  const html = page()
  const h1At = html.indexOf('<h1')
  const hero = html.slice(h1At, html.indexOf('<section', h1At))

  it('says what vx is in one line, then the picture, the benchmark and the pillars', () => {
    const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)]
    expect(h1).toHaveLength(1)
    expect(text(h1[0]![1]!)).toBe('A fast, correct task runner for JavaScript monorepos.')
    const ids = [...html.matchAll(/<section\b[^>]*\bid="([\w-]+)"/g)]
    expect(ids.map((m) => m[1])).toEqual(SECTIONS)
    expect(h1[0]!.index!).toBeLessThan(ids[0]!.index!)
  })

  it('offers the install command, the quickstart and GitHub, nothing else', () => {
    expect(hero).toContain('data-copy="npm install -g @vzn/vx"')
    expect(hrefs(hero)).toEqual([`${BASE}quickstart/`, 'https://github.com/vznjs/vx'])
    const buttons = [...hero.matchAll(/<a\b[^>]*class="btn [^"]*"[^>]*>([\s\S]*?)<\/a>/g)]
    expect(buttons.map((m) => text(m[1]!))).toEqual(['Quickstart →', 'GitHub'])
  })

  it('draws the one picture, both layouts, and lists its six lines at their anchors', () => {
    const run = section(html, 'one-run')
    const figures = [...run.matchAll(/<figure\b[^>]*data-picture="([^"]+)"/g)].map((m) => m[1])
    expect(figures).toEqual(['one-run'])
    const svgs = [...run.matchAll(/<svg\b[^>]*data-layout="(\w+)"[^>]*>/g)].map((m) => m[1])
    expect(svgs).toEqual(['wide', 'narrow'])
    const items = [...run.matchAll(/<li\b[^>]*\bid="([\w-]+)"[^>]*>([\s\S]*?)<\/li>/g)]
    const line = (li: string): string => {
      const [, n, rest] = /<span class="n">(\d)<\/span>\s*<span>([\s\S]*)<\/span>/.exec(li)!
      return `${n} ${text(rest!)}`
    }
    expect(items.map((m) => [m[1], line(m[2]!)])).toEqual(LINES)
    expect(run).not.toMatch(/<script\b|\son[a-z]+=/)
  })

  it('holds exactly one benchmark section, the first one', () => {
    const bench = section(html, 'bench')
    expect(text(bench)).toContain('First in every row.')
    expect([...html.matchAll(/class="bench-panel"/g)]).toHaveLength(1)
  })

  it('carries the four pillars in order, each an icon, a title, one short sentence and its page', () => {
    const cards = [
      ...section(html, 'pillars').matchAll(
        /<a\b[^>]*class="card"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
      ),
    ]
    expect(
      cards.map((m) => [
        text(/<h3\b[^>]*>([\s\S]*?)<\/h3>/.exec(m[2]!)![1]!),
        m[1]!.slice(BASE.length),
      ]),
    ).toEqual(PILLARS)
    for (const [, , body] of cards) {
      expect(body).toMatch(/<svg\b/)
      const sentence = text(/<p\b[^>]*>([\s\S]*?)<\/p>/.exec(body!)![1]!)
      expect({ sentence, one: sentence.split(/[.!?]\s/).length }).toEqual({ sentence, one: 1 })
      expect(sentence.split(' ').length).toBeLessThanOrEqual(15)
    }
  })

  it('writes no paragraph longer than one sentence', () => {
    const long = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)]
      .map((m) => text(m[1]!))
      .filter((p) => (p.match(/[.!?](?:\s|$)/g) ?? []).length > 1)
    expect(long).toEqual([])
  })

  it('keeps every internal link the page had, unless it went on purpose, and each lands', () => {
    const now = new Set(
      allHrefs(html)
        .filter((h) => h.startsWith(BASE))
        .map((h) => h.slice(BASE.length)),
    )
    expect(OLD_LINKS.filter((l) => !now.has(l) && !(l in REMOVED))).toEqual([])
    // Removed means removed: a link on the list that is still on the page is
    // a stale entry.
    expect(Object.keys(REMOVED).filter((l) => now.has(l))).toEqual([])
    expect([...now].map(resolves).filter((m) => m !== undefined)).toEqual([])
    expect(allHrefs(html).filter((h) => h.includes('{'))).toEqual([])
  })
})

describe('the one picture, as data', () => {
  it('says what the design draws, wide and on a phone', () => {
    const want = { boxes: BOXES, arrows: ARROWS, frames: FRAMES }
    const wide = says(oneRun)
    const phone = says(narrowOf(oneRun)!)
    expect({ boxes: wide.boxes, arrows: wide.arrows, frames: wide.frames }).toEqual(want)
    expect({ boxes: phone.boxes, arrows: phone.arrows, frames: phone.frames }).toEqual(want)
  })

  it('numbers the six callouts on the drawing, in order, beside the note that app runs', () => {
    const marks = CALLOUTS.map((c) => c.mark)
    expect(marks).toEqual(['①', '②', '③', '④', '⑤', '⑥'])
    for (const p of [oneRun, narrowOf(oneRun)!]) {
      expect(says(p).notes).toEqual([
        `accent: ${marks.slice(0, 4).join(' ')} ✎ runs ${marks.slice(4).join(' ')}`,
        'muted: yours plugs in the same way',
      ])
    }
  })

  it('runs the stages below the run, in the pipeline’s order, the plugins hanging under them', () => {
    const RUN = ['utils', 'ui', 'api', 'app', 'secrets']
    const PLUGINS = ['remote', 'otel']
    for (const p of [oneRun, narrowOf(oneRun)!]) {
      const ys = (ids: string[]): number[] =>
        p.boxes.filter((b) => ids.includes(b.id)).map((b) => b.y)
      const stages = p.boxes.filter((b) => STAGES.includes(b.id))
      const order = [...stages].sort((a, b) => a.y - b.y || a.x - b.x).map((b) => b.id)
      expect(order).toEqual(STAGES)
      expect(Math.min(...ys(STAGES))).toBeGreaterThan(Math.max(...ys(RUN)))
      expect(Math.min(...ys(PLUGINS))).toBeGreaterThan(Math.max(...ys(STAGES)))
    }
  })

  it('keeps utils, ui and api inside neither frame but their own, and app inside the sandbox', () => {
    for (const p of [oneRun, narrowOf(oneRun)!]) {
      const inside = (id: string, label: string): boolean => {
        const b = p.boxes.find((x) => x.id === id)!
        const f = p.frames!.find((x) => x.label === label)!
        const w = b.w ?? 130
        const h = b.h ?? (b.sub === undefined ? 52 : 60)
        return b.x >= f.x && b.y >= f.y && b.x + w <= f.x + f.w && b.y + h <= f.y + f.h
      }
      expect(['utils', 'ui', 'api', 'app', 'secrets'].map((id) => inside(id, 'at once'))).toEqual([
        false,
        true,
        true,
        false,
        false,
      ])
      expect(['utils', 'ui', 'api', 'app', 'secrets'].map((id) => inside(id, 'sandbox'))).toEqual([
        false,
        false,
        false,
        true,
        false,
      ])
    }
  })
})
