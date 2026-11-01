// The site never shows a vx figure worse than the one it shows now
// (2026-11-01): a run is published only when none of vx's overheads in it
// is above the live site's. Overhead, not wall time, so a lower ideal
// cannot hide a slower vx. Only vx is held: a rival's row moves with its
// own releases and the machine.
import { overhead, type BenchData } from './format.ts'

const HELD = ['warm', 'restore', 'cold', 'cpu'] as const

/** vx's overheads the measured run is above the live site's on, in page order. */
export function worse(measured: BenchData, live: BenchData): (typeof HELD)[number][] {
  const now = overhead(measured.runners.vx)
  const shown = overhead(live.runners.vx)
  return HELD.filter((k) => now[k] > shown[k])
}
