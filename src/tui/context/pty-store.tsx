// Per-task pty store. Each task gets one `xterm-headless` Terminal
// the first time we see output for it. The pty itself absorbs every
// chunk synchronously (xterm-headless's internal parse is fast); the
// **`rev` signal that drives UI re-render is throttled to ~30 Hz**
// so a chatty build tool (1000+ chunks/sec) can't drown Solid's
// reactivity in updates.

import { createSignal, onCleanup, onMount } from 'solid-js'
import { createSimpleContext } from './helper.tsx'
import { createPtyOutput, type PtyOutput } from '../component/pty-output.ts'
import type { ObserverEvent } from '../../orchestrator/observer.js'

interface PtyStoreInit extends Record<string, unknown> {
  cols?: number
  rows?: number
}

const FRAME_MS = 33 // ~30 Hz

const { provider: PtyStoreProvider, use: usePtyStore } = createSimpleContext<
  {
    readonly rev: () => number
    get(taskId: string): PtyOutput | null
    apply(event: ObserverEvent): void
    resizeAll(cols: number, rows: number): void
    disposeAll(): void
  },
  PtyStoreInit
>({
  name: 'PtyStore',
  init: (props) => {
    const ptys = new Map<string, PtyOutput>()
    const [rev, setRev] = createSignal(0)
    let cols = props.cols ?? 200
    let rows = props.rows ?? 1000
    let dirty = false
    let frameTimer: ReturnType<typeof setInterval> | null = null

    function ensure(taskId: string): PtyOutput {
      let pty = ptys.get(taskId)
      if (!pty) {
        pty = createPtyOutput(cols, rows)
        ptys.set(taskId, pty)
      }
      return pty
    }

    // Frame-throttled "something changed" pump. Bumps rev at most
    // ~30 times per second regardless of how many chunks arrived.
    onMount(() => {
      frameTimer = setInterval(() => {
        if (dirty) {
          dirty = false
          setRev((n) => n + 1)
        }
      }, FRAME_MS)
    })

    onCleanup(() => {
      if (frameTimer) clearInterval(frameTimer)
      frameTimer = null
    })

    return {
      get rev() {
        return rev
      },
      get(taskId: string) {
        return ptys.get(taskId) ?? null
      },
      apply(event: ObserverEvent) {
        if (event.kind === 'taskStdout' || event.kind === 'taskStderr') {
          ensure(event.nodeId).write(event.chunk)
          dirty = true
        }
      },
      resizeAll(c: number, r: number) {
        cols = c
        rows = r
        for (const pty of ptys.values()) pty.resize(c, r)
        dirty = true
      },
      disposeAll() {
        for (const pty of ptys.values()) pty.dispose()
        ptys.clear()
      },
    }
  },
})

export { PtyStoreProvider, usePtyStore }
