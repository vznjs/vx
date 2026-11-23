// The site's places and its one Docs sidebar (M 2026-11-23: "merge guides
// and docs", "merge references into docs as well"), read from the built
// HTML: what a reader sees, not what the config says. The most important
// features come first; the reference ends with the glossary. Every page with
// a sidebar shows that one (the blog keeps its own), and no sidebar links an
// internals page.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const DIST = path.resolve(import.meta.dir, '../dist')
const BASE = (process.env['BASE_PATH'] ?? '/vx').replace(/\/?$/, '/')

// Written by hand from the design, not read from src/nav/sections.ts.
const PLACES: [string, string][] = [
  ['Docs', 'docs/'],
  ['Conformance', 'conformance/'],
  ['Blog', 'blog/'],
  ['Releases', 'releases/'],
]
// The path a new user walks (M 2026-11-23): start, define tasks, run them,
// cache them, CI, then distributed task execution; the reference groups
// close the list.
const DOCS_GROUPS = [
  'Get started',
  'Define tasks',
  'Run tasks',
  'Cache',
  'CI',
  'Distributed task execution',
  'Plugins',
  'Debugging',
  'CLI reference',
  'Config reference',
  'Benchmarks',
  'Compare',
  'Plugin reference',
  'Protocols',
]
const DOCS_FIRST: [string, string][] = [
  ['What is vx?', 'docs/'],
  ['Quickstart', 'quickstart/'],
  ['Migrate from Turbo, Nx or Vite Task', 'docs/migrate/'],
  ['AI agents', 'docs/agents/'],
  ['Upgrading vx', 'docs/upgrading/'],
  ['Workspace', 'docs/workspace/'],
  ['Tasks', 'docs/tasks/'],
]
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

describe('the sidebar', () => {
  const all = pages()
  const docs = sidebarList(html('quickstart/'))!

  it('is one Docs list along the path a new user walks, the reference last', () => {
    expect(groupLabels(docs)).toEqual(DOCS_GROUPS)
    const links = sidebarLinks(docs)
    expect(links.slice(0, DOCS_FIRST.length)).toEqual(DOCS_FIRST)
    expect(links.at(-1)).toEqual(['Glossary', 'glossary/'])
    const hrefs = links.map(([, h]) => h)
    for (const h of ['docs/caching/', 'docs/caching/why-a-task-missed/', 'cli/', 'schema/'])
      expect(hrefs).toContain(h)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it('every page with a sidebar shows the Docs one and marks Docs', () => {
    const want = JSON.stringify(sidebarLinks(docs).map(([, h]) => h))
    const wrong: string[] = []
    for (const rel of all) {
      if (rel === '' || /^(?:blog|releases)\//.test(rel)) continue
      const page = html(rel)
      const list = sidebarList(page)
      if (list === undefined) continue
      if (JSON.stringify(sidebarLinks(list).map(([, h]) => h)) !== want)
        wrong.push(`${rel}: another sidebar`)
      else if (JSON.stringify(places(page).current) !== '["Docs"]')
        wrong.push(`${rel}: marks ${JSON.stringify(places(page).current)}`)
    }
    expect(wrong).toEqual([])
  })

  it('puts a doc, a how-to, a reference page and a post each in its section', () => {
    expect(places(html('docs/tasks/')).current).toEqual(['Docs'])
    expect(places(html('docs/migrate/')).current).toEqual(['Docs'])
    expect(places(html('docs/caching/why-a-task-missed/')).current).toEqual(['Docs'])
    expect(places(html('caching/')).current).toEqual(['Docs'])
    expect(places(html('modules/')).current).toEqual(['Docs'])
    expect(places(html('blog/')).current).toEqual(['Blog'])
    expect(places(html('releases/')).current).toEqual(['Releases'])
    expect(places(html('releases/vx-0-0-625/')).current).toEqual(['Releases'])
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
  it('names the places, in order, on every page', () => {
    const wrong: string[] = []
    for (const rel of pages()) {
      const got = places(html(rel)).links
      if (JSON.stringify(got) !== JSON.stringify(PLACES))
        wrong.push(`${rel}: ${JSON.stringify(got)}`)
    }
    expect(wrong).toEqual([])
  })
})
