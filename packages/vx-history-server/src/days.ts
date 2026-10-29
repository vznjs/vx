// `TIMING_DAYS`, as Bun's environment and Workers' vars both name it.

/**
 * `TIMING_DAYS`: a whole number of days, or undefined for the default. A
 * Worker var may be JSON: a number is read as Bun reads its digits, and
 * anything else is refused, as `TIMING_DAYS=true` is on Bun (`true` was
 * read as 1 day).
 */
export function timingDaysOf(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined
  const days = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new Error(
      `TIMING_DAYS: a whole number of days, got ${typeof value === 'string' || typeof value === 'number' ? value : JSON.stringify(value)}`,
    )
  }
  return days
}
