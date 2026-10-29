// docs/benchmarks.md's tables print each tool's figure only (owner,
// 2026-10-12: never say how much faster vx is; the numbers speak).
// The head-to-head's cells are tokens filled from the measured data; the
// dated tables are held here, so no `(vx N× faster)` aside comes back.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const BENCH = readFileSync(path.resolve(import.meta.dir, '..', 'docs', 'benchmarks.md'), 'utf8')

describe('benchmarks.md quotes no vx multiple', () => {
  it('no table cell says how much faster or slower vx is', () => {
    const rows = BENCH.split('\n').filter((l) => l.startsWith('|'))
    expect(rows.length).toBeGreaterThan(0)
    expect(
      rows.filter((l) => /\(vx (?:[\d.]+×|\d+%) (?:faster|slower)\)|\bvx is\b/.test(l)),
    ).toEqual([])
  })
})
