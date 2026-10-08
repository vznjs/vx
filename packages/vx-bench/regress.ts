export type Timings = { runner: string } & Record<string, number | string | undefined>

/**
 * Each timing of a runner measured in both sets that grew past `tolerance`
 * (0.1 = 10 %), as `runner state: before → after (+n%)`. A NaN or missing
 * side is not comparable, so it reports nothing.
 */
export function regressions(
  prior: readonly Timings[],
  next: readonly Timings[],
  tolerance = 0.1,
): string[] {
  const out: string[] = []
  for (const row of next) {
    const old = prior.find((p) => p.runner === row.runner)
    if (!old) continue
    for (const [key, after] of Object.entries(row)) {
      const before = old[key]
      if (typeof after !== 'number' || typeof before !== 'number') continue
      if (!(before > 0) || !(after > before * (1 + tolerance))) continue
      const pct = Math.round((after / before - 1) * 100)
      out.push(`${row.runner} ${key}: ${Math.round(before)} → ${Math.round(after)} ms (+${pct}%)`)
    }
  }
  return out
}
