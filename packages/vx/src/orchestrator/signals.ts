// A SIGINT/SIGTERM mid-run stops the run the way `RunOptions.signal` does
// — the scheduler dispatches nothing more, and the signal is forwarded to
// everything live, SIGKILLed after a bounded grace — then waits, bounded,
// for run() to leave its own end-of-run path (telemetry flush, each
// plugin's teardown, the cache close), and exits 128+signo (130/143). A
// second signal exits at once. Without the forward, a
// programmatic signal to the vx process alone (CI cancellation,
// `kill <pid>`) orphans every running child — terminal Ctrl-C only worked
// via process-group propagation. Without the escalation (added
// 2026-09-10) a child that traps TERM — a dev server mid-cleanup, a test
// runner that ignores it — outlived the run that owned it: vx exited
// 143 and left it running under init. Split from run.ts on 2026-09-10
// (pure motion); the registries it reads stay with `run()`, which hands
// them to the runner around every spawn.

import { signalExitCode } from '../exec/index.js'
import { killGraceMs, settleWithin } from '../util/index.js'
import { killTree, untilGroupsGone } from '../exec/index.js'
import type { Logger } from './logger.js'

/**
 * How long a SIGTERMed child gets before SIGKILL on the way out. The
 * end-of-run persistent shutdown grants the same two seconds; both read
 * `VX_KILL_GRACE_MS` (util/settle.ts) so the suites that prove the
 * escalation do not wait the full grace.
 */
export const SIGNAL_SHUTDOWN_GRACE_MS = 2000

type Child = ReturnType<typeof Bun.spawn>

/**
 * SIGHUP too: a task runs in its own session (kill-tree.ts), so the
 * terminal closing no longer reaches it — only vx hears the hang-up,
 * and vx must pass it on or the tree outlives the window.
 */
export type StopSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP'

/** What a teardown sends a task's group before the SIGKILL. */
export type ForwardedSignal = 'SIGINT' | 'SIGTERM'

/**
 * The signal a stop forwards to every task group: the one vx received.
 * A task runs in its own session, so a terminal's Ctrl-C reaches vx
 * alone; forwarding SIGTERM in its place skipped every SIGINT-only
 * cleanup — a Node SIGINT listener, a shell's `trap … INT`
 * (turborepo#444, #12652, #13097 and nx#23585 reproduced on vx,
 * 2026-09-24). A hang-up forwards SIGTERM: to many servers SIGHUP means
 * "reload", not "stop". Anything else — an embedder's abort reason that
 * names no signal — is a SIGTERM.
 */
export function forwardedSignal(received: unknown): ForwardedSignal {
  return received === 'SIGINT' ? 'SIGINT' : 'SIGTERM'
}

/**
 * Send `signal` to every child `live()` returns, wait the grace for each one's
 * process GROUP to go, then SIGKILL every group with a member left and
 * whatever `live()` returns NOW — re-read, because the run loop may still
 * be dispatching during the grace and a child spawned after the first
 * sweep must not survive the second. The group, not the leader: a shell
 * that dies at once on the SIGTERM ended the wait, and its backgrounded
 * server was SIGKILLed mid-cleanup or, once the runner had dropped the
 * shell, not at all. Resolves once the survivors are reaped. The one
 * teardown behind the process-signal handler below, `RunOptions.signal`,
 * and the foreground keep-alive.
 */
export async function terminateChildren(
  live: () => Child[],
  signal: ForwardedSignal = 'SIGTERM',
  graceMs: number = killGraceMs(SIGNAL_SHUTDOWN_GRACE_MS),
): Promise<void> {
  const children = live()
  for (const child of children) killTree(child, signal)
  const left = await untilGroupsGone(children, graceMs)
  const survivors = [...new Set([...left, ...live()])]
  for (const child of survivors) killTree(child, 'SIGKILL')
  await Promise.allSettled(survivors.map((c) => c.exited))
}

export interface SignalForwarding {
  /** Detach the handlers — in `run()`'s finally, so repeated runs never stack listeners. */
  remove(): void
}

export function forwardSignals(args: {
  /** `RunOptions.handleSignals` — an embedder that owns the process's signals opts out. */
  enabled: boolean
  log: Logger
  cache: { close(): void }
  /**
   * Stop the run as `RunOptions.signal` would: the scheduler stops
   * dispatching and run()'s abort listener tears the children down.
   */
  stop: (signal: StopSignal) => void
  /**
   * Settles when run() has left its `finally`. A signal waits for it
   * before exiting: `process.exit` runs no `finally`, and plugin.md
   * promises a plugin its teardown and a sink its flush at the end of
   * every run — a Ctrl-C skipped both (item 849).
   */
  done: Promise<void>
  /** How long a signal waits for `done` before it exits anyway. */
  boundMs: number
  /** In-flight children; the runner adds and removes each around its spawn. */
  liveChildren: ReadonlySet<Child>
  /** Ready persistent tasks the orchestrator owns until the graph finishes. */
  persistentRegistry: ReadonlyMap<string, Child>
}): SignalForwarding {
  const everyChild = (): Child[] => [...args.liveChildren, ...args.persistentRegistry.values()]
  const exit = (signal: StopSignal): never => {
    for (const child of everyChild()) killTree(child, 'SIGKILL')
    try {
      args.cache.close()
    } catch {
      // double-close race with the normal path; we're exiting anyway
    }
    process.exit(signalExitCode(signal))
  }
  let stopping: StopSignal | undefined
  const onSignal = (signal: StopSignal): void => {
    // A second signal during the grace is the user saying "now": SIGKILL
    // and go. The exit code stays the first signal's — that is the one
    // that ended the run.
    if (stopping !== undefined) exit(stopping)
    stopping = signal
    // Clear the live worker/status region BEFORE exiting so a TTY isn't
    // left with a frozen region in the scrollback. runEnd is idempotent
    // and a no-op for non-TTY loggers.
    try {
      args.log.runEnd?.()
    } catch {
      // teardown must not throw on the way out
    }
    args.stop(signal)
    void settleWithin(args.done, args.boundMs)
      // The run's output may still be in the pipe: `process.exit` drops
      // what a reader has not taken (CLAUDE.md). An empty `write`'s
      // callback fired early, and a CI-mode run lost 0.8 of 2 MiB (item
      // 857); `end`'s waits for the pipe on Bun >= 1.4 (bin.ts). Bounded,
      // for a reader that has gone and never takes it.
      .then(() => settleWithin(new Promise<void>((r) => process.stdout.end(() => r())), 2_000))
      .then(() => exit(signal))
  }
  const onSigint = (): void => onSignal('SIGINT')
  const onSigterm = (): void => onSignal('SIGTERM')
  const onSighup = (): void => onSignal('SIGHUP')
  if (args.enabled) {
    process.on('SIGINT', onSigint)
    process.on('SIGTERM', onSigterm)
    process.on('SIGHUP', onSighup)
  }
  return {
    remove: () => {
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
      process.off('SIGHUP', onSighup)
    },
  }
}
