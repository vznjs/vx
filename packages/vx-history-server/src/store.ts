// What the server keeps: one row per issuer, repository name, scope and task
// definition (M, 2026-10-25, the cache's key), already the
// numbers a scheduler asks for (M, 2026-10-25: a history, not a log). Each
// report folds into its row in one statement, so racing jobs lose nothing.
// A row holds the issuer and id hashed (`hashPart`) and the scope as the
// ref's hash a client sends: never a plain value.

import { hashPart } from '@vzn/vx-devtools'

/** A SQLite database, as bun:sqlite and D1 both serve one. */
export interface Db {
  all<T>(sql: string, params: readonly unknown[]): Promise<T[]>
  run(sql: string, params: readonly unknown[]): Promise<number>
}

/** One run of a task that succeeded, as a client reports it. */
export interface Report {
  /** The task's definition hash, opaque to the server. */
  readonly hash: string
  readonly durationMs: number
  /** CPU cores it kept busy on average. */
  readonly cores?: number
  /** Its peak memory. */
  readonly rssBytes?: number
}

/** What a scheduler reads for a task: the folded numbers and how many runs made them. */
export interface Timing {
  readonly durationMs: number
  readonly cores: number | null
  readonly rssBytes: number | null
  readonly runs: number
}

/**
 * The newest run's weight in a task's duration and cores: a median needs
 * the samples, a plain mean never forgets; at 0.3 a task that truly got
 * slower is followed within about three runs, and one outlier moves it 30%.
 */
export const WEIGHT = 0.3
/** Peak memory keeps the larger of the new peak and the old one decayed by this: a reservation needs the peak. */
export const RSS_DECAY = 0.9

/**
 * A report within this share of the row (and no new memory peak) leaves
 * it as it is, unless the row is a day old: the fold would move it under
 * 1.5%, and each write is billed (D1's free plan: 100k rows a day). The
 * day keeps a reported task's row past the sweep; `runs` counts the
 * reports that moved it.
 */
const NOISE = 0.05
const DAY_MS = 86_400_000

/** A repository: its token's issuer and its `org/name` there (stored hashed, in `repo_id`). */
export interface Repo {
  readonly issuer: string
  readonly repository: string
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS task_timings (issuer TEXT NOT NULL, repo_id TEXT NOT NULL, scope TEXT NOT NULL, hash TEXT NOT NULL, duration_ms INTEGER NOT NULL, cores REAL, rss_bytes INTEGER, runs INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (issuer, repo_id, scope, hash)) WITHOUT ROWID`

// One statement for a whole report, its rows passed as one JSON parameter:
// D1 binds at most 100 parameters, and a free plan's Worker runs at most
// 50 queries a request.
const FOLD = `INSERT INTO task_timings (issuer, repo_id, scope, hash, duration_ms, cores, rss_bytes, runs, updated_at)
SELECT ?1, ?2, ?3, j.value ->> '$.hash', j.value ->> '$.durationMs', j.value ->> '$.cores', j.value ->> '$.rssBytes', 1, ?4
FROM json_each(?5) AS j WHERE true
ON CONFLICT (issuer, repo_id, scope, hash) DO UPDATE SET
  duration_ms = CAST(round(duration_ms * ${1 - WEIGHT} + excluded.duration_ms * ${WEIGHT}) AS INTEGER),
  cores = CASE WHEN excluded.cores IS NULL THEN cores WHEN cores IS NULL THEN excluded.cores
    ELSE cores * ${1 - WEIGHT} + excluded.cores * ${WEIGHT} END,
  rss_bytes = CASE WHEN excluded.rss_bytes IS NULL THEN rss_bytes WHEN rss_bytes IS NULL THEN excluded.rss_bytes
    ELSE max(excluded.rss_bytes, CAST(rss_bytes * ${RSS_DECAY} AS INTEGER)) END,
  runs = runs + 1,
  updated_at = excluded.updated_at
WHERE abs(excluded.duration_ms - duration_ms) > duration_ms * ${NOISE}
  OR (excluded.cores IS NOT NULL AND (cores IS NULL OR abs(excluded.cores - cores) > cores * ${NOISE}))
  OR (excluded.rss_bytes IS NOT NULL AND (rss_bytes IS NULL OR excluded.rss_bytes > rss_bytes))
  OR excluded.updated_at - updated_at >= ${DAY_MS}`

/** The rows of `scopes` for the hashes asked; a hash the first scope lacks reads the next. */
const READ = `SELECT hash, scope, duration_ms, cores, rss_bytes, runs FROM task_timings
WHERE issuer = ?1 AND repo_id = ?2 AND scope IN (SELECT value FROM json_each(?3)) AND hash IN (SELECT value FROM json_each(?4))`

export interface Store {
  init(): Promise<void>
  /** Folds each report into its row of `scope` (a ref's hash). */
  fold(repo: Repo, scope: string, now: number, reports: readonly Report[]): Promise<void>
  /** Each hash's row in the first of `scopes` (refs' hashes) that holds one. */
  read(
    repo: Repo,
    scopes: readonly string[],
    hashes: readonly string[],
  ): Promise<Map<string, Timing>>
  /** Deletes the rows not reported since `before`; how many. */
  sweep(before: number): Promise<number>
}

const keyOf = (repo: Repo): Promise<[string, string]> =>
  Promise.all([hashPart(repo.issuer), hashPart(repo.repository)])

export function sqliteStore(db: Db): Store {
  return {
    init: async () => void (await db.run(SCHEMA, [])),
    async fold(repo, scope, now, reports) {
      if (reports.length > 0)
        await db.run(FOLD, [...(await keyOf(repo)), scope, now, JSON.stringify(reports)])
    },
    async read(repo, scopes, hashes) {
      const rows = await db.all<{
        hash: string
        scope: string
        duration_ms: number
        cores: number | null
        rss_bytes: number | null
        runs: number
      }>(READ, [...(await keyOf(repo)), JSON.stringify(scopes), JSON.stringify(hashes)])
      // A hash's row in the earliest scope asked wins.
      rows.sort((a, b) => scopes.indexOf(b.scope) - scopes.indexOf(a.scope))
      return new Map(
        rows.map((r) => [
          r.hash,
          { durationMs: r.duration_ms, cores: r.cores, rssBytes: r.rss_bytes, runs: r.runs },
        ]),
      )
    },
    sweep: (before) => db.run('DELETE FROM task_timings WHERE updated_at < ?1', [before]),
  }
}
