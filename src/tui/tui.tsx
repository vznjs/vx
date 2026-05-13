// TUI entry. Mirrors opencode's `tui()` function shape — returns a
// Promise<void> that resolves on user-quit. The orchestrator awaits
// it after the run finishes (and meanwhile dispatches Observer
// events into the TUI's `apply` handler).

import { createCliRenderer, type CliRendererConfig } from '@opentui/core'
import { render } from '@opentui/solid'
import { App } from './app.tsx'
import { ThemeProvider } from './context/theme.tsx'
import { RunStateProvider, useRunState } from './context/run-state.tsx'
import { PtyStoreProvider, usePtyStore } from './context/pty-store.tsx'
import { DialogProvider } from './ui/dialog.tsx'
import type { Observer, ObserverEvent } from '../orchestrator/observer.js'
import { createEffect, on } from 'solid-js'

export interface TuiHandle {
  observer: Observer
  /** Resolves when the user signals exit (q / Ctrl-C). */
  waitForExit: () => Promise<void>
  /** Tear down the renderer (idempotent). */
  dispose: () => Promise<void>
}

export interface StartTuiOptions {
  /** Bypass alt-screen + raw stdin (OpenTUI's `testing` flag). */
  testing?: boolean
}

const RENDERER_CONFIG: CliRendererConfig = {
  exitOnCtrlC: false,
  targetFps: 30,
  gatherStats: false,
}

export async function startTui(options: StartTuiOptions = {}): Promise<TuiHandle> {
  const cfg: CliRendererConfig = options.testing
    ? { ...RENDERER_CONFIG, screenMode: 'main-screen', testing: true }
    : { ...RENDERER_CONFIG, screenMode: 'alternate-screen' }
  const renderer = await createCliRenderer(cfg)

  let runStateApply: ((event: ObserverEvent) => void) | null = null
  let ptyApply: ((event: ObserverEvent) => void) | null = null
  let onExitRequested: (() => void) | null = null

  // Bridge: a tiny inner component that registers its `apply` fn into
  // the closure above on mount. The outer factory then forwards
  // Observer events from the orchestrator into the right contexts.
  function Bridge() {
    const run = useRunState()
    const pty = usePtyStore()
    runStateApply = run.apply
    ptyApply = pty.apply

    // Watch the run's `exitRequested` flag — when true, resolve the
    // wait-for-exit promise.
    createEffect(
      on(
        () => run.state.exitRequested,
        (requested) => {
          if (requested) onExitRequested?.()
        },
      ),
    )
    return null
  }

  await render(
    () => (
      <ThemeProvider>
        <RunStateProvider>
          <PtyStoreProvider>
            <DialogProvider>
              <Bridge />
              <App />
            </DialogProvider>
          </PtyStoreProvider>
        </RunStateProvider>
      </ThemeProvider>
    ),
    renderer,
  )

  let exitResolve: (() => void) | null = null
  const exitPromise = new Promise<void>((resolve) => {
    exitResolve = resolve
  })
  onExitRequested = () => {
    if (exitResolve) {
      const r = exitResolve
      exitResolve = null
      r()
    }
  }

  let disposed = false
  const observer: Observer = {
    emit(event: ObserverEvent) {
      runStateApply?.(event)
      ptyApply?.(event)
    },
  }

  return {
    observer,
    async waitForExit() {
      await exitPromise
    },
    async dispose() {
      if (disposed) return
      disposed = true
      try {
        renderer.destroy()
      } catch {
        // best-effort
      }
    },
  }
}
