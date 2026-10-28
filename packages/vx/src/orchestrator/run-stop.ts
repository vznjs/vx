// One stop for the run: an embedder's `RunOptions.signal` and a process
// signal both abort it. The scheduler stops dispatching (it reads the
// signal), the children are torn down, and run() returns through its own
// end-of-run path. Owns the run-scoped registries of live subprocesses:
//   - `liveChildren`: in-flight children. The runner adds/removes each
//     child around its spawn (persistent children stay until they exit).
//   - `persistentRegistry`: ready persistent tasks (dev servers,
//     watchers). executeTask spawns them but does NOT await their exit;
//     ownership moves here so the orchestrator can SIGTERM them once the
//     rest of the graph finishes.
// A SIGINT/SIGTERM mid-run forwards that signal to everything in both
// (`signals.ts`); `detach` removes the handlers so repeated run() calls
// (test suites) never stack listeners.

import { killGraceMs, teardownTimeoutMs } from '../util/index.js'
import { type Logger, warnOf } from '../report/index.js'
import { hasEnded } from './persistent.js'
import {
  forwardedSignal,
  forwardSignals,
  SIGNAL_SHUTDOWN_GRACE_MS,
  type StopSignal,
  terminateChildren,
} from './signals.js'

type Child = ReturnType<typeof Bun.spawn>

export interface RunStop {
  readonly signal: AbortSignal
  readonly liveChildren: Set<Child>
  readonly persistentRegistry: Map<string, Child>
  /**
   * The process signal that stopped the run. A run a process signal
   * stopped records no history: until item 849 the handler exited before
   * any outcome landed, and a Ctrl-C'd run then read in `vx last` as
   * FAILED with 0 tasks (item 854). So does an embedder's abort whose
   * reason names one (`'SIGINT'`, `'SIGTERM'`, `'SIGHUP'`): the signal the
   * embedder received, as the watch loop relays a Ctrl-C to its cycle. Any
   * other abort is the embedder's own call and keeps its record.
   */
  readonly stoppedBy: StopSignal | undefined
  /**
   * The stop's teardown of every child, awaited before run() leaves: a
   * task's shell can die of the signal at once while a child it
   * backgrounded ignores it and dies only to the SIGKILL after the grace,
   * and a run that returned first left that child running past vx's exit
   * (turborepo#14043's class).
   */
  readonly aborting: Promise<void> | undefined
  /**
   * The servers that had ended when the stop landed: those crashed. One
   * that ends after it is the stop's own kill, and was named a crash
   * (item 1061).
   */
  readonly endedBeforeStop: ReadonlySet<Child> | undefined
  /** The graph finished: a server ending from here on is said by the end of the run. */
  graphDone(): void
  /** Removes the signal handlers and abort listeners. */
  detach(): void
  /** run() has left its `finally`: a process signal waits for this before it exits. */
  left(): void
}

export function runStop(args: {
  log: Logger
  cache: { close(): void }
  /** `RunOptions.signal`. */
  external: AbortSignal | undefined
  /** `RunOptions.handleSignals`. */
  handleSignals: boolean
  handsTerminal: boolean
  /** How many plugins have a teardown: each gets its own bound before a signal exits. */
  teardowns: number
  /** Called first when the run is stopped. */
  onStop: () => void
}): RunStop {
  const { log, external } = args
  const liveChildren = new Set<Child>()
  // A server that ends on its own while the graph still runs is said at
  // once: its dependants were failing against it, and the end of the run
  // was the first word of it (C-69). Not once the graph is done (the end
  // of the run and the keep-alive wait say it) nor under a stop.
  let graphDone = false
  const persistentRegistry = new (class extends Map<string, Child> {
    override set(id: string, child: Child): this {
      super.set(id, child)
      void child.exited.then((code) => {
        if (code !== 0 && !graphDone && !controller.signal.aborted)
          warnOf(log)(`vx: ${id} exited with code ${code} while the run went on`)
      })
      return this
    }
  })()
  const controller = new AbortController()
  let stoppedBy: StopSignal | undefined
  const forwardAbort = (): void => {
    const reason: unknown = external?.reason
    if (reason === 'SIGINT' || reason === 'SIGTERM' || reason === 'SIGHUP') stoppedBy = reason
    controller.abort(reason)
  }
  if (external?.aborted === true) forwardAbort()
  else external?.addEventListener('abort', forwardAbort, { once: true })
  let left = (): void => {}
  const runLeft = new Promise<void>((resolve) => {
    left = resolve
  })
  const signals = forwardSignals({
    enabled: args.handleSignals,
    log,
    cache: args.cache,
    liveChildren,
    persistentRegistry,
    stop: (signal) => {
      stoppedBy = signal
      controller.abort(signal)
    },
    done: runLeft,
    handsTerminal: args.handsTerminal,
    // The grace, then one flush and each teardown at their own bound, and
    // slack for the summary and the cache close.
    boundMs:
      killGraceMs(SIGNAL_SHUTDOWN_GRACE_MS) + teardownTimeoutMs() * (1 + args.teardowns) + 2_000,
  })
  let aborting: Promise<void> | undefined
  let endedBeforeStop: ReadonlySet<Child> | undefined
  const onAbort = (): void => {
    args.onStop()
    endedBeforeStop = new Set([...persistentRegistry.values()].filter(hasEnded))
    aborting = terminateChildren(
      () => [...liveChildren, ...persistentRegistry.values()],
      forwardedSignal(controller.signal.reason),
    )
  }
  if (controller.signal.aborted) onAbort()
  else controller.signal.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    liveChildren,
    persistentRegistry,
    get stoppedBy() {
      return stoppedBy
    },
    get aborting() {
      return aborting
    },
    get endedBeforeStop() {
      return endedBeforeStop
    },
    graphDone: () => {
      graphDone = true
    },
    detach: () => {
      signals.remove()
      external?.removeEventListener('abort', forwardAbort)
      controller.signal.removeEventListener('abort', onAbort)
    },
    left: () => left(),
  }
}
