// The docs guide's checkable rules (org/docs-site/docs-research.md, owner
// 2026-10-26): no prose paragraph longer than five lines on a phone (200
// characters), no plain white output block ("I don't wanna see ever a plain
// white output"), and none of the internal words. Read from the sources,
// where the author writes them.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const CONTENT = path.resolve(import.meta.dir, '../src/content/docs')
const MAX_PARAGRAPH = 200
const BANNED =
  /not on npm|coming soon|bun link|from a checkout|\bcurrently\b|distributed runs?\b|\bseams?\b|\bsimply\b|\bjust\b|\beasily\b|\bpowerful\b|\bseamless\b|\bnpx\b|npm run|pnpm run|\blet's\b/i
const PLAIN_FENCE = /^\s*(```|~~~)\s*(text|txt|plain|plaintext)?(\s|$)/

// Pages these rules reach. Each place joins once its pages pass.
const ROOTS = ['docs', 'guides', 'quickstart.mdx']
// Still to come: the generated upgrading guide quotes commit footers, and
// the server pages wait on the ALLOW change.
const LATER = new Set([
  'guides/upgrading.md',
  'docs/remote-cache.mdx',
  'docs/servers/index.mdx',
  'docs/servers/cache.mdx',
  'docs/servers/history.mdx',
  'docs/servers/dte.mdx',
])
// Output vx prints with no colour yet: the sample turns `ansi` with it.
const UNCOLOURED = new Set([
  'docs/running-tasks.mdx',
  'docs/distributed-task-execution.mdx',
  'guides/troubleshooting.mdx',
  'guides/running/run-what-changed.md',
  'guides/running/run-one-project.md',
  'guides/migrate.mdx',
  'guides/caching/why-a-task-missed.md',
  'quickstart.mdx',
])

const pages = (rel: string): string[] => {
  const abs = path.join(CONTENT, rel)
  if (!statSync(abs).isDirectory()) return /\.mdx?$/.test(rel) ? [rel] : []
  return readdirSync(abs).flatMap((f) => pages(path.join(rel, f)))
}

function problems(rel: string): string[] {
  const out: string[] = []
  const lines = readFileSync(path.join(CONTENT, rel), 'utf8').split('\n')
  let front = lines[0] === '---'
  let fence = false
  let para: string[] = []
  let start = 0
  const flush = () => {
    const text = para.join(' ').trim()
    if (text.length > MAX_PARAGRAPH) out.push(`${rel}:${start} paragraph of ${text.length}`)
    para = []
  }
  lines.forEach((line, i) => {
    if (front) {
      if (i > 0 && line === '---') front = false
      return
    }
    if (/^\s*(```|~~~)/.test(line)) {
      if (!fence && !UNCOLOURED.has(rel) && PLAIN_FENCE.test(line))
        out.push(`${rel}:${i + 1} plain fence`)
      fence = !fence
      flush()
      return
    }
    if (fence) return
    const banned = BANNED.exec(line)
    if (banned) out.push(`${rel}:${i + 1} "${banned[0]}"`)
    const prose = line.trim() && !/^\s*([#|<>\-*+:]|\d+\.|import |export |\{)/.test(line)
    if (!prose) return flush()
    if (!para.length) start = i + 1
    para.push(line.trim())
  })
  flush()
  return out
}

describe('every page reads on a phone', () => {
  const all = ROOTS.flatMap(pages)

  it('walks the pages', () => {
    expect(all.length).toBeGreaterThan(20)
    for (const rel of [...LATER, ...UNCOLOURED]) expect(all).toContain(rel)
  })

  it('keeps paragraphs short, output coloured, and internal words out', () => {
    expect(all.filter((rel) => !LATER.has(rel)).flatMap(problems)).toEqual([])
  })

  // CONTROL: the check sees a long paragraph and a plain fence.
  it('catches what it is for', () => {
    expect(problems('guides/upgrading.md').length).toBeGreaterThan(0)
  })
})
