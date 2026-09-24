// The landing page (roadmap W8, item 709; design/landing-2026-09.md): the
// problem first, then the three ideas, then the numbers. These rows read the
// page as it shipped, `dist/index.html`, which the `build` task writes.
//
// The measurements are not checked here: `@vzn/vx-bench#check.site` holds
// the benchRows block, the stat tiles and the graph's size to results.json,
// and the n8n panel and its task count to benchmarks.md. The page's other
// figures (item 712) are held below, each to its own source.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const DIST = path.resolve(import.meta.dir, '../dist')
const REPO = path.resolve(import.meta.dir, '../../..')
const BASE = (process.env['BASE_PATH'] ?? '/vx').replace(/\/?$/, '/')
const GH_BLOB = 'https://github.com/vznjs/vx/blob/main/'

// Every section, top to bottom: the three ideas, then the numbers, then the
// sections the page had before the ideas.
const SECTIONS = [
  'inputs',
  'seams',
  'speed',
  'bench',
  'real',
  'scale',
  'why',
  'open',
  'plugins',
  'config',
  'migrate',
]

// Each idea section and the pages it must link to: its Learn pages, and for
// the third, which has none, the page on its mechanisms and benchmarks.md.
const IDEA_LINKS: Record<string, string[]> = {
  inputs: ['learn/caching/', 'learn/correctness/', 'learn/labs/'],
  seams: ['learn/architecture/', 'learn/extending/'],
  speed: ['concepts/why-vx-is-fast/', 'benchmarks/'],
}

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
// Links removed on purpose, each with the reason. None so far: the cards the
// idea sections replaced linked pages the page still links elsewhere.
const REMOVED: Record<string, string> = {}

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

  it('states the problem in the h1, then the three ideas, then the numbers', () => {
    const h1 = [...html.matchAll(/<h1\b/g)]
    expect(h1).toHaveLength(1)
    const ids = [...html.matchAll(/<section\b[^>]*\bid="([\w-]+)"/g)]
    expect(ids.map((m) => m[1])).toEqual(SECTIONS)
    expect(h1[0]!.index!).toBeLessThan(ids[0]!.index!)
  })

  it('sends the first actions to Learn, then the playground, then the quickstart', () => {
    const h1 = html.indexOf('<h1')
    const hero = html.slice(h1, html.indexOf('<section', h1))
    expect(hrefs(hero)).toEqual([
      `${BASE}learn/what-is-task-orchestration/`,
      `${BASE}learn/playground/`,
      `${BASE}quickstart/`,
    ])
  })

  it('links each idea to its pages, and every one lands on a built page', () => {
    const wrong: string[] = []
    for (const [id, links] of Object.entries(IDEA_LINKS)) {
      const on = hrefs(section(html, id))
      for (const l of links) {
        if (!on.includes(`${BASE}${l}`)) wrong.push(`${id}: no link to ${l}`)
        const miss = resolves(l)
        if (miss !== undefined) wrong.push(`${id}: ${miss}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it("links idea 1's guarantee to the core test row that holds it", () => {
    const tests = [...section(html, 'inputs').matchAll(/<a\b[^>]*\shref="([^"]+)"[^>]*>([^<]+)</g)]
      .filter((m) => m[1]!.startsWith(GH_BLOB))
      .map((m) => ({ file: m[1]!.slice(GH_BLOB.length), row: text(m[2]!) }))
    expect(tests).toHaveLength(1)
    const { file, row } = tests[0]!
    expect(file.startsWith('packages/vx/tests/')).toBe(true)
    const source = path.join(REPO, file)
    expect(existsSync(source)).toBe(true)
    expect(readFileSync(source, 'utf8')).toContain(`'${row}'`)
  })

  it('draws each idea as a static figure, with no script in any idea section', () => {
    for (const id of Object.keys(IDEA_LINKS)) {
      const body = section(html, id)
      const svgs = [...body.matchAll(/<svg\b([^>]*)>/g)].map((m) => m[1]!)
      expect(svgs).toHaveLength(1)
      expect(svgs[0]).toMatch(/\srole="img"/)
      expect(svgs[0]).toMatch(/\saria-label="[^"]{40,}"/)
      expect(body).not.toMatch(/<script\b|\son[a-z]+=/)
    }
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
    expect(text(section(html, 'why'))).toContain(
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
    const term = html.slice(html.indexOf('<div class="term">'), html.indexOf('id="inputs"'))
    expect(text(term)).toContain('zsh — vx · sample output')
    expect(text(term)).toContain(`─ vx ${version} `)
  })
})
