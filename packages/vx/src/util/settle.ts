// End-of-run settle bound. A plugin's flush/teardown is I/O a third party
// wrote; it must not hold the run's exit hostage.

import { MAX_TIMEOUT_MS } from './num.js'
import { parseDuration } from './size.js'

/** Default upper bound on one end-of-run flush/teardown await. */
const DEFAULT_TIMEOUT_MS = 3000

/**
 * An internal timer a test shortens: `VX_TEST_<name>`, a duration.
 * Undocumented and in no settings table: the suites that prove a deadline
 * drive it instead of waiting the real one out. The user-facing timers are
 * settings (`timerSettingMs`).
 */
export function testTimerMs(name: string, defaultMs: number): number {
  const raw = process.env[`VX_TEST_${name}`]
  if (raw === undefined || raw === '') return defaultMs
  const n = parseDuration(raw)
  return n !== null && n > 0 && n <= MAX_TIMEOUT_MS ? n : defaultMs
}

/**
 * The timer settings `.vx/workspace` gave, by variable name, set once a run
 * loads it (`applyWorkspaceTimers` in settings.ts). The variable beats them,
 * read where the timer arms, as the tests that shorten one drive it in
 * process; the CLI refused a malformed one at its start.
 */
const workspaceTimers = new Map<string, number>()

export function setWorkspaceTimers(values: ReadonlyMap<string, number>): void {
  workspaceTimers.clear()
  for (const [k, v] of values) workspaceTimers.set(k, v)
}

/**
 * The output budgets and counts a run reads (`run.logs.*`,
 * `run.secrets.minLength`), by variable, resolved once per workspace load
 * from the variable, else `.vx/workspace` (`applyWorkspaceLimits` in
 * settings.ts): a reader on a hot path pays one map read.
 */
const workspaceLimits = new Map<string, number>()

export function setWorkspaceLimits(values: ReadonlyMap<string, number>): void {
  workspaceLimits.clear()
  for (const [k, v] of values) workspaceLimits.set(k, v)
}

/** A limit setting as the last workspace load resolved it, else `defaultValue`. */
export function limitSetting(variable: string, defaultValue: number): number {
  return workspaceLimits.get(variable) ?? defaultValue
}

/**
 * A timer setting: its variable, else the workspace's, else `defaultMs`.
 * Zero only where `zero` allows it.
 */
function timerSettingMs(variable: string, defaultMs: number, zero = false): number {
  const raw = process.env[variable]
  if (raw !== undefined && raw !== '') {
    const n = parseDuration(raw)
    if (n !== null && (n > 0 || (zero && n === 0)) && n <= MAX_TIMEOUT_MS) return n
  }
  return workspaceTimers.get(variable) ?? defaultMs
}

/**
 * The bound on one end-of-run flush or teardown, and on a remote download's
 * wait for its answer and between its bytes (`run.pluginTimeout`): a
 * plugin's flush cannot hold the run's exit hostage.
 */
export function teardownTimeoutMs(): number {
  return timerSettingMs('VX_RUN_PLUGIN_TIMEOUT', DEFAULT_TIMEOUT_MS, true)
}

/**
 * Grace after the direct child exits before we abort the stdout/stderr readers.
 * The pipe reaches EOF only when EVERY write-end fd is closed, so a task that
 * backgrounds a process inheriting fd 1/2 (`server & echo up` — `execWrap`
 * leaves compound commands as `sh -c`, so `sh` exits while the grandchild holds
 * the pipe) never EOFs. On a clean exit with no lingering writer the pipe EOFs
 * at once, so the readers win this race immediately and normal tasks pay
 * nothing; only a stuck reader waits out the grace. Residual buffered output is
 * what the pipe and the reader thread hold, a few MiB; a bound the scheduler
 * spent blocked is re-armed (`drainOrAbort`). What the leftover
 * process writes after the bound is lost, and `POST_EXIT_CUT_LINE`
 * (exec/runner.ts) says so.
 * A runtime probe's drain is bounded the same (cache/inputs.ts).
 */
export const POST_EXIT_DRAIN_MS = 250

/**
 * The SIGTERM→SIGKILL grace a run grants a child that ignores SIGTERM:
 * the one-shot timeout escalation (`exec/runner.ts`),
 * the signal teardown (`orchestrator/signals.ts`) and the end-of-run
 * persistent shutdown (`orchestrator/persistent.ts`) share it. Two seconds
 * is generous for a real server's cleanup and is what every run waits when
 * a child wedges; the tests that prove the escalation used to wait the
 * full two seconds each, a third of the suite's wall time for a claim a
 * 200 ms grace proves too. `run.killGrace` sets it.
 */
export function killGraceMs(defaultMs: number): number {
  return timerSettingMs('VX_RUN_KILL_GRACE', defaultMs)
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
    // A delay past a 32-bit int fires at 1 ms: the longest the timer holds instead.
    timer = setTimeout(() => resolve(false), Math.min(ms, MAX_TIMEOUT_MS))
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
 * Die of `signal`: its listeners off, so Bun restores the default action, the
 * signal sent to this process, and the caller held until it lands. A kill is
 * not always delivered before it returns: a signal another thread takes, or one
 * a tracer holds (the sandbox's `strace -f` sees every signal before the tracee
 * does), lands later, and the `process.exit` after it won: vx exited with the
 * signal's code (130), not of the signal, and a script running it went on (CI).
 * Bounded: the caller's exit code is the fallback should the signal never land.
 * `testTimerMs('SELF_SIGNAL_DELAY')` sends it from a helper that late instead,
 * the window a test widens.
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
