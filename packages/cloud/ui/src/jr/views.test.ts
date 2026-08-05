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
import { compareRowOf, triageRowOf } from './data.ts'
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
    // `flaky` is a PAGE + its workspace total, so a real zero is `total: 0`.
    expect(read({ savings: { estimatedTimeSavedTotalMs: 0 }, stats: { hitRate24h: 0 }, parallelism: [], flaky: { rows: [], total: 0, shown: 0 } })).toEqual([
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
        flaky: { rows: [{}, {}, {}, {}], total: 4, shown: 4 },
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

// --- F5: the compare table passes no PERFORMANCE verdict on a restore --------

describe('compare never judges a cache restore against an execution', () => {
  /** The `neutralKey` the SHIPPED compare.json hands the deltaBar cell. */
  const neutralKey = ((): string => {
    let found: string | undefined
    walk(COMPARE as Node, (n) => {
      if (n['kind'] === 'deltaBar' && typeof n['neutralKey'] === 'string') found = n['neutralKey']
    })
    if (found === undefined) throw new Error('compare.json has no deltaBar neutralKey')
    return found
  })()

  /** `components.tsx`'s deltaBar tone decision, verbatim. */
  function tone(row: Record<string, unknown>): 'faint' | 'danger' | 'success' {
    const v = Number(row['deltaMs'])
    const base = Math.abs(Number(row['baseMs'])) || 0
    const measured = Number(row['_noiseMs'])
    const flat = Number.isFinite(measured) && measured > 0 ? measured : Math.max(5, base * 0.005)
    const neutral = row[neutralKey] === true || !Number.isFinite(v) || Math.abs(v) < flat
    return neutral ? 'faint' : v > 0 ? 'danger' : 'success'
  }

  const side = (durationMs: number, cacheHit: boolean) => ({
    status: 'success',
    durationMs,
    hash: cacheHit ? 'K' : 'K2',
    cacheHit,
    exitCode: 0,
  })
  const row = (a: ReturnType<typeof side>, b: ReturnType<typeof side>) =>
    compareRowOf({
      taskId: 'web#build',
      project: 'web',
      task: 'build',
      a,
      b,
      hashChanged: true,
      durationDeltaMs: a.durationMs - b.durationMs,
      noiseCv: 0.05,
      statusChanged: false,
    } as never) as unknown as Record<string, unknown>

  it('the shipped view reads a key the mapper actually sets', () => {
    expect(row(side(2000, false), side(1000, false))[neutralKey]).toBeDefined()
  })

  it('an execution against a restored predecessor passes no verdict', () => {
    // The ordinary warm-CI shape: you edited the task, so THIS run executed
    // while the PREVIOUS run was restored from cache in 4ms.
    expect(tone(row(side(2000, false), side(4, true)))).toBe('faint')
  })

  it('a restore against an executed predecessor passes no verdict either', () => {
    expect(tone(row(side(4, true), side(2000, false)))).toBe('faint')
  })

  it('two real executions are still judged in both directions', () => {
    expect(tone(row(side(2000, false), side(1000, false)))).toBe('danger')
    expect(tone(row(side(1000, false), side(2000, false)))).toBe('success')
  })
})

// --- F7: triage never claims a task is running for the first time -----------

describe('triage evidence distinguishes "no key" from "no earlier run"', () => {
  const row = (over: Record<string, unknown>) =>
    triageRowOf({
      taskId: 'web#dev',
      project: 'web',
      task: 'dev',
      verdict: 'new-failure',
      sameKeySuccesses: 0,
      defaultBranchFailing: false,
      defaultBranchRunId: null,
      keyChanged: null,
      previousRunId: null,
      ...over,
    } as never)

  it('a keyless SUBJECT with a previous run says so, and stops claiming a first run', () => {
    // `vx run dev` failing to become ready on its 500th run: persistent tasks
    // are never cacheable, so the subject has no key while an earlier keyed
    // run plainly exists — the server hands us its id.
    const r = row({ previousRunId: 'run-499' })
    expect(r['_evidence']).toBe('this task records no cache key, so its inputs cannot be compared')
    // The row links to that run, so the sentence beside it must not deny it.
    expect(r['_evidenceRunId']).toBe('run-499')
    expect(String(r['_evidence'])).not.toContain('first recorded run')
  })

  it('genuinely no earlier keyed run says THAT, not "first run of this task"', () => {
    const r = row({ previousRunId: null })
    expect(r['_evidence']).toBe('no earlier keyed run of this task to compare inputs against')
    expect(String(r['_evidence'])).not.toContain('first recorded run')
  })

  it('the verdicts that DO have key evidence are unchanged', () => {
    expect(row({ keyChanged: true, previousRunId: 'p' })['_evidence']).toBe(
      'first failure of this key — this run changed the task’s inputs',
    )
    expect(row({ keyChanged: false, previousRunId: 'p' })['_evidence']).toBe(
      'first failure of this key',
    )
    expect(String(row({ verdict: 'flaky', sameKeySuccesses: 3 })['_evidence'])).toContain(
      'passed 3× in other runs',
    )
  })
})

// --- F8: the flaky headline counts the WORKSPACE, not the page --------------

describe('the flaky headline reports the workspace, not the page size', () => {
  const tile = (() => {
    let found: Node | undefined
    walk(INSIGHTS as Node, (n) => {
      if (n['type'] === 'Metric' && (n['props'] as Node)?.['label'] === 'Flaky tasks')
        found = n['props'] as Node
    })
    if (found === undefined) throw new Error('insights.json has no "Flaky tasks" metric')
    return found
  })()
  const PAGE = 25
  const state = (total: number | undefined) => {
    const shown = Math.min(total ?? 0, PAGE)
    return {
      flaky: {
        rows: Array.from({ length: shown }, (_, i) => ({ id: `t${i}` })),
        total,
        shown,
        _truncated: total !== undefined && total > shown,
      },
    }
  }

  it('reads the real count past the page, in both directions', () => {
    expect(resolve(tile['value'], state(7))).toBe('7')
    expect(resolve(tile['value'], state(25))).toBe('25')
    // The two that used to read "25".
    expect(resolve(tile['value'], state(60))).toBe('60')
    expect(resolve(tile['value'], state(200))).toBe('200')
  })

  it('an older serve sends no total, so the tile claims nothing', () => {
    // Absent must not silently degrade to the page length — that is the very
    // number this fix removed.
    expect(resolve(tile['value'], state(undefined))).toBe('—')
    expect(resolve(tile['tone'], state(undefined))).toBe('default')
  })

  it('still tones a clean workspace green and a flaky one warn', () => {
    expect(resolve(tile['tone'], state(0))).toBe('good')
    expect(resolve(tile['tone'], state(3))).toBe('warn')
  })

  it('the card admits truncation only when the total PROVES it', () => {
    const callout = (() => {
      let found: Node | undefined
      walk(INSIGHTS as Node, (n) => {
        if (n['type'] === 'Callout' && JSON.stringify(n).includes('flakiest')) found = n
      })
      if (found === undefined) throw new Error('insights.json has no flaky truncation callout')
      return found
    })()
    const shows = (total: number | undefined): boolean =>
      visibleUnder([callout['visible']], state(total))
    expect(shows(60)).toBe(true)
    expect(shows(25)).toBe(false)
    expect(shows(undefined)).toBe(false)
    expect(String(resolve((callout['props'] as Node)['text'], state(60)))).toBe(
      'showing the 25 flakiest of 60 — open a task for its own history',
    )
  })
})

// --- F11: the Debug card stops asserting an artifact does not exist ---------

describe('task debug never claims "no artifact" on a serve that holds no inventory', () => {
  /** Every typed element with the `visible` gates of its ancestors. */
  function elements(doc: Node): Array<{ n: Node; gates: unknown[] }> {
    const out: Array<{ n: Node; gates: unknown[] }> = []
    const descend = (node: unknown, gates: unknown[]): void => {
      if (Array.isArray(node)) {
        for (const v of node) descend(v, gates)
        return
      }
      if (node === null || typeof node !== 'object') return
      const n = node as Node
      const next = n['type'] !== undefined && n['visible'] !== undefined ? [...gates, n['visible']] : gates
      if (n['type'] !== undefined) out.push({ n, gates: next })
      for (const v of Object.values(n)) descend(v, next)
    }
    descend(doc, [])
    return out
  }
  const debugLists = elements(TASK_DETAIL as Node).filter(
    (e) => e['n']['type'] === 'RankList' && JSON.stringify((e.n['props'] as Node)['items']).includes('_debug'),
  )
  const state = (capsCacheMissing: boolean) => ({
    capsCacheMissing,
    detailStatus: 'ok',
    detail: {
      _debug: {
        runs: [],
        // Null by construction on a platform serve (analytics.ts:1998).
        artifact: [],
        store: [{ label: 'Artifacts for this task — store listing + download', _taskId: 'web#build' }],
      },
    },
  })
  const shownWith = (props: (p: Node) => boolean, caps: boolean) =>
    debugLists.filter((e) => props(e.n['props'] as Node) && visibleUnder(e.gates, state(caps)))

  const isEntryList = (p: Node) => String(JSON.stringify(p['items'])).includes('/artifact')
  const isStoreList = (p: Node) => String(JSON.stringify(p['items'])).includes('/store')

  it('the entry-backed list is not rendered where entry inventory cannot exist', () => {
    // Its empty title is a claim ("No cached artifact yet") that was false for
    // EVERY task on EVERY platform deployment.
    expect(shownWith(isEntryList, true)).toHaveLength(0)
    // …and is untouched on a colocated serve, where `latestEntry` is real.
    expect(shownWith(isEntryList, false)).toHaveLength(1)
  })

  it('a route to the artifact store is offered in BOTH modes', () => {
    expect(shownWith(isStoreList, true)).toHaveLength(1)
    expect(shownWith(isStoreList, false)).toHaveLength(1)
  })

  it('the route row declares no value, so none is fabricated', () => {
    // A navigation row has no timestamp. `RankList` rendered
    // `Number(undefined)` unconditionally, so the real browser painted a
    // literal 'NaN' in the value column (caught by the visual capture).
    const props = shownWith(isStoreList, true)[0]!.n['props'] as Node
    expect(props['valueKey']).toBeUndefined()
  })

  it('that route lands on the artifacts page pre-filtered to this task', () => {
    const props = shownWith(isStoreList, true)[0]!.n['props'] as Node
    expect(props['rowHref']).toBe('/artifacts?q={_taskId}')
    const rows = resolve(props['items'], state(true)) as Array<Record<string, unknown>>
    expect(rows[0]!['_taskId']).toBe('web#build')
    // The artifacts table has to READ that param, or the link is decoration.
    let searchParam: unknown
    walk(ARTIFACTS as Node, (n) => {
      if (n['type'] === 'DataTable') searchParam = (n['props'] as Node)['searchParam']
    })
    expect(searchParam).toBe('q')
  })

  it('the cache-entry page explains absence instead of inventing a cause', () => {
    const empties = elements(CACHE_ENTRY as Node).filter((e) => e.n['type'] === 'Empty')
    const titlesFor = (capsCacheMissing: boolean) =>
      empties
        .filter((e) => visibleUnder(e.gates, { capsCacheMissing, entryStatus: 'missing' }))
        .map((e) => String((e.n['props'] as Node)['title']))
    // "may have been pruned" is a fabricated cause where inventory never exists.
    expect(titlesFor(true)).toEqual(['Cache-entry details are not available on this serve'])
    expect(titlesFor(false)).toEqual(['No cache entry with this hash'])
  })

  it('the Cache key card does not tell a platform user to re-run a task they already ran', () => {
    // `explainCacheKey` returns `latestEntry: null` UNCONDITIONALLY — the
    // platform has no entries table, so there is no query and no future push
    // that fills it. The card read that null as "not yet" and rendered
    // "run this task once to populate its cache key" for EVERY task, including
    // ones with hundreds of recorded runs; following it can never work.
    // Confirmed against a real platform: ingest a run, then GET /v1/explain →
    // latestEntry null, card → the run-it-once hint.
    const cardEmpties = elements(TASK_DETAIL as Node).filter(
      (e) =>
        e.n['type'] === 'Empty' &&
        String(JSON.stringify(e.gates)).includes('capsCacheMissing') &&
        String(JSON.stringify((e.n['props'] as Node)['title'])).match(/cache|entry/i) !== null,
    )
    const titlesFor = (capsCacheMissing: boolean) =>
      cardEmpties
        .filter((e) =>
          visibleUnder(e.gates, {
            capsCacheMissing,
            cacheKeyStatus: 'ok',
            cacheKey: { latestEntry: null },
          }),
        )
        .map((e) => String((e.n['props'] as Node)['title']))

    // Where inventory can never exist: say so, and point at where it lives.
    expect(titlesFor(true)).toContain('Cache-entry details are not available on this serve')
    expect(titlesFor(true)).not.toContain('No cached entry yet')
    // On a colocated serve an entry genuinely CAN appear, so the original hint
    // is accurate there and must survive — this is the control that stops the
    // fix degenerating into "never explain an absent entry".
    expect(titlesFor(false)).toContain('No cached entry yet')
  })
})
