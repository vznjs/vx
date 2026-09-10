// The flakiness verdict, in ONE place. Two readers classify `runs` rows —
// the all-time per-task query here and `LocalHistoryProvider`'s bounded
// window — and they used to encode the rule independently, which let them
// drift into opposite verdicts on identical data. Both build on
// `mixedOutcomeKeysSql` + `failureModeOf`, so the rule cannot fork again.
// The per-run detector (`detectFlaky`) and the doctor's list (`flakyTasks`)
// read the same per-key projection (`keyOutcomesSql`).

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
 * Per-key outcome projection: every keyed (project, task, hash) under
 * `source` (a relation with `project`, `task`, `hash`, `status`, `cache_hit`
 * columns) with how often it failed and how often it passed — a pass being
 * an executed success or a cache hit, which replays a success. Every
 * flakiness reader is a filter over this one projection.
 */
function keyOutcomesSql(source: string, where = ''): string {
  return `SELECT project, task, hash,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
       SUM(CASE WHEN status = 'success' OR status IN ${HIT_STATUSES} OR cache_hit = 1
           THEN 1 ELSE 0 END) AS passes
       FROM ${source}
       WHERE ${KEYED_RUNS_SQL}${where}
       GROUP BY project, task, hash`
}

/**
 * Per-key outcome subquery: the distinct cache keys under `source` that
 * produced BOTH a failure and a success — the definitional flake: identical
 * inputs, different outcomes. A failure whose key never succeeded is a
 * legitimate break (a changed input that fails), which belongs to the
 * regressions surface, not flakiness. One projection of the rule serves the
 * all-time query below and the windowed one in `history.ts`.
 */
export function mixedOutcomeKeysSql(source: string, where = ''): string {
  return `SELECT project, task FROM (${keyOutcomesSql(source, where)})
       WHERE failures > 0 AND passes > 0`
}

/** Mixed-outcome keys of one (project, task) over its WHOLE recorded history. */
export function mixedOutcomeKeyCount(db: Database, project: string, task: string): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM (${mixedOutcomeKeysSql('runs', ' AND project = ? AND task = ?')})`,
    )
    .get(project, task) as { n: number }
  return row.n
}

/**
 * The verdict. Flaky requires a NONDETERMINISM signal: a within-run retry,
 * or a cache key that both failed and succeeded (`mixedKeys`). Failures
 * alone — each on its own key — are legitimate breaks, however many there
 * are. `mixedKeys` is a thunk so a task that never failed is stable without
 * the key count being computed at all.
 */
export function failureModeOf(
  counts: { total: number; failures: number; retried: number },
  mixedKeys: () => number,
): FailureMode {
  const flakySignal = counts.retried > 0 || (counts.failures > 0 && mixedKeys() > 0)
  if (!flakySignal) return 'stable'
  return counts.failures < counts.total / 5 ? 'flaky-recoverable' : 'flaky-fatal'
}

/** `failureModeOf` over a task's whole recorded history (the DB is not touched unless it failed). */
export function classifyFailureMode(
  db: Database,
  project: string,
  task: string,
  counts: { total: number; failures: number; retried: number },
): FailureMode {
  return failureModeOf(counts, () => mixedOutcomeKeyCount(db, project, task))
}

/** An executed, keyed outcome of the run in progress — what `detectFlaky` judges. */
export interface FlakyCandidate {
  project: string
  task: string
  hash: string
  status: 'success' | 'failed'
  /** Attempts this run took; > 1 is a within-run retry. */
  attempts: number
}

/** One task the run just proved nondeterministic. */
export interface FlakyFinding extends FlakyCandidate {
  /** `project#task`. */
  taskId: string
  /** Outcomes on record for this exact key, this run's included. */
  passes: number
  failures: number
}

// Bound parameters per statement: SQLite's compile-time cap is 32 766 in
// every build Bun ships, but a run can execute more tasks than that only in
// theory — chunking keeps the query shape identical at any size.
const IN_CHUNK = 500

function chunked<T>(items: readonly T[], each: (chunk: readonly T[]) => void): void {
  for (let i = 0; i < items.length; i += IN_CHUNK) each(items.slice(i, i + IN_CHUNK))
}

const keyOf = (c: { project: string; task: string; hash: string }): string =>
  `${c.project}\0${c.task}\0${c.hash}`

/**
 * Which of this run's executed tasks are flaky, judged BEFORE the run's own
 * rows are recorded: a pass on a key that has failed before, a failure on
 * a key that has passed before, or a within-run retry. The counts fold this
 * run in.
 *
 * The cost follows the run's colour. No candidate (every task a hit or a
 * skip): no query. A green miss: one probe of the `runs_failed` partial
 * index for the keys that ever failed — failures are the rare rows, so the
 * probe is microseconds however long the history. Only a key that DID fail
 * before, or a task failing now, pays the projection scan over its own
 * keys, and a run that is failing has more to look at than a scan.
 */
export function detectFlaky(db: Database, candidates: readonly FlakyCandidate[]): FlakyFinding[] {
  if (candidates.length === 0) return []
  const everFailed = new Set<string>()
  const passedNow = candidates.filter((c) => c.status === 'success' && c.attempts <= 1)
  chunked(passedNow, (chunk) => {
    const rows = db
      .query(
        `SELECT DISTINCT project, task, hash FROM runs
         WHERE status = 'failed' AND hash IN (${chunk.map(() => '?').join(', ')})`,
      )
      .all(...chunk.map((c) => c.hash)) as { project: string; task: string; hash: string }[]
    for (const r of rows) everFailed.add(keyOf(r))
  })
  const suspects = candidates.filter(
    (c) => c.status === 'failed' || c.attempts > 1 || everFailed.has(keyOf(c)),
  )
  if (suspects.length === 0) return []
  const counts = new Map<string, { passes: number; failures: number }>()
  chunked(suspects, (chunk) => {
    const rows = db
      .query(keyOutcomesSql('runs', ` AND hash IN (${chunk.map(() => '?').join(', ')})`))
      .all(...chunk.map((c) => c.hash)) as {
      project: string
      task: string
      hash: string
      passes: number
      failures: number
    }[]
    for (const r of rows) counts.set(keyOf(r), { passes: r.passes, failures: r.failures })
  })
  const out: FlakyFinding[] = []
  for (const c of suspects) {
    const before = counts.get(keyOf(c)) ?? { passes: 0, failures: 0 }
    const passes = before.passes + (c.status === 'success' ? 1 : 0)
    const failures = before.failures + (c.status === 'failed' ? 1 : 0)
    if (!(passes > 0 && failures > 0) && c.attempts <= 1) continue
    out.push({ ...c, taskId: `${c.project}#${c.task}`, passes, failures })
  }
  return out
}

/** One task the recorded history shows both passing and failing on unchanged inputs. */
export interface FlakyTask {
  /** `project#task`. */
  taskId: string
  project: string
  task: string
  /** Distinct cache keys that both passed and failed. */
  keys: number
  /** Outcomes over those keys. */
  passes: number
  failures: number
}

/**
 * Every task with a mixed-outcome key anywhere in the retained history
 * (30 days, `RunHistory.pruneOlderThan`), most failures first: the
 * doctor's list. A full scan of `runs`, which an inspection verb affords.
 */
export function flakyTasks(db: Database): FlakyTask[] {
  const rows = db
    .query(
      `SELECT project, task, COUNT(*) AS keys, SUM(passes) AS passes, SUM(failures) AS failures
       FROM (${keyOutcomesSql('runs')})
       WHERE failures > 0 AND passes > 0
       GROUP BY project, task
       ORDER BY failures DESC, passes DESC, project, task`,
    )
    .all() as { project: string; task: string; keys: number; passes: number; failures: number }[]
  return rows.map((r) => ({ ...r, taskId: `${r.project}#${r.task}` }))
}
