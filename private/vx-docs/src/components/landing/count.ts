// The conformance count runs up from 0 as its band comes near. A frame's
// timestamp is when the frame began, so the first one can come before the
// clock read that started the count: elapsed time below 0 holds at 0, never
// below (2026-11-21: the home page showed "-6740 of 1023").

export const COUNT_MS = 1800

export const countAt = (to: number, elapsed: number): number => {
  const t = Math.min(1, Math.max(0, elapsed / COUNT_MS))
  return Math.round(to * (1 - (1 - t) ** 4))
}
