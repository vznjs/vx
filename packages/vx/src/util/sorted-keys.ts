/**
 * `v` with every object's keys sorted, all the way down: `v` itself when
 * they are already, a copy when not. A key hashes a config's JSON, and the
 * order a file or a plugin spells its keys in says nothing. Checked first,
 * a config the lock wrote sorted costs a walk, not a copy.
 */
export function keysSorted<T>(v: T): T {
  return isSorted(v) ? v : (sortedDeep(v) as T)
}

function isSorted(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return true
  if (Array.isArray(v)) return v.every(isSorted)
  let prev: string | undefined
  for (const k in v) {
    if (prev !== undefined && prev > k) return false
    prev = k
    if (!isSorted((v as Record<string, unknown>)[k])) return false
  }
  return true
}

function sortedDeep(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(sortedDeep)
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v).sort()) out[k] = sortedDeep((v as Record<string, unknown>)[k])
  return out
}
