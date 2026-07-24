// Tiny data-fetch hook, the app-wide replacement for Solid's createResource:
// every page keys its reads on the connection key (origin|token|workspace) so
// switching connection or workspace re-fetches everything, and an unmounted
// or superseded fetch can never clobber a newer one.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useConnectionKey } from './api.ts'

export interface Query<T> {
  data: T | undefined
  error: string | null
  loading: boolean
  /** Re-run the fetch in place (used by auto-refresh + retry buttons). */
  refresh: () => void
}

/**
 * Fetch `fn` once per connection × deps change. `deps` are the page-level
 * params (route ids, filters, limits) — pass every value `fn` closes over.
 */
export function useQuery<T>(fn: () => Promise<T>, deps: readonly unknown[] = []): Query<T> {
  const connection = useConnectionKey()
  const [state, setState] = useState<{ data: T | undefined; error: string | null; loading: boolean }>(
    { data: undefined, error: null, loading: true },
  )
  const [tick, setTick] = useState(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    fnRef.current().then(
      (data) => {
        if (alive) setState({ data, error: null, loading: false })
      },
      (err: unknown) => {
        if (alive) {
          setState((s) => ({
            data: s.data,
            error: err instanceof Error ? err.message : String(err),
            loading: false,
          }))
        }
      },
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, tick, ...deps])

  const refresh = useCallback(() => setTick((t) => t + 1), [])
  return { ...state, refresh }
}

/** useQuery + a polling interval (ms). 0 disables polling. */
export function usePolledQuery<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  deps: readonly unknown[] = [],
): Query<T> {
  const q = useQuery(fn, deps)
  const refresh = q.refresh
  useEffect(() => {
    if (intervalMs <= 0) return
    const t = setInterval(refresh, intervalMs)
    return () => clearInterval(t)
  }, [intervalMs, refresh])
  return q
}
