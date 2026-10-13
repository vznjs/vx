// End-of-run settle bound. A plugin's flush/teardown is I/O a third party
// wrote; it must not hold the run's exit hostage.

import { MAX_TIMEOUT_MS } from './num.js'
import { parseDuration } from './size.js'

/** Default upper bound on one end-of-run flush/teardown await. */
const DEFAULT_TIMEOUT_MS = 3000

/** A bound the run resolved from its flag or `vx.workspace`. */
export interface SettleBound {
  readonly ms: number
  readonly from: 'flag' | 'workspace'
}

let teardownSet: SettleBound | undefined
let killGraceSet: SettleBound | undefined

/**
 * The run's `run.teardownTimeout` and `run.killGrace` from its flag or
 * workspace (the orchestrator resolves them; util sits below settings).
 * The variable, read per call, sits between the two, so a test drives the
 * deadline instead of waiting it out.
 */
export function setSettleBounds(b: { teardown?: SettleBound; killGrace?: SettleBound }): void {
  teardownSet = b.teardown
  killGraceSet = b.killGrace
}

/**
 * A flag's bound, else the variable's (a positive duration inside the
 * timer's range: the CLI refuses any other before a run, and an embedder's
 * falls back), else the workspace's.
 */
function bound(name: string, set: SettleBound | undefined, zero = false): number | undefined {
  if (set?.from === 'flag') return set.ms
  const raw = process.env[name]
  if (raw !== undefined && raw !== '') {
    const n = parseDuration(raw)
    if (n !== null && (n > 0 || zero) && n <= MAX_TIMEOUT_MS) return n
  }
  return set?.ms
}

/**
 * The bound on one end-of-run flush or teardown (`run.teardownTimeout`).
 * There is no "no limit": the deadline exists so a plugin's flush cannot
 * hold the run's exit hostage, so a timer past the platform's range (which
 * would fire at once and drop every buffered record) is no value.
 */
export function teardownTimeoutMs(): number {
  return bound('VX_RUN_TEARDOWN_TIMEOUT', teardownSet, true) ?? DEFAULT_TIMEOUT_MS
}

/**
 * The SIGTERM→SIGKILL grace a run grants a child that ignores SIGTERM
 * (`run.killGrace`): the one-shot timeout escalation (`exec/runner.ts`),
 * the signal teardown (`orchestrator/signals.ts`) and the end-of-run
 * persistent shutdown (`orchestrator/persistent.ts`) share it. Two seconds
 * is generous for a real server's cleanup and is what every run waits when
 * a child wedges; the tests that prove the escalation used to wait the
 * full two seconds each, a third of the suite's wall time for a claim a
 * 200 ms grace proves too.
 */
export function killGraceMs(defaultMs: number): number {
  return bound('VX_RUN_KILL_GRACE', killGraceSet) ?? defaultMs
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

// Who ends the process. bin.ts exits once its verb has settled and the
// streams have ended; a signal's handler exits by itself, with the
// signal's code, once the run it stopped is done. The verb settles first,
// with the run's verdict (1), so bin.ts asks before it exits.
let signalOwnsExit = false

/** A signal's handler will end the process: bin.ts leaves the exit to it. */
export function claimExitForSignal(): void {
  signalOwnsExit = true
}

export function exitClaimedBySignal(): boolean {
  return signalOwnsExit
}
