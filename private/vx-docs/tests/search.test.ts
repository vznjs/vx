// Search finds the docs before the release notes that announce them
// (src/plugins/release-search.ts): every note is in its own index, merged at
// a tenth of the weight, and none is in the site's. The conformance page's
// case rows stay out too: two thousand of them outranked every docs page.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const DIST = path.resolve(import.meta.dir, '../dist')
const read = (p: string): string => readFileSync(path.join(DIST, p), 'utf8')
const pages = (bundle: string): number =>
  (
    JSON.parse(read(`${bundle}/pagefind-entry.json`)) as {
      languages: { en: { page_count: number } }
    }
  ).languages.en.page_count

const NOTES = readdirSync(path.join(DIST, 'releases')).filter((d) => /^vx-[\d-]+$/.test(d))

describe('search', () => {
  it('indexes every release note apart, and none in the site’s index', () => {
    expect(NOTES.length).toBeGreaterThan(20)
    expect(pages('pagefind-releases')).toBe(NOTES.length)
    const inMain = NOTES.filter((n) =>
      read(`releases/${n}/index.html`).includes('data-pagefind-body'),
    )
    expect(inMain).toEqual([])
    // A docs page still is.
    expect(read('guides/running/stop-at-the-first-failure/index.html')).toContain(
      'data-pagefind-body',
    )
  })

  it('merges the notes into every search at a tenth of the weight', () => {
    const scripts = readdirSync(path.join(DIST, '_astro')).filter((f) => f.endsWith('.js'))
    const search = scripts
      .map((f) => read(`_astro/${f}`))
      .find((s) => s.includes('pagefind-releases'))
    expect(search).toMatch(/mergeIndex:\[\{indexWeight:\.1\b/)
  })

  it('leaves the conformance page’s case rows out of search', () => {
    const html = readdirSync(path.join(DIST, 'conformance'))
      .filter((d) => !d.includes('.'))
      .map((d) => read(`conformance/${d}/index.html`))
      .join('\n')
    const tables = [...html.matchAll(/<table class="cfm-cases"[^>]*>/g)].map((m) => m[0])
    expect(tables.length).toBeGreaterThan(5)
    expect(tables.filter((t) => !t.includes('data-pagefind-ignore'))).toEqual([])
  })
})
