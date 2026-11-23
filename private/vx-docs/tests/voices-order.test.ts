// The quote rows (M, 2026-11-23): two quotes from one person sit side by
// side only where the count leaves no other way.

import { describe, expect, it } from 'bun:test'
import { ALL_VOICES } from '../src/components/landing/voices.ts'

const half = Math.ceil(ALL_VOICES.length / 2)
const rows = [ALL_VOICES.slice(0, half), ALL_VOICES.slice(half)]

// Each row loops, so its last card meets its first.
const pairs = (row: typeof ALL_VOICES): number =>
  row.filter((v, i) => v.who === row[(i + 1) % row.length]!.who).length

describe('the quote rows', () => {
  it('keep one person’s quotes apart as far as the count allows', () => {
    const counts = new Map<string, number>()
    for (const v of ALL_VOICES) counts.set(v.who, (counts.get(v.who) ?? 0) + 1)
    const most = Math.max(...counts.values())
    const fewest = Math.max(0, most - (ALL_VOICES.length - most))
    expect(pairs(rows[0]!) + pairs(rows[1]!)).toBe(fewest)
  })
})
