// Seeded randomness for the generated graphs, its own file so the
// head-to-head's shape (shape.ts) imports nothing of core: the rivals'
// bench tasks are keyed on the harness, never on vx's source.

/** mulberry32: small, seeded, and the same on every machine. */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
