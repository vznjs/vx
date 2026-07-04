// Per-workspace persisted task-log store (task-logs-2026-07 §5). A SQLite
// sidecar `<workspaceDir>/logs.db` — deliberately NOT a table in core's Cache
// schema (that would bump SCHEMA_VERSION for every user's local cache.db for a
// cloud-only feature). Its own version gate; history, not cache.
//
// The store is the LAST line of the bounded-storage law: it re-truncates every
// tail server-side (the wire is never trusted for caps), compresses over a
// threshold, and prunes by age + a per-workspace byte ceiling. A cache-hit
// task stores nothing — a hit resolves by hash to the run that produced the
// bytes.

import { Database } from 'bun:sqlite'
import path from 'node:path'
import {
  RUN_LOG_BUDGET_CHARS,
  TASK_LOG_TAIL_CHARS,
  type TaskLogBundle,
} from './task-log-capture.js'

const LOGS_SCHEMA_VERSION = 1

/** Content at/over this many bytes is stored zstd-compressed; below stays plain. */
const COMPRESS_THRESHOLD_BYTES = 4 * 1024

/** Prune runs at most this often (ms) — pruning walks the table, so throttle it. */
const PRUNE_INTERVAL_MS = 5 * 60 * 1000

function retentionMs(): number {
  const days = Number(process.env['VX_CLOUD_LOG_RETENTION_DAYS'])
  return (Number.isFinite(days) && days > 0 ? days : 30) * 24 * 60 * 60 * 1000
}

function maxBytes(): number {
  const n = Number(process.env['VX_CLOUD_LOG_MAX_BYTES'])
  return Number.isFinite(n) && n > 0 ? n : 512 * 1024 * 1024
}

export interface StoredTaskLog {
  runId: string
  taskId: string
  hash?: string
  status: 'success' | 'failed'
  content: string
  charsFull: number
  truncatedHeadChars: number
}

interface Row {
  run_id: string
  task_id: string
  hash: string | null
  status: string
  codec: string
  content: Uint8Array
  chars_full: number
  truncated_head: number
}

/**
 * One `logs.db` per workspace. Opened lazily by `IngestStore` next to the
 * per-workspace `Cache`. `now` is injectable for deterministic prune tests.
 */
export class LogStore {
  private readonly db: Database
  private lastPruneAt = 0

  constructor(
    dir: string,
    private readonly now: () => number = Date.now,
    warn?: (message: string) => void,
  ) {
    this.db = new Database(path.join(dir, 'logs.db'))
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000')
    this.gate(warn)
  }

  /**
   * Drop + recreate on a schema mismatch (pre-alpha, no migrations) — this is
   * log HISTORY, so warn loudly like the ingest store does, but a wipe of
   * transient logs is far less costly than a run-history wipe.
   */
  private gate(warn?: (message: string) => void): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS logs_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)',
    )
    const row = this.db.prepare('SELECT value FROM logs_meta WHERE key = ?').get('schema') as {
      value: number
    } | null
    if (row != null && row.value === LOGS_SCHEMA_VERSION) return
    if (row != null && row.value !== LOGS_SCHEMA_VERSION) {
      warn?.(`task-log store schema upgraded (${row.value} → ${LOGS_SCHEMA_VERSION}); logs reset`)
      this.db.exec('DROP TABLE IF EXISTS task_logs')
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_logs (
        run_id         TEXT    NOT NULL,
        task_id        TEXT    NOT NULL,
        hash           TEXT,
        status         TEXT    NOT NULL,
        codec          TEXT    NOT NULL DEFAULT 'plain',
        content        BLOB    NOT NULL,
        chars_full     INTEGER NOT NULL,
        bytes_stored   INTEGER NOT NULL,
        truncated_head INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL,
        PRIMARY KEY (run_id, task_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS task_logs_hash    ON task_logs(hash);
      CREATE INDEX IF NOT EXISTS task_logs_created ON task_logs(created_at);
    `)
    this.db
      .prepare('INSERT OR REPLACE INTO logs_meta (key, value) VALUES (?, ?)')
      .run('schema', LOGS_SCHEMA_VERSION)
  }

  /**
   * Persist a bundle's tasks — one transaction, INSERT OR IGNORE per
   * (run, task) (PK = idempotency; a re-delivered bundle adds nothing).
   * Server-side re-truncation to the caps regardless of what the client
   * claimed — the wire is never trusted for size. Returns rows newly stored.
   */
  ingestLogs(bundle: TaskLogBundle): number {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO task_logs
         (run_id, task_id, hash, status, codec, content, chars_full, bytes_stored, truncated_head, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const at = this.now()
    let stored = 0
    let runBudget = RUN_LOG_BUDGET_CHARS
    const tx = this.db.transaction(() => {
      // Failures already lead the bundle (the buffer's drain order); process in
      // order so, if a hostile/huge body blows the run budget, failures land
      // and later successes are the ones dropped.
      for (const t of bundle.tasks) {
        if (runBudget <= 0) break
        let content = t.content
        let extraTrunc = 0
        if (content.length > TASK_LOG_TAIL_CHARS) {
          const keep = content.slice(content.length - TASK_LOG_TAIL_CHARS)
          extraTrunc = content.length - keep.length
          content = keep
        }
        if (content.length > runBudget) {
          const keep = content.slice(content.length - runBudget)
          extraTrunc += content.length - keep.length
          content = keep
        }
        runBudget -= content.length
        const raw = Buffer.from(content, 'utf8')
        const useZstd = raw.length >= COMPRESS_THRESHOLD_BYTES
        const blob = useZstd ? Bun.zstdCompressSync(raw) : raw
        const info = insert.run(
          bundle.runId,
          t.taskId,
          t.hash ?? null,
          t.status,
          useZstd ? 'zstd' : 'plain',
          blob,
          t.charsFull,
          blob.length,
          t.truncatedHeadChars + extraTrunc,
          at,
        )
        if (info.changes > 0) stored++
      }
    })
    tx()
    this.maybePrune()
    return stored
  }

  /** The stored tail for one (run, task), or undefined. */
  logFor(runId: string, taskId: string): StoredTaskLog | undefined {
    const row = this.db
      .prepare('SELECT * FROM task_logs WHERE run_id = ? AND task_id = ?')
      .get(runId, taskId) as Row | null
    return row == null ? undefined : this.decode(row)
  }

  /** The most-recent stored log for a cache key — the hit→executed-run resolution. */
  latestByHash(hash: string): StoredTaskLog | undefined {
    const row = this.db
      .prepare('SELECT * FROM task_logs WHERE hash = ? ORDER BY created_at DESC LIMIT 1')
      .get(hash) as Row | null
    return row == null ? undefined : this.decode(row)
  }

  close(): void {
    this.db.close()
  }

  private decode(row: Row): StoredTaskLog {
    const bytes = row.codec === 'zstd' ? Bun.zstdDecompressSync(row.content) : row.content
    return {
      runId: row.run_id,
      taskId: row.task_id,
      ...(row.hash !== null ? { hash: row.hash } : {}),
      status: row.status === 'failed' ? 'failed' : 'success',
      content: Buffer.from(bytes).toString('utf8'),
      charsFull: row.chars_full,
      truncatedHeadChars: row.truncated_head,
    }
  }

  /**
   * Opportunistic prune, throttled to `PRUNE_INTERVAL_MS`: drop rows past the
   * age horizon, then, if the workspace still exceeds its byte ceiling, delete
   * whole oldest runs until under. Both cheap index scans.
   */
  private maybePrune(): void {
    const at = this.now()
    if (at - this.lastPruneAt < PRUNE_INTERVAL_MS) return
    this.lastPruneAt = at
    this.db.prepare('DELETE FROM task_logs WHERE created_at < ?').run(at - retentionMs())

    const total = (
      this.db.prepare('SELECT COALESCE(SUM(bytes_stored), 0) AS n FROM task_logs').get() as {
        n: number
      }
    ).n
    const ceiling = maxBytes()
    if (total <= ceiling) return
    // Delete whole runs oldest-first until under the ceiling. One run's rows
    // share a created_at (written in one transaction), so group by run.
    const runs = this.db
      .prepare(
        `SELECT run_id, MIN(created_at) AS ts, SUM(bytes_stored) AS bytes
         FROM task_logs GROUP BY run_id ORDER BY ts ASC`,
      )
      .all() as Array<{ run_id: string; ts: number; bytes: number }>
    let over = total - ceiling
    const del = this.db.prepare('DELETE FROM task_logs WHERE run_id = ?')
    for (const r of runs) {
      if (over <= 0) break
      del.run(r.run_id)
      over -= r.bytes
    }
  }
}
