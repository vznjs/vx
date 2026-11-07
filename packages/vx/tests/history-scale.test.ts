// What `vx last`, `vx why` and `vx info` read of a long history: at 2M
// rows a statement that walks a whole table costs seconds (1.5 s for `vx
// last`, 4.2 s for `vx info`, 2026-11-07). Pinned by query plan, not by a
// clock: each statement's plan names how it reaches every table.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { indexDb, Cache } from '../src/cache/index.js'
import { flakyTasks, LocalHistoryProvider } from '../src/history/index.js'

let dir: string
let cache: Cache
let db: Database

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vx-history-scale-'))
  cache = new Cache(dir)
  db = indexDb(cache)
})
afterAll(() => {
  cache.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Each plan line of every statement `read` prepares on the history's handle. */
function plans(read: (db: Database) => unknown): string[] {
  const seen: string[] = []
  const spy = new Proxy(db, {
    get: (target, key) =>
      key === 'query'
        ? (sql: string) => {
            seen.push(sql)
            return target.query(sql)
          }
        : Reflect.get(target, key),
  })
  read(spy)
  expect(seen.length).toBeGreaterThan(0)
  return seen.flatMap((sql) =>
    (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail),
  )
}

/** The plan lines that read every row of `table`. */
const scans = (lines: readonly string[], table: string): string[] =>
  lines.filter((l) => new RegExp(`^SCAN (\\w+\\.)?${table}\\b`).test(l))

it("the replay's `—` check probes each task's timings by index, at most two rows", () => {
  const defs = new Map([['a#build', 'd1']])
  const lines = plans((h) =>
    new LocalHistoryProvider(h, undefined, null, defs).timedOnlySince(['a#build', 'b#test'], 0),
  )
  expect(scans(lines, 'task_durations')).toEqual([])
  expect(lines).toContain(
    'SEARCH task_durations USING INDEX task_durations_task (project=? AND task=?)',
  )
})

it("a mistyped task id is matched against the window's rows, a key range", () => {
  const lines = plans((h) => new LocalHistoryProvider(h).recentTaskIds())
  expect(scans(lines, 'runs')).toEqual([])
  expect(lines).toContain('SEARCH main.runs USING INTEGER PRIMARY KEY (rowid>?)')
})

it('the flaky list projects only the keys that failed or retried, by index', () => {
  const lines = plans((h) => flakyTasks(h))
  // The one pass over every row picks the candidate keys; the projection,
  // whose window sorts what it reads, reads only theirs.
  expect(scans(lines, 'task_outcomes')).toEqual(['SCAN task_outcomes'])
  expect(lines.indexOf('SCAN task_outcomes')).toBe(lines.indexOf('LIST SUBQUERY 1') + 1)
  expect(lines).toContain('SEARCH task_outcomes USING INDEX task_outcomes_hash (hash=?)')
})
