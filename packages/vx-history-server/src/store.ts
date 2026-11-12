// What the server keeps: one row per issuer, repository, ref and task
// definition, already the numbers a scheduler asks for (a history, not a log).
// Each report folds into its row in one statement, so racing jobs lose nothing.
// Every column is plain: the server is the user's own, and a hash only hid its
// rows from them.

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

/** One run of a cached task, pass or fail, as a client reports it: its flaky record. */
export interface Outcome {
  /** The task's definition hash, as its timing names it. */
  readonly hash: string
  /** The run's cache key: one key that failed, then passed, is a flake. */
  readonly key: string
  /** `flaky`: the run saw the task flake itself (a retry that passed). */
  readonly outcome: 'pass' | 'fail' | 'flaky'
}

/** What a scheduler reads for a task: the folded numbers and how many runs made them. */
export interface Timing {
  readonly durationMs: number
  readonly cores: number | null
  readonly rssBytes: number | null
  /** A slow run's duration: the slowest report, decayed by `SLOW_DECAY` a report. */
  readonly slowMs: number
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
 * A slow run's duration keeps the larger of the new run and the old slow
 * one decayed by this: a deadline needs how slow a task gets, which the
 * duration's mean hides, and a run 40% over it is taken at once, where
 * the mean takes three runs to reach it.
 */
const SLOW_DECAY = 0.9

/**
 * A report within this share of the row (and no new memory peak) leaves
 * it as it is, unless the row is a day old: the fold would move it under
 * 1.5%, and each write is billed (D1's free plan: 100k rows a day). The
 * day keeps a reported task's row past the sweep; `runs` counts the
 * reports that moved it.
 */
const NOISE = 0.05
const DAY_MS = 86_400_000

/** A repository: its issuer's URL, no trailing slash, and its `org/name` there, lowercased. */
export interface Repo {
  readonly issuer: string
  readonly repository: string
}

// Rows were keyed by hashes of these; nothing that table holds can be read by
// plain values.
const DROP_OLD = 'DROP TABLE IF EXISTS task_timings'
const SCHEMA = `CREATE TABLE IF NOT EXISTS timings (issuer TEXT NOT NULL, repository TEXT NOT NULL, ref TEXT NOT NULL, hash TEXT NOT NULL, duration_ms INTEGER NOT NULL, cores REAL, rss_bytes INTEGER, runs INTEGER NOT NULL, updated_at INTEGER NOT NULL, slow_ms INTEGER, PRIMARY KEY (issuer, repository, ref, hash)) WITHOUT ROWID`
// A table made before `slow_ms` gains it; its rows read their duration as
// their slow one until a report sets it.
const ADD_SLOW = 'ALTER TABLE timings ADD COLUMN slow_ms INTEGER'

// The flaky record: a row only for a task definition and cache key that failed,
// and whether it flaked since. A pass with no row writes nothing: passes are
// most outcomes. Kept by repository, not by ref: a key is the same inputs on
// every branch.
const OUTCOMES = `CREATE TABLE IF NOT EXISTS outcomes (issuer TEXT NOT NULL, repository TEXT NOT NULL, hash TEXT NOT NULL, key TEXT NOT NULL, flaky INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (issuer, repository, hash, key)) WITHOUT ROWID`

// When the database was last swept, by whichever node: a Worker runs many
// isolates and starts new ones all day, and each swept on its first upload.
const SWEEPS =
  'CREATE TABLE IF NOT EXISTS sweeps (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL)'

// One statement per 2 MB of a report's rows, passed as one JSON parameter:
// D1 binds at most 100 parameters, and a free plan's Worker runs at most
// 50 queries a request.
const FOLD = `INSERT INTO timings (issuer, repository, ref, hash, duration_ms, cores, rss_bytes, runs, updated_at, slow_ms)
SELECT ?1, ?2, ?3, j.value ->> '$.hash', j.value ->> '$.durationMs', j.value ->> '$.cores', j.value ->> '$.rssBytes', 1, ?4, j.value ->> '$.durationMs'
FROM json_each(?5) AS j WHERE true
ON CONFLICT (issuer, repository, ref, hash) DO UPDATE SET
  duration_ms = CAST(round(duration_ms * ${1 - WEIGHT} + excluded.duration_ms * ${WEIGHT}) AS INTEGER),
  cores = CASE WHEN excluded.cores IS NULL THEN cores WHEN cores IS NULL THEN excluded.cores
    ELSE cores * ${1 - WEIGHT} + excluded.cores * ${WEIGHT} END,
  rss_bytes = CASE WHEN excluded.rss_bytes IS NULL THEN rss_bytes WHEN rss_bytes IS NULL THEN excluded.rss_bytes
    ELSE max(excluded.rss_bytes, CAST(rss_bytes * ${RSS_DECAY} AS INTEGER)) END,
  slow_ms = max(excluded.duration_ms, CAST(coalesce(slow_ms, duration_ms) * ${SLOW_DECAY} AS INTEGER)),
  runs = runs + 1,
  updated_at = excluded.updated_at
WHERE abs(excluded.duration_ms - duration_ms) > duration_ms * ${NOISE}
  OR (excluded.cores IS NOT NULL AND (cores IS NULL OR abs(excluded.cores - cores) > cores * ${NOISE}))
  OR (excluded.rss_bytes IS NOT NULL AND (rss_bytes IS NULL OR excluded.rss_bytes > rss_bytes))
  OR excluded.updated_at - updated_at >= ${DAY_MS}`

// A failure or a run's flake writes its row; a row already as it would
// be is rewritten only when a day old, since each write is billed.
const RECORD = `INSERT INTO outcomes (issuer, repository, hash, key, flaky, at)
SELECT ?1, ?2, j.value ->> '$.hash', j.value ->> '$.key', j.value ->> '$.outcome' = 'flaky', ?3
FROM json_each(?4) AS j WHERE j.value ->> '$.outcome' <> 'pass'
ON CONFLICT (issuer, repository, hash, key) DO UPDATE SET flaky = max(flaky, excluded.flaky), at = excluded.at
WHERE excluded.flaky > flaky OR excluded.at - at >= ${DAY_MS}`

/** A pass of a key that failed: the key flaked. */
const PASSED = `UPDATE outcomes SET flaky = 1, at = ?3
WHERE issuer = ?1 AND repository = ?2 AND flaky = 0 AND (hash, key) IN
  (SELECT j.value ->> '$.hash', j.value ->> '$.key' FROM json_each(?4) AS j WHERE j.value ->> '$.outcome' = 'pass')`

/** The hashes asked that flaked: a key that failed and then passed, or a run that saw it. */
const FLAKY = `SELECT DISTINCT hash FROM outcomes
WHERE issuer = ?1 AND repository = ?2 AND hash IN (SELECT value FROM json_each(?3)) AND flaky = 1`

/** The rows of `refs` for the hashes asked; a hash the first ref lacks reads the next. */
const READ = `SELECT hash, ref, duration_ms, cores, rss_bytes, slow_ms, runs FROM timings
WHERE issuer = ?1 AND repository = ?2 AND ref IN (SELECT value FROM json_each(?3)) AND hash IN (SELECT value FROM json_each(?4))`

export interface Store {
  init(): Promise<void>
  /** Folds each report into its row of `ref`. */
  fold(repo: Repo, ref: string, now: number, reports: readonly Report[]): Promise<void>
  /** Each hash's row in the first of `refs` that holds one. */
  read(repo: Repo, refs: readonly string[], hashes: readonly string[]): Promise<Map<string, Timing>>
  /** Records each outcome in the repository's flaky record. */
  record(repo: Repo, now: number, outcomes: readonly Outcome[]): Promise<void>
  /** The hashes asked that the flaky record names flaky. */
  flaky(repo: Repo, hashes: readonly string[]): Promise<string[]>
  /** When a node last swept the database; 0 before the first sweep. */
  sweptAt(): Promise<number>
  /** Deletes the rows not reported since `before`, and records the sweep at `now`; how many. */
  sweep(before: number, now: number): Promise<number>
}

/**
 * D1's limit on a bound string (developers.cloudflare.com/d1/platform/limits):
 * a report's rows, or a query's hashes, past it failed the statement, so a
 * server took less than its PROTOCOL.md limits name.
 */
const MAX_PARAM_BYTES = 2_000_000

/** `items` as JSON arrays each within `MAX_PARAM_BYTES`: a UTF-16 unit is at most 3 UTF-8 bytes. */
function jsonParams(items: readonly unknown[]): string[] {
  const out: string[] = []
  let part: string[] = []
  let units = 2
  for (const item of items) {
    const json = JSON.stringify(item)
    if (part.length > 0 && (units + json.length + 1) * 3 > MAX_PARAM_BYTES) {
      out.push(`[${part.join(',')}]`)
      part = []
      units = 2
    }
    part.push(json)
    units += json.length + 1
  }
  if (part.length > 0) out.push(`[${part.join(',')}]`)
  return out
}

export function sqliteStore(db: Db): Store {
  return {
    async init() {
      await db.run(DROP_OLD, [])
      await db.run(SCHEMA, [])
      await db.run(ADD_SLOW, []).catch((err: unknown) => {
        if (!/duplicate column/i.test(String(err))) throw err
      })
      await db.run(SWEEPS, [])
      await db.run(OUTCOMES, [])
    },
    async record(repo, now, outcomes) {
      for (const part of jsonParams(outcomes)) {
        await db.run(PASSED, [repo.issuer, repo.repository, now, part])
        await db.run(RECORD, [repo.issuer, repo.repository, now, part])
      }
    },
    async flaky(repo, hashes) {
      const rows = await Promise.all(
        jsonParams(hashes).map((part) =>
          db.all<{ hash: string }>(FLAKY, [repo.issuer, repo.repository, part]),
        ),
      )
      return rows.flat().map((r) => r.hash)
    },
    async fold(repo, ref, now, reports) {
      for (const part of jsonParams(reports))
        await db.run(FOLD, [repo.issuer, repo.repository, ref, now, part])
    },
    async read(repo, refs, hashes) {
      const rows = (
        await Promise.all(
          jsonParams(hashes).map((part) =>
            db.all<{
              hash: string
              ref: string
              duration_ms: number
              cores: number | null
              rss_bytes: number | null
              slow_ms: number | null
              runs: number
            }>(READ, [repo.issuer, repo.repository, JSON.stringify(refs), part]),
          ),
        )
      ).flat()
      // A hash's row in the earliest ref asked wins.
      rows.sort((a, b) => refs.indexOf(b.ref) - refs.indexOf(a.ref))
      return new Map(
        rows.map((r) => [
          r.hash,
          {
            durationMs: r.duration_ms,
            cores: r.cores,
            rssBytes: r.rss_bytes,
            slowMs: r.slow_ms ?? r.duration_ms,
            runs: r.runs,
          },
        ]),
      )
    },
    async sweptAt() {
      const [row] = await db.all<{ at: number }>('SELECT at FROM sweeps WHERE id = 1', [])
      return row?.at ?? 0
    },
    async sweep(before, now) {
      // A report that would not move its row is not written for up to a
      // day (FOLD): a row's write time lags its last report by up to that.
      const deleted = await db.run('DELETE FROM timings WHERE updated_at < ?1', [before - DAY_MS])
      await db.run('DELETE FROM outcomes WHERE at < ?1', [before - DAY_MS])
      await db.run(
        'INSERT INTO sweeps (id, at) VALUES (1, ?1) ON CONFLICT (id) DO UPDATE SET at = excluded.at',
        [now],
      )
      return deleted
    },
  }
}
