// The flakiness RULE, pinned at the unit it was extracted into.
//
// `failure-mode.ts` exists because `metrics.getHistory` and
// `LocalHistoryProvider` encoded this rule independently and drifted into
// OPPOSITE verdicts on identical rows (five failures on five distinct keys
// read `stable` on one surface and `flaky-fatal` on the other). So these
// tests assert the rule itself — flakiness needs a NONDETERMINISM signal, a
// within-run retry or one cache key that both failed and succeeded — and then
// assert both consumers still answer it identically.
//
// The consumer-level suites (history.test.ts, metrics.test.ts) exercise the
// surfaces; this one exercises the primitives they share.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { Cache, EXECUTED_RUNS_SQL, KEYED_RUNS_SQL, type RunRecord } from '../src/cache/index.js'
import { classifyFailureMode, mixedOutcomeKeyCount } from '../src/orchestrator/failure-mode.js'
import { getFlakiestTasks, getHistory, LocalHistoryProvider } from '../src/orchestrator/index.js'

/** Monotonic `started_at` so row ordering is deterministic across a file run. */
let seq = 0

function mkRun(args: {
  hash?: string
  project: string
  task: string
  status?: RunRecord['status']
  cacheHit?: boolean
  attempts?: number
  durationMs?: number
  startedAt?: number
}): RunRecord {
  const startedAt = args.startedAt ?? 1_700_000_000_000 + seq++
  const durationMs = args.durationMs ?? 10
  return {
    // `hash` is OMITTED (not `undefined`) when absent so `bindRun`'s `?? ''`
    // sentinel is what lands in the column — the keyless shape production
    // writes for a skipped or persistent outcome.
    ...(args.hash !== undefined ? { hash: args.hash } : {}),
    project: args.project,
    task: args.task,
    status: args.status ?? 'success',
    exitCode: args.status === 'failed' ? 1 : 0,
    durationMs,
    forwardArgs: [],
    startedAt,
    endedAt: startedAt + durationMs,
    runId: `r-${startedAt}`,
    cpuMs: durationMs,
    peakRssBytes: 0,
    wallclockStartNs: 0n,
    wallclockEndNs: 0n,
    cacheHit: args.cacheHit ?? false,
    ...(args.attempts !== undefined ? { attempts: args.attempts } : {}),
  }
}

/** Open a throwaway cache, seed `rows`, hand the raw handle to `fn`. */
async function withRuns(
  rows: readonly RunRecord[],
  fn: (db: Database, cache: Cache) => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'vx-failure-mode-'))
  const cache = new Cache(dir)
  try {
    if (rows.length > 0) cache.recordRuns(rows)
    await fn(cache.dbHandle(), cache)
  } finally {
    cache.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * A `Database` stand-in that records every SQL string executed through it.
 * `classifyFailureMode` only ever calls `db.query(sql).get(...)`, so this is
 * a faithful pass-through — it exists to prove the DB is NOT touched on the
 * paths the short-circuits are supposed to keep it off.
 */
function countingDb(real: Database): { db: Database; queries: string[] } {
  const queries: string[] = []
  const db = {
    query(sql: string) {
      queries.push(sql)
      return real.query(sql)
    },
  } as unknown as Database
  return { db, queries }
}

// ---------------------------------------------------------------------------
// mixedOutcomeKeyCount — the cross-run nondeterminism signal
// ---------------------------------------------------------------------------

describe('mixedOutcomeKeyCount', () => {
  it('returns 0 for a pair that has never run', async () => {
    await withRuns([], (db) => {
      expect(mixedOutcomeKeyCount(db, 'pkg', 'test')).toBe(0)
    })
  })

  it('returns 0 when every run succeeded', async () => {
    // No failure anywhere, so no key can be mixed however many runs there are.
    const rows = [1, 2, 3].map((i) => mkRun({ hash: `k${i}`, project: 'pkg', task: 'test' }))
    await withRuns(rows, (db) => {
      expect(mixedOutcomeKeyCount(db, 'pkg', 'test')).toBe(0)
    })
  })

  it('returns 0 for five failures on five DISTINCT keys', async () => {
    // THE case the pre-extraction fork got wrong: five reds look alarming, but
    // every one sits on its own inputs. That is five legitimate breaks (a
    // regression), not one task behaving differently on identical inputs.
    const rows = [0, 1, 2, 3, 4].map((i) =>
      mkRun({ hash: `break-${i}`, project: 'pkg', task: 'lint', status: 'failed' }),
    )
    await withRuns(rows, (db) => {
      expect(mixedOutcomeKeyCount(db, 'pkg', 'lint')).toBe(0)
    })
  })

  it('returns 0 when ONE key failed repeatedly and never succeeded', async () => {
    // A deterministic break: the same inputs fail every time. Reproducible is
    // the opposite of flaky, so this must not earn a nondeterminism verdict.
    const rows = [0, 1, 2].map(() =>
      mkRun({ hash: 'stuck', project: 'pkg', task: 'lint', status: 'failed' }),
    )
    await withRuns(rows, (db) => {
      expect(mixedOutcomeKeyCount(db, 'pkg', 'lint')).toBe(0)
    })
  })

  it('counts a key that failed and later succeeded', async () => {
    const rows = [
      mkRun({ hash: 'K', project: 'pkg', task: 'test', status: 'failed' }),
      mkRun({ hash: 'K', project: 'pkg', task: 'test', status: 'success' }),
    ]
    await withRuns(rows, (db) => {
      expect(mixedOutcomeKeyCount(db, 'pkg', 'test')).toBe(1)
    })
  })

  it('counts a key that succeeded and later failed (order-independent)', async () => {
    // The signal is "both outcomes exist for these inputs" — a GROUP BY, not a
    // transition. Order-sensitivity here would make the verdict depend on when
    // the dashboard happened to look.
    const rows = [
      mkRun({ hash: 'K', project: 'pkg', task: 'test', status: 'success' }),
      mkRun({ hash: 'K', project: 'pkg', task: 'test', status: 'failed' }),
    ]
    await withRuns(rows, (db) => {
      expect(mixedOutcomeKeyCount(db, 'pkg', 'test')).toBe(1)
    })
  })

  // A cache HIT is a pass: the key was proven good enough to replay. Missing
  // this branch would hide every flake whose green run was served from cache —
  // i.e. exactly the flakes on a warm CI runner.
  for (const status of ['cache-hit', 'cache-hit-remote'] as const) {
    it(`counts a '${status}' row as the pass side`, async () => {
      const rows = [
        mkRun({ hash: 'K', project: 'pkg', task: 'test', status: 'failed' }),
        mkRun({ hash: 'K', project: 'pkg', task: 'test', status, cacheHit: false }),
      ]
      await withRuns(rows, (db) => {
        expect(mixedOutcomeKeyCount(db, 'pkg', 'test')).toBe(1)
      })
    })
  }

  it('counts a row flagged cache_hit as the pass side', async () => {
    // Third pass predicate: the `cache_hit` column, independent of `status`.
    // Older rows carry the flag without a `cache-hit*` status.
    const rows = [
      mkRun({ hash: 'K', project: 'pkg', task: 'test', status: 'failed' }),
      mkRun({ hash: 'K', project: 'pkg', task: 'test', status: 'skipped', cacheHit: true }),
    ]
    await withRuns(rows, (db) => {
      expect(mixedOutcomeKeyCount(db, 'pkg', 'test')).toBe(1)
    })
  })

  it('counts each mixed key once and ignores clean keys beside them', async () => {
    // The return value is a COUNT OF KEYS, not of rows: three failures on one
    // mixed key must not read as three separate flakes.
    const rows = [
      mkRun({ hash: 'M1', project: 'pkg', task: 'test', status: 'failed' }),
      mkRun({ hash: 'M1', project: 'pkg', task: 'test', status: 'failed' }),
      mkRun({ hash: 'M1', project: 'pkg', task: 'test', status: 'success' }),
      mkRun({ hash: 'M2', project: 'pkg', task: 'test', status: 'success' }),
      mkRun({ hash: 'M2', project: 'pkg', task: 'test', status: 'failed' }),
      mkRun({ hash: 'clean-a', project: 'pkg', task: 'test', status: 'success' }),
      mkRun({ hash: 'clean-b', project: 'pkg', task: 'test', status: 'failed' }),
    ]
    await withRuns(rows, (db) => {
      expect(mixedOutcomeKeyCount(db, 'pkg', 'test')).toBe(2)
    })
  })

  it('never groups keyless rows: a keyless failure beside a keyless success is not a flake', async () => {
    // `hash` is `''` for an outcome that derived no key (skipped, persistent).
    // Without the `hash <> ''` guard every such row collapses into ONE `''`
    // group, so a skipped-then-succeeded task would fabricate a flake verdict
    // out of two rows that never described the same inputs — because they
    // describe NO inputs.
    const rows = [
      mkRun({ project: 'pkg', task: 'dev', status: 'failed' }),
      mkRun({ project: 'pkg', task: 'dev', status: 'success' }),
      mkRun({ project: 'pkg', task: 'dev', status: 'skipped' }),
    ]
    await withRuns(rows, (db) => {
      expect(mixedOutcomeKeyCount(db, 'pkg', 'dev')).toBe(0)
    })
  })

  it('ignores keyless rows when judging a real key', async () => {
    // The only success is keyless, so key `K` has failures and no pass: still
    // a deterministic break. A keyless row can neither corroborate nor refute.
    const rows = [
      mkRun({ hash: 'K', project: 'pkg', task: 'test', status: 'failed' }),
      mkRun({ project: 'pkg', task: 'test', status: 'success' }),
    ]
    await withRuns(rows, (db) => {
      expect(mixedOutcomeKeyCount(db, 'pkg', 'test')).toBe(0)
    })
  })

  it('scopes strictly to the (project, task) pair', async () => {
    // A flake in one package must not paint its neighbours — nor a sibling
    // task in the same package — as flaky.
    const rows = [
      mkRun({ hash: 'K', project: 'pkg-a', task: 'test', status: 'failed' }),
      mkRun({ hash: 'K', project: 'pkg-a', task: 'test', status: 'success' }),
      mkRun({ hash: 'K2', project: 'pkg-b', task: 'test', status: 'failed' }),
      mkRun({ hash: 'K3', project: 'pkg-a', task: 'build', status: 'failed' }),
    ]
    await withRuns(rows, (db) => {
      expect(mixedOutcomeKeyCount(db, 'pkg-a', 'test')).toBe(1)
      expect(mixedOutcomeKeyCount(db, 'pkg-b', 'test')).toBe(0)
      expect(mixedOutcomeKeyCount(db, 'pkg-a', 'build')).toBe(0)
    })
  })

  it('does not mix two pairs that happen to share a cache key string', async () => {
    // `hash` is unique per task in practice, but the GROUP BY is over the
    // pair-filtered set — grouping globally by hash would let one pair's red
    // and another's green combine into a flake neither of them had.
    const rows = [
      mkRun({ hash: 'SHARED', project: 'pkg-a', task: 'test', status: 'failed' }),
      mkRun({ hash: 'SHARED', project: 'pkg-b', task: 'test', status: 'success' }),
    ]
    await withRuns(rows, (db) => {
      expect(mixedOutcomeKeyCount(db, 'pkg-a', 'test')).toBe(0)
      expect(mixedOutcomeKeyCount(db, 'pkg-b', 'test')).toBe(0)
    })
  })

  it('treats project and task as bound data, never as SQL', async () => {
    const nasty = "'; DROP TABLE runs; --"
    const rows = [
      mkRun({ hash: 'K', project: nasty, task: nasty, status: 'failed' }),
      mkRun({ hash: 'K', project: nasty, task: nasty, status: 'success' }),
      mkRun({ hash: 'S', project: 'pkg', task: 'test', status: 'success' }),
    ]
    await withRuns(rows, (db) => {
      expect(mixedOutcomeKeyCount(db, nasty, nasty)).toBe(1)
      // The table survived — the payload was a value, not a statement.
      expect(mixedOutcomeKeyCount(db, 'pkg', 'test')).toBe(0)
    })
  })

  it('handles unicode names and a task name containing #', async () => {
    // `history.ts` splits `project#task` on the FIRST `#` and its comment
    // records that filtering on a concatenated `project || '#' || task`
    // expression was reverted (it defeated the index). This pins that the
    // helper takes the two fields SEPARATELY, so re-concatenating would break.
    const rows = [
      mkRun({ hash: 'K', project: '@scope/pkg-ü', task: 'test#unit', status: 'failed' }),
      mkRun({ hash: 'K', project: '@scope/pkg-ü', task: 'test#unit', status: 'success' }),
      mkRun({ hash: 'K', project: '@scope/pkg-ü#test', task: 'unit', status: 'failed' }),
    ]
    await withRuns(rows, (db) => {
      expect(mixedOutcomeKeyCount(db, '@scope/pkg-ü', 'test#unit')).toBe(1)
      expect(mixedOutcomeKeyCount(db, '@scope/pkg-ü#test', 'unit')).toBe(0)
    })
  })
})

// ---------------------------------------------------------------------------
// classifyFailureMode — the verdict
// ---------------------------------------------------------------------------

describe('classifyFailureMode', () => {
  it('is stable for zero runs', async () => {
    await withRuns([], (db) => {
      expect(classifyFailureMode(db, 'pkg', 'test', { total: 0, failures: 0, retried: 0 })).toBe(
        'stable',
      )
    })
  })

  it('is stable for a single successful run', async () => {
    const rows = [mkRun({ hash: 'k1', project: 'pkg', task: 'test' })]
    await withRuns(rows, (db) => {
      expect(classifyFailureMode(db, 'pkg', 'test', { total: 1, failures: 0, retried: 0 })).toBe(
        'stable',
      )
    })
  })

  it('is stable when every run succeeded', async () => {
    const rows = [1, 2, 3, 4, 5].map((i) => mkRun({ hash: `k${i}`, project: 'pkg', task: 'test' }))
    await withRuns(rows, (db) => {
      expect(classifyFailureMode(db, 'pkg', 'test', { total: 5, failures: 0, retried: 0 })).toBe(
        'stable',
      )
    })
  })

  it('is stable for five failures on five DISTINCT keys', async () => {
    // The sharpest case in this file. A naive `failures / total` heuristic
    // calls this flaky-fatal; the rule calls it a break, because nothing here
    // shows the task behaving two ways on one set of inputs.
    const rows = [0, 1, 2, 3, 4].map((i) =>
      mkRun({ hash: `break-${i}`, project: 'pkg', task: 'lint', status: 'failed' }),
    )
    await withRuns(rows, (db) => {
      expect(classifyFailureMode(db, 'pkg', 'lint', { total: 5, failures: 5, retried: 0 })).toBe(
        'stable',
      )
    })
  })

  it('is stable for a deterministic break: every failure on ONE key, never green', async () => {
    const rows = [0, 1, 2].map(() =>
      mkRun({ hash: 'stuck', project: 'pkg', task: 'lint', status: 'failed' }),
    )
    await withRuns(rows, (db) => {
      // Three failures on ONE key that has never succeeded is a deterministic
      // break, not flake: there is no nondeterminism signal — no within-run
      // retry, and no key that both failed and passed. Calling this flaky is
      // what the pre-rule `failures < total/5` heuristic did, and it is what
      // sends a developer to bolt `exec.retries` onto a real breakage.
      expect(classifyFailureMode(db, 'pkg', 'lint', { total: 3, failures: 3, retried: 0 })).toBe(
        'stable',
      )
    })
  })

  it('is flaky when one key both failed and succeeded', async () => {
    const rows = [
      mkRun({ hash: 'K', project: 'pkg', task: 'test', status: 'failed' }),
      mkRun({ hash: 'K', project: 'pkg', task: 'test', status: 'success' }),
    ]
    await withRuns(rows, (db) => {
      expect(classifyFailureMode(db, 'pkg', 'test', { total: 2, failures: 1, retried: 0 })).toBe(
        'flaky-fatal',
      )
    })
  })

  it('is flaky on a within-run retry even with ZERO failed rows', async () => {
    // The run went green, on attempt 2. Nothing in the row counts is red, so
    // only the retry signal can see this — and it is the STRONGEST evidence
    // there is: identical inputs, same machine, same minute, two outcomes.
    //
    // The severity lands on RECOVERABLE, and that is the right reading rather
    // than a rounding accident: severity is `failures < total/5`, and with zero
    // failed ROWS the task did recover every time it was observed. The signal
    // is what matters — a retried-green task is flaky, and reporting it as
    // `stable` is what would send someone hunting a phantom.
    const rows = [mkRun({ hash: 'k1', project: 'pkg', task: 'test', attempts: 2 })]
    await withRuns(rows, (db) => {
      expect(classifyFailureMode(db, 'pkg', 'test', { total: 1, failures: 0, retried: 1 })).toBe(
        'flaky-recoverable',
      )
    })
  })

  it('lets a within-run retry outrank the absence of any mixed key', async () => {
    // Five failures on distinct keys is `stable` on its own (asserted above).
    // Add ONE retried row and the verdict must flip: the retry is direct
    // evidence, and it must not be gated behind the inferred key signal.
    const rows = [
      ...[0, 1, 2, 3, 4].map((i) =>
        mkRun({ hash: `break-${i}`, project: 'pkg', task: 'lint', status: 'failed' }),
      ),
      mkRun({ hash: 'green', project: 'pkg', task: 'lint', attempts: 3 }),
    ]
    await withRuns(rows, (db) => {
      expect(mixedOutcomeKeyCount(db, 'pkg', 'lint')).toBe(0)
      expect(classifyFailureMode(db, 'pkg', 'lint', { total: 6, failures: 5, retried: 1 })).toBe(
        'flaky-fatal',
      )
    })
  })

  it('is flaky when the pass side of the mixed key is a cache hit', async () => {
    const rows = [
      mkRun({ hash: 'K', project: 'pkg', task: 'test', status: 'failed' }),
      mkRun({ hash: 'K', project: 'pkg', task: 'test', status: 'cache-hit', cacheHit: true }),
    ]
    await withRuns(rows, (db) => {
      expect(classifyFailureMode(db, 'pkg', 'test', { total: 2, failures: 1, retried: 0 })).toBe(
        'flaky-fatal',
      )
    })
  })

  // Severity split, once a flaky signal exists: `failures < total / 5`.
  // The boundary is exact, so an off-by-one in the comparison silently
  // downgrades a task that fails a fifth of the time to "recoverable".
  const severity: readonly [number, number, 'flaky-recoverable' | 'flaky-fatal'][] = [
    [10, 1, 'flaky-recoverable'], // 1 < 2
    [10, 2, 'flaky-fatal'], // 2 < 2 is false — exactly at the boundary
    [10, 3, 'flaky-fatal'],
    [100, 19, 'flaky-recoverable'], // 19 < 20
    [100, 20, 'flaky-fatal'],
    [5, 0, 'flaky-recoverable'], // retry-only: 0 < 1
    [5, 1, 'flaky-fatal'], // 1 < 1 is false
    [1, 0, 'flaky-recoverable'], // 0 < 0.2
  ]
  for (const [total, failures, expected] of severity) {
    it(`grades ${failures}/${total} failures as ${expected}`, async () => {
      // A real mixed key supplies the flaky signal for the failing cases; the
      // zero-failure rows lean on `retried` instead (the only other signal).
      const rows = [
        mkRun({ hash: 'K', project: 'pkg', task: 'test', status: 'failed' }),
        mkRun({ hash: 'K', project: 'pkg', task: 'test', status: 'success' }),
      ]
      await withRuns(rows, (db) => {
        expect(
          classifyFailureMode(db, 'pkg', 'test', {
            total,
            failures,
            retried: failures === 0 ? 1 : 0,
          }),
        ).toBe(expected)
      })
    })
  }

  it('does not touch the database when nothing failed and nothing retried', async () => {
    // The `failures > 0 &&` short-circuit is a load-bearing perf property: it
    // keeps a GROUP BY scan off the path taken by every healthy task, which is
    // almost all of them on a warm monorepo.
    const rows = [mkRun({ hash: 'k1', project: 'pkg', task: 'test' })]
    await withRuns(rows, (real) => {
      const { db, queries } = countingDb(real)
      expect(classifyFailureMode(db, 'pkg', 'test', { total: 1, failures: 0, retried: 0 })).toBe(
        'stable',
      )
      expect(queries).toEqual([])
    })
  })

  it('does not touch the database when a retry already proves flakiness', async () => {
    // `retried > 0 ||` short-circuits before the key scan: the verdict cannot
    // change, so the query would be pure cost.
    const rows = [
      mkRun({ hash: 'K', project: 'pkg', task: 'test', status: 'failed' }),
      mkRun({ hash: 'K', project: 'pkg', task: 'test', status: 'success', attempts: 2 }),
    ]
    await withRuns(rows, (real) => {
      const { db, queries } = countingDb(real)
      expect(classifyFailureMode(db, 'pkg', 'test', { total: 2, failures: 1, retried: 1 })).toBe(
        'flaky-fatal',
      )
      expect(queries).toEqual([])
    })
  })

  it('queries exactly once when failures exist and no retry was recorded', async () => {
    // The control for the two short-circuit tests above: without it, a helper
    // that never queried at all would pass both of them.
    const rows = [
      mkRun({ hash: 'K', project: 'pkg', task: 'test', status: 'failed' }),
      mkRun({ hash: 'K', project: 'pkg', task: 'test', status: 'success' }),
    ]
    await withRuns(rows, (real) => {
      const { db, queries } = countingDb(real)
      expect(classifyFailureMode(db, 'pkg', 'test', { total: 2, failures: 1, retried: 0 })).toBe(
        'flaky-fatal',
      )
      expect(queries).toHaveLength(1)
      // And it is the keyed scan, not some broader read.
      expect(queries[0]).toContain(KEYED_RUNS_SQL)
    })
  })
})

// ---------------------------------------------------------------------------
// The two core consumers must not fork again
// ---------------------------------------------------------------------------

describe('metrics.getHistory and LocalHistoryProvider agree', () => {
  // Each shape is a row-set plus the verdict the RULE dictates. Both surfaces
  // are asserted against the same expectation, so a fork shows up as a failure
  // on the surface that drifted rather than as two mutually-consistent lies.
  const shapes: readonly {
    id: string
    expected: 'stable' | 'flaky-recoverable' | 'flaky-fatal'
    rows: (p: string, t: string) => RunRecord[]
  }[] = [
    {
      id: 'break#distinct-keys',
      expected: 'stable',
      rows: (p, t) =>
        [0, 1, 2, 3, 4].map((i) => mkRun({ hash: `b${i}`, project: p, task: t, status: 'failed' })),
    },
    {
      id: 'break#one-key',
      expected: 'stable',
      rows: (p, t) =>
        [0, 1, 2].map(() => mkRun({ hash: 'one', project: p, task: t, status: 'failed' })),
    },
    {
      id: 'green#all',
      expected: 'stable',
      rows: (p, t) => [1, 2, 3].map((i) => mkRun({ hash: `g${i}`, project: p, task: t })),
    },
    {
      id: 'green#single',
      expected: 'stable',
      rows: (p, t) => [mkRun({ hash: 'g1', project: p, task: t })],
    },
    {
      id: 'keyless#pair',
      expected: 'stable',
      rows: (p, t) => [
        mkRun({ project: p, task: t, status: 'failed' }),
        mkRun({ project: p, task: t, status: 'success' }),
      ],
    },
    {
      id: 'flake#mixed-key',
      expected: 'flaky-fatal',
      rows: (p, t) => [
        mkRun({ hash: 'K', project: p, task: t, status: 'failed' }),
        mkRun({ hash: 'K', project: p, task: t, status: 'success' }),
      ],
    },
    {
      id: 'flake#cache-hit-pass',
      expected: 'flaky-fatal',
      rows: (p, t) => [
        mkRun({ hash: 'K', project: p, task: t, status: 'failed' }),
        mkRun({ hash: 'K', project: p, task: t, status: 'cache-hit', cacheHit: true }),
      ],
    },
    {
      id: 'flake#retry-only',
      // Retry is the strongest SIGNAL, but severity is a separate axis:
      // `failures < total/5`, and this row went green, so zero failures put it
      // on the recoverable side. Flaky either way — which is the property this
      // matrix exists to keep both surfaces agreeing on.
      expected: 'flaky-recoverable',
      rows: (p, t) => [mkRun({ hash: 'g1', project: p, task: t, attempts: 2 })],
    },
    {
      id: 'flake#recoverable',
      expected: 'flaky-recoverable',
      rows: (p, t) => [
        mkRun({ hash: 'K', project: p, task: t, status: 'failed' }),
        mkRun({ hash: 'K', project: p, task: t, status: 'success' }),
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => mkRun({ hash: `g${i}`, project: p, task: t })),
      ],
    },
  ]

  it('reaches the same verdict on every failure shape', async () => {
    const rows: RunRecord[] = []
    for (const s of shapes) {
      const [project, task] = s.id.split('#') as [string, string]
      rows.push(...s.rows(project, task))
    }
    await withRuns(rows, async (db) => {
      const provider = new LocalHistoryProvider(db)
      const table = await provider.loadFor(shapes.map((s) => s.id))
      for (const s of shapes) {
        const [project, task] = s.id.split('#') as [string, string]
        const viaMetrics = getHistory(db, { project, task })[0]!.failureMode
        const viaProvider = table.get(s.id)!.failureMode
        expect({ id: s.id, mode: viaMetrics }).toEqual({ id: s.id, mode: s.expected })
        expect({ id: s.id, mode: viaProvider }).toEqual({ id: s.id, mode: s.expected })
      }
    })
  })

  it('reports the same mixed-key count to getFlakiestTasks as the helper does', async () => {
    // `getFlakiestTasks` surfaces `mixedOutcomeKeys` on the dashboard's flaky
    // card and uses it for ranking; it must be the SAME number the verdict was
    // derived from, or the card explains a verdict nobody reached.
    const rows = [
      mkRun({ hash: 'K1', project: 'pkg', task: 'test', status: 'failed' }),
      mkRun({ hash: 'K1', project: 'pkg', task: 'test', status: 'success' }),
      mkRun({ hash: 'K2', project: 'pkg', task: 'test', status: 'failed' }),
      mkRun({ hash: 'K2', project: 'pkg', task: 'test', status: 'cache-hit', cacheHit: true }),
      mkRun({ hash: 'K3', project: 'pkg', task: 'test', status: 'success' }),
    ]
    await withRuns(rows, (db) => {
      const direct = mixedOutcomeKeyCount(db, 'pkg', 'test')
      expect(direct).toBe(2)
      const row = getFlakiestTasks(db).find((f) => f.id === 'pkg#test')
      expect(row).toBeDefined()
      expect(row!.mixedOutcomeKeys).toBe(direct)
      expect(row!.flakyConfirmed).toBe(false) // inferred, no within-run retry
    })
  })

  it('ranks a retry-confirmed task above a merely-inferred one', async () => {
    // The ordering the flaky card depends on: direct evidence first. Both are
    // flaky by the rule; only one was PROVEN inside a single run.
    const rows = [
      mkRun({ hash: 'I1', project: 'inferred', task: 't', status: 'failed' }),
      mkRun({ hash: 'I1', project: 'inferred', task: 't', status: 'success' }),
      mkRun({ hash: 'I2', project: 'inferred', task: 't', status: 'failed' }),
      mkRun({ hash: 'C1', project: 'confirmed', task: 't' }),
      mkRun({ hash: 'C2', project: 'confirmed', task: 't' }),
      mkRun({ hash: 'C3', project: 'confirmed', task: 't', attempts: 2 }),
    ]
    await withRuns(rows, (db) => {
      const flaky = getFlakiestTasks(db)
      expect(flaky[0]!.id).toBe('confirmed#t')
      expect(flaky[0]!.flakyConfirmed).toBe(true)
      expect(flaky.find((f) => f.id === 'inferred#t')?.mixedOutcomeKeys).toBe(1)
    })
  })

  it('SUSPECTED DEFECT: the two surfaces DO diverge when the recent window truncates the failures', async () => {
    // The RULE is shared, but its INPUTS are not: `LocalHistoryProvider`
    // aggregates the last `recent` rows while `metrics.getHistory` aggregates
    // ALL TIME — and `mixedOutcomeKeyCount` is unwindowed in both cases.
    //
    // So an old flake that has since gone quiet reads `stable` from the
    // provider (its window holds no failure, so the `failures > 0` guard
    // short-circuits) and `flaky-*` from metrics, on the SAME database. That
    // is the exact class of fork this module was extracted to prevent —
    // sharing the predicate did not make the windows agree.
    //
    // Pinned as CURRENT behaviour, not endorsed. See the returned findings.
    const rows = [
      mkRun({ hash: 'OLD', project: 'pkg', task: 'test', status: 'failed' }),
      mkRun({ hash: 'OLD', project: 'pkg', task: 'test', status: 'success' }),
      mkRun({ hash: 'new1', project: 'pkg', task: 'test' }),
      mkRun({ hash: 'new2', project: 'pkg', task: 'test' }),
    ]
    await withRuns(rows, async (db) => {
      // A 2-row window sees only the two recent greens.
      const windowed = await new LocalHistoryProvider(db, 2).loadFor(['pkg#test'])
      expect(windowed.get('pkg#test')!.runs).toBe(2)
      expect(windowed.get('pkg#test')!.failureMode).toBe('stable')
      // All-time sees the flake. `flaky-FATAL` because severity is
      // `failures < total/5`: 1 failure across 4 all-time runs is 1 >= 0.8, so
      // this lands on the severe side of the split. The divergence being pinned
      // is stable-vs-flaky, and the severity is asserted exactly so a change to
      // that boundary shows up here too.
      expect(getHistory(db, { project: 'pkg', task: 'test' })[0]!.failureMode).toBe('flaky-fatal')
      // And the unwindowed key scan agrees with the all-time surface.
      expect(mixedOutcomeKeyCount(db, 'pkg', 'test')).toBe(1)
    })
  })
})

// ---------------------------------------------------------------------------
// The cloud copy of the rule (Postgres) must not drift from core's
// ---------------------------------------------------------------------------

describe('cloud analytics mirrors the rule', () => {
  // `packages/cloud/src/db/analytics.ts` re-implements this rule over Postgres
  // `task_runs` — it cannot import the SQLite version. That duplication is the
  // fork risk, so these read the cloud source and assert the load-bearing
  // fragments are still there. Whitespace is normalised; wording is not
  // asserted, only the predicates that decide a verdict.
  let cloudSrc: string
  async function source(): Promise<string> {
    cloudSrc ??= (
      await Bun.file(
        path.join(import.meta.dir, '..', 'packages', 'cloud', 'src', 'db', 'analytics.ts'),
      ).text()
    ).replace(/\s+/g, ' ')
    return cloudSrc
  }

  it('keeps the keyed and executed predicates byte-identical to core', async () => {
    const src = await source()
    // If either literal changes on one side only, the two stores start
    // disagreeing about which rows are even eligible for a verdict.
    expect(src).toContain(`const KEYED_TASK_RUNS_SQL = "${KEYED_RUNS_SQL}"`)
    expect(src).toContain(`const EXECUTED_TASK_RUNS_SQL = "${EXECUTED_RUNS_SQL}"`)
  })

  it('keeps all three pass predicates on the mixed-key scan', async () => {
    const src = await source()
    const scan = src.slice(src.indexOf('private async mixedOutcomeKeyCounts'))
    expect(scan.length).toBeGreaterThan(0)
    // The failure side.
    expect(scan).toContain("SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) > 0")
    // All three ways a run can count as a pass — dropping any one of them
    // hides a whole population of flakes (notably every cache-served green).
    expect(scan).toContain("status = 'success'")
    expect(scan).toContain("status LIKE 'cache-hit%'")
    expect(scan).toContain('cache_hit = true')
    // And the keyless guard, so `''` rows cannot group into a phantom flake.
    expect(scan).toContain("hash != ''")
  })

  it('keeps the same nondeterminism signal and severity split', async () => {
    const src = await source()
    const fn = src.slice(src.indexOf('function historyRowFrom'))
    // Same OR of the two signals ...
    expect(fn).toContain('mixedOutcomeKeys > 0')
    expect(fn).toContain('retried || 0) > 0')
    // ... and the same boundary. A threshold changed on one side only makes
    // the same task read `recoverable` in the dashboard and `fatal` in `vx info`.
    expect(fn).toContain('failures < total / 5')
    expect(fn).toContain("'flaky-recoverable'")
    expect(fn).toContain("'flaky-fatal'")
  })
})
