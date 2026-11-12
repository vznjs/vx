// The landing page (2026-11-12, rebuilt: the system graph is the hero, in
// 3D over a grid, standing up as you scroll and playing one CI run). These
// rows read the page as it shipped, `dist/index.html`, which the `build`
// task writes, and the graph as data (src/components/landing/system-map.ts).
// What the design says is written out here by hand; every figure is held to
// the site's data: src/data/bench.json (bench.data) and the conformance
// results.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { FIGURES } from '../src/bench/data.ts'
import { RESULTS, TOOLS, percent, supports, toolName } from '../src/conformance/data.ts'
import * as map from '../src/components/landing/system-map.ts'

const DIST = path.resolve(import.meta.dir, '../dist')
const BASE = (process.env['BASE_PATH'] ?? '/vx').replace(/\/?$/, '/')

// Every band under the stage, top to bottom.
const SECTIONS = ['proof', 'speed', 'data', 'dte', 'plugins', 'agents', 'start']

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

  // The graph is drawn once per layout, and every step of the run is in the
  // HTML, so the page reads whole with no script.
  it('draws the graph, both layouts, and lists every step of the run', () => {
    const svgs = [...stage.matchAll(/<svg\b[^>]*data-layout="(\w+)"/g)].map((m) => m[1])
    expect(svgs).toEqual(['wide', 'narrow'])
    for (const b of map.BOXES)
      expect([...stage.matchAll(new RegExp(`data-box="${b.id}"`, 'g'))]).toHaveLength(2)
    for (const w of map.WIRES)
      expect([...stage.matchAll(new RegExp(`data-wire="${w.id}"`, 'g'))]).toHaveLength(2)
    const steps = [...stage.matchAll(/<li\b[^>]*data-step="\d"[^>]*>([\s\S]*?)<\/li>/g)].map(
      (m) => [
        text(/<strong class="story-title">([\s\S]*?)<\/strong>/.exec(m[1]!)![1]!),
        text(/<p>([\s\S]*?)<\/p>/.exec(m[1]!)![1]!),
      ],
    )
    expect(steps).toEqual(map.STEPS.map((s) => [s.title, s.line.replaceAll('`', '')]))
  })

  it('keeps every anchor the redirects land on', () => {
    expect(
      ANCHORS.filter((a) => [...html.matchAll(new RegExp(`\\bid="${a}"`, 'g'))].length !== 1),
    ).toEqual([])
  })

  // Passes out of every case, rounded down, from the site's conformance data.
  it('scores every tool on the conformance suite, first after the stage', () => {
    const proof = section(html, 'proof')
    expect(text(proof)).toContain(`${RESULTS.cases.length} cases`)
    expect(text(proof)).toContain('Every test in vx, Turbo, Nx, Vite Task, Nix and moon')
    const vx = RESULTS.scores['vx']!.all!
    expect(text(/<div class="score-big">([\s\S]*?)<\/div>/.exec(proof)![1]!)).toBe(
      `${vx.pass} of ${vx.of} cases pass on vx`,
    )
    const cols = [...proof.matchAll(/<li\b[^>]*style="--h:[\d.]+"[^>]*>([\s\S]*?)<\/li>/g)].map(
      (m) => [
        text(/class="col-name">([\s\S]*?)<\/span>/.exec(m[1]!)![1]!),
        text(/class="col-pct">([\s\S]*?)<\/span>/.exec(m[1]!)![1]!),
        text(/class="col-sup">([\s\S]*?)<\/span>/.exec(m[1]!)![1]!),
      ],
    )
    // Highest score first.
    const rate = (t: string): number => RESULTS.scores[t]!.all!.pass / RESULTS.scores[t]!.all!.of
    expect(cols).toEqual(
      [...TOOLS]
        .sort((x, y) => rate(y) - rate(x))
        .map((t) => {
          const all = RESULTS.scores[t]!.all!
          return [toolName(t), percent(all), `supports ${supports(all)}`]
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
    const races = [...speed.matchAll(/<figure class="race">([\s\S]*?)<\/figure>/g)].map(
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
        ...f.matchAll(/<div class="lane( vx)?" style="--w:([\d.]+);[^"]*">([\s\S]*?)<\/div>/g),
      ]
      expect(
        lanes.map((m) => text(/class="lane-name">([\s\S]*?)<\/span>/.exec(m[3]!)![1]!)),
      ).toEqual(['vx', 'Turbo', 'Nx', 'Vite Task'])
      expect(lanes.map((m) => m[1] ?? '')).toEqual([' vx', '', '', ''])
      expect(Math.max(...lanes.map((m) => Number(m[2])))).toBe(100)
      expect(
        lanes.map((m) => text(/class="lane-value">([\s\S]*?)<\/span>/.exec(m[3]!)![1]!)),
      ).toEqual(['vx', 'turbo', 'nx', 'vt'].map((r) => FIGURES.get(`${r}.${ROWS[i]}`) ?? 'missing'))
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
    expect(hrefs(start)).toEqual([
      `${BASE}quickstart/`,
      `${BASE}guides/migrate/`,
      `${BASE}features/`,
    ])
    expect(text(start)).not.toMatch(/turbo\.json|nx\.json|unchanged|faster/i)
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
  it('places every box and wire in both layouts, inside the drawing', () => {
    for (const L of Object.values(map.LAYOUTS)) {
      for (const b of map.BOXES) {
        const r = L.boxes[b.id]!
        expect(r).toBeDefined()
        expect(r.x + r.w).toBeLessThanOrEqual(L.width)
        expect(r.y + r.h).toBeLessThanOrEqual(L.height)
      }
      for (const w of map.WIRES) expect(L.ends[w.id]).toBeDefined()
    }
  })

  it('lights only boxes, stages and wires that exist, each step one sentence', () => {
    const boxes = new Set(map.BOXES.map((b) => b.id))
    const wires = new Set(map.WIRES.map((w) => w.id))
    for (const s of map.STEPS) {
      expect(s.boxes.filter((b) => !boxes.has(b))).toEqual([])
      expect(s.stages.filter((x) => !(map.STAGES as readonly string[]).includes(x))).toEqual([])
      expect(s.wires.map((w) => w.replace(/^-/, '')).filter((w) => !wires.has(w))).toEqual([])
      expect(s.line.split(/[.!?]\s/)).toHaveLength(1)
      expect(s.line.length).toBeLessThanOrEqual(200)
    }
    // Every piece takes part in the run.
    const lit = new Set(map.STEPS.flatMap((s) => s.boxes))
    expect(map.BOXES.filter((b) => b.id !== 'core' && !lit.has(b.id)).map((b) => b.id)).toEqual([])
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
