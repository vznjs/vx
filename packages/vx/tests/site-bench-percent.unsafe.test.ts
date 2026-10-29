// No post or guide quotes a benchmark figure with how much faster vx is
// (2026-10-12: never say how much faster vx is; the numbers speak).
// The site fills raw figures from the measured data; a hand-typed
// `(vx N× faster)` would bring the claim back.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const DOCS = path.resolve(import.meta.dir, '../../../private/vx-docs/src/content/docs')
const QUOTE = /\(vx (?:[\d.]+×|\d+%) (?:faster|slower)\)/g

function pages(): string[] {
  const out: string[] = []
  for (const dir of ['blog', 'concepts', 'guides'])
    for (const f of readdirSync(path.join(DOCS, dir)))
      if (/\.mdx?$/.test(f)) out.push(path.join(DOCS, dir, f))
  return out
}

describe('no page quotes a vx multiple', () => {
  it('blog, concepts and guides carry no (vx N× faster) aside', () => {
    const found: string[] = []
    for (const file of pages())
      for (const m of readFileSync(file, 'utf8').matchAll(QUOTE))
        found.push(`${path.basename(file)}: ${m[0]}`)
    expect(found).toEqual([])
  })
})
