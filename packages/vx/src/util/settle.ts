// End-of-run settle bound. A plugin's flush/teardown is I/O a third party
// wrote; it must not hold the run's exit hostage.

import { MAX_TIMEOUT_MS } from './num.js'
import { parseDuration } from './size.js'

/** Default upper bound on one end-of-run flush/teardown await. */
const DEFAULT_TIMEOUT_MS = 3000

/**
 * A timer a test shortens: `VX_TEST_<name>`, a duration. Undocumented and
 * in no settings table: the suites that prove a deadline drive it instead
 * of waiting the real one out. Zero only where `zero` allows it.
 */
export function testTimerMs(name: string, defaultMs: number, zero = false): number {
  const raw = process.env[`VX_TEST_${name}`]
  if (raw === undefined || raw === '') return defaultMs
  const n = parseDuration(raw)
  return n !== null && (n > 0 || (zero && n === 0)) && n <= MAX_TIMEOUT_MS ? n : defaultMs
}

/**
 * The bound on one end-of-run flush or teardown: a plugin's flush cannot
 * hold the run's exit hostage.
 */
export function teardownTimeoutMs(): number {
  return testTimerMs('TEARDOWN_TIMEOUT', DEFAULT_TIMEOUT_MS, true)
}

/**
 * The SIGTERM→SIGKILL grace a run grants a child that ignores SIGTERM:
 * the one-shot timeout escalation (`exec/runner.ts`),
 * the signal teardown (`orchestrator/signals.ts`) and the end-of-run
 * persistent shutdown (`orchestrator/persistent.ts`) share it. Two seconds
 * is generous for a real server's cleanup and is what every run waits when
 * a child wedges; the tests that prove the escalation used to wait the
 * full two seconds each, a third of the suite's wall time for a claim a
 * 200 ms grace proves too.
 */
export function killGraceMs(defaultMs: number): number {
  return testTimerMs('KILL_GRACE', defaultMs)
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

/** How long `dieOf` waits for its own signal to land before the caller exits anyway. */
const SELF_SIGNAL_WAIT_MS = 1000

/**
 * Die of `signal`: its listeners off, so Bun restores the default action,
 * the signal sent to this process, and the caller held until it lands. A
 * kill is not always delivered before it returns: a signal another thread
 * takes, or one a tracer holds (the sandbox's `strace -f` sees every
 * signal before the tracee does), lands later, and the `process.exit`
 * after it won: vx exited 130, not of SIGINT, and a script running it
 * went on (CI, PR #4867). Bounded: the caller's exit code is the fallback
 * should the signal never land. `VX_TEST_SELF_SIGNAL_DELAY` sends it from
 * a helper that late instead, the window a test widens.
 */
export function dieOf(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): void {
  process.removeAllListeners(signal)
  const lateMs = testTimerMs('SELF_SIGNAL_DELAY', 0)
  if (lateMs > 0) {
    Bun.spawn(['sh', '-c', `sleep ${lateMs / 1000}; kill -${signal.slice(3)} ${process.pid}`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
  } else {
    process.kill(process.pid, signal)
  }
  // Synchronous: an `exit` listener's loop never turns again. A signal
  // that lands ends the process here; the wait costs nothing then.
  const until = performance.now() + lateMs + SELF_SIGNAL_WAIT_MS
  while (performance.now() < until) Bun.sleepSync(5)
}

/** A signal's handler will end the process: bin.ts leaves the exit to it. */
export function claimExitForSignal(): void {
  signalOwnsExit = true
}

export function exitClaimedBySignal(): boolean {
  return signalOwnsExit
}
