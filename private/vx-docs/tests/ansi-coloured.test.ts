// Every ` ```ansi ` block on the site shows vx's colours (2026-10-26: never
// plain white terminal output). A block pasted from a NO_COLOR run renders
// white; dev-servers-in-the-graph.md and the 0.0.657 notes shipped that way.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'bun:test'

const CONTENT = path.resolve(import.meta.dir, '../src/content/docs')

test('every ansi block carries a colour escape', () => {
  const plain: string[] = []
  for (const f of readdirSync(CONTENT, { recursive: true, encoding: 'utf8' })) {
    if (!/\.mdx?$/.test(f)) continue
    const page = readFileSync(path.join(CONTENT, f), 'utf8')
    for (const m of page.matchAll(/```ansi[^\n]*\n([\s\S]*?)```/g)) {
      if (!m[1]!.includes('\x1b[')) plain.push(`${f}: ${m[1]!.split('\n')[0]}`)
    }
  }
  expect(plain).toEqual([])
})
