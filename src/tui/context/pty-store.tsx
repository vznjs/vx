// Per-task pty store. Each task gets one `xterm-headless` instance
// the first time we see output for it. The `LogPane` reads
// `readLines()` for the selected task on every paint.
//
// Solid signals here are deliberate — we bump a `rev` counter on
// every write so subscribed effects re-render. (xterm-headless
// itself emits onData/onWrite events but those don't go through
// Solid's reactivity, so the bump is the simplest bridge.)

import { createSignal } from 'solid-js'
import { createSimpleContext } from './helper.tsx'
import { createPtyOutput, type PtyOutput } from '../component/pty-output.ts'
import type { ObserverEvent } from '../../orchestrator/observer.js'

interface PendingTask {
  pty: PtyOutput | null
  /** Bytes received before the pty finished loading. Replayed on creation. */
  buffer: string[]
}

interface PtyStoreInit extends Record<string, unknown> {
  cols?: number
  rows?: number
}

const { provider: PtyStoreProvider, use: usePtyStore } = createSimpleContext<
  {
    readonly rev: () => number
    /** Get the pty for a task, or null if it hasn't been created yet. */
    get(taskId: string): PtyOutput | null
    /** Apply an Observer event (no-op for non-output events). */
    apply(event: ObserverEvent): void
    /** Resize every existing pty. Called on terminal resize. */
    resizeAll(cols: number, rows: number): void
    /** Tear down every pty (called on TUI dispose). */
    disposeAll(): void
  },
  PtyStoreInit
>({
  name: 'PtyStore',
  init: (props) => {
    // Each task has at most one PendingTask. We start creating the pty
    // on first chunk; meanwhile, subsequent chunks queue into
    // `buffer` and replay once `pty` resolves.
    const ptys = new Map<string, PendingTask>()
    const [rev, setRev] = createSignal(0)
    let cols = props.cols ?? 200
    let rows = props.rows ?? 1000

    function ensure(taskId: string): PendingTask {
      let entry = ptys.get(taskId)
      if (!entry) {
        entry = { pty: null, buffer: [] }
        ptys.set(taskId, entry)
        void createPtyOutput(cols, rows).then((pty) => {
          entry!.pty = pty
          for (const chunk of entry!.buffer) pty.write(chunk)
          entry!.buffer = []
          setRev((n) => n + 1)
        })
      }
      return entry
    }

    function feed(taskId: string, chunk: string): void {
      const entry = ensure(taskId)
      if (entry.pty) entry.pty.write(chunk)
      else entry.buffer.push(chunk)
      setRev((n) => n + 1)
    }

    return {
      get rev() {
        return rev
      },
      get(taskId: string) {
        return ptys.get(taskId)?.pty ?? null
      },
      apply(event: ObserverEvent) {
        if (event.kind === 'taskStdout' || event.kind === 'taskStderr') {
          feed(event.nodeId, event.chunk)
        }
      },
      resizeAll(c: number, r: number) {
        cols = c
        rows = r
        for (const entry of ptys.values()) entry.pty?.resize(c, r)
      },
      disposeAll() {
        for (const entry of ptys.values()) entry.pty?.dispose()
        ptys.clear()
      },
    }
  },
})

export { PtyStoreProvider, usePtyStore }
