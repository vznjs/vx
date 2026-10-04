// A post or guide that quotes a benchmark figure with vx's multiple quotes both
// from docs/benchmarks.md, whose 3,270-task table update-site.ts generates
// from results.json: a new run regenerates that table, and a hand-typed multiple
// beside an old figure would survive it. Each `<figure> (… vx N× faster)`
// must appear on the page as `<figure> (vx N× faster)`.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const DOCS = path.resolve(import.meta.dir, '../../vx-docs/src/content/docs')
const BENCH = readFileSync(path.resolve(import.meta.dir, '..', 'docs', 'benchmarks.md'), 'utf8')
const QUOTE =
  /(\d+m \d+s|\d+(?:\.\d+)?(?:ms|s))\s*\((?:\+[\d:]+, )?(vx [\d.]+× (?:faster|slower))\)/g

function pages(): string[] {
  const out: string[] = []
  for (const dir of ['blog', 'concepts', 'guides'])
    for (const f of readdirSync(path.join(DOCS, dir)))
      if (/\.mdx?$/.test(f)) out.push(path.join(DOCS, dir, f))
  return out
}

describe('every vx multiple a page quotes is the benchmarks page’s', () => {
  it('each figure and its multiple sit together on docs/benchmarks.md', () => {
    const wrong: string[] = []
    let checked = 0
    for (const file of pages()) {
      for (const m of readFileSync(file, 'utf8').matchAll(QUOTE)) {
        checked += 1
        if (!BENCH.includes(`${m[1]} (${m[2]})`))
          wrong.push(`${path.basename(file)}: ${m[1]} (${m[2]})`)
      }
    }
    // honest-benchmarks, why-vx-is-fast, no-daemon, from-nx, configure.
    expect(checked).toBeGreaterThanOrEqual(15)
    expect(wrong).toEqual([])
  })
})
