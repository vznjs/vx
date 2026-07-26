/**
 * Clamp to an INTEGER in `[min, max]`; a non-finite value collapses to `min`.
 *
 * The floor is load-bearing wherever the result reaches SQL: a fractional
 * `LIMIT` is a `datatype mismatch` error, not a smaller page.
 */
export function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.floor(n)))
}
