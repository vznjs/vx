// `TIMING_DAYS`, as Bun's environment and Workers' vars both name it.

/** `TIMING_DAYS`: a whole number of days, or undefined for the default. */
export function timingDaysOf(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const days = Number(value)
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new Error(`TIMING_DAYS: a whole number of days, got ${value}`)
  }
  return days
}
