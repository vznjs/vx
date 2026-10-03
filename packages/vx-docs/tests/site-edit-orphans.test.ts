// Every page of the built site has an "Edit page" link that names a file the
// repo has, and no page is an orphan: another page links to it. A page's
// route is reachable from the sidebar, an index or a post, never only by URL.
// Left out: redirect stubs (a meta refresh), the landing and 404, and the
// blog's generated listings (tags, authors, pages), which have no source.
//
// An edit link under packages/vx-docs/ must name a file of this project; one
// under packages/vx/docs/ is an imported page, whose generated copy carries
// the same `editUrl` (scripts/import-docs.ts). This project's sandbox reads
// only itself, so the copy stands in for the source it was made from.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const SITE = path.resolve(import.meta.dir, '..')
const DIST = path.join(SITE, 'dist')
const CONTENT = path.join(SITE, 'src/content/docs')
// astro.config.mjs reads the same variable with the same default.
const BASE = (process.env['BASE_PATH'] ?? '/vx').replace(/\/?$/, '/')
const EDIT = 'https://github.com/vznjs/vx/edit/main/'

const route = (f: string): string => BASE + f.replace(/index\.html$/, '').replace(/\.html$/, '')

function built(): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of readdirSync(DIST, { recursive: true, encoding: 'utf8' }))
    if (f.endsWith('.html')) out.set(f, readFileSync(path.join(DIST, f), 'utf8'))
  return out
}

const skipped = (f: string, html: string): boolean =>
  /http-equiv="refresh"/.test(html) ||
  f === '404.html' ||
  f === 'index.html' ||
  /^blog\/(?:tags|authors|\d+)\/|^blog\/index\.html$/.test(f)

it('every page has an edit link to a real file, and another page links to it', () => {
  const pages = built()
  const inbound = new Set<string>()
  for (const [f, html] of pages)
    for (const m of html.matchAll(/href="([^"#?]*)/g)) {
      const href = m[1]!
      if (/^[a-z]+:/.test(href)) continue
      const to = href.startsWith('/') ? href : new URL(href, `https://x${route(f)}`).pathname
      if (to !== route(f)) inbound.add(to)
    }
  const imported = new Set<string>()
  for (const f of readdirSync(CONTENT, { recursive: true, encoding: 'utf8' }))
    if (/\.mdx?$/.test(f)) {
      const url = /^editUrl: "?([^"\n]+)"?$/m.exec(readFileSync(path.join(CONTENT, f), 'utf8'))
      if (url) imported.add(url[1]!)
    }

  const wrong: string[] = []
  let checked = 0
  for (const [f, html] of pages) {
    if (skipped(f, html)) continue
    checked++
    const edit = new RegExp(`href="${EDIT.replace(/[./]/g, '\\$&')}([^"]+)"`).exec(html)?.[1]
    if (edit === undefined) wrong.push(`${f}: no edit link`)
    else if (edit.startsWith('packages/vx-docs/')) {
      if (!existsSync(path.join(SITE, edit.slice('packages/vx-docs/'.length))))
        wrong.push(`${f}: edit link names a missing ${edit}`)
    } else if (!imported.has(EDIT + edit))
      wrong.push(`${f}: edit link names ${edit}, no page's source`)
    if (!inbound.has(route(f))) wrong.push(`${f}: no page links to ${route(f)}`)
  }
  expect(checked).toBeGreaterThan(150)
  expect(wrong).toEqual([])
})
