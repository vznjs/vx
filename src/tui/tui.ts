// TUI entry point. The single import site for `@opentui/react`'s
// renderer and the React root. The orchestrator calls `startTui` when
// `shouldUseTui()` returns `{ use: true }`; everything else falls
// back to the framed-block Logger as today.
//
// We expose:
//   - An `Observer` the orchestrator dispatches events into
//   - A `dispose()` that tears down the alt-screen + react root
//
// The store is a plain in-memory reducer + version-counter pattern.
// We rebuild + re-render at most every 33 ms (≈30 Hz) to keep ink-
// busy output from drowning the screen.

import { createElement } from 'react'
import type { Observer, ObserverEvent } from '../orchestrator/observer.js'
import { App } from './App.tsx'
import { createCliRenderer, createRoot, type CliRenderer, type Root } from './tui-shim.ts'
import { initialState, reduce, type Action, type State } from './state/store.ts'

export interface TuiHandle {
  observer: Observer
  /** Tear down alt-screen + unmount React. Idempotent. */
  dispose: () => Promise<void>
}

export interface StartTuiOptions {
  version: string
  /**
   * Called when the user hits `q` / Ctrl-C. The orchestrator uses this
   * to cancel the run (see design doc §6). For Phase 2B we just exit
   * the process — proper cancellation comes when the scheduler-cancel
   * primitive lands.
   */
  onExit?: () => void
  /**
   * Bypass alt-screen + raw stdin (OpenTUI's `testing` flag). Used by
   * the smoke test; never set in production.
   */
  testing?: boolean
}

const PAINT_MS = 33

export async function startTui(options: StartTuiOptions): Promise<TuiHandle> {
  let state: State = initialState()
  let renderer: CliRenderer | null = null
  let root: Root | null = null
  let painting = false
  let paintScheduled = false
  let disposed = false
  let sampler: ReturnType<typeof setInterval> | null = null

  renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: options.testing ? 'main-screen' : 'alternate-screen',
    targetFps: 30,
    ...(options.testing ? { testing: true } : {}),
  })
  root = createRoot(renderer)

  const onExit = (): void => {
    options.onExit?.()
    // Best-effort dispose; the run loop may have already taken over.
    void dispose()
  }

  const dispatch = (action: Action): void => {
    state = reduce(state, action)
    if (state.dirty) schedulePaint()
  }

  const paint = (): void => {
    if (disposed || !root) return
    painting = true
    root.render(
      createElement(App, {
        state,
        dispatch,
        version: options.version,
        onExit,
      }),
    )
    state.dirty = false
    painting = false
  }

  const schedulePaint = (): void => {
    if (paintScheduled || disposed) return
    paintScheduled = true
    setTimeout(() => {
      paintScheduled = false
      if (!painting) paint()
    }, PAINT_MS)
  }

  // 1 Hz sparkline sampler — see store.ts tick handler.
  sampler = setInterval(() => {
    dispatch({ type: 'tick', nowNs: process.hrtime.bigint() })
  }, 1000)

  // Initial paint so the screen is non-blank before the first event.
  paint()

  const observer: Observer = {
    emit(event: ObserverEvent) {
      dispatch({ type: 'event', event })
    },
  }

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    if (sampler) {
      clearInterval(sampler)
      sampler = null
    }
    try {
      root?.unmount()
    } catch {
      // Best-effort — renderer may already be torn down.
    }
    root = null
    try {
      renderer?.destroy()
    } catch {
      // Best-effort.
    }
    renderer = null
  }

  return { observer, dispose }
}
