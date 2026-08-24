// The flakiness verdict, in ONE place. Two surfaces classify the same
// `runs` rows — `metrics.getHistory` (the dashboard / `vx info` read) and
// `LocalHistoryProvider` (what `vx mcp` hands an AI agent) — and they used
// to encode the rule independently, which let them drift into opposite
// verdicts on identical data. Both now call `classifyFailureMode`, so the
// rule cannot fork again.

import type { Database } from 'bun:sqlite'
import { KEYED_RUNS_SQL } from '../cache/index.js'
import { isCacheHit, TASK_STATUSES } from './telemetry.js'

// SQL hit set derived from the predicate — never a hand-typed list and never
// a prefix LIKE (a prefix counts any status merely NAMED cache-hit-*). The
// status-vocabulary tripwire greps both wrong forms.
const HIT_STATUSES = `(${TASK_STATUSES.filter(isCacheHit)
  .map((s) => `'${s}'`)
  .join(', ')})`

export type FailureMode = 'stable' | 'flaky-recoverable' | 'flaky-fatal'

/**
 * Distinct cache keys that produced BOTH a failure and a success — the
 * definitional flake: identical inputs, different outcomes. A failure whose
 * key never succeeded is a legitimate break (a changed input that fails),
 * which belongs to the regressions surface, not flakiness.
 */
export function mixedOutcomeKeyCount(db: Database, project: string, task: string): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM (
         SELECT hash FROM runs
         WHERE project = ? AND task = ? AND ${KEYED_RUNS_SQL}
         GROUP BY hash
         HAVING SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) > 0
            AND SUM(CASE WHEN status = 'success' OR status IN ${HIT_STATUSES} OR cache_hit = 1
                    THEN 1 ELSE 0 END) > 0
       )`,
    )
    .get(project, task) as { n: number }
  return row.n
}

/**
 * Flaky requires a NONDETERMINISM signal: a within-run retry, or a cache key
 * that both failed and succeeded. Failures alone — each on its own key — are
 * legitimate breaks, however many there are.
 *
 * The `failures > 0` short-circuit keeps the key-count query off the common
 * path: a task that never failed is stable without touching the DB.
 */
export function classifyFailureMode(
  db: Database,
  project: string,
  task: string,
  counts: { total: number; failures: number; retried: number },
): FailureMode {
  const flakySignal =
    counts.retried > 0 || (counts.failures > 0 && mixedOutcomeKeyCount(db, project, task) > 0)
  if (!flakySignal) return 'stable'
  return counts.failures < counts.total / 5 ? 'flaky-recoverable' : 'flaky-fatal'
}
