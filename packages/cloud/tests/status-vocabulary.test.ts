// The dashboard's copy of "is this a cache hit?" must answer exactly what
// core's does.
//
// This is the ONE place in the repo where the status vocabulary genuinely
// cannot be shared: `packages/cloud/ui` is a standalone browser bundle that
// declares no dependency on `@vzn/vx` (see its package.json — solid, vite,
// unocss, nothing else), so `ui/src/components/status.tsx` has to carry its
// own `isCacheHit`. Everywhere else the sweep that added this collapsed ten
// hand-rolled copies onto core's predicate; here the honest answer was a
// second definition plus a guard that it agrees.
//
// The check reads the dashboard's SOURCE rather than importing it, and both
// reasons are worth knowing:
//
//   1. `packages/cloud/tsconfig.json` deliberately scopes to `src/` + `tests/`
//      and sets no `jsx` — the UI compiles under its OWN tsconfig (DOM lib,
//      solid JSX). Importing a `.tsx` from a cloud test makes the lint gate
//      fail `TS6142: '--jsx' is not set`, and widening the cloud tsconfig to
//      swallow UI files would break confusingly the day this file imports a
//      real component.
//   2. Renaming it to `.ts` — tempting, and it was checked — is REFUSED:
//      `uno.config.ts` states that UnoCSS's default pipeline scans `.tsx` but
//      NOT plain `.ts`, and this file holds the literal class strings for every
//      status colour. The rename would silently drop them from the built CSS.
//
// So the table is extracted from the text, and the extraction is strict: a
// formatting change it cannot parse THROWS rather than passing vacuously.

import { describe, expect, it } from 'bun:test'
import { isCacheHit as coreIsCacheHit, isPassStatus, TASK_STATUSES } from '@vzn/vx'

const UI_STATUS = new URL('../ui/src/components/status.tsx', import.meta.url)

/** Parse the dashboard's `CACHE_HIT` record out of its source. */
function readUiCacheHitTable(src: string): ReadonlyMap<string, boolean> {
  const block = src.match(/const CACHE_HIT: Record<VizState, boolean> = \{([\s\S]*?)\n\}/)
  if (block?.[1] === undefined) {
    throw new Error(
      'could not locate `const CACHE_HIT: Record<VizState, boolean>` in ui/src/components/status.tsx. ' +
        'If it was renamed or restructured, update THIS parser — do not delete the guard: it is the only ' +
        'thing tying the dashboard vocabulary to core.',
    )
  }
  const table = new Map<string, boolean>()
  for (const line of block[1].split('\n')) {
    const entry = line.match(/^\s*'?([A-Za-z][A-Za-z0-9-]*)'?\s*:\s*(true|false)\s*,?\s*$/)
    if (entry?.[1] !== undefined && entry[2] !== undefined) table.set(entry[1], entry[2] === 'true')
  }
  // Non-vacuity: the union has nine members today, and a parser that silently
  // matched none would make every assertion below trivially pass.
  if (table.size < 6) {
    throw new Error(
      `parsed only ${table.size} CACHE_HIT entries — the extraction is broken, not the code`,
    )
  }
  return table
}

const src = await Bun.file(UI_STATUS).text()
const uiTable = readUiCacheHitTable(src)
const uiIsCacheHit = (status: string): boolean => uiTable.get(status) === true

describe('the dashboard status vocabulary tracks core', () => {
  it('agrees with core on every TaskStatus', () => {
    // Iterates the REAL union rather than a list written here, so adding a
    // status to core and forgetting the dashboard fails immediately — which is
    // the failure this guard exists for.
    for (const status of TASK_STATUSES) {
      expect({ status, ui: uiIsCacheHit(status) }).toEqual({
        status,
        ui: coreIsCacheHit(status),
      })
    }
  })

  it('names every core status, rather than agreeing by omission', () => {
    // Without this, a dashboard table missing `cache-hit-remote` entirely would
    // still "agree" for every status core calls a non-hit. The dashboard's
    // `VizState` is a SUPERSET (it adds render-only states), so the containment
    // is checked one way only.
    const missing = TASK_STATUSES.filter((s) => !uiTable.has(s))
    expect(missing).toEqual([])
  })

  it('classifies the dashboard-only render states as not-a-hit', () => {
    // These never arrive from core — they are states the cockpit invents while
    // a run is in flight, plus the umbrella-task marker. A hit is a RESULT, so
    // none of them can be one; `queued` in particular reaching the critical
    // path as a "restores ahead" node would drop real work off the wall-time
    // floor the panel reports.
    for (const state of ['queued', 'running', 'group']) {
      expect({ state, known: uiTable.has(state), hit: uiIsCacheHit(state) }).toEqual({
        state,
        known: true,
        hit: false,
      })
    }
  })

  it('reads an unknown string as not-a-hit, like core', () => {
    for (const junk of ['', 'cache-hit-magnetic', 'toString', '__proto__']) {
      expect({ junk, ui: uiIsCacheHit(junk), core: coreIsCacheHit(junk) }).toEqual({
        junk,
        ui: false,
        core: false,
      })
    }
  })

  it('exposes the predicate the two views were routed onto', () => {
    // The cockpit's critical path and the recorded-run graph both hand-rolled
    // the comparison before this existed. That they no longer INLINE it is
    // asserted repo-wide by core's `tests/status-vocabulary.test.ts`, whose
    // no-inline scan covers `packages/cloud/ui/src`; what belongs here is that
    // the thing they were routed onto is actually exported.
    expect(src).toContain('export function isCacheHit')
  })

  it('core still exports the predicates the dashboard is being held to', () => {
    // A vacuous version of this suite — an empty union — would pass everything
    // above, so assert the set is real and the predicate is live.
    expect(TASK_STATUSES.length).toBeGreaterThan(0)
    expect(isPassStatus('success')).toBe(true)
    expect(isPassStatus('failed')).toBe(false)
    expect(coreIsCacheHit('cache-hit-remote')).toBe(true)
  })
})
