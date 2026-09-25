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
 * The SIGTERM→SIGKILL grace a run grants a child that ignores SIGTERM: the
 * one-shot timeout escalation (`exec/runner.ts`) and the end-of-run
 * persistent shutdown (`orchestrator/persistent.ts`) share it. Two seconds
 * is generous for a real server's cleanup and is what every run waits when
 * a child wedges. `VX_KILL_GRACE_MS` overrides it, read per call and bounded
 * like the teardown deadline (out of range falls back to the default): the
 * tests that prove the escalation used to wait the full two seconds each,
 * a third of the suite's wall time for a claim a 200 ms grace proves too.
 */
export function killGraceMs(defaultMs: number): number {
  const raw = process.env['VX_KILL_GRACE_MS']
  if (raw !== undefined && /^[0-9]+$/.test(raw)) {
    const n = Number(raw)
    if (n > 0 && n <= MAX_TIMEOUT_MS) return n
  }
  return defaultMs
}

/**
 * Await `p`, giving up after `ms`. Returns true when `p` fulfilled first,
 * false when the deadline won — the caller decides whether a lost result
 * is worth reporting. A rejection before the deadline is not a timeout: it
 * propagates, so the caller reports the failure rather than a hang
 * (`tests/util-settle.test.ts`).
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
