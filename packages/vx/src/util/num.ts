/**
 * The largest delay `setTimeout` actually honours: 2^31 - 1 ms (~24.8 days).
 *
 * A larger delay does NOT saturate and does NOT throw — it silently becomes
 * **1 ms**, which is the exact INVERSE of what the caller asked for. A task
 * declaring a 317-year timeout is SIGTERMed 4 ms after it spawns and reported
 * `failed`, and the only clue is a `TimeoutOverflowWarning` on stderr that a CI
 * log swallows. Every surface that accepts a millisecond delay bounds it
 * against this, so "effectively no limit" can never mean "kill immediately".
 */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1

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
