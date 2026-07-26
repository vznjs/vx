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

/**
 * Parse a PLAIN decimal integer from user input; `null` for anything else.
 *
 * `Number()` is the wrong tool at an argument boundary: it silently accepts
 * hex (`0x10` → 16), exponents (`1e3` → 1000), fractions, a leading `+`, and
 * surrounding whitespace — so a typo becomes a different number instead of an
 * error. Values past `Number.MAX_SAFE_INTEGER` are rejected too: they parse to
 * a number the user did not type (`9007199254740993` → `…92`).
 */
export function parseDecimalInt(input: string): number | null {
  if (!/^\d+$/.test(input)) return null
  const n = Number(input)
  return Number.isSafeInteger(n) ? n : null
}
