// The site never shows vx worse against Turbo than it shows now
// (2026-11-01). Each figure is vx's overhead over Turbo's, the ratio a
// reader compares; a new run that raises any of them is not published.
import { overhead, type BenchData } from './format.ts'

const GATED = ['warm', 'restore', 'cold', 'cpu'] as const
export type Gated = (typeof GATED)[number]

/** vx's overhead as a share of Turbo's, per figure. */
export function againstTurbo(d: BenchData): Record<Gated, number> {
  const vx = overhead(d.runners.vx)
  const turbo = overhead(d.runners.turbo)
  return Object.fromEntries(
    GATED.map((k) => [k, turbo[k] === 0 ? Infinity : vx[k] / turbo[k]]),
  ) as Record<Gated, number>
}

/** The figures where the new run shows vx worse against Turbo than the live one. */
export function worse(live: BenchData, next: BenchData): Gated[] {
  const was = againstTurbo(live)
  const now = againstTurbo(next)
  return GATED.filter((k) => now[k] > was[k])
}
