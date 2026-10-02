// The property tests' PRNG draws what it claims: no repeat within the
// draws a suite takes, and an even spread (C-79). The float LCG it
// replaced cycled after 71 draws from seed 298.

import { expect, it } from 'bun:test'
import { rng } from './helpers/rng.js'

it('does not repeat within a million draws, from the seeds the suites use', () => {
  for (const seed of [23, 298, 1019, 0]) {
    const r = rng(seed)
    const seen = new Set<number>()
    for (let i = 0; i < 1_000_000; i++) seen.add(r())
    // Values of 32 bits: a few birthday collisions among 10^6, not a cycle.
    expect(seen.size).toBeGreaterThan(999_000)
  }
})

it('spreads evenly over ten buckets', () => {
  const r = rng(298)
  const buckets = Array.from({ length: 10 }, () => 0)
  for (let i = 0; i < 100_000; i++) buckets[Math.floor(r() * 10)]!++
  expect(buckets.every((b) => b > 9_500 && b < 10_500)).toBe(true)
})
