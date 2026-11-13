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
