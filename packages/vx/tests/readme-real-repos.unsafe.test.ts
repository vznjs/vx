// The README's "Tried on real repos" table (and the site page generated
// beside it from packages/vx-bench/real-repos.json) quotes benchmarks.md,
// and a re-measure that changes a number there must change the data too. Each
// cell is "vx / theirs"; both must sit on one row of a benchmarks.md
// table, which is how every real-repo result is recorded. The README is
// the repo root's, hence the unsafe suite.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const ROOT = path.resolve(import.meta.dir, '..', '..', '..')
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
const bench = readFileSync(path.join(ROOT, 'packages/vx/docs/benchmarks.md'), 'utf8').split('\n')

const section = readme.slice(
  readme.indexOf('## Tried on real repos'),
  readme.indexOf('## How it compares'),
)
const rows = section.split('\n').filter((l) => l.startsWith('| ['))

describe("the README's real-repo table", () => {
  it('lists the thirteen benched repos', () => {
    expect(rows.map((r) => /\[([^\]]+)\]/.exec(r)![1])).toEqual([
      'solidjs/solid',
      'withastro/astro',
      'payloadcms/payload',
      'medusajs/medusa',
      'n8n-io/n8n',
      'calcom/cal.com',
      'unocss/unocss',
      'vueuse/vueuse',
      'TanStack/query',
      'strapi/strapi',
      'novuhq/novu',
      'TanStack/router',
      'refinedev/refine',
    ])
  })

  it('quotes each vx / theirs pair from one benchmarks.md row', () => {
    const missing: string[] = []
    for (const row of rows) {
      const cells = row.split('|').slice(3, 6)
      for (const cell of cells) {
        const [ours, theirs] = cell
          .replace(/\*\*/g, '')
          .split(' / ')
          .map((t) => t.trim())
        const found = bench.some(
          (l) => l.startsWith('|') && l.includes(`${ours}`) && l.includes(`${theirs}`),
        )
        if (!found) missing.push(`${row.slice(0, 30)}…: ${ours} / ${theirs}`)
      }
    }
    expect(rows.length * 3).toBe(39)
    expect(missing).toEqual([])
  })
})
