// Every link inside the built site lands (item 711): each `href` and `src` in
// every page of `dist/`, and every URL under the base in its feeds and
// sitemaps, names a built file, and a `#fragment` names an id on that page.
// The per-page link rows (landing, choosing, …) say which links a page must
// carry; this one says that none of them, on any page, is dead.
//
// What it does not check, and why:
// - An external link is not fetched: the row would test the network, and the
//   gate runs in a sandbox with none.
// - Search's index (`pagefind/`) is not parsed: its fragments are compressed
//   records Pagefind builds from these same pages. The one file the search
//   box loads by a path no attribute names, `pagefind.js`, is checked below.
// - The 404 page's canonical link names the route `404/`, and the build
//   writes `404.html`, which the host serves for every missing path; that
//   one link is excused (EXCUSED), and the excuse fails once it is unused.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const DIST = path.resolve(import.meta.dir, '../dist')
// astro.config.mjs reads the same two variables with the same defaults.
const BASE = (process.env['BASE_PATH'] ?? '/vx').replace(/\/?$/, '/')
const SITE = new URL(BASE, process.env['SITE_URL'] ?? 'https://vznjs.github.io').href

const EXCUSED: Record<string, Record<string, string>> = {
  '404.html': { [`${SITE}404/`]: "Starlight's canonical for the 404 route, built as 404.html" },
}

function unescape(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Every built page, as a path under `dist/`. */
function pages(): string[] {
  if (!existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(`${DIST} has no index.html: run the site's build task first`)
  }
  return readdirSync(DIST, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.html'))
    .map((f) => f.split(path.sep).join('/'))
    .sort()
}

/** The URL a page is served at, which its relative links resolve against. */
function urlOf(page: string): string {
  return `${SITE}${page.replace(/(^|\/)index\.html$/, '$1')}`
}

const idCache = new Map<string, Set<string>>()
function idsOf(file: string): Set<string> {
  let ids = idCache.get(file)
  if (ids === undefined) {
    const html = readFileSync(file, 'utf8')
    ids = new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((m) => unescape(m[1]!)))
    idCache.set(file, ids)
  }
  return ids
}

/** Why `link`, as written on `page`, does not land; undefined when it does. */
function miss(page: string, link: string): string | undefined {
  if (link.startsWith('//')) return undefined
  const scheme = /^[a-z][a-z0-9+.-]*:/i.test(link)
  // The 404 page is served at whatever path was missing, so a relative link
  // on it resolves against a URL nobody can predict.
  if (page === '404.html' && !scheme && !link.startsWith('/') && !link.startsWith('#')) {
    return 'relative link on the 404 page'
  }
  const url = new URL(link, urlOf(page))
  if (scheme && !url.href.startsWith(SITE)) return undefined
  if (!`${url.origin}${url.pathname}`.startsWith(SITE)) return 'outside the base path'
  const rel = decodeURIComponent(url.pathname.slice(new URL(SITE).pathname.length))
  const file = path.join(DIST, rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel)
  if (statSync(file, { throwIfNoEntry: false })?.isFile() !== true) return 'no such file'
  const anchor = decodeURIComponent(url.hash.slice(1))
  if (anchor !== '' && file.endsWith('.html') && !idsOf(file).has(anchor)) return 'no such id'
  return undefined
}

/** Every link on a page that does not land, as `page: link (why)`. */
function broken(page: string, html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
    const link = unescape(m[1]!)
    if (EXCUSED[page]?.[link] !== undefined) continue
    const why = miss(page, link)
    if (why !== undefined) out.push(`${page}: ${link} (${why})`)
  }
  return out
}

/** The absolute URLs a feed or sitemap names. */
function xmlUrls(xml: string): string[] {
  return [...xml.matchAll(/<(?:loc|link)>([^<]*)<\/|\shref="([^"]*)"/g)].map((m) =>
    unescape(m[1] ?? m[2]!),
  )
}

describe('every internal link in the built site', () => {
  const all = pages()

  it('lands on a built file, and on an id when it names one', () => {
    const dead = all.flatMap((p) => broken(p, readFileSync(path.join(DIST, p), 'utf8')))
    expect(dead).toEqual([])
  })

  it('uses every excuse it makes', () => {
    const used = Object.entries(EXCUSED).flatMap(([page, links]) => {
      const html = readFileSync(path.join(DIST, page), 'utf8')
      return Object.keys(links).filter((l) => html.includes(`="${l}"`))
    })
    expect(used).toEqual(Object.values(EXCUSED).flatMap((l) => Object.keys(l)))
  })

  // A redirect page (astro.config.mjs `redirects`) is built but is no page
  // of the site's own, so the sitemap leaves it out; its one link is still
  // checked above, which is what makes a redirect to nowhere fail.
  it('scans exactly the pages the sitemap lists, the 404 page and the redirects', () => {
    const xml = readdirSync(DIST).filter((f) => /^sitemap-\d+\.xml$/.test(f))
    expect(xml.length).toBeGreaterThan(0)
    const listed = xml
      .flatMap((f) => [...readFileSync(path.join(DIST, f), 'utf8').matchAll(/<loc>([^<]*)</g)])
      .map((m) => {
        const rel = unescape(m[1]!).slice(SITE.length)
        return rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel
      })
    const redirects = all.filter((p) =>
      /<meta http-equiv="refresh"/.test(readFileSync(path.join(DIST, p), 'utf8')),
    )
    expect(redirects.length).toBeGreaterThan(0)
    expect(all).toEqual([...listed, '404.html', ...redirects].sort())
  })

  it('names only built files in its feeds and sitemaps', () => {
    const feeds = readdirSync(DIST, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.xml'))
      .map((f) => f.split(path.sep).join('/'))
      .sort()
    expect(feeds).toEqual(['blog/rss.xml', 'sitemap-0.xml', 'sitemap-index.xml'])
    const dead = feeds.flatMap((f) =>
      xmlUrls(readFileSync(path.join(DIST, f), 'utf8'))
        .filter((u) => u.startsWith(SITE))
        .flatMap((u) => {
          const why = miss(f, u)
          return why === undefined ? [] : [`${f}: ${u} (${why})`]
        }),
    )
    expect(dead).toEqual([])
  })

  it("ships the search script's bundle, which no attribute names", () => {
    expect(statSync(path.join(DIST, 'pagefind/pagefind.js')).isFile()).toBe(true)
  })

  // `modules/README.md` and `modules/index.md` both wrote the collection's
  // `modules/index.md`, and the directory scan's order chose the page the
  // site kept: this machine kept `src/index.ts`'s page, CI kept the module
  // index, whose link to the other one was then dead. import-docs.ts now
  // refuses two sources on one output; this row holds that both pages ship.
  it('ships the module index and the src/index.ts page, each at its own URL', () => {
    const title = (page: string): string | undefined =>
      /<title>([^<|]*?)\s*\|/.exec(readFileSync(path.join(DIST, page), 'utf8'))?.[1]
    expect([title('modules/index.html'), title('modules/public-surface/index.html')]).toEqual([
      'Module reference',
      'src/index.ts — public package surface',
    ])
  })

  it('reports each kind of dead link, and passes the ones that land', () => {
    const fixture = `
      <a href="${BASE}learn/caching/">page</a>
      <a href="${BASE}learn/caching/#the-cascade">anchor</a>
      <a href="../caching/#_top">relative</a>
      <a href="#_top">same page</a>
      <a href="${SITE}learn/caching/">absolute</a>
      <a href="https://example.com/nowhere/">external</a>
      <img src="${BASE}favicon.svg">
      <a href="${BASE}learn/no-such-page/">gone</a>
      <a href="${BASE}learn/caching/#no-such-heading">bad anchor</a>
      <a href="${BASE}learn/caching">no slash</a>
      <a href="../no-such/">bad relative</a>
      <a href="/elsewhere/">outside</a>
      <a href="${SITE}learn/gone/">bad absolute</a>
    `
    expect(broken('learn/labs/index.html', fixture)).toEqual([
      `learn/labs/index.html: ${BASE}learn/no-such-page/ (no such file)`,
      `learn/labs/index.html: ${BASE}learn/caching/#no-such-heading (no such id)`,
      `learn/labs/index.html: ${BASE}learn/caching (no such file)`,
      'learn/labs/index.html: ../no-such/ (no such file)',
      'learn/labs/index.html: /elsewhere/ (outside the base path)',
      `learn/labs/index.html: ${SITE}learn/gone/ (no such file)`,
    ])
    expect(broken('404.html', '<a href="learn/">relative</a>')).toEqual([
      '404.html: learn/ (relative link on the 404 page)',
    ])
  })
})
