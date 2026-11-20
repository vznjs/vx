// The landing's race, as arithmetic: where a runner is and how many laps it
// has done after `elapsed` ms, and whether the race should be running. The
// page's script only applies these, so the motion and the lap count come
// from one clock and cannot disagree.

/** A runner `elapsed` ms into a race whose lap takes `lapMs`. */
export const lapAt = (elapsed: number, lapMs: number): { laps: number; x: number } => {
  const t = elapsed / lapMs
  const laps = Math.floor(t)
  // -100% is the start line, 0% the finish.
  return { laps, x: (t - laps - 1) * 100 }
}

/** The race runs while any of it is on screen and the tab is showing. */
export const racing = (
  box: { top: number; bottom: number },
  viewport: number,
  hidden: boolean,
): boolean => !hidden && box.top < viewport && box.bottom > 0

/** A frame's share of the clock: a tab that slept does not jump the race ahead. */
export const step = (now: number, last: number): number => Math.min(100, Math.max(0, now - last))

export const lapsLabel = (laps: number): string => (laps === 1 ? '1 lap' : `${laps} laps`)

// The CPU panel is an amount, not a pace: a meter of cells, one per CPU
// second, lit column by column and each column from its floor.

/** Cells per column of the meter. */
export const BURN_ROWS = 4
/** The burn lasts this long for the tool that burns most, then holds. */
export const BURN_MS = 6000
export const BURN_HOLD_MS = 2500

/** Cells lit `elapsed` ms into the loop, for a tool that burns `total` of the most, `max`. */
export const burnAt = (elapsed: number, total: number, max: number): number =>
  Math.min(total, Math.floor(((elapsed % (BURN_MS + BURN_HOLD_MS)) / BURN_MS) * max))

/** The shape of `cells` lit cells in a meter `cols` columns wide, as a clip-path. */
export const burnClip = (cells: number, cols: number): string => {
  const full = Math.floor(cells / BURN_ROWS)
  const pct = (n: number): string => `${Number(((n / cols) * 100).toFixed(3))}%`
  const top = `${100 - ((cells % BURN_ROWS) / BURN_ROWS) * 100}%`
  return `polygon(0 0, ${pct(full)} 0, ${pct(full)} ${top}, ${pct(full + 1)} ${top}, ${pct(full + 1)} 100%, 0 100%)`
}

/** A tool's figure against the row's fastest: the fastest is 1×, the rest
 * how many times longer, so every number reads the same way in every row.
 * A near tie keeps two decimals so it never shows as the winner's 1×. */
export const ratioLabel = (ms: number, fastest: number): string => {
  if (ms === fastest) return '1×'
  const r = ms / fastest
  return `${r < 2 ? r.toFixed(2) : r < 10 ? r.toFixed(1) : Math.round(r)}×`
}

// A runner's tail is the track it covered in the last TAIL_MS, like a
// streak of motion blur: one rule for every tool, so a faster runner draws a
// longer tail, held between a floor that always shows and a ceiling.
export const TAIL_MS = 150
export const TAIL_MIN = 8
export const TAIL_MAX = 40

/** A runner's tail, in % of the track, for a lap of `lapMs`. */
export const tailPct = (lapMs: number): number =>
  Math.min(TAIL_MAX, Math.max(TAIL_MIN, (TAIL_MS / lapMs) * 100))
