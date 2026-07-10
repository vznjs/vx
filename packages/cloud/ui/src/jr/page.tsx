// Generic loader that turns a pure-JSON page definition into a rendered view.
// A page declares its data sources by name + a (nested or flat) json-render
// spec; this fetches the sources into `state`, exposes decoded route `params`
// and a `<key>Status` flag per source (loading | missing | ok) for `visible`
// gating, and renders the spec through the shared registry. This is the ONLY
// per-page machinery — the pages themselves are pure data.

import { type JSX, ErrorBoundary, createMemo, createResource } from 'solid-js'
import { useParams, useSearchParams } from '@solidjs/router'
import { nestedToFlat } from '@json-render/core'
import type { Spec } from '@json-render/solid'
import { getCapabilitiesSignal, getConnectionKey } from '../api.ts'
import { useVisibilityRefresh } from '../live.ts'
import { Dash } from './renderer.tsx'
import { SOURCES } from './data.ts'

const capabilities = getCapabilitiesSignal()

export interface JsonView {
  /** stateKey → data-source name (see data.ts). */
  data?: Record<string, string>
  /** static state merged in (e.g. constants). */
  state?: Record<string, unknown>
  /** nested ({type,props,children}) or flat ({root,elements}) json-render spec. */
  spec: Record<string, unknown>
  /** Opt-in live auto-refresh interval (ms) — re-fetches this view's sources
   *  on a visibility-aware tick (paused while the tab is hidden). */
  refresh?: number
}

const toFlat = (spec: Record<string, unknown>): Spec => ('elements' in spec ? (spec as unknown as Spec) : nestedToFlat(spec))

/** Last-resort fallback so an unexpected render throw shows a message, not a blank page. */
function PageError(props: { error: unknown }): JSX.Element {
  const msg = props.error instanceof Error ? props.error.message : String(props.error)
  return (
    <div class="m-6 rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm">
      <div class="font-semibold text-danger">Failed to render this view</div>
      <div class="mt-1 font-mono text-xs text-fg-3">{msg}</div>
    </div>
  )
}

/** Build a route component from a pure-JSON page definition. */
export function jsonPage(view: JsonView): () => JSX.Element {
  const flat = toFlat(view.spec)
  const sources = Object.entries(view.data ?? {})
  return () => {
    const params = useParams()
    const [searchParams] = useSearchParams()
    // Route params + query params, both decoded, in ONE map — sources and
    // views read them uniformly (`/params/task` carries a `?task=` deep
    // link). Route params win on a name collision.
    const decoded = createMemo<Record<string, string>>(() => {
      const o: Record<string, string> = {}
      // Search params arrive already decoded from the router.
      for (const [k, v] of Object.entries(searchParams)) {
        if (v !== undefined) o[k] = String(v)
      }
      for (const [k, v] of Object.entries(params)) o[k] = decodeURIComponent(String(v))
      return o
    })
    // Opt-in live refresh: a `refresh` interval makes every source re-fetch on
    // a visibility-aware tick (paused when the tab is hidden). The tick joins
    // the resource source key below, so the refetch reuses the same machinery
    // as a connection switch.
    const tick = view.refresh !== undefined ? useVisibilityRefresh(view.refresh) : undefined
    // Keyed on route params AND the connection key (origin|token|workspace) so
    // switching server or workspace re-fetches every source in place — the
    // fetchers read the current connection from api.ts at call time.
    const source = createMemo(() => ({ params: decoded(), conn: getConnectionKey(), tick: tick?.() ?? 0 }))
    const resources = sources.map(([key, src]) => {
      const fn = SOURCES[src]
      const [res] = createResource(source, (s) => (fn ? fn(s.params) : Promise.resolve(undefined)))
      return { key, res }
    })
    const state = createMemo<Record<string, unknown>>(() => {
      const s: Record<string, unknown> = { params: decoded(), ...(view.state ?? {}) }
      // Serve capabilities (api.ts probe) as simple booleans every view can
      // gate on. `capsCacheMissing` is true only once the probe RESOLVED and
      // found no cache-entry data — so entry-backed sections degrade to an
      // honest "not available on this serve" hint instead of fake emptiness.
      const caps = capabilities()
      s.capsKnown = caps.known
      s.hasWorkspace = caps.hasWorkspace
      s.capsCacheMissing = caps.known && !caps.hasCacheDb
      s.capsCatalog = caps.known && caps.catalog
      for (const { key, res } of resources) {
        // Read `res.error` BEFORE the value: calling an errored resource's
        // accessor re-throws, which (with no per-source boundary) would blank
        // the whole page. Degrade a failed source to an 'error' status so only
        // its own section falls back to an empty state, never the entire view.
        //
        // Read `res.latest` (the last resolved value), NOT `res()`: on an
        // interval refetch `res.loading` flips true but `latest` still holds
        // the previous value, so the section keeps its data instead of flashing
        // back to the loading skeleton. Only the FIRST load (latest still
        // undefined while loading) shows the skeleton.
        let v: unknown
        let status: 'loading' | 'error' | 'missing' | 'ok'
        if (res.error) status = 'error'
        else {
          v = res.latest
          status = res.loading && v === undefined ? 'loading' : v === null ? 'missing' : v === undefined ? 'loading' : 'ok'
        }
        s[key] = v
        s[`${key}Status`] = status
      }
      return s
    })
    return (
      <ErrorBoundary fallback={(err) => <PageError error={err} />}>
        <Dash spec={flat} state={state()} />
      </ErrorBoundary>
    )
  }
}
