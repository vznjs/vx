// Generic loader that turns a pure-JSON page definition into a rendered view.
// A page declares its data sources by name + a (nested or flat) json-render
// spec; this fetches the sources into `state`, exposes decoded route `params`
// and a `<key>Status` flag per source (loading | missing | ok) for `visible`
// gating, and renders the spec through the shared registry. This is the ONLY
// per-page machinery — the pages themselves are pure data.

import { type JSX, createMemo, createResource } from 'solid-js'
import { useParams } from '@solidjs/router'
import { nestedToFlat } from '@json-render/core'
import type { Spec } from '@json-render/solid'
import { Dash } from './renderer.tsx'
import { SOURCES } from './data.ts'

export interface JsonView {
  /** stateKey → data-source name (see data.ts). */
  data?: Record<string, string>
  /** static state merged in (e.g. constants). */
  state?: Record<string, unknown>
  /** nested ({type,props,children}) or flat ({root,elements}) json-render spec. */
  spec: Record<string, unknown>
}

const toFlat = (spec: Record<string, unknown>): Spec => ('elements' in spec ? (spec as unknown as Spec) : nestedToFlat(spec))

/** Build a route component from a pure-JSON page definition. */
export function jsonPage(view: JsonView): () => JSX.Element {
  const flat = toFlat(view.spec)
  const sources = Object.entries(view.data ?? {})
  return () => {
    const params = useParams()
    const decoded = createMemo<Record<string, string>>(() => {
      const o: Record<string, string> = {}
      for (const [k, v] of Object.entries(params)) o[k] = decodeURIComponent(String(v))
      return o
    })
    const resources = sources.map(([key, src]) => {
      const fn = SOURCES[src]
      const [res] = createResource(decoded, (p) => (fn ? fn(p) : Promise.resolve(undefined)))
      return { key, res }
    })
    const state = createMemo<Record<string, unknown>>(() => {
      const s: Record<string, unknown> = { params: decoded(), ...(view.state ?? {}) }
      for (const { key, res } of resources) {
        const v = res()
        s[key] = v
        s[`${key}Status`] = res.loading ? 'loading' : v === null ? 'missing' : v === undefined ? 'loading' : 'ok'
      }
      return s
    })
    return <Dash spec={flat} state={state()} />
  }
}
