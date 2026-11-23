// The landing page (2026-11-12, rebuilt: the system graph is the hero, in
// 3D over a grid, standing up as you scroll and playing one CI run). These
// rows read the page as it shipped, `dist/index.html`, which the `build`
// task writes, and the graph as data (src/components/landing/system-map.ts).
// What the design says is written out here by hand; every figure is held to
// the site's data: src/data/bench.json (bench.bun.data) and the conformance
// results.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { FIGURES } from '../src/bench/data.ts'
import { parseDuration } from '../src/plugins/data-charts.ts'
import { RESULTS, TOOLS, toolName } from '../src/conformance/data.ts'
import {
  BURN_HOLD_MS,
  BURN_MS,
  burnAt,
  burnClip,
  lapAt,
  lapsLabel,
  racing,
  step,
  ratioLabel,
  tailPct,
  TAIL_MAX,
  TAIL_MIN,
  TAIL_MS,
} from '../src/components/landing/race.ts'
import * as map from '../src/components/landing/system-map.ts'
import run from '../src/data/hero-run.json'
import { ALL_VOICES } from '../src/components/landing/voices.ts'
import { PLUGIN_HOOKS } from '@vzn/vx'

const DIST = path.resolve(import.meta.dir, '../dist')
const BASE = (process.env['BASE_PATH'] ?? '/vx').replace(/\/?$/, '/')

// Every band under the stage, top to bottom.
const SECTIONS = ['proof', 'speed', 'data', 'dte', 'flaky', 'plugins', 'agents', 'voices', 'start']

// The anchors the old chapters and landings redirect to (redirects.test.ts),
// each on the step, vow or card that now says it.
const ANCHORS = [
  'one-run',
  'tasks',
  'changed',
  'parallel',
  'cache',
  'sandbox',
  'extensible',
  'plugins',
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
  'docs/plugins/',
  'guides/remote-caching/',
  'guides/remote-execution/',
  'docs/sandboxing/',
  'logo-mark.svg',
  'migrate/from-nx/',
  'migrate/from-turborepo/',
  'parity/',
  'quickstart/',
  'schema/',
]
const CHAPTER = 'the Guide collapsed into this page; the chapter redirects to its line'
const REMOVED: Record<string, string> = {
  'logo-mark.svg': 'the favicon is the shared Starlight head’s, favicon.svg',
  'architecture/': 'internals, reached from the Reference; the footer lists what a user reads',
  'benchmarks/#five-real-turbo-repos-2026-09-11': 'the #real panel went; one benchmark stays',
  'benchmarks/#how-the-overhead-scales-with-the-workspace-2026-09-10':
    'the #scale panel went; one benchmark stays',
  'cli/#vx-init': 'the migrate section went; the quickstart runs vx init',
  'comparison/': 'the footer links conformance/, where every tool runs one suite',
  'compare/': 'the page went; conformance/ shows every tool on one suite',
  'guide/affected/': CHAPTER,
  'guide/caching/': CHAPTER,
  'guide/concurrency/': CHAPTER,
  'guide/dependencies/': CHAPTER,
  'guide/inside-vx/': CHAPTER,
  'guide/many-machines/': CHAPTER,
  'guide/tasks/': CHAPTER,
  'guide/trust/': CHAPTER,
  'guide/try-it/': 'the playground was removed; quickstart, which the footer links, took its place',
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

describe('the landing page', () => {
  const html = page()
  const stage = /<section class="stage"[\s\S]*?<\/section>/.exec(html)![0]

  it('says it in one line, then the bands in order', () => {
    const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)]
    expect(h1).toHaveLength(1)
    expect(text(h1[0]![1]!)).toBe('Run everything. Own everything.')
    expect(text(/<p class="lede">([\s\S]*?)<\/p>/.exec(stage)![1]!)).toBe(
      'One task graph from your laptop to every machine your CI can start, with the cache, the history, the workers and the telemetry all yours to host.',
    )
    const ids = [...html.matchAll(/<section\b[^>]*\bid="([\w-]+)"/g)]
    expect(ids.map((m) => m[1])).toEqual(SECTIONS)
    expect(html.indexOf('<section class="stage"')).toBeLessThan(ids[0]!.index!)
  })

  it('offers the install command, the quickstart and GitHub first', () => {
    const copy = /<div class="stage-copy">([\s\S]*?)<div class="stage-world"/.exec(stage)![1]!
    expect(copy).toContain('data-copy="bunx @vzn/vx init"')
    const buttons = [
      ...copy.matchAll(/<a\b[^>]*class="btn [^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g),
    ]
    expect(buttons.map((m) => [text(m[2]!), m[1]])).toEqual([
      ['Quickstart →', `${BASE}quickstart/`],
      ['GitHub', 'https://github.com/vznjs/vx'],
    ])
  })

  // Ownership and extensibility, never a speed multiple (2026-10-12: the
  // benchmark shows speed, copy does not).
  it('leads with seams, no paid tier and nothing to run beside it', () => {
    const specs = [
      ...stage.matchAll(/<li>\s*<strong>([\s\S]*?)<\/strong>\s*<span>([\s\S]*?)<\/span>/g),
    ]
    expect(specs.map((m) => `${text(m[1]!)} ${text(m[2]!)}`)).toEqual([
      '15 stages a plugin can take over',
      'MIT every piece, no paid tier',
      '0 daemons, accounts or clouds',
    ])
  })

  // The graph is drawn once per layout, and every hook group is in the
  // HTML, so the page reads whole with no script.
  it('draws the graph, both layouts, and lists every hook group', () => {
    const svgs = [...stage.matchAll(/<svg\b[^>]*data-layout="(\w+)"/g)].map((m) => m[1])
    expect(svgs).toEqual(['wide', 'narrow'])
    for (const b of map.BOXES)
      expect([...stage.matchAll(new RegExp(`data-box="${b.id}"`, 'g'))]).toHaveLength(2)
    for (const w of map.WIRES)
      expect([...stage.matchAll(new RegExp(`data-wire="${w.id}"`, 'g'))]).toHaveLength(2)
    // Every worker's slot is drawn, whether a worker holds it or not.
    expect([...stage.matchAll(/data-slot="\d"/g)]).toHaveLength(2 * map.SLOTS)
    const groups = [...stage.matchAll(/<li\b[^>]*data-step="\d"[^>]*>([\s\S]*?)<\/li>/g)].map(
      (m) => [
        text(/<strong class="story-title">([\s\S]*?)<\/strong>/.exec(m[1]!)![1]!),
        text(/<p>([\s\S]*?)<\/p>/.exec(m[1]!)![1]!),
      ],
    )
    expect(groups).toEqual(map.GROUPS.map((g) => [g.title, g.line.replaceAll('`', '')]))
  })

  it('keeps every anchor the redirects land on', () => {
    expect(
      ANCHORS.filter((a) => [...html.matchAll(new RegExp(`\\bid="${a}"`, 'g'))].length !== 1),
    ).toEqual([])
  })

  // Bars are passes; each label counts the cases a tool supports but fails
  // (issues), from the site's conformance data.
  it('scores every tool on the conformance suite, first after the stage', () => {
    const proof = section(html, 'proof')
    expect(text(proof)).toContain(`${RESULTS.cases.length} cases`)
    expect(text(proof)).toContain('Every test in vx, Turbo, Nx, Vite Task, Nix and moon')
    const vx = RESULTS.scores['vx']!.all!
    expect(text(/<div class="score-big">([\s\S]*?)<\/div>/.exec(proof)![1]!)).toBe(
      `${vx.pass} of ${vx.of} cases pass on vx`,
    )
    const cols = [
      ...proof.matchAll(/<li\b[^>]*style="--h:[\d.]+; --s:[\d.]+"[^>]*>([\s\S]*?)<\/li>/g),
    ].map((m) => [
      text(/class="col-name">([\s\S]*?)<\/span>/.exec(m[1]!)![1]!),
      text(/class="col-pct">([\s\S]*?)<\/span>/.exec(m[1]!)![1]!),
    ])
    // Highest score first.
    const rate = (t: string): number => RESULTS.scores[t]!.all!.pass / RESULTS.scores[t]!.all!.of
    expect(cols).toEqual(
      [...TOOLS]
        .sort((x, y) => rate(y) - rate(x))
        .map((t) => {
          const all = RESULTS.scores[t]!.all!
          const issues = all.can - all.pass
          return [toolName(t), `${issues} ${issues === 1 ? 'issue' : 'issues'}`]
        }),
    )
    expect(cols[0]![0]).toBe('vx')
    expect(new Set(cols.map((c) => c[0]))).toEqual(
      new Set(['vx', 'Turbo', 'Nx', 'Vite Task', 'Nix', 'moon']),
    )
    expect(hrefs(proof)).toEqual([`${BASE}conformance/`])
  })

  // Every race is the time a runner adds over the ideal run, never a total
  // (2026-10-09), each lane as long as its time against the slowest.
  it('races vx, Turbo, Nx and Vite Task on the measured figures', () => {
    const speed = section(html, 'speed')
    const races = [...speed.matchAll(/<figure class="race[^"]*"[^>]*>([\s\S]*?)<\/figure>/g)].map(
      (m) => m[1]!,
    )
    expect(races.map((f) => text(/<figcaption>([\s\S]*?)<\/figcaption>/.exec(f)![1]!))).toEqual([
      'Nothing changed',
      'Nothing changed, outputs restored',
      'Cold build',
      'Cold build: CPU the runner burns',
    ])
    const ROWS = ['warm', 'restore', 'cold', 'cpu']
    races.forEach((f, i) => {
      const lanes = [
        ...f.matchAll(
          /<div class="lane( vx)?(?: best)?" style="--w:([\d.]+);[^"]*">([\s\S]*?)<\/div>/g,
        ),
      ]
      expect(
        lanes.map((m) => text(/class="lane-name">([\s\S]*?)<\/span>/.exec(m[3]!)![1]!)),
      ).toEqual(['vx', 'Turbo', 'Nx', 'Vite Task'])
      expect(lanes.map((m) => m[1] ?? '')).toEqual([' vx', '', '', ''])
      expect(Math.max(...lanes.map((m) => Number(m[2])))).toBe(100)
      const figures = ['vx', 'turbo', 'nx', 'vt'].map(
        (r) => FIGURES.get(`${r}.${ROWS[i]}`) ?? 'missing',
      )
      // Each lane leads with its ratio to the row's fastest, whoever that is,
      // and shows no time: a time moves every run, the ratio far less.
      expect(
        lanes.map((m) => text(/class="lane-value">\s*<b>([\s\S]*?)<\/b>/.exec(m[3]!)![1]!)),
      ).toEqual(
        figures.map((v) =>
          ratioLabel(parseDuration(v)!, Math.min(...figures.map((f) => parseDuration(f)!))),
        ),
      )
      expect(f).not.toMatch(/<small>/)
      expect(lanes.filter((m) => m[0].includes('<b>1×</b>')).length).toBeGreaterThanOrEqual(1)
    })
    const fine = [...speed.matchAll(/<p class="fine">([\s\S]*?)<\/p>/g)].map((m) => text(m[1]!))
    expect(fine[0]).toBe('Time each tool adds over the ideal run; lower is better.')
    expect(fine[1]).toMatch(
      /^Benchmark workload: a synthetic monorepo of [\d,]+ projects and [\d,]+ tasks .* real repos with uneven task times will differ\.$/,
    )
    expect(fine[2]).toBe(FIGURES.get('provenance'))
    expect(hrefs(speed)).toEqual([`${BASE}benchmarks/`])
  })

  it('draws Distributed task execution as a run, its facts beside it', () => {
    const dte = section(html, 'dte')
    expect(text(dte)).toContain('Distributed task execution')
    expect([...dte.matchAll(/class="dte-lane"/g)]).toHaveLength(4)
    expect([...dte.matchAll(/class="dte-block dte-crit"/g)].length).toBeGreaterThan(0)
    expect(hrefs(dte)).toEqual([`${BASE}plugins/vx-dte/`])
  })

  // Every package beside core, a server named beside the plugin that talks to it.
  it('shows every plugin, each server beside its plugin, and your own', () => {
    const plugins = section(html, 'plugins')
    const PKGS = [
      'vx-dte',
      'vx-cache',
      'vx-history',
      'vx-lockfile',
      'vx-otel',
      'vx-ci',
      'vx-reapi',
      'vx-migrate',
    ]
    expect(hrefs(plugins)).toEqual([
      ...PKGS.map((p) => `${BASE}plugins/${p}/`),
      `${BASE}docs/plugins/`,
    ])
    const servers = [
      ...plugins.matchAll(/<a\b[^>]*class="part[^"]*"[^>]*>([\s\S]*?)<\/a>/g),
    ].flatMap((m) => {
      const s = /class="part-server">([\s\S]*?)<\/span>/.exec(m[1]!)
      return s
        ? [`${text(/class="part-pkg">([\s\S]*?)<\/code>/.exec(m[1]!)![1]!)} ${text(s[1]!)}`]
        : []
    })
    expect(servers).toEqual(
      ['vx-dte', 'vx-cache', 'vx-history'].map((p) => `@vzn/${p} + @vzn/${p}-server`),
    )
  })

  it('installs the agent skill', () => {
    const agents = section(html, 'agents')
    expect(agents).toContain('data-copy="bunx skills add vznjs/vx"')
    expect(hrefs(agents)).toEqual([`${BASE}docs/agents/`])
  })

  // Four commands on native config; Turbo or Nx only through migration,
  // with no speed claim for it. `vx init` outside Turbo and Nx writes an
  // empty root project (#3778), so the hit names the task the reader declares.
  it('ends on how to start', () => {
    const start = section(html, 'start')
    const steps = [...start.matchAll(/<li>\s*<code>([\s\S]*?)<\/code>\s*<span>([\s\S]*?)<\/span>/g)]
    expect(steps.map((m) => text(m[1]!))).toEqual([
      'bunx @vzn/vx init',
      'vx lock',
      'vx run build',
      'vx run build',
    ])
    expect(text(steps[1]![2]!)).toContain('declare a task')
    expect(hrefs(start)).toEqual([`${BASE}quickstart/`, `${BASE}docs/migrate/`, `${BASE}features/`])
    expect(text(start)).not.toMatch(/turbo\.json|nx\.json|unchanged|faster/i)
  })

  // The race's clock: a lap takes the tool's measured time, the lap count
  // and the runner's place come from the same elapsed time, and whether it
  // runs is a fact about where the band is now. The race once stopped for
  // good when an observer's queued entry was stale (2026-11-13).
  it('runs the race on one clock, whenever the band is on screen', () => {
    expect(lapAt(0, 390)).toEqual({ laps: 0, x: -100 })
    expect(lapAt(195, 390)).toEqual({ laps: 0, x: -50 })
    expect(lapAt(390 * 38 + 39, 390).laps).toBe(38)
    expect(lapAt(390 * 38 + 39, 390).x).toBeCloseTo(-90)
    // 14 s in, vx has lapped 35 times and Nx once: real time, not a share.
    expect([lapAt(14_000, 390).laps, lapAt(14_000, 7460).laps]).toEqual([35, 1])
    expect(lapsLabel(0)).toBe('0 laps')
    expect(lapsLabel(1)).toBe('1 lap')
    // CPU is an amount: every tool burns at one rate, so the least stops
    // first, holds, and the loop starts over.
    expect(burnAt(0, 29, 244)).toBe(0)
    expect(burnAt(BURN_MS / 2, 29, 244)).toBe(29)
    expect(burnAt(BURN_MS / 2, 244, 244)).toBe(122)
    expect(burnAt(BURN_MS + BURN_HOLD_MS - 1, 244, 244)).toBe(244)
    expect(burnAt(BURN_MS + BURN_HOLD_MS, 244, 244)).toBe(0)
    expect(burnClip(8, 61)).toBe(
      'polygon(0 0, 3.279% 0, 3.279% 100%, 4.918% 100%, 4.918% 100%, 0 100%)',
    )
    expect(burnClip(9, 61)).toContain('3.279% 75%, 4.918% 75%')
    // Every figure is a ratio to the row's fastest; a near tie never reads as 1×.
    expect(ratioLabel(28_710, 28_710)).toBe('1×')
    expect(ratioLabel(405, 390)).toBe('1.04×')
    expect(ratioLabel(28_710, 16_030)).toBe('1.79×')
    expect(ratioLabel(62_000, 28_710)).toBe('2.2×')
    expect(ratioLabel(7460, 390)).toBe('19×')
    expect(ratioLabel(80_000, 0)).toBe('—')
    // A tail follows its runner's speed, the same rule for every tool,
    // between a floor that always shows and a ceiling.
    expect(tailPct(TAIL_MS * 2)).toBe(TAIL_MAX)
    expect(tailPct(TAIL_MS * 5)).toBe(20)
    expect(tailPct(107_000)).toBe(TAIL_MIN)
    expect(tailPct(1)).toBe(TAIL_MAX)
    expect(tailPct(400)).toBeGreaterThan(tailPct(800))
    const view = 900
    expect(racing({ top: 899, bottom: 2000 }, view, false)).toBe(true)
    expect(racing({ top: -1500, bottom: 1 }, view, false)).toBe(true)
    expect(racing({ top: 900, bottom: 2000 }, view, false)).toBe(false)
    expect(racing({ top: -1500, bottom: 0 }, view, false)).toBe(false)
    expect(racing({ top: 100, bottom: 800 }, view, true)).toBe(false)
    // A tab that slept an hour moves the race one frame's worth, not an hour.
    expect(step(3_600_000, 0)).toBe(100)
    expect(step(1016, 1000)).toBe(16)
    // Every lane carries its measured lap for the script to read.
    const laps = [...section(html, 'speed').matchAll(/--lap:([\d.]+)s/g)].map((m) => Number(m[1]))
    expect(laps).toHaveLength(16)
    expect(laps.every((s) => s > 0)).toBe(true)
    // The script reads the band's place, not an observer entry.
    const page = readFileSync(
      path.join(import.meta.dir, '..', 'src', 'pages', 'index.astro'),
      'utf8',
    )
    expect(page).toContain('new IntersectionObserver(sync).observe(speed)')
    expect(page).toContain("addEventListener('pageshow', sync)")
  })

  // The scope shows the fields vx records for a task, on an example run it
  // names as one, and links to where each number is read.
  it('shows what vx records for every task, and where to read it', () => {
    const data = section(html, 'data')
    const dials = [...data.matchAll(/class="dial-k">([\s\S]*?)<\/span>/g)].map((m) => text(m[1]!))
    expect(dials).toEqual(['Time', 'CPU', 'Peak memory', 'Outputs', 'Cache', 'History'])
    expect(text(data)).toContain('An example run')
    expect(hrefs(data)).toEqual([
      `${BASE}features/vx-last/`,
      `${BASE}features/vx-why/`,
      `${BASE}features/run-analytics/`,
      `${BASE}plugins/vx-otel/`,
    ])
  })

  // At rest (no script, reduced motion) the page is whole and still: the
  // motion is script on top, and no keyframe loops forever (motion-budget).
  it('keeps the motion off with reduced motion', () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1]!)
      .join('\n')
    expect(scripts).toContain('prefers-reduced-motion: reduce')
  })

  // Quotes only (2026-11-19): the words, who said them and their role,
  // a public one linked to the GitHub thread where it was said, all in one band.
  it('quotes people word for word, in one band', () => {
    expect(html).not.toContain('class="qc"')
    const wall = section(html, 'voices')
    expect(text(/<h2>([\s\S]*?)<\/h2>/.exec(wall)![1]!.replace(/<br\s*\/?>/, ' '))).toBe(
      'What others say about us.',
    )
    const quotes = [...wall.matchAll(/<blockquote>([\s\S]*?)<\/blockquote>/g)].map((m) =>
      text(m[1]!),
    )
    expect(quotes).toEqual(ALL_VOICES.map((v) => `“${v.quote}”`))
    expect(hrefs(wall)).toEqual(ALL_VOICES.flatMap((v) => (v.href ? [v.href] : [])))
    for (const v of ALL_VOICES) {
      if (v.href)
        expect(v.href).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+/)
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

describe('the system graph, as data', () => {
  it('places every box, slot and wire in both layouts, inside the drawing', () => {
    const slots = Array.from({ length: map.SLOTS }, (_, i) => `slot${i + 1}`)
    // Every worker the run had has its own box.
    expect(map.play(run as map.Run).lanes.length).toBeLessThanOrEqual(map.SLOTS)
    for (const L of Object.values(map.LAYOUTS)) {
      for (const id of [...map.BOXES.map((b) => b.id), ...slots]) {
        const r = L.boxes[id]!
        expect(r).toBeDefined()
        expect(r.x + r.w).toBeLessThanOrEqual(L.width)
        expect(r.y + r.h).toBeLessThanOrEqual(L.height)
      }
      for (const w of map.WIRES) expect(L.ends[w.id]).toBeDefined()
    }
  })

  // The six groups (M, 2026-11-18) hold every hook a plugin fills a stage
  // with, once; `commands` adds verbs, not a stage.
  it('groups every stage hook once', () => {
    const hooks = map.GROUPS.flatMap((g) => g.hooks)
    expect(new Set(hooks).size).toBe(hooks.length)
    expect([...hooks].sort()).toEqual(PLUGIN_HOOKS.filter((h) => h !== 'commands').sort())
    expect(map.GROUPS.map((g) => g.title)).toEqual([
      'Setup',
      'Graph',
      'Cache',
      'Schedule',
      'Run',
      'Report',
    ])
    for (const g of map.GROUPS) {
      expect(g.line.split(/[.!?]\s/)).toHaveLength(1)
      expect(g.line.length).toBeLessThanOrEqual(120)
    }
  })
})

// The graph plays one run as vx-dte's simulator ran it (scripts/hero-run.ts
// wrote src/data/hero-run.json): 10 tasks, workers started when the plan
// needed them and let go when it did not.
describe('the hero run', () => {
  const r = run as map.Run
  const P = map.play(r)
  const byId = new Map(r.tasks.map((t) => [t.id, t]))

  it('is 10 tasks, some held in the cache, the rest run on workers', () => {
    expect(r.tasks).toHaveLength(10)
    expect(r.tasks.filter((t) => t.hit).length).toBeGreaterThan(0)
    expect(P.bars).toHaveLength(r.tasks.filter((t) => !t.hit).length)
  })

  it('runs a task only after every task it depends on ended', () => {
    const late = r.tasks.filter(
      (t) => !t.hit && t.deps.some((d) => (byId.get(d)!.endMs ?? 0) > t.startMs!),
    )
    expect(late.map((t) => t.id)).toEqual([])
  })

  it('runs each task on its worker while that worker is joined', () => {
    const outside = r.tasks.filter((t) => {
      const w = r.workers.find((x) => x.id === t.worker)
      return !t.hit && (!w || w.joinMs === null || t.startMs! < w.joinMs || t.endMs! > w.leaveMs)
    })
    expect(outside.map((t) => t.id)).toEqual([])
  })

  it('starts workers as the plan needs them, not all at once, and lets each go', () => {
    expect(new Set(r.workers.map((w) => w.spawnMs)).size).toBe(r.workers.length)
    expect(new Set(r.workers.map((w) => w.leaveMs)).size).toBe(r.workers.length)
    for (const w of r.workers) expect(w.leaveMs).toBeGreaterThan(w.joinMs!)
  })

  it('draws no two tasks on the same cores of a worker at once', () => {
    const clash = P.bars.filter((a) =>
      P.bars.some(
        (b) =>
          b !== a &&
          b.slot === a.slot &&
          b.start < a.end &&
          a.start < b.end &&
          b.at < a.at + a.cores &&
          a.at < b.at + b.cores,
      ),
    )
    expect(clash.map((b) => b.id)).toEqual([])
  })

  // M (2026-11-18): one card a step, every step 5 s but Run's 10 s, which
  // the tasks together fill; a worker boots in 2 s.
  // M (2026-11-18): never a moment of waiting for time.
  it('keeps something moving through every moment of the loop', () => {
    const busy: [number, number][] = [
      ...P.dots.map((d): [number, number] => [d.at, d.at + (d.dur ?? map.TRAVEL_MS)]),
      ...P.lanes.map((l): [number, number] => [l.spawn, l.join]),
      ...P.bars.map((b): [number, number] => [b.start, b.end]),
    ]
    const idle: number[] = []
    for (let t = 0; t < P.loop; t += 50) if (!busy.some(([a, b]) => a <= t && t < b)) idle.push(t)
    expect(idle).toEqual([])
  })

  it('gives each step 5 s, the tasks Run’s 10 s, each boot 2 s', () => {
    expect(P.steps.map((x) => x.to - x.from)).toEqual(
      map.GROUPS.map((g) => (g.id === 'run' ? 2 * map.STEP_MS : map.STEP_MS)),
    )
    expect(P.steps.map((x) => x.group)).toEqual(map.GROUPS.map((g) => g.id))
    const run = P.steps.find((x) => x.group === 'run')!
    expect(Math.min(...P.bars.map((b) => b.start))).toBeCloseTo(run.from, 6)
    expect(Math.max(...P.bars.map((b) => b.end))).toBeCloseTo(run.to, 6)
    for (const l of P.lanes) expect(l.join - l.spawn).toBe(map.BOOT_MS)
    expect(
      P.dots.every((d) => d.at >= 0 && d.at + (d.dur ?? map.TRAVEL_MS) <= P.loop && d.label !== ''),
    ).toBe(true)
    // A step whose work is one message lets it take the whole step.
    for (const g of ['setup', 'graph']) {
      const step = P.steps.find((x) => x.group === g)!
      for (const d of P.dots.filter((x) => x.at >= step.from && x.at < step.to))
        expect([d.at, d.at + d.dur!]).toEqual([step.from, step.to])
    }
  })

  // M (2026-11-18): a step's group lights for its window; outside it, only
  // what vx calls through its hooks is done by vx, and a group vx calls in
  // a step stays lit that whole step, never blinking.
  it('lights a group for every whole step vx calls its hooks in', () => {
    const own = new Set(
      map.WIRES.filter((w) => w.from === 'core' || w.to === 'core').map((w) => w.id),
    )
    for (const [group, spans] of Object.entries(P.lit))
      for (const [from, to] of spans) {
        const step = P.steps.find((x) => x.from === from && x.to === to)
        expect(step).toBeDefined()
        if (step!.group === group) continue
        expect(P.dots.some((d) => d.at >= from && d.at < to && own.has(d.wire))).toBe(true)
      }
  })

  // vx-history sends finished tasks' timings while the run goes (M,
  // 2026-11-18): History hears a stream through Run, not only at the end.
  it('streams timings to history during Run', () => {
    const run = P.steps.find((x) => x.group === 'run')!
    const live = P.dots.filter(
      (d) => d.wire === 'history' && d.back && d.at >= run.from && d.at < run.to,
    )
    expect(live.length).toBeGreaterThanOrEqual(2)
    expect(run.boxes).toContain('history')
  })

  // vx hands DTE the plan before DTE starts a worker.
  it('starts no worker before DTE has the plan', () => {
    const plan = P.dots.find((d) => d.label === 'plan')!
    for (const l of P.lanes)
      expect(l.spawn - map.TRAVEL_MS).toBeGreaterThanOrEqual(plan.at + map.TRAVEL_MS - 1e-6)
  })

  // Each message in the order the run sent it: DTE starts each worker, an
  // order reaches it before its task starts, and nothing but the start
  // reaches a worker that is off.
  it('sends each order before its task and only to a worker that is on', () => {
    for (const l of P.lanes)
      expect(
        P.dots.some(
          (d) => d.wire === `s${l.slot}` && d.label === 'start' && d.at + map.TRAVEL_MS === l.spawn,
        ),
      ).toBe(true)
    for (const b of P.bars) {
      const order = P.dots.find(
        (d) =>
          d.wire === `s${b.slot}` &&
          d.label === 'task' &&
          d.at + map.TRAVEL_MS <= b.start + 1e-6 &&
          d.at >= b.start - 3 * map.TRAVEL_MS - 1e-6,
      )
      expect(order).toBeDefined()
    }
    const off = P.dots
      .filter((d) => /^[sc]\d$/.test(d.wire) && d.label !== 'start')
      .filter(
        (d) =>
          !P.lanes.some(
            (l) =>
              `${d.wire[1]}` === `${l.slot}` && d.at >= l.join - 1e-6 && d.at <= l.leave + 1e-6,
          ),
      )
    expect(off).toEqual([])
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
    expect(meta(page(), 'og:title')).toEqual(['vx — task orchestration you own'])
    // The search result's and the card's headline says what vx is: the
    // cinematic landing's slogan outlived the page it headed.
    expect(/<title>([^<]*)<\/title>/.exec(page())?.[1]).toBe('vx — task orchestration you own')
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

  // The card's alt text still said "a faster runner for your Turborepo or Nx
  // repo", and a shared docs link's snippet "task scheduler for JavaScript
  // monorepos", after the landing stopped (2026-11-05).
  it("the card's alt text and the site description say what the page says", () => {
    const h1 = text(/<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(page())![1]!)
    const quickstart = readFileSync(path.join(DIST, 'quickstart', 'index.html'), 'utf8')
    for (const html of [page(), quickstart])
      expect(meta(html, 'og:image:alt')).toEqual([`vx: ${h1}`])
    const config = readFileSync(path.resolve(import.meta.dir, '../astro.config.mjs'), 'utf8')
    const description = meta(page(), 'description')[0]!
    expect(config).toContain(`'${description}'`)
  })

  it('the card is a 1200×630 PNG', () => {
    const png = readFileSync(path.join(DIST, 'og.png'))
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630])
  })
})

// The landing and the feature pages end on their own footer (docs,
// reference and community links) inside Starlight's panel. A rule hiding
// every footer in a panel hid that one too, on every such page, and left
// only the legal line, flush with the screen's edge (2026-11-17).
describe("the pages in the landing's look", () => {
  const css = readFileSync(path.resolve(import.meta.dir, '../src/styles/landing.css'), 'utf8')

  it("end on their own footer, not Starlight's", () => {
    for (const page of ['index.html', 'features/index.html', 'conformance/index.html']) {
      const html = readFileSync(path.join(DIST, page), 'utf8')
      expect(html).toContain('<footer class="footer"')
    }
    expect(css).not.toMatch(/\.content-panel footer\s*\{/)
    expect(css).toContain('.content-panel :is(footer:not(.footer), .vx-legal)')
  })

  it('run edge to edge, with no panel padding around them', () => {
    expect(css).toMatch(
      /:root:has\(\.vx-landing\) main \.content-panel \{\s*padding: 0;\s*border: 0;/,
    )
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
