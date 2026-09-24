// The site's three places and two sidebars (design/site-short-2026-09.md §
// The shape), read from the built HTML: what a reader sees, not what the
// config says. The Docs' sidebar is the six pages, then the playground; the Reference ends
// with the one way into the internals. Every page shows exactly one of the
// two (the blog keeps its own), and no sidebar links an internals page. The
// Guide is gone: no page shows a sidebar of its own.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const DIST = path.resolve(import.meta.dir, '../dist')
const BASE = (process.env['BASE_PATH'] ?? '/vx').replace(/\/?$/, '/')

// Written by hand from the design, not read from src/nav/sections.ts.
const PLACES: [string, string][] = [
  ['Docs', 'quickstart/'],
  ['Reference', 'cli/'],
  ['Blog', 'blog/'],
]
// The Docs are six pages, no groups (design/site-short-2026-09.md).
const DOCS_PAGES: [string, string][] = [
  ['Quickstart', 'quickstart/'],
  ['Configure', 'guides/configure/'],
  ['Sandboxing', 'guides/sandboxing/'],
  ['CI and remote', 'guides/ci/'],
  ['Migrate', 'guides/migrate/'],
  ['Plugins', 'guides/plugins/'],
]
const REFERENCE_GROUPS = ['CLI', 'Config', 'Benchmarks', 'Compare']
const INTERNALS_TOP = ['overview/', 'architecture/', 'optimizations/', 'patterns/', 'flows/']
const INTERNALS_DIRS = ['modules/', 'design/']

function isInternals(rel: string): boolean {
  return INTERNALS_TOP.includes(rel) || INTERNALS_DIRS.some((d) => rel.startsWith(d))
}

function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .trim()
}

/** Every built page, as its path under the base (`cli/`); not the
 *  redirect pages astro writes for a moved URL, which carry no chrome. */
function pages(): string[] {
  return readdirSync(DIST, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('index.html'))
    .filter((f) => !/<meta http-equiv="refresh"/.test(readFileSync(path.join(DIST, f), 'utf8')))
    .map((f) =>
      f
        .split(path.sep)
        .join('/')
        .replace(/index\.html$/, ''),
    )
    .sort()
}

function html(rel: string): string {
  return readFileSync(path.join(DIST, rel, 'index.html'), 'utf8')
}

/** The sidebar's list (Starlight's `ul.top-level`), balanced; undefined when the page has none. */
function sidebarList(page: string): string | undefined {
  const start = page.search(/<ul class="top-level[ "]/)
  if (start < 0) return undefined
  const tags = /<(\/?)ul\b/g
  tags.lastIndex = start
  let depth = 0
  for (let m = tags.exec(page); m !== null; m = tags.exec(page)) {
    depth += m[1] === '/' ? -1 : 1
    if (depth === 0) return page.slice(start, m.index + '</ul>'.length)
  }
  throw new Error('unbalanced sidebar list')
}

/** The sidebar's links, as [label, path under the base]. */
function sidebarLinks(list: string): [string, string][] {
  return [...list.matchAll(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [
    text(m[2]!),
    m[1]!.startsWith(BASE) ? m[1]!.slice(BASE.length) : m[1]!,
  ])
}

/** The sidebar's group labels, in order. */
function groupLabels(list: string): string[] {
  return [...list.matchAll(/<span class="group-label[^"]*">([\s\S]*?)<\/span><\/span>/g)].map((m) =>
    text(m[1]!),
  )
}

/** The header's places, and which one the page marks current. */
function places(page: string): { links: string[][]; current: string[] } {
  const nav = /<nav class="vx-places[ "][^>]*>([\s\S]*?)<\/nav>/.exec(page)
  if (nav === null) return { links: [], current: [] }
  const as = [...nav[1]!.matchAll(/<a href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g)]
  return {
    links: as.map((m) => [text(m[3]!), m[1]!.slice(BASE.length)]),
    current: as.filter((m) => m[2]!.includes('aria-current="true"')).map((m) => text(m[3]!)),
  }
}

describe('the sidebars', () => {
  const all = pages()
  const docs = sidebarList(html('quickstart/'))!
  const reference = sidebarList(html('cli/'))!

  it('the Docs are the design’s six pages, then the playground', () => {
    expect(groupLabels(docs)).toEqual([])
    expect(sidebarLinks(docs)).toEqual([...DOCS_PAGES, ['Try it', 'playground/']])
  })

  it('the Reference is the four groups, and ends with the internals index, which links every internals page', () => {
    expect(groupLabels(reference)).toEqual(REFERENCE_GROUPS)
    const links = sidebarLinks(reference)
    expect(links.at(-1)).toEqual(['Internals (for contributors)', 'internals/'])
    expect(links.map(([, href]) => href)).toContain('cli/')
    const index = html('internals/')
    const linked = [...index.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]!)
    for (const p of [...INTERNALS_TOP, ...INTERNALS_DIRS]) {
      expect(linked).toContain(`../${p}`)
    }
  })

  it('the two share no page', () => {
    const sets = [docs, reference].map((l) => sidebarLinks(l).map(([, h]) => h))
    const seen = sets.flat()
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('every page shows exactly one of the two, the one its section owns', () => {
    const lists = { Docs: docs, Reference: reference }
    const wrong: string[] = []
    for (const rel of all) {
      if (rel === '' || rel.startsWith('blog/')) continue
      const page = html(rel)
      const list = sidebarList(page)
      if (list === undefined) continue
      const hrefs = JSON.stringify(sidebarLinks(list).map(([, h]) => h))
      const match = Object.entries(lists).filter(
        ([, l]) => JSON.stringify(sidebarLinks(l).map(([, h]) => h)) === hrefs,
      )
      const current = places(page).current
      if (match.length !== 1) wrong.push(`${rel}: a sidebar that is none of the two`)
      else if (current.length !== 1 || current[0] !== match[0]![0]) {
        wrong.push(`${rel}: shows the ${match[0]![0]} sidebar, marks ${JSON.stringify(current)}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('puts a Docs page, a Reference page and a post each in its own section', () => {
    expect(places(html('guides/configure/')).current).toEqual(['Docs'])
    expect(places(html('playground/')).current).toEqual(['Docs'])
    expect(places(html('caching/')).current).toEqual(['Reference'])
    expect(places(html('modules/')).current).toEqual(['Reference'])
    expect(places(html('blog/')).current).toEqual(['Blog'])
  })

  it('no sidebar, on any page, links an internals page', () => {
    const wrong: string[] = []
    for (const rel of all) {
      const list = sidebarList(html(rel))
      if (list === undefined) continue
      for (const [, href] of sidebarLinks(list)) {
        if (isInternals(href)) wrong.push(`${rel}: ${href}`)
      }
    }
    expect(wrong).toEqual([])
  })

  // The control for the row above: an internals page exists at each named
  // path, so "no sidebar links one" is not true of an empty set.
  it('builds every internals page it keeps out of the sidebars', () => {
    const missing = INTERNALS_TOP.filter((p) => !all.includes(p))
    expect(missing).toEqual([])
    for (const d of INTERNALS_DIRS)
      expect(all.filter((p) => p.startsWith(d)).length).toBeGreaterThan(1)
  })
})

describe('the header', () => {
  it('names the three places, in order, on every docs page', () => {
    const wrong: string[] = []
    for (const rel of pages()) {
      if (rel === '') continue
      const got = places(html(rel)).links
      if (JSON.stringify(got) !== JSON.stringify(PLACES))
        wrong.push(`${rel}: ${JSON.stringify(got)}`)
    }
    expect(wrong).toEqual([])
  })

  it('and the landing names the same three', () => {
    const nav = /<nav class="nav-links[^"]*">([\s\S]*?)<\/nav>/.exec(html(''))![1]!
    const got = [...nav.matchAll(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [
      text(m[2]!),
      m[1]!.slice(BASE.length),
    ])
    expect(got).toEqual(PLACES.map(([l, h]) => [l.toLowerCase(), h]))
  })
})
