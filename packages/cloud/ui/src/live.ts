// Visibility-aware live refresh — the one primitive behind the dashboard's
// auto-updating surfaces. A view opts in (a `refresh` field on a JSON view, or
// a direct call in a Solid component); the returned tick accessor increments on
// an interval while the tab is VISIBLE, pauses when hidden, and bumps once
// immediately on regaining focus so returning to the tab refetches at once.
//
// Two module-global signals feed the header's live indicator: `visible` (one
// visibilitychange listener for the whole app) and a ref-count of how many
// live-refreshing views are currently mounted. Both are created at module
// scope — app-global state with no owner to dispose, the same pattern api.ts
// uses for the connection signals.

import { type Accessor, createSignal, onCleanup } from 'solid-js'

function docHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden
}

const [visible, setVisible] = createSignal(!docHidden())
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => setVisible(!document.hidden))
}

/** True while the browser tab is visible (paused surfaces read this). */
export function getVisibleSignal(): Accessor<boolean> {
  return visible
}

const [liveCount, setLiveCount] = createSignal(0)

/** True while at least one live-refreshing view is mounted (header indicator). */
export function getLiveActiveSignal(): Accessor<boolean> {
  return () => liveCount() > 0
}

/**
 * A tick that increments every `intervalMs` while the tab is visible. Pauses
 * when hidden, and fires once immediately on regaining focus. Registers a
 * live-refresh marker for the header indicator and cleans everything up on
 * unmount — so it MUST be called inside a component's reactive owner.
 */
export function useVisibilityRefresh(intervalMs: number): Accessor<number> {
  const [tick, setTick] = createSignal(0)
  setLiveCount((n) => n + 1)

  let timer: ReturnType<typeof setInterval> | undefined
  const stop = (): void => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
  const start = (): void => {
    stop()
    timer = setInterval(() => setTick((t) => t + 1), intervalMs)
  }
  const onVisibility = (): void => {
    if (document.hidden) stop()
    else {
      setTick((t) => t + 1) // immediate refetch on focus
      start()
    }
  }

  if (!docHidden()) start()
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)

  onCleanup(() => {
    stop()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    setLiveCount((n) => Math.max(0, n - 1))
  })

  return tick
}

/**
 * Identity stability for polled fetchers: byte-identical payloads reuse the
 * PREVIOUS reference, so downstream memos (default `===` equality) do not
 * re-notify and reference-keyed `<For>` rows produce ZERO DOM work on a
 * data-identical tick. Wrap the resolved value: `stable(await fetchRows())`.
 */
export function identityStable<T>(): (v: T) => T {
  let json: string | undefined
  let value: T
  return (v: T) => {
    const j = JSON.stringify(v)
    if (j === json) return value
    json = j
    value = v
    return v
  }
}
