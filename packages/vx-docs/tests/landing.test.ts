// The landing page as the Guide's cover (design/site-redo-2026-09.md § The
// landing; R3 of the site redo): one question and one picture, the ten
// chapters, then the numbers, adoption and what is not inside. These rows
// read the page as it shipped, `dist/index.html`, which the `build` task
// writes.
//
// The measurements are not checked here: `@vzn/vx-bench#check.site` holds
// the benchRows block, the stat tiles and the graph's size to results.json,
// and the n8n panel and its task count to benchmarks.md. The page's other
// figures (item 712) are held below, each to its own source.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { CHAPTERS } from '../src/guide/chapters.js'

const DIST = path.resolve(import.meta.dir, '../dist')
const BASE = (process.env['BASE_PATH'] ?? '/vx').replace(/\/?$/, '/')

// Every section below the hero, top to bottom. The three idea sections of
// item 709 (`inputs`, `seams`, `speed`), the feature and plugin cards
// (`why`, `plugins`) and the config sample (`config`) are gone: the
// chapters teach each of them now.
const SECTIONS = ['chapters', 'run', 'bench', 'real', 'scale', 'migrate', 'open']

// The toy monorepo's four packages, in the order `for p in packages/*`
// visits them: by name.
const LOOP_ORDER = ['api', 'app', 'ui', 'utils']

// Every internal link the page carried before item 709 (the built page at
// f565ec5f), without the base path. Two of them, the benchmark panels'
// links, were written as quoted `{href(…)}` in the source and shipped as that
// literal text, so they never resolved; they are listed by the target they
// named, which the page now links.
const OLD_LINKS = [
  '',
  'architecture/',
  'benchmarks/',
  'benchmarks/#five-real-turbo-repos-2026-09-11',
  'benchmarks/#how-the-overhead-scales-with-the-workspace-2026-09-10',
  'blog/',
  'cli/',
  'cli/#vx-init',
  'cli/#vx-why',
  'comparison/',
  'guides/extensibility/',
  'guides/mcp/',
  'guides/plugins/',
  'guides/plugins/#keys-and-order',
  'guides/remote-caching/',
  'guides/remote-execution/',
  'guides/sandboxing/',
  'guides/trusting-the-cache/',
  'logo-mark.svg',
  'migrate/from-nx/',
  'migrate/from-turborepo/',
  'parity/',
  'quickstart/',
  'schema/',
]
// Links removed on purpose, each with the reason.
const REMOVED: Record<string, string> = {
  'cli/#vx-why': 'the feature cards went; the Docs caching page shows `vx why`',
  'guides/extensibility/': 'merged into guides/plugins/, which the footer links',
  'guides/plugins/#keys-and-order': 'the plugin cards went; chapter 9 teaches the stages',
  'guides/trusting-the-cache/': 'merged into guides/caching/, which the footer links',
}

// benchmarks.md as the import step copied it; its tables and headings are
// the source's, byte for byte.
const BENCHMARKS = path.resolve(import.meta.dir, '../src/content/docs/benchmarks.md')
const CORE_PACKAGE = path.resolve(import.meta.dir, '../node_modules/@vzn/vx/package.json')

/** A `## ` section of benchmarks.md, up to the next one. */
function benchSection(heading: string): string {
  const doc = readFileSync(BENCHMARKS, 'utf8')
  const at = doc.indexOf(`\n## ${heading}`)
  expect(at).toBeGreaterThan(-1)
  const next = doc.indexOf('\n## ', at + 1)
  return doc.slice(at, next === -1 ? undefined : next)
}

/** The cells of the row labelled `label` in a Markdown table. */
function tableRow(md: string, label: string): string[] {
  const line = md.split('\n').find((l) => l.split('|')[1]?.trim() === label)
  expect(line).toBeDefined()
  return line!
    .split('|')
    .slice(2, -1)
    .map((c) => c.trim())
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

/** Text with each tag read as a space: a `<br>` or two spans side by side. */
function spaced(html: string): string {
  return text(html.replace(/<[^>]+>/g, ' '))
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
  const h1At = html.indexOf('<h1')
  const hero = html.slice(h1At, html.indexOf('<section', h1At))

  it('asks the question in the h1, then lists the chapters, then the numbers', () => {
    const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)]
    expect(h1).toHaveLength(1)
    expect(spaced(h1[0]![1]!)).toBe(
      'Four packages. One build. Why is it slow, and why is it wrong?',
    )
    const ids = [...html.matchAll(/<section\b[^>]*\bid="([\w-]+)"/g)]
    expect(ids.map((m) => m[1])).toEqual(SECTIONS)
    expect(h1[0]!.index!).toBeLessThan(ids[0]!.index!)
  })

  it('sends the reader to the guide first, then the quickstart', () => {
    expect(hrefs(hero)).toEqual([`${BASE}guide/why/`, `${BASE}quickstart/`])
    const primary = /<a\b[^>]*class="btn btn-primary[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(hero)
    expect(text(primary![1]!)).toBe('Read the guide →')
    expect(hero).toContain('data-copy="npm install -g @vzn/vx"')
  })

  it('draws the loop failing three ways, as one static picture', () => {
    const svgs = [...hero.matchAll(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/g)].filter((m) =>
      /\srole="img"/.test(m[1]!),
    )
    expect(svgs).toHaveLength(1)
    const [, attrs, body] = svgs[0]!
    expect(attrs).toMatch(/\saria-label="[^"]{80,}"/)
    // The command is text above the drawing, so it wraps on a phone.
    expect(/<code class="loop-code">([\s\S]*?)<\/code>/.exec(hero)?.[1]).toContain(
      'for p in packages/*',
    )
    // One lane per package, in the loop's order; the three that need a
    // package built later fail, and the one that needs nothing builds.
    const lanes = [...body!.matchAll(/<text class="lane"[^>]*>([^<]*)</g)].map((m) => m[1])
    expect(lanes).toEqual(LOOP_ORDER)
    const bars = [...body!.matchAll(/<g class="bar (fail|ok)"/g)].map((m) => m[1])
    expect(bars).toEqual(['fail', 'fail', 'fail', 'ok'])
    const legend = [...hero.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => spaced(m[1]!))
    expect(legend.map((l) => l.replace(/\..*$/, ''))).toEqual([
      '1 Wrong order',
      '2 Rebuilds everything',
      '3 One at a time',
    ])
    expect(hero).not.toMatch(/<script\b|\son[a-z]+=/)
  })

  it('lists the ten chapters, each its title and problem, as chapters.ts has them', () => {
    const items = [...section(html, 'chapters').matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => {
      const link = /<a href="([^"]*)"/.exec(m[1]!)![1]!
      const part = (cls: string) =>
        text(new RegExp(`<span class="${cls}"[^>]*>([\\s\\S]*?)</span>`).exec(m[1]!)![1]!)
      return [link, part('n'), part('t'), part('p')]
    })
    expect(items).toEqual(
      CHAPTERS.map((c) => [
        `${BASE}guide/${c.slug}/`,
        String(c.chapter).padStart(2, '0'),
        c.title,
        c.problem.replace(/`/g, ''),
      ]),
    )
    for (const [link] of items) expect(resolves(link!.slice(BASE.length))).toBeUndefined()
  })

  it('keeps every internal link the page had, unless it was removed on purpose', () => {
    const now = new Set(
      allHrefs(html)
        .filter((h) => h.startsWith(BASE))
        .map((h) => h.slice(BASE.length)),
    )
    const lost = OLD_LINKS.filter((l) => !now.has(l) && !(l in REMOVED))
    expect(lost).toEqual([])
    // Removed means removed: a link on the list that is still on the page is
    // a stale entry.
    expect(Object.keys(REMOVED).filter((l) => now.has(l))).toEqual([])
    const broken = [...now].map(resolves).filter((m) => m !== undefined)
    expect(broken).toEqual([])
    // No link is a literal of the source's expression syntax.
    expect(allHrefs(html).filter((h) => h.includes('{'))).toEqual([])
  })
})

// Item 712: every figure on the page that update-site.ts does not write,
// held to its source. The expected facts are written out here, and each is
// read from the source AND from the built page, so a change to either
// fails the row.
describe("the landing page's figures", () => {
  const html = page()

  it("says five real Turbo repos and vx's restore on all five, as benchmarks.md does", () => {
    const five = benchSection('Five real Turbo repos')
    // One `### owner/name (…)` subsection per repo; the section's last
    // subsection, the wide graphs, is not a repo.
    const subsections = five.split(/^### /m).filter((s) => /^[\w.-]+\/[\w.-]+ \(/.test(s))
    expect(subsections.map((s) => s.slice(0, s.indexOf(' ')))).toEqual([
      'withastro/astro',
      'payloadcms/payload',
      'medusajs/medusa',
      'n8n-io/n8n',
      'calcom/cal.com',
    ])
    // A bold cell is the faster tool's; vx's is the first.
    const restore = subsections.map((repo) =>
      tableRow(repo, 'warm, outputs wiped (restore)')[0]!.startsWith('**'),
    )
    expect(restore).toEqual([true, true, true, true, true])
    expect(text(section(html, 'real'))).toContain(
      'On five real Turbo repos, the fastest restore on all five;',
    )
    // The panel shows n8n and names the other four.
    expect(text(section(html, 'real'))).toContain(
      'Astro, payload, medusa and cal.com are in the benchmarks.',
    )
  })

  it('names the three sizes the scaling table measures', () => {
    const sizes = benchSection('How the overhead scales with the workspace')
      .split('\n')
      .filter((l) => /^\| [\d,]+ /.test(l))
      .map((l) => l.split('|')[1]!.trim())
    expect(sizes).toEqual(['100', '300', '1,000'])
    expect(text(section(html, 'scale'))).toContain('Benchmarks: 100, 300 and 1,000 packages')
  })

  it("labels the terminal a sample, and prints core's version in it", () => {
    const version = (JSON.parse(readFileSync(CORE_PACKAGE, 'utf8')) as { version: string }).version
    const term = section(html, 'run')
    expect(term).toContain('<div class="term">')
    expect(text(term)).toContain('zsh — vx · sample output')
    expect(text(term)).toContain(`─ vx ${version} `)
  })
})
