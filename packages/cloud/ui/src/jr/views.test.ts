// View-level guards: the SHIPPED `views/*.json` bindings resolved through the
// REAL `@json-render/core` resolver, exactly as `page.tsx` does.
//
// These pin the two things a helper-level unit test cannot: (a) that the
// bindings actually shipped in the JSON carry the honest behaviour, and (b) —
// for the absence rule — that they carry it for EVERY metric, so a tenth one
// added tomorrow cannot forget. The class this exists for is a dashboard that
// states a confident number for a question it never got an answer to.

import { evaluateVisibility, resolvePropValue } from '@json-render/core'
import { describe, expect, it } from 'bun:test'
import { FUNCTIONS, invocationPassed } from './functions.ts'
import ARTIFACTS from '../views/artifacts.json'
import CACHE from '../views/cache.json'
import CACHE_ENTRY from '../views/cacheEntry.json'
import COMPARE from '../views/compare.json'
import INSIGHTS from '../views/insights.json'
import OVERVIEW from '../views/overview.json'
import PROJECTS from '../views/projects.json'
import PROJECT_DETAIL from '../views/projectDetail.json'
import RUN_DETAIL from '../views/runDetail.json'
import TASKS from '../views/tasks.json'
import TASK_DETAIL from '../views/taskDetail.json'

type Node = Record<string, unknown>

const VIEWS: Array<[string, Node]> = [
  ['artifacts', ARTIFACTS as Node],
  ['cache', CACHE as Node],
  ['cacheEntry', CACHE_ENTRY as Node],
  ['compare', COMPARE as Node],
  ['insights', INSIGHTS as Node],
  ['overview', OVERVIEW as Node],
  ['projects', PROJECTS as Node],
  ['projectDetail', PROJECT_DETAIL as Node],
  ['runDetail', RUN_DETAIL as Node],
  ['tasks', TASKS as Node],
  ['taskDetail', TASK_DETAIL as Node],
]

/** Resolve one prop binding the way the renderer does. */
function resolve(binding: unknown, state: unknown): unknown {
  if (binding === undefined) return undefined
  // `stateModel` is the field @json-render/core reads (NOT `state`).
  return resolvePropValue(binding as never, { stateModel: state, functions: FUNCTIONS } as never)
}

function walk(node: unknown, visit: (n: Node) => void): void {
  if (Array.isArray(node)) {
    for (const v of node) walk(v, visit)
  } else if (node !== null && typeof node === 'object') {
    visit(node as Node)
    for (const v of Object.values(node)) walk(v, visit)
  }
}

/**
 * Every `Metric` element across every shipped view, carrying the `visible`
 * conditions of its ancestors — a tile inside a `Grid` gated on
 * `<key>Status === 'ok'` is not rendered when its source is absent, and must
 * not be judged for what it *would* have said.
 */
function metrics(): Array<{ view: string; props: Node; gates: unknown[] }> {
  const out: Array<{ view: string; props: Node; gates: unknown[] }> = []
  const descend = (node: unknown, view: string, gates: unknown[]): void => {
    if (Array.isArray(node)) {
      for (const v of node) descend(v, view, gates)
      return
    }
    if (node === null || typeof node !== 'object') return
    const n = node as Node
    const next = n['type'] !== undefined && n['visible'] !== undefined ? [...gates, n['visible']] : gates
    if (n['type'] === 'Metric' && n['props'] !== undefined) out.push({ view, props: n['props'] as Node, gates: next })
    for (const v of Object.values(n)) descend(v, view, next)
  }
  for (const [view, doc] of VIEWS) descend(doc, view, [])
  return out
}

/** Would the renderer paint this element under `state`? (the real evaluator) */
function visibleUnder(gates: unknown[], state: unknown): boolean {
  const ctx = { stateModel: state, functions: FUNCTIONS } as never
  return gates.every((g) => evaluateVisibility(g as never, ctx))
}

/** The scalar aggregators — the ones that answer a NUMBER over a row array. */
const SCALAR_AGGREGATORS = new Set(['agg', 'aggFmt', 'aggTone', 'ratioFmt', 'countWhere', 'span', 'countCold', 'coldBytes'])

function usesScalarAggregator(binding: unknown): boolean {
  let found = false
  walk(binding, (n) => {
    if (typeof n['$computed'] === 'string' && SCALAR_AGGREGATORS.has(n['$computed'])) found = true
  })
  return found
}

// --- F1: absence is visibly absent ------------------------------------------

describe('metric tiles never state a number for a source that failed', () => {
  // The state `page.tsx` builds when EVERY source errored / is still loading:
  // the keys are simply not there. `{}` reproduces it for any view.
  const ABSENT = {}

  it('covers a meaningful number of shipped metrics, some of them ungated', () => {
    // Guards the guard: if the walk stops finding metrics (a view renames its
    // element type) or every tile turns out to be gated, the assertions below
    // would silently pass over nothing.
    const all = metrics()
    expect(all.length).toBeGreaterThan(20)
    expect(all.filter((m) => visibleUnder(m.gates, ABSENT)).length).toBeGreaterThan(3)
  })

  it('EVERY aggregate-backed metric STILL ON SCREEN renders — with no data', () => {
    const fabricated: string[] = []
    for (const { view, props, gates } of metrics()) {
      if (!usesScalarAggregator(props['value'])) continue
      if (!visibleUnder(gates, ABSENT)) continue
      const rendered = String(resolve(props['value'], ABSENT))
      if (rendered !== '—') fabricated.push(`${view}: "${String(props['label'])}" = ${rendered}`)
    }
    // Insights' "Avg parallelism" (0.00×) and "Flaky tasks" (0) were the HIGH
    // finding: the only two of the nine aggregate-backed tiles with no gate.
    // Either gate a tile or make it honest — this fails on neither.
    expect(fabricated).toEqual([])
  })

  it('EVERY derived tone STILL ON SCREEN asserts nothing with no data', () => {
    const toned: string[] = []
    for (const { view, props, gates } of metrics()) {
      // A STATIC tone (a plain string) is a styling choice — it can't lie about
      // data it never reads. Only DERIVED tones are in this class.
      const tone = props['tone']
      if (tone === undefined || typeof tone !== 'object') continue
      if (!visibleUnder(gates, ABSENT)) continue
      const resolved = resolve(tone, ABSENT)
      // undefined is "no tone" (MetricCard falls back to default) — fine.
      if (resolved !== undefined && resolved !== 'default') {
        toned.push(`${view}: "${String(props['label'])}" tone=${JSON.stringify(resolved)}`)
      }
    }
    // A failed flaky probe used to paint its tile GREEN (tone 'good').
    expect(toned).toEqual([])
  })

  it('the four Insights headline tiles: absent → —, empty → a real zero, data → the number', () => {
    const grid = (INSIGHTS as Node)['spec'] as Node
    const row = (grid['children'] as Node[]).find((c) => c['type'] === 'Grid')!
    const tiles = (row['children'] as Node[]).map((m) => m['props'] as Node)
    const read = (state: unknown) =>
      tiles.map((p) => `${String(p['label'])}=${String(resolve(p['value'], state))}`)

    expect(read({})).toEqual([
      'Time saved (all-time)=—',
      'Hit rate=—',
      'Avg parallelism=—',
      'Flaky tasks=—',
    ])
    // The server ANSWERED and there is nothing to report — a real zero, not '—'.
    expect(read({ savings: { estimatedTimeSavedTotalMs: 0 }, stats: { hitRate24h: 0 }, parallelism: [], flaky: [] })).toEqual([
      'Time saved (all-time)=<1ms',
      'Hit rate=0%',
      'Avg parallelism=0.00×',
      'Flaky tasks=0',
    ])
    expect(
      read({
        savings: { estimatedTimeSavedTotalMs: 90_000 },
        stats: { hitRate24h: 0.8 },
        parallelism: [{ factor: 3 }, { factor: 5 }],
        flaky: [{}, {}, {}, {}],
      }),
    ).toEqual([
      'Time saved (all-time)=1m 30s',
      'Hit rate=80%',
      'Avg parallelism=4.00×',
      'Flaky tasks=4',
    ])
  })
})

// --- F2: the run's verdict comes from the header ----------------------------

describe('run detail states the run’s real outcome', () => {
  const outcome = (() => {
    let props: Node | undefined
    walk(RUN_DETAIL as Node, (n) => {
      if (n['type'] === 'Metric' && (n['props'] as Node | undefined)?.['label'] === 'Outcome') props = n['props'] as Node
    })
    return props!
  })()
  const tasksTile = (() => {
    let props: Node | undefined
    walk(RUN_DETAIL as Node, (n) => {
      if (n['type'] === 'Metric' && (n['props'] as Node | undefined)?.['label'] === 'Tasks') props = n['props'] as Node
    })
    return props!
  })()

  const read = (state: unknown) => ({
    value: resolve(outcome['value'], state),
    tone: resolve(outcome['tone'], state),
    sub: resolve(outcome['sub'], state),
  })
  const task = (over: Node = {}) => ({ status: 'success', cacheHit: false, ...over })
  const header = (over: Node = {}) => ({ runId: 'r1', failedCount: 0, exitOk: true, ...over })

  it('a --verify run whose tasks all exited 0 reads FAILED, agreeing with the Runs list', () => {
    // `--verify` proving outputs non-reproducible leaves the task row 'success'
    // (execute-task does not flip its exit code) while `run.ts` makes ok false.
    const inv = header({ exitOk: false })
    const state = { run: { tasks: [task()] }, invocation: inv }
    expect(read(state)).toEqual({ value: 'failed', tone: 'bad', sub: '' })
    expect(invocationPassed(inv)).toBe(false) // the Runs list / CI strip
  })

  it('an aborted task leaves no row at all — the run still reads FAILED', () => {
    // run.ts excludes aborted outcomes from telemetry, so nothing is stored.
    const state = { run: { tasks: [task()] }, invocation: header({ exitOk: false, taskCount: 1 }) }
    expect(read(state).value).toBe('failed')
  })

  it('a genuinely green run still reads success (control)', () => {
    const state = {
      run: { tasks: [task(), task({ status: 'cache-hit', cacheHit: true })] },
      invocation: header({ hitCount: 1 }),
    }
    expect(read(state)).toEqual({ value: 'success', tone: 'good', sub: '' })
    expect(invocationPassed(state.invocation)).toBe(true)
  })

  it('a genuinely failed run still reads failed (control)', () => {
    const state = {
      run: { tasks: [task({ status: 'failed' })] },
      invocation: header({ failedCount: 1, exitOk: false }),
    }
    expect(read(state).value).toBe('failed')
  })

  it('an in-flight run states nothing rather than a premature green', () => {
    // Task rows are ingested per task; the invocation header only at run end,
    // so /v1/invocations/:id 404s ('missing') for the whole live run.
    expect(read({ run: { tasks: [task()] }, invocationStatus: 'missing' })).toEqual({
      value: '—',
      tone: 'default',
      sub: 'run header not recorded yet',
    })
    // …but a failed row PROVES the run red even without the header.
    expect(read({ run: { tasks: [task(), task({ status: 'failed' })] }, invocationStatus: 'missing' }).value).toBe('failed')
    // A failed header FETCH must not be reported as "not recorded yet".
    expect(read({ run: { tasks: [task()] }, invocationStatus: 'error' }).sub).toBe('run header unavailable')
  })

  it('the task breakdown accounts for every recorded row, skipped included', () => {
    const rows = [
      task(),
      task({ status: 'failed' }),
      task({ status: 'skipped' }),
      task({ status: 'cache-hit', cacheHit: true }),
      task({ status: 'cache-hit-remote', cacheHit: true }),
    ]
    const state = { run: { tasks: rows }, invocation: header({ exitOk: false, failedCount: 1 }) }
    expect(resolve(tasksTile['value'], state)).toBe('5')
    // ok + fail + skipped + hits must reconcile with the total: `skipped` rows
    // (stored since telemetry widened to every non-aborted outcome) used to
    // fall outside all three buckets.
    expect(resolve(tasksTile['sub'], state)).toBe('1 ok · 1 fail · 1 skipped · 2 hits')
  })
})
