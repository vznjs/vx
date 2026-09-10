// A SIGINT/SIGTERM mid-run forwards SIGTERM to everything live, waits a
// bounded grace for it to go, SIGKILLs what is still there, closes the
// cache handle, and exits 128+signo (130/143). Without the forward, a
// programmatic signal to the vx process alone (CI cancellation,
// `kill <pid>`) orphans every running child — terminal Ctrl-C only worked
// via process-group propagation. Without the escalation (added
// 2026-09-10) a child that traps TERM — a dev server mid-cleanup, a test
// runner that ignores it — outlived the run that owned it: vx exited
// 143 and left it running under init. Split from run.ts on 2026-09-10
// (pure motion); the registries it reads stay with `run()`, which hands
// them to the runner around every spawn.

import { signalExitCode } from '../exec/index.js'
import { killGraceMs } from '../util/index.js'
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
 * SIGTERM every child `live()` returns, wait the grace for them to go,
 * then SIGKILL whatever `live()` returns NOW — re-read, because the run
 * loop may still be dispatching during the grace and a child spawned
 * after the first sweep must not survive the second. Resolves once the
 * survivors are reaped. The one teardown behind the process-signal
 * handler below, `RunOptions.signal`, and the foreground keep-alive.
 */
export async function terminateChildren(
  live: () => Child[],
  graceMs: number = killGraceMs(SIGNAL_SHUTDOWN_GRACE_MS),
): Promise<void> {
  const children = live()
  for (const child of children) child.kill('SIGTERM')
  const allExited = Promise.allSettled(children.map((c) => c.exited))
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  // Not unref'd: it is what guarantees progress when every other handle
  // has drained, and the grace is bounded either way.
  await Promise.race([
    allExited,
    new Promise<void>((resolve) => {
      graceTimer = setTimeout(resolve, graceMs)
    }),
  ])
  if (graceTimer !== undefined) clearTimeout(graceTimer)
  const survivors = live()
  for (const child of survivors) child.kill('SIGKILL')
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
  /** In-flight children; the runner adds and removes each around its spawn. */
  liveChildren: ReadonlySet<Child>
  /** Ready persistent tasks the orchestrator owns until the graph finishes. */
  persistentRegistry: ReadonlyMap<string, Child>
}): SignalForwarding {
  const everyChild = (): Child[] => [...args.liveChildren, ...args.persistentRegistry.values()]
  const exit = (signal: 'SIGINT' | 'SIGTERM'): never => {
    for (const child of everyChild()) child.kill('SIGKILL')
    try {
      args.cache.close()
    } catch {
      // double-close race with the normal path; we're exiting anyway
    }
    process.exit(signalExitCode(signal))
  }
  let stopping: 'SIGINT' | 'SIGTERM' | undefined
  const onSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
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
    void terminateChildren(everyChild).then(() => exit(signal))
  }
  const onSigint = (): void => onSignal('SIGINT')
  const onSigterm = (): void => onSignal('SIGTERM')
  if (args.enabled) {
    process.on('SIGINT', onSigint)
    process.on('SIGTERM', onSigterm)
  }
  return {
    remove: () => {
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
    },
  }
}
