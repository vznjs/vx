// The landing page is the whole story (owner, 2026-09-28; design/site-short-2026-09.md
// § Laws; 2026-10-02: vx is its own tool, Turbo and Nx only via migration):
// the hero, the benchmark chart and why, how to start, the one picture with its six
// callouts, and the four pillars. These rows read the page as it shipped,
// `dist/index.html`, which the `build` task writes, and the picture as data
// (src/components/landing/one-run.ts). What the design says is written out
// here by hand, never read from the module it holds.
//
// The measurements are not checked here: `@vzn/vx-bench#check.site` holds
// the benchTable block and the graph's size to results.json.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { CALLOUTS, oneRun } from '../src/components/landing/one-run.js'
import { narrowOf, type Picture } from '../src/components/guide/diagram/diagram.js'

const DIST = path.resolve(import.meta.dir, '../dist')
const BASE = (process.env['BASE_PATH'] ?? '/vx').replace(/\/?$/, '/')

// Every section below the hero, top to bottom.
const SECTIONS = ['bench', 'edge', 'try', 'one-run', 'pillars']

// The six lines under the picture, as the design writes them, each at the
// anchor the old chapters redirect to.
const LINES = [
  ['tasks', '1 Tasks. app builds after what it uses.'],
  ['parallel', '2 Parallel. ui and api build at once.'],
  ['cache', '3 Cache. Unchanged work comes back from the cache.'],
  ['changed', '4 Only what changed. You edited app; only app runs.'],
  ['sandbox', '5 Sandbox. A workspace file you did not declare is out of reach.'],
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

  it('says what vx is in one line, then the sections in order', () => {
    const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)]
    expect(h1).toHaveLength(1)
    expect(text(h1[0]![1]!)).toBe('The fastest task runner for JS monorepos.')
    expect(text(/<p class="lede">([\s\S]*?)<\/p>/.exec(hero)![1]!)).toBe(
      'Measured against Turborepo, Nx and Vite Task, each in its own native config.',
    )
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

  // The demo is a real run (scripts/terminal-demo.ts); core's
  // examples.unsafe.test.ts re-runs it against the committed file.
  it('shows the recorded run under the buttons', () => {
    const imgs = [...hero.matchAll(/<img\b[^>]*class="demo"[^>]*src="([^"]+)"/g)].map((m) => m[1])
    expect(imgs).toEqual([`${BASE}demo.svg`])
    expect(readFileSync(path.join(DIST, 'demo.svg'), 'utf8')).toContain('$ </tspan>')
  })

  // It prints line by line, but a line is hidden only during its own delay:
  // a renderer with no animation, or reduced motion, shows the whole run.
  it('animates the demo without ever depending on the animation', () => {
    const svg = readFileSync(path.join(DIST, 'demo.svg'), 'utf8')
    const style = /<style>([\s\S]*?)<\/style>/.exec(svg)![1]!
    const textRule = /(?:^|\n)\s*text \{([^}]*)\}/.exec(style)![1]!
    expect(textRule).toContain('animation: hide 0.01s backwards')
    expect(textRule).not.toContain('opacity')
    expect(style).toContain('@media (prefers-reduced-motion: reduce) { text { animation: none; } }')
    const delays = [...svg.matchAll(/<text [^>]*style="animation-delay:([\d.]+)s"/g)].map((m) =>
      Number(m[1]),
    )
    expect(delays.length).toBe([...svg.matchAll(/<text /g)].length)
    expect(delays).toEqual([...delays].sort((x, y) => x - y))
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

  // The numbers are check.site's; the shape is here: one chart per number,
  // vx's bar first, every other tool's bar saying how vx compares, each bar
  // as long as its time against the slowest, the formula under the chart,
  // and three reasons under it.
  it('draws one benchmark chart, vx, Turborepo and Nx, and why it is faster', () => {
    const bench = section(html, 'bench')
    expect(text(bench)).toContain('Least time added, cold and cached.')
    expect([...html.matchAll(/class="bench-panel"/g)]).toHaveLength(1)
    expect(bench).not.toContain('<table')
    const figures = [...bench.matchAll(/<figure class="vx-bars">([\s\S]*?)<\/figure>/g)].map(
      (m) => m[1]!,
    )
    expect(figures.map((f) => text(/<figcaption>([\s\S]*?)<\/figcaption>/.exec(f)![1]!))).toEqual([
      'Cold build: time the runner adds',
      'Cold build: CPU burned',
      'Fully cached run (restored)',
      'Fully cached run (up-to-date)',
    ])
    for (const f of figures) {
      const bars = [
        ...f.matchAll(/<div class="vx-bar([^"]*)" style="--w:([\d.]+)%">([\s\S]*?)<\/div>/g),
      ]
      expect(
        bars.map((m) => text(/<span class="vx-bar-name">([\s\S]*?)<\/span>/.exec(m[3]!)![1]!)),
      ).toEqual(['vx', 'Turborepo', 'Nx', 'Vite Task'])
      expect(bars.map((m) => m[1])).toEqual([' vx-bar-lead', '', '', ''])
      expect(Math.max(...bars.map((m) => Number(m[2])))).toBe(100)
      const notes = bars.map((m) => /<span class="vx-bar-note">([\s\S]*?)<\/span>/.exec(m[3]!)?.[1])
      expect(notes[0]).toBeUndefined()
      expect(notes.slice(1).filter((n) => !/^vx [\d.]+× (?:faster|slower)$/.test(n ?? ''))).toEqual(
        [],
      )
    }
    expect(text(/<p class="bench-formula">([\s\S]*?)<\/p>/.exec(bench)![1]!)).toBe(
      'vx N× faster: that tool takes N times as long as vx (theirs ÷ vx); N× slower: vx takes N times as long (vx ÷ theirs).',
    )
    const notes = [...bench.matchAll(/<p class="bench-formula">([\s\S]*?)<\/p>/g)].map((m) =>
      text(m[1]!),
    )
    expect(notes).toHaveLength(1)
    const reasons = [...bench.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]!))
    expect(reasons).toHaveLength(3)
  })

  // The hero's three numbers are the chart's own multiples (owner,
  // 2026-10-04: "show off best traits of vx vs competitors").
  it('leads with three multiples the chart states', () => {
    const wins = [
      ...hero.matchAll(/<li>\s*<strong>([\s\S]*?)<\/strong>\s*<span>([\s\S]*?)<\/span>/g),
    ]
    expect(wins.map((m) => text(m[2]!))).toEqual([
      'less time added to a cold build than Turborepo',
      'less CPU burned on a cold build than Turborepo',
      'faster fully cached run than Nx',
    ])
    const bench = section(html, 'bench')
    const notes = [...bench.matchAll(/<span class="vx-bar-note">vx ([\d.]+)× faster<\/span>/g)].map(
      (m) => `${m[1]}×`,
    )
    // The "faster" notes in chart order: Vite Task's cold-CPU note reads "slower".
    expect(wins.map((m) => text(m[1]!))).toEqual([notes[0]!, notes[3]!, notes[9]!])
  })

  // Where vx differs from both, as the choosing page's model says it.
  it('compares vx, Turborepo and Nx trait by trait', () => {
    const edge = section(html, 'edge')
    const cols = [...edge.matchAll(/<th scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
      text(m[1]!),
    )
    expect(cols).toEqual(['', 'vx', 'Turborepo', 'Nx'])
    const rows = [...edge.matchAll(/<tr>\s*<th scope="row">([\s\S]*?)<\/th>([\s\S]*?)<\/tr>/g)]
    expect(rows.map((m) => text(m[1]!))).toEqual([
      'A file sandbox for every task',
      'Remote execution you host',
      'A remote cache on any backend',
      'Config is code',
      'No background daemon',
    ])
    const kinds = rows.map((m) =>
      [...m[2]!.matchAll(/<td class="(yes|no|paid)" data-tool="([^"]+)"/g)].map(
        (c) => `${c[2]} ${c[1]}`,
      ),
    )
    expect(kinds).toEqual([
      ['vx yes', 'Turborepo no', 'Nx paid'],
      ['vx yes', 'Turborepo no', 'Nx paid'],
      ['vx yes', 'Turborepo no', 'Nx no'],
      ['vx yes', 'Turborepo no', 'Nx no'],
      ['vx yes', 'Turborepo yes', 'Nx no'],
    ])
    expect(hrefs(edge)).toEqual([`${BASE}compare/`])
  })

  // Four commands on native config, and Turbo or Nx only as a temporary
  // start through migration, with no speed claim for it.
  it('shows how to start, and Turbo or Nx only through migration', () => {
    const start = section(html, 'try')
    const lines = /<pre class="code"><code>([\s\S]*?)<\/code>/
      .exec(start)![1]!
      .split('\n')
      .map((l) => l.replace(/\s+#.*$/, '').trim())
    expect(lines).toEqual([
      'npm install -D @vzn/vx',
      'npx vx init',
      'npx vx run build --all',
      'npx vx run build --all',
    ])
    // `vx init` writes no cache block (its report says so), so the block
    // that promises a hit on the second build names the step between.
    expect(/npx vx init +# ([^\n]*)/.exec(start)![1]).toContain('add the cache block')
    const subs = [...start.matchAll(/<p class="sub">([\s\S]*?)<\/p>/g)].map((m) => text(m[1]!))
    expect(subs).toEqual([
      // `vx init` is the temporary start; the migrator writes the native
      // config, and npm has no copy of it yet (J2-28).
      'Coming from Turbo or Nx: vx init gives a temporary start, and bunx @vzn/vx-migrate writes the native vx config.',
    ])
    expect(text(start)).not.toMatch(/turbo\.json|nx\.json|unchanged|faster/i)
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

// A link pasted into X, Slack or Discord shows a card only when the page
// names an image by absolute URL, and a large one only with
// `summary_large_image`. Starlight writes neither the image nor, on the
// standalone landing, anything at all.
describe('a shared link shows the card', () => {
  const SITE = process.env['SITE_URL'] ?? 'https://vznjs.github.io'
  const meta = (html: string, key: string): string[] =>
    [...html.matchAll(new RegExp(`<meta\\b[^>]*(?:property|name)="${key}"[^>]*>`, 'g'))].map(
      (m) => /content="([^"]*)"/.exec(m[0])![1]!,
    )

  it('the landing and a docs page name the card by absolute URL', () => {
    const quickstart = readFileSync(path.join(DIST, 'quickstart', 'index.html'), 'utf8')
    for (const html of [page(), quickstart]) {
      expect(meta(html, 'og:image')).toEqual([`${SITE}${BASE}og.png`])
      expect(meta(html, 'twitter:card')).toEqual(['summary_large_image'])
    }
    expect(meta(page(), 'og:title')).toEqual(['vx — the fastest task runner for JS monorepos'])
    // The search result's and the card's headline says what vx is: the
    // cinematic landing's slogan outlived the page it headed.
    expect(/<title>([^<]*)<\/title>/.exec(page())?.[1]).toBe(
      'vx — the fastest task runner for JS monorepos',
    )
  })

  // The PNG is rendered from public/og.svg; the card said "a faster runner
  // for your Turborepo or Nx repo" after the page stopped (2026-10-02).
  it('the card says what the page says', () => {
    const svg = readFileSync(path.resolve(import.meta.dir, '../public/og.svg'), 'utf8')
    const lines = [
      ...svg.matchAll(/<tspan x="96"[^>]*>([\s\S]*?)<\/tspan>\s*(?=<tspan x=|<\/text>)/g),
    ]
      .map((m) => text(m[1]!))
      .join(' ')
    const h1 = text(/<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(page())![1]!)
    expect(lines).toBe(h1)
  })

  it('the card is a 1200×630 PNG', () => {
    const png = readFileSync(path.join(DIST, 'og.png'))
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630])
  })
})

// Search engines index what the sitemap lists; each such page names its own
// URL as canonical (a trailing-slash twin splits its rank), carries a
// description (the snippet under the link) and points at the sitemap. The
// docs pages get all three from Starlight; the standalone landing had none
// of the first and last until K-9.
describe('every page the sitemap lists', () => {
  const SITE = process.env['SITE_URL'] ?? 'https://vznjs.github.io'
  const urls = [
    ...readFileSync(path.join(DIST, 'sitemap-0.xml'), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g),
  ].map((m) => m[1]!)

  it('includes the landing, and every docs page Starlight built', () => {
    expect(urls).toContain(`${SITE}${BASE}`)
    expect(urls.length).toBeGreaterThan(50)
  })

  it('names itself canonical, describes itself and links the sitemap', () => {
    const bad: string[] = []
    for (const url of urls) {
      const rel = url.slice(`${SITE}${BASE}`.length)
      const html = readFileSync(path.join(DIST, rel, 'index.html'), 'utf8')
      const canonical = /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1]
      if (canonical !== url) bad.push(`${url}: canonical ${canonical}`)
      if (!/<meta name="description" content="[^"]+"/.test(html)) bad.push(`${url}: no description`)
      if (!html.includes(`<link rel="sitemap" href="${BASE}sitemap-index.xml"`))
        bad.push(`${url}: no sitemap link`)
    }
    expect(bad).toEqual([])
  })
})
