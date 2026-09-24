/**
 * Two distinct lockfile `global` strings whose xxHash3 digests share their
 * low 32 bits: the half Bun's xxHash3 reads when a digest is passed as a
 * seed. A digest folded under either as a SEED comes out the same; folded
 * as data it does not (item 682). A birthday search over ~2^17 strings.
 */
export function lowHalfGlobals(): [string, string] {
  const seen = new Map<number, string>()
  for (let i = 0; i < 1 << 20; i++) {
    const g = `{"version":${i}}`
    const low = Number(Bun.hash.xxHash3(g) & 0xffffffffn)
    const prev = seen.get(low)
    if (prev !== undefined) return [prev, g]
    seen.set(low, g)
  }
  throw new Error('no low-half pair in 2^20 strings')
}
