// One watch cycle's run, stoppable on its own. A cycle whose dev server
// never prints its `readyWhen` line and has no `exec.timeout` never ended,
// so every later edit (the fix included) waited behind it for good (WD-15).
// While nothing but persistent tasks is in flight, an edit stops the cycle
// as Ctrl-C would and the loop starts the next one; a cycle running any
// other work is never stopped.

import { createEventBus, type RunOptions } from '../orchestrator/index.js'

export interface WatchCycle {
  /** The options for this cycle's run: its own bus and a stop of its own beside watch's. */
  readonly opts: RunOptions
  /** Every task in flight is a persistent one not yet ready. */
  waitsOnReadiness(): boolean
  /** Stop the run as a SIGTERM would; watch keeps going. */
  interrupt(): void
  readonly interrupted: boolean
}

/** `onWaiting` hears each task event after which the cycle waits on readiness alone. */
export function watchCycle(opts: RunOptions, stop: AbortSignal, onWaiting: () => void): WatchCycle {
  const own = new AbortController()
  const bus = createEventBus()
  // id → persistent; a group task has no process and holds nothing up.
  const active = new Map<string, boolean>()
  const waitsOnReadiness = (): boolean =>
    active.size > 0 && [...active.values()].every((persistent) => persistent)
  bus.subscribe((e) => {
    if (e.kind === 'task:start' && e.node.config.exec !== undefined)
      active.set(e.node.id, e.node.config.exec.persistent !== undefined)
    else if (e.kind === 'task:complete') active.delete(e.node.id)
    else return
    if (waitsOnReadiness()) onWaiting()
  })
  return {
    opts: { ...opts, bus, signal: AbortSignal.any([stop, own.signal]) },
    waitsOnReadiness,
    interrupt: () => own.abort('SIGTERM'),
    get interrupted() {
      return own.signal.aborted
    },
  }
}
