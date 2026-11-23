// What a screen reader walks on every page the build ships: headings that
// step down one level at a time (a blog tag page went h1 to h3, the DTE
// plugin page h1 to h3), table headers that say what their column holds,
// and no logo alt read twice beside the title text it repeats. Lighthouse
// and axe flagged each on 2026-11-23.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const DIST = path.resolve(import.meta.dir, '../dist')

function pages(): Array<{ page: string; html: string }> {
  const out: Array<{ page: string; html: string }> = []
  for (const e of readdirSync(DIST, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || e.name !== 'index.html') continue
    const html = readFileSync(path.join(e.parentPath, e.name), 'utf8')
    if (html.includes('http-equiv="refresh"')) continue
    out.push({ page: path.relative(DIST, e.parentPath), html })
  }
  return out
}

function skips(html: string): string[] {
  const main = html.split('<main')[1]
  if (main === undefined) return []
  const out: string[] = []
  let prev = 1
  for (const m of main.matchAll(/<h([1-6])(?:\s[^>]*)?>/g)) {
    const level = Number(m[1])
    if (level > prev + 1) out.push(`h${prev} -> h${level}`)
    prev = level
  }
  return out
}

describe('every page the site ships', () => {
  if (!existsSync(DIST)) throw new Error(`${DIST} is missing: run the site's build task first`)
  const all = pages()

  it('finds the pages and reads their headings', () => {
    expect(all.length).toBeGreaterThan(300)
    expect(skips('<main><h1>a</h1><h2>b</h2><h4 id="c">c</h4><h2>d</h2></main>')).toEqual([
      'h2 -> h4',
    ])
  })

  it('never skips a heading level', () => {
    const bad = all.flatMap(({ page, html }) => skips(html).map((s) => `${page}: ${s}`))
    expect(bad).toEqual([])
  })

  it('gives every table header text', () => {
    const bad = all.filter(({ html }) => /<th(?:\s[^>]*)?>\s*<\/th>/.test(html)).map((p) => p.page)
    expect(bad).toEqual([])
  })

  it('leaves the logo beside the title text unread', () => {
    const bad = all
      .filter(({ html }) => /<a [^>]*class="site-title[^>]*><img [^>]*alt="[^"]+"/.test(html))
      .map((p) => p.page)
    expect(bad).toEqual([])
  })
})
