// A seeded PRNG for property tests: mulberry32, 32-bit integer state.
// The LCG the first property files carried, `(s * 1103515245 + 12345) %
// 2 ** 31` in float arithmetic, lost the product's low bits past 2 ** 53
// and fell into a cycle: seed 298 repeated after 71 draws, 23 and 1019
// within 15,000, so "2,000 random graphs" were a few hundred (C-79).
// `Math.imul` keeps every step exact; the period is 2 ** 32.

/** Uniform in [0, 1), deterministic per seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
