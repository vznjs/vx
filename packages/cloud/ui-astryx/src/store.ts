// Minimal external-store signal: framework-neutral get/set + a React hook.
// api.ts holds connection state (origin/token/workspace/…) OUTSIDE the React
// tree — fetch helpers read it synchronously, components subscribe via
// useSignal (useSyncExternalStore), so a connection switch re-renders every
// subscribed surface without threading context through the app.

import { useSyncExternalStore } from 'react'

export interface Signal<T> {
  get(): T
  set(next: T): void
  subscribe(listener: () => void): () => void
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return
      value = next
      for (const l of [...listeners]) l()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Subscribe a React component to a signal's current value. */
export function useSignal<T>(s: Signal<T>): T {
  return useSyncExternalStore(s.subscribe, s.get, s.get)
}
