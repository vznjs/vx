// A row of quotes: it scrolls on its own, a finger, trackpad or mouse
// takes it over, and it drifts on from wherever it was left. The
// row holds three copies of its cards; the offset stays in the middle one,
// so a swipe has a whole copy of room either way before the seam.

// Pixels a row moves per millisecond.
export const DRIFT_SPEED = 1 / 28

// How long a row waits, after the last touch, drag or scroll, before it drifts again.
export const DRIFT_REST_MS = 1500

// Folds a scroll offset into [one, 2 * one): the same view, middle copy.
export const fold = (pos: number, one: number): number => one + ((((pos - one) % one) + one) % one)

// The offset after `ms` of drift; `dir` -1 moves the cards left.
export const drift = (pos: number, ms: number, dir: number, one: number): number =>
  fold(pos + (dir < 0 ? 1 : -1) * ms * DRIFT_SPEED, one)
