// The shared outcome tally: ONE fold, three surfaces.
//
// `summary.ts` (the terminal footer), `run-artifacts.ts` (the `--summarize`
// JSON) and `run-report.ts` (`--report=markdown`) all describe the same run
// out of these numbers. The report used to carry its own copy of the
// partition and it drifted: it had no group filter (it could not have one —
// `OutcomeView` carried no `isGroup`), so every organizational node was
// counted as a successful task and rendered as a row claiming
// `success | miss | 0ms`.
//
// So the load-bearing property here is not any single count but that the two
// entry points AGREE: `tallyOutcomes` (live `TaskOutcome`s, group-ness read
// off the node) and `tallyViews` (the serializable `OutcomeView`, group-ness
// carried as a flag) must answer identically for the same run. The
// equivalence block below is that guard — driven through the real
// `projectOutcome` projection, so a drift in EITHER the fold or the
// projection fails it. The rest pins the bucket rules the three consumers
// derive from.

import { describe, expect, it } from 'bun:test'
import { projectOutcome } from '../src/orchestrator/events.js'
import { tallyOutcomes, tallyViews, type Tally, type TallyItem } from '../src/orchestrator/tally.js'
import type { TaskNode, TaskOutcome, TaskStatus } from '../src/graph/index.js'

const ZERO: Tally = {
  successful: 0,
  failed: 0,
  skipped: 0,
  cachedLocal: 0,
  restoredLocal: 0,
  restoredRemote: 0,
  upToDate: 0,
  cachedRemote: 0,
  aborted: 0,
  total: 0,
}

/** Expected tally: every field zero except the named ones. Assertions compare
 *  the WHOLE object, so a stray increment anywhere fails the case that caused
 *  it rather than leaking into some later, unrelated test. */
function tally(over: Partial<Tally>): Tally {
  return { ...ZERO, ...over }
}

interface Shape {
  status: TaskStatus
  restored?: boolean
  /** No `exec` — an umbrella node that chains `dependsOn` and runs nothing. */
  group?: boolean
  /** A dev server: real `exec`, resolves at ready, never carries a hash. */
  persistent?: boolean
}

function mkNode(id: string, s: Shape): TaskNode {
  const [projectName, taskName] = id.split('#') as [string, string]
  return {
    id,
    projectName,
    taskName,
    projectDir: `/tmp/${projectName}`,
    deps: [],
    requested: true,
    config:
      s.group === true
        ? {}
        : {
            exec: {
              command: 'noop',
              ...(s.persistent === true ? { persistent: { readyWhen: 'ready' } } : {}),
            },
          },
  }
}

function mkOutcome(id: string, s: Shape): TaskOutcome {
  const o: TaskOutcome = {
    node: mkNode(id, s),
    status: s.status,
    exitCode: s.status === 'failed' ? 1 : s.status === 'aborted' ? 143 : 0,
    durationMs: 100,
  }
  if (s.restored !== undefined) o.restored = s.restored
  return o
}

/**
 * Every status and the buckets one item of it lands in (with no `restored`
 * flag — the hit split is exercised separately). Typed as an exhaustive
 * `Record<TaskStatus, …>` on purpose: a seventh `TaskStatus` cannot be added
 * to the scheduler without this table failing to typecheck, which is where
 * you get told to give it a bucket. `STATUSES` derives from these keys so
 * every matrix below widens with it automatically.
 */
const BUCKETS: Record<TaskStatus, Partial<Tally>> = {
  success: { total: 1, successful: 1 },
  'cache-hit': { total: 1, successful: 1, cachedLocal: 1, upToDate: 1 },
  'cache-hit-remote': { total: 1, successful: 1, cachedRemote: 1, upToDate: 1 },
  failed: { total: 1, failed: 1 },
  skipped: { total: 1, skipped: 1 },
  // Killed by a shutdown signal: no work happened, so no bucket and no
  // total — but counted, because it is what makes the run red.
  aborted: { aborted: 1 },
}

const STATUSES = Object.keys(BUCKETS) as TaskStatus[]

/** status × restored × group — every combination the two entry points can
 *  legally be handed. */
const MATRIX: readonly Shape[] = STATUSES.flatMap((status) =>
  [true, false, undefined].flatMap((restored) =>
    [false, true].map(
      (group): Shape => ({ status, group, ...(restored === undefined ? {} : { restored }) }),
    ),
  ),
)

const label = (s: Shape): string =>
  `${s.status} restored=${String(s.restored)} group=${String(s.group === true)}`

describe('tallyOutcomes — bucket rules', () => {
  it('an empty run is all zeros', () => {
    expect(tallyOutcomes([])).toEqual(ZERO)
    expect(tallyViews([])).toEqual(ZERO)
  })

  it('exposes exactly the ten documented fields', () => {
    // `writeRunSummary` serializes this object VERBATIM as `summary` in the
    // `--summarize` artifact, which CI jobs gate on. Adding, dropping or
    // renaming a field is a change to a documented machine-readable payload,
    // not an internal refactor.
    expect(Object.keys(tallyOutcomes([])).sort()).toEqual([...Object.keys(ZERO)].sort())
  })

  it('each status lands in exactly its documented buckets', () => {
    for (const status of STATUSES) {
      const got = tallyOutcomes([mkOutcome('pkg#t', { status })])
      expect({ status, ...got }).toEqual({ status, ...tally(BUCKETS[status]) })
    }
  })

  it("a hit's restored flag splits local/remote from up-to-date", () => {
    // The cache meter renders these as three differently-coloured segments
    // ("2 up-to-date · 1 local · 1 remote"), so conflating them mislabels
    // what the cache actually did this run.
    expect(tallyOutcomes([mkOutcome('a#x', { status: 'cache-hit', restored: true })])).toEqual(
      tally({ total: 1, successful: 1, cachedLocal: 1, restoredLocal: 1 }),
    )
    expect(tallyOutcomes([mkOutcome('a#x', { status: 'cache-hit', restored: false })])).toEqual(
      tally({ total: 1, successful: 1, cachedLocal: 1, upToDate: 1 }),
    )
    expect(
      tallyOutcomes([mkOutcome('a#x', { status: 'cache-hit-remote', restored: true })]),
    ).toEqual(tally({ total: 1, successful: 1, cachedRemote: 1, restoredRemote: 1 }))
    expect(
      tallyOutcomes([mkOutcome('a#x', { status: 'cache-hit-remote', restored: false })]),
    ).toEqual(tally({ total: 1, successful: 1, cachedRemote: 1, upToDate: 1 }))
  })

  it('a hit with no restored flag reads as up-to-date, never as a restore', () => {
    // `projectOutcome` omits `restored` when the outcome has none, and an
    // older serve's wire payload can lack it entirely. Claiming a restore
    // there would report files written that never were.
    expect(tallyOutcomes([mkOutcome('a#x', { status: 'cache-hit' })])).toEqual(
      tally({ total: 1, successful: 1, cachedLocal: 1, upToDate: 1 }),
    )
    expect(tallyOutcomes([mkOutcome('a#x', { status: 'cache-hit-remote' })])).toEqual(
      tally({ total: 1, successful: 1, cachedRemote: 1, upToDate: 1 }),
    )
  })

  it('cachedLocal / cachedRemote count every hit, restored or not', () => {
    const t = tallyOutcomes([
      mkOutcome('a#x', { status: 'cache-hit', restored: true }),
      mkOutcome('b#x', { status: 'cache-hit', restored: false }),
      mkOutcome('c#x', { status: 'cache-hit-remote', restored: true }),
      mkOutcome('d#x', { status: 'cache-hit-remote', restored: false }),
    ])
    // `formatRunSummary` derives misses as `total − skipped − (cachedLocal +
    // cachedRemote)`, so a hit missing from these two counts is reported as
    // an execution that never happened.
    expect(t.cachedLocal).toBe(2)
    expect(t.cachedRemote).toBe(2)
    expect(t.total - t.skipped - (t.cachedLocal + t.cachedRemote)).toBe(0)
  })

  it('the restored flag is only meaningful for hits', () => {
    // It is documented undefined on non-hit outcomes; pinning that the split
    // lives INSIDE the two hit branches stops a refactor from hoisting it to
    // a top-level check and inventing restores for executed tasks.
    for (const status of ['success', 'failed', 'skipped', 'aborted'] as const) {
      const withFlag = tallyOutcomes([mkOutcome('pkg#t', { status, restored: true })])
      expect({ status, ...withFlag }).toEqual({ status, ...tally(BUCKETS[status]) })
    }
  })

  it('aborted is neither a success nor a failure, and never in total', () => {
    // The 2026-07-26 wave made abort a distinct status precisely so it does
    // not read as either: a task killed by a signal did no work (so it earns
    // no bucket) yet it makes the run exit non-zero (so it must be counted
    // somewhere, or the red exit names nothing).
    expect(tallyOutcomes([mkOutcome('pkg#dev', { status: 'aborted' })])).toEqual(
      tally({ aborted: 1 }),
    )
    const mixed = tallyOutcomes([
      mkOutcome('a#x', { status: 'success' }),
      mkOutcome('b#x', { status: 'aborted' }),
      mkOutcome('c#x', { status: 'aborted' }),
    ])
    expect(mixed).toEqual(tally({ total: 1, successful: 1, aborted: 2 }))
  })

  it('skipped counts toward total', () => {
    // Both meters render skipped as their yellow segment and the legends are
    // compared against "N total" by eye; dropping it from the total made the
    // cache legend sum below the tasks legend (owner-reported).
    const t = tallyOutcomes([
      mkOutcome('a#x', { status: 'success' }),
      mkOutcome('b#x', { status: 'skipped' }),
      mkOutcome('c#x', { status: 'skipped' }),
    ])
    expect(t).toEqual(tally({ total: 3, successful: 1, skipped: 2 }))
  })

  it('a persistent task carries no cache key and is still counted', () => {
    // The sibling `toRecord` path filtered on `!o.hash`, which selects
    // exactly {skipped, persistent} — a failing dev server then recorded
    // `0 tasks, 0 failures` on a run the terminal called red. The tally
    // buckets by STATUS and must never acquire a hash-shaped filter.
    const t = tallyOutcomes([
      mkOutcome('web#dev', { status: 'success', persistent: true }),
      mkOutcome('api#dev', { status: 'failed', persistent: true }),
    ])
    expect(t).toEqual(tally({ total: 2, successful: 1, failed: 1 }))
    // ...and they count as misses: a dev server executed, it hit no cache.
    expect(t.total - t.skipped - (t.cachedLocal + t.cachedRemote)).toBe(2)
  })

  it('accumulates a realistic mixed run', () => {
    const t = tallyOutcomes([
      mkOutcome('web#build', { status: 'success' }),
      mkOutcome('api#build', { status: 'cache-hit', restored: true }),
      mkOutcome('lib#build', { status: 'cache-hit', restored: false }),
      mkOutcome('ui#build', { status: 'cache-hit-remote', restored: true }),
      mkOutcome('web#test', { status: 'failed' }),
      mkOutcome('api#test', { status: 'skipped' }),
      mkOutcome('web#ci', { status: 'success', group: true }),
      mkOutcome('web#dev', { status: 'aborted' }),
    ])
    expect(t).toEqual(
      tally({
        total: 6,
        successful: 4,
        failed: 1,
        skipped: 1,
        cachedLocal: 2,
        cachedRemote: 1,
        restoredLocal: 1,
        restoredRemote: 1,
        upToDate: 1,
        aborted: 1,
      }),
    )
  })

  it('the numbers do not depend on the order outcomes finished in', () => {
    // Outcomes arrive in completion order, which varies with concurrency
    // between two runs of the same graph. The summary must not.
    const all = MATRIX.map((s, i) => mkOutcome(`pkg#t${i}`, s))
    const base = tallyOutcomes(all)
    expect(tallyOutcomes([...all].reverse())).toEqual(base)
    expect(
      tallyOutcomes([...all.filter((_, i) => i % 2 === 0), ...all.filter((_, i) => i % 2 === 1)]),
    ).toEqual(base)
  })

  it('returns a fresh tally per call — no accumulator is shared between runs', () => {
    // `emptyTally()` is a factory; demoting it to a module-level constant
    // would make every run after the first report the previous one's counts
    // (and `vx watch` re-invokes `run()` in one process).
    const first = tallyOutcomes([
      mkOutcome('a#x', { status: 'success' }),
      mkOutcome('b#x', { status: 'aborted' }),
    ])
    const second = tallyOutcomes([])
    expect(second).toEqual(ZERO)
    expect(second).not.toBe(first)
    expect(first).toEqual(tally({ total: 1, successful: 1, aborted: 1 }))
    expect(tallyViews([])).not.toBe(tallyViews([]))
  })
})

describe('group tasks are excluded from every count', () => {
  it('a group contributes nothing, whatever status it ended with', () => {
    for (const status of STATUSES) {
      const got = tallyOutcomes([mkOutcome('pkg#ci', { status, group: true })])
      expect({ status, ...got }).toEqual({ status, ...ZERO })
    }
  })

  it('a group killed by a signal is still not a task', () => {
    // The group guard runs BEFORE the aborted guard. Swap them and an
    // umbrella node — which spawned nothing and so cannot have been killed —
    // starts appearing in the Aborted count that explains a red exit.
    expect(tallyOutcomes([mkOutcome('pkg#ci', { status: 'aborted', group: true })])).toEqual(ZERO)
  })

  it('a group never dilutes the real tasks around it', () => {
    // The historical `--report` defect: an umbrella node counted as work,
    // so `vx run ci` reported "3 tasks" for two tasks' worth of commands.
    const withGroups = tallyOutcomes([
      mkOutcome('pkg#ci', { status: 'success', group: true }),
      mkOutcome('pkg#lint', { status: 'success' }),
      mkOutcome('pkg#build', { status: 'cache-hit', restored: true }),
      mkOutcome('pkg#check', { status: 'success', group: true }),
    ])
    const withoutGroups = tallyOutcomes([
      mkOutcome('pkg#lint', { status: 'success' }),
      mkOutcome('pkg#build', { status: 'cache-hit', restored: true }),
    ])
    expect(withGroups).toEqual(withoutGroups)
    expect(withGroups.total).toBe(2)
  })

  it('tallyViews: an absent isGroup reads as "not a group"; only true excludes', () => {
    // Group-ness crosses the wire as an OPTIONAL flag (`projectOutcome` sets
    // it only for groups), so "absent" has to mean a real task — otherwise
    // every task from a serve that predates the field vanishes from the
    // report's totals.
    expect(tallyViews([{ status: 'success' }])).toEqual(tally({ total: 1, successful: 1 }))
    expect(tallyViews([{ status: 'success', isGroup: false }])).toEqual(
      tally({ total: 1, successful: 1 }),
    )
    expect(tallyViews([{ status: 'success', isGroup: true }])).toEqual(ZERO)
  })

  it('tallyViews: accepts the minimal structural item', () => {
    // `TallyItem` is deliberately structural (declared here rather than
    // importing `OutcomeView`, which would close an events → summary → tally
    // cycle). A surface must be able to hand it a bare `{ status }`.
    const items: TallyItem[] = [{ status: 'failed' }, { status: 'cache-hit', restored: true }]
    expect(tallyViews(items)).toEqual(
      tally({ total: 2, failed: 1, successful: 1, cachedLocal: 1, restoredLocal: 1 }),
    )
  })
})

describe('tallyOutcomes and tallyViews agree', () => {
  it('for every status × restored × group combination, one at a time', () => {
    // Per-shape so a drift names the shape that broke rather than a delta on
    // an aggregate. The view side goes through the REAL `projectOutcome`, so
    // this also guards the projection: if it stopped emitting `isGroup`, the
    // report would silently start counting umbrella nodes again.
    for (const s of MATRIX) {
      const o = mkOutcome('pkg#t', s)
      expect({ shape: label(s), ...tallyViews([projectOutcome(o)]) }).toEqual({
        shape: label(s),
        ...tallyOutcomes([o]),
      })
    }
  })

  it('and over the whole matrix at once, with the exact expected numbers', () => {
    // Asserting the aggregate explicitly keeps the equivalence above from
    // being vacuously true (two all-zero tallies would "agree" perfectly).
    const all = MATRIX.map((s, i) => mkOutcome(`pkg#t${i}`, s))
    const expected = tally({
      total: 15, // 5 counted statuses × 3 restored variants; the 18 groups drop out
      successful: 9, // success + cache-hit + cache-hit-remote, 3 each
      failed: 3,
      skipped: 3,
      cachedLocal: 3,
      cachedRemote: 3,
      restoredLocal: 1, // only restored:true
      restoredRemote: 1,
      upToDate: 4, // restored:false and restored-absent, both hit kinds
      aborted: 3,
    })
    expect(tallyOutcomes(all)).toEqual(expected)
    expect(tallyViews(all.map(projectOutcome))).toEqual(expected)
  })
})

describe('invariants the summary and report derive from', () => {
  const all = MATRIX.map((s, i) => mkOutcome(`pkg#t${i}`, s))
  const t = tallyOutcomes(all)

  it('total partitions into successful / failed / skipped', () => {
    // Every counted task ended exactly one of three ways. Break it and the
    // tasks meter's segments stop summing to the "N total" printed beside
    // them — the bar is drawn from these three numbers.
    expect(t.successful + t.failed + t.skipped).toBe(t.total)
  })

  it('hits partition into up-to-date / restored-local / restored-remote', () => {
    // `formatRunSummary` computes hits two different ways — as
    // `upToDate + restoredLocal + restoredRemote` for the meter, and as
    // `cachedLocal + cachedRemote` inside the miss derivation. If the two
    // disagree the cache legend sums to a different number than the tasks
    // legend, which is exactly the confusion the yellow skipped segment was
    // added to fix.
    expect(t.upToDate + t.restoredLocal + t.restoredRemote).toBe(t.cachedLocal + t.cachedRemote)
  })

  it('misses are exactly the tasks that executed', () => {
    // The summary has no `miss` field; it derives one. That only yields the
    // executed count while aborted and group outcomes stay out of `total`.
    const miss = t.total - t.skipped - (t.cachedLocal + t.cachedRemote)
    const executed = all.filter(
      (o) => o.node.config.exec !== undefined && (o.status === 'success' || o.status === 'failed'),
    ).length
    expect(miss).toBe(executed)
    expect(miss).toBeGreaterThanOrEqual(0)
  })

  it('both meters describe the same population', () => {
    // tasks meter: failed + successful + skipped.
    // cache meter: miss + upToDate + restoredLocal + restoredRemote + skipped.
    const miss = t.total - t.skipped - (t.cachedLocal + t.cachedRemote)
    const tasksMeter = t.failed + t.successful + t.skipped
    const cacheMeter = miss + t.upToDate + t.restoredLocal + t.restoredRemote + t.skipped
    expect(cacheMeter).toBe(tasksMeter)
    expect(cacheMeter).toBe(t.total)
  })

  it('cached tasks are a subset of the successful ones', () => {
    // A hit is a success by definition; the report prints both
    // ("N success · M cached") off one run, so M > N would be nonsense.
    expect(t.cachedLocal + t.cachedRemote).toBeLessThanOrEqual(t.successful)
  })
})

describe('degradations', () => {
  it('KNOWN: an unrecognised status is counted in total but lands in no bucket', () => {
    // Pins CURRENT behaviour, and it is a (low-severity) defect: `fold` has
    // no `else`, so a status this binary does not know — reachable only when
    // a NEWER serve returns an `OutcomeView` over the wire, since nothing
    // validates the union on decode — increments `total` and nothing else.
    // The summary then derives one phantom miss for it and prints a tasks
    // legend whose buckets sum to less than the "N total" beside them.
    // The honest fix is to leave `total` alone for a status with no bucket;
    // update this expectation when that lands.
    const t = tallyViews([{ status: 'timed-out' } as unknown as TallyItem])
    expect(t).toEqual(tally({ total: 1 }))
    expect(t.successful + t.failed + t.skipped).toBe(0)
  })
})
