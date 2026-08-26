// End-of-run settle bound. A plugin's flush/teardown is I/O a third party
// wrote; it must not hold the run's exit hostage.

import { MAX_TIMEOUT_MS } from './num.js'

/** Default upper bound on one end-of-run flush/teardown await. */
const DEFAULT_TIMEOUT_MS = 3000

/**
 * The bound to apply, read per call so a test can drive the deadline
 * instead of waiting it out.
 */
export function teardownTimeoutMs(): number {
  const raw = process.env['VX_TEARDOWN_TIMEOUT_MS']
  // Out-of-range falls back to the DEFAULT rather than clamping to
  // MAX_TIMEOUT_MS, and the distinction matters. This value is a BOUND, not a
  // duration: there is no "no limit" option here, because the whole reason the
  // deadline exists is that a plugin's flush must not hold the run's exit
  // hostage. Clamping would honour "wait ~24.8 days", which defeats it — the
  // run would hang. Unbounded is worse still (the delay becomes 1 ms, so every
  // flush times out and every buffered record is dropped). Falling back keeps
  // the bound real in both directions.
  if (raw !== undefined && /^[0-9]+$/.test(raw)) {
    const n = Number(raw)
    if (n <= MAX_TIMEOUT_MS) return n
  }
  return DEFAULT_TIMEOUT_MS
}

/**
 * Await `p`, giving up after `ms`. Returns true when `p` settled first,
 * false when the deadline won — the caller decides whether a lost result
 * is worth reporting.
 */
export async function settleWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return (await Promise.race([p.then(() => true), deadline])) !== false
  } finally {
    clearTimeout(timer)
    // A rejection landing after the deadline won already resolved the
    // race must not surface as an unhandled-rejection crash.
    void p.catch(() => {})
  }
}
