// The site's places and three sidebars (design/site-short-2026-09.md §
// The shape; Features, standalone pages, and Guides, as Bun's docs have
// them, came after), read from the built HTML: what a reader sees, not what
// the config says. The Docs' sidebar is its pages; the
// Guides' is the index, then one group per area; the Reference ends with the
// glossary. Every page shows exactly one of the three (the blog keeps its
// own), and no sidebar links an internals page.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const DIST = path.resolve(import.meta.dir, '../dist')
const BASE = (process.env['BASE_PATH'] ?? '/vx').replace(/\/?$/, '/')

// Written by hand from the design, not read from src/nav/sections.ts.
const PLACES: [string, string][] = [
  ['Features', 'features/'],
  ['Docs', 'docs/'],
  ['Guides', 'guides/'],
  ['Reference', 'cli/'],
  ['Blog', 'blog/'],
  ['Releases', 'releases/'],
]
// The Docs are one page per feature, in groups by area.
const DOCS_PAGES: [string, string][] = [
  ['What is vx?', 'docs/'],
  ['Quickstart', 'quickstart/'],
  ['Upgrading to 1.0', 'guides/upgrading/'],
  ['Workspace', 'docs/workspace/'],
  ['Tasks', 'docs/tasks/'],
  ['Caching', 'docs/caching/'],
  ['Environment variables', 'docs/environment-variables/'],
  ['Dev servers', 'docs/dev-servers/'],
  ['Lockfiles', 'docs/lockfiles/'],
  ['Running tasks', 'docs/running-tasks/'],
  ['Sandboxing', 'docs/sandboxing/'],
  ['CI', 'docs/ci/'],
  ['Distributed runs', 'docs/distributed-runs/'],
  ['Remote cache', 'docs/remote-cache/'],
  ['Remote execution', 'docs/remote-execution/'],
  ['Servers', 'docs/servers/'],
  ['Cache server', 'docs/servers/cache/'],
  ['History server', 'docs/servers/history/'],
  ['DTE server', 'docs/servers/dte/'],
  ['Plugins', 'docs/plugins/'],
  ['Write a plugin', 'docs/writing-plugins/'],
  ['AI agents', 'docs/agents/'],
]
const DOCS_GROUPS = ['Get started', 'Configure', 'Run', 'Servers', 'Extend']
const GUIDES_GROUPS = ['Get started', 'Caching', 'Running', 'CI', 'Debugging']
const REFERENCE_GROUPS = ['CLI', 'Config', 'Benchmarks', 'Compare', 'Plugins', 'Protocols']
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
  const guides = sidebarList(html('guides/'))!
  const reference = sidebarList(html('cli/'))!

  it('the Docs are their pages, in groups', () => {
    expect(groupLabels(docs)).toEqual(DOCS_GROUPS)
    expect(sidebarLinks(docs)).toEqual(DOCS_PAGES)
  })

  // The index lists every guide the sidebar does, so neither drifts.
  it('the Guides are the index, then one group per area, each a guide the index lists', () => {
    expect(groupLabels(guides)).toEqual(GUIDES_GROUPS)
    const links = sidebarLinks(guides)
    expect(links[0]).toEqual(['All guides', 'guides/'])
    const page = html('guides/')
    const index = page.slice(page.indexOf('sl-markdown-content'), page.indexOf('<footer'))
    const listed = [...index.matchAll(/<li><a href="([^"]*)"/g)]
      .map((m) => m[1]!)
      .map((h) => (h.startsWith(BASE) ? h.slice(BASE.length) : `guides/${h}`))
    expect(listed.sort()).toEqual(
      links
        .slice(1)
        .map(([, h]) => h)
        .sort(),
    )
  })

  // vx takes issues, not contributions (M, 2026-10-20): no contributor
  // index ends the Reference.
  it('the Reference is its groups, ending with the glossary', () => {
    expect(groupLabels(reference)).toEqual(REFERENCE_GROUPS)
    const links = sidebarLinks(reference)
    expect(links.at(-1)).toEqual(['Glossary', 'glossary/'])
    expect(links.map(([, href]) => href)).toContain('cli/')
  })

  it('the three share no page', () => {
    const sets = [docs, guides, reference].map((l) => sidebarLinks(l).map(([, h]) => h))
    const seen = sets.flat()
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('every page shows exactly one of the three, the one its section owns', () => {
    const lists = { Docs: docs, Guides: guides, Reference: reference }
    const wrong: string[] = []
    for (const rel of all) {
      if (rel === '' || /^(?:blog|releases)\//.test(rel)) continue
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

  it('puts a Docs page, a guide, a Reference page and a post each in its own section', () => {
    expect(places(html('docs/tasks/')).current).toEqual(['Docs'])
    expect(places(html('guides/migrate/')).current).toEqual(['Guides'])
    expect(places(html('guides/caching/why-a-task-missed/')).current).toEqual(['Guides'])
    expect(places(html('caching/')).current).toEqual(['Reference'])
    expect(places(html('modules/')).current).toEqual(['Reference'])
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
