// Per-workspace persisted output-fingerprint store (verify-cross-machine §3).
// A SQLite sidecar `<workspaceDir>/fingerprints.db` — deliberately NOT a table
// in core's Cache schema (that would bump SCHEMA_VERSION for every user's
// local cache.db for a cloud-only feature; the log-store rationale). Its own
// version gate; history, not cache.
//
// One row per (cache key, os, arch, tree): INSERT OR IGNORE makes re-delivery
// idempotent, a deterministic task costs one row per platform forever, and a
// task reporting two trees on the SAME platform accumulates both rows — the
// same-platform nondeterminism signal, observed without the 2× re-run.
// Platform identity = os + arch; `host` is a stored debugging detail, never
// identity. Divergence is computed at READ time (`hermeticity()`), naming the
// diverging rels via core's `diffOutputTrees` — the one tree-diff
// implementation, shared with the verify verdict.

import { Database } from 'bun:sqlite'
import path from 'node:path'
import { diffOutputTrees, type OutputFingerprint } from '@vzn/vx'

const FP_SCHEMA_VERSION = 1

/** Server-side per-file cap, re-applied regardless of what the wire claims. */
export const FP_MAX_FILES = 500

/** A files blob at/over this many bytes is stored zstd-compressed. */
const COMPRESS_THRESHOLD_BYTES = 4 * 1024

/** Prune runs at most this often (ms). */
const PRUNE_INTERVAL_MS = 5 * 60 * 1000

// zstd frames always open with this magic; a JSON pairs array opens with `[`.
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function retentionMs(): number {
  const days = Number(process.env['VX_CLOUD_FP_RETENTION_DAYS'])
  // Divergence is slow-moving; nightly per-platform recipes need a long
  // window for two platforms' reports on one key to pair up.
  return (Number.isFinite(days) && days > 0 ? days : 90) * 24 * 60 * 60 * 1000
}

function maxBytes(): number {
  const n = Number(process.env['VX_CLOUD_FP_MAX_BYTES'])
  return Number.isFinite(n) && n > 0 ? n : 128 * 1024 * 1024
}

/** One task's fingerprint report, extracted from an ingested summary. */
export interface FpReport {
  hash: string
  os: string
  arch: string
  host: string | null
  taskId: string
  runId: string
  fp: OutputFingerprint
}

export interface HermeticityReport {
  os: string
  arch: string
  tree: string
  runId: string
  host: string | null
  at: number
}

export interface DivergentKey {
  hash: string
  taskId: string
  /** false ⇒ same-platform run-to-run divergence (the Phase-1 signal). */
  crossPlatform: boolean
  /** Output keys on which any two reports' file maps disagree, sorted. */
  changed: string[]
  /** false when any report was tree-only / truncated — `changed` may be partial. */
  changedComplete: boolean
  reports: HermeticityReport[]
}

export interface HermeticityResult {
  divergent: DivergentKey[]
  keysTracked: number
  reportCount: number
}

interface Row {
  hash: string
  os: string
  arch: string
  tree: string
  file_count: number
  files: Uint8Array | null
  truncated: number
  task_id: string
  run_id: string
  host: string | null
  created_at: number
}

function isPairArray(v: unknown): v is ReadonlyArray<readonly [string, string]> {
  return (
    Array.isArray(v) &&
    v.every(
      (p) =>
        Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string',
    )
  )
}

/** Validate one wire report at the network boundary. */
function validReport(r: FpReport): boolean {
  const fp = r.fp as unknown
  return (
    typeof r.hash === 'string' &&
    r.hash !== '' &&
    typeof r.os === 'string' &&
    r.os !== '' &&
    typeof r.arch === 'string' &&
    r.arch !== '' &&
    typeof r.taskId === 'string' &&
    r.taskId !== '' &&
    typeof r.runId === 'string' &&
    r.runId !== '' &&
    typeof fp === 'object' &&
    fp !== null &&
    typeof (fp as OutputFingerprint).tree === 'string' &&
    (fp as OutputFingerprint).tree !== '' &&
    Number.isInteger((fp as OutputFingerprint).fileCount) &&
    (fp as OutputFingerprint).fileCount >= 0 &&
    ((fp as OutputFingerprint).files === undefined || isPairArray((fp as OutputFingerprint).files))
  )
}

/**
 * One `fingerprints.db` per workspace. Opened lazily by `IngestStore` next to
 * the per-workspace `Cache`. `now` is injectable for deterministic prune tests.
 */
export class FpStore {
  private readonly db: Database
  private lastPruneAt = 0

  constructor(
    dir: string,
    private readonly now: () => number = Date.now,
    warn?: (message: string) => void,
  ) {
    this.db = new Database(path.join(dir, 'fingerprints.db'))
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000')
    this.gate(warn)
  }

  /** Drop + recreate on a schema mismatch (pre-alpha, no migrations), loudly. */
  private gate(warn?: (message: string) => void): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS fp_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)',
    )
    const row = this.db.prepare('SELECT value FROM fp_meta WHERE key = ?').get('schema') as {
      value: number
    } | null
    if (row != null && row.value === FP_SCHEMA_VERSION) return
    if (row != null && row.value !== FP_SCHEMA_VERSION) {
      warn?.(
        `fingerprint store schema upgraded (${row.value} → ${FP_SCHEMA_VERSION}); fingerprints reset`,
      )
      this.db.exec('DROP TABLE IF EXISTS output_fp')
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS output_fp (
        hash        TEXT    NOT NULL,
        os          TEXT    NOT NULL,
        arch        TEXT    NOT NULL,
        tree        TEXT    NOT NULL,
        file_count  INTEGER NOT NULL,
        files       BLOB,
        truncated   INTEGER NOT NULL DEFAULT 0,
        task_id     TEXT    NOT NULL,
        run_id      TEXT    NOT NULL,
        host        TEXT,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (hash, os, arch, tree)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS output_fp_created ON output_fp(created_at);
    `)
    this.db
      .prepare('INSERT OR REPLACE INTO fp_meta (key, value) VALUES (?, ?)')
      .run('schema', FP_SCHEMA_VERSION)
  }

  /**
   * Persist a run's reports — one transaction, INSERT OR IGNORE per PK
   * (idempotent re-delivery; a known (key, platform, tree) adds nothing).
   * Server-side re-truncation to `FP_MAX_FILES` regardless of the wire's
   * claim (re-sorted first, so a hostile unsorted map still truncates to the
   * deterministic subset). Malformed rows are skipped — the body is a
   * network boundary. Returns rows newly stored.
   */
  ingest(reports: readonly FpReport[]): number {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO output_fp
         (hash, os, arch, tree, file_count, files, truncated, task_id, run_id, host, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const at = this.now()
    let stored = 0
    const tx = this.db.transaction(() => {
      for (const r of reports) {
        if (!validReport(r)) continue
        let files = r.fp.files
        let truncated = r.fp.truncated === true
        let blob: Uint8Array | null = null
        if (files !== undefined) {
          if (files.length > FP_MAX_FILES) {
            files = [...files].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, FP_MAX_FILES)
            truncated = true
          }
          const raw = Buffer.from(JSON.stringify(files), 'utf8')
          blob = raw.length >= COMPRESS_THRESHOLD_BYTES ? Bun.zstdCompressSync(raw) : raw
        }
        const info = insert.run(
          r.hash,
          r.os,
          r.arch,
          r.fp.tree,
          r.fp.fileCount,
          blob,
          truncated ? 1 : 0,
          r.taskId,
          r.runId,
          r.host,
          at,
        )
        if (info.changes > 0) stored++
      }
    })
    tx()
    this.maybePrune()
    return stored
  }

  /**
   * The divergence read (verify-cross-machine §4): keys with >1 distinct
   * tree, most recently reported first, diffed at read time. `changed` is
   * the union of keys on which any two distinct trees' file maps disagree.
   */
  hermeticity(limit: number): HermeticityResult {
    const totals = this.db
      .prepare('SELECT COUNT(DISTINCT hash) AS keys, COUNT(*) AS reports FROM output_fp')
      .get() as { keys: number; reports: number }
    const hashes = this.db
      .prepare(
        `SELECT hash FROM output_fp GROUP BY hash
         HAVING COUNT(DISTINCT tree) > 1
         ORDER BY MAX(created_at) DESC LIMIT ?`,
      )
      .all(limit) as Array<{ hash: string }>
    const rows = this.db.prepare('SELECT * FROM output_fp WHERE hash = ? ORDER BY created_at DESC')
    return {
      divergent: hashes.map((h) => this.divergence(rows.all(h.hash) as Row[])),
      keysTracked: totals.keys,
      reportCount: totals.reports,
    }
  }

  close(): void {
    this.db.close()
  }

  private divergence(rows: Row[]): DivergentKey {
    // Cross-platform iff some pair of DIFFERENT trees comes from DIFFERENT
    // platforms; same-platform-only divergence is the run-to-run signal.
    let crossPlatform = false
    for (const a of rows) {
      for (const b of rows) {
        if (a.tree !== b.tree && (a.os !== b.os || a.arch !== b.arch)) crossPlatform = true
      }
    }
    // One representative file map per distinct tree; pairwise-diff them. A
    // tree-only / truncated report can't name every rel — flag the diff
    // partial rather than pretending completeness.
    const changedComplete = rows.every((r) => r.files !== null && r.truncated === 0)
    const byTree = new Map<string, Map<string, string>>()
    for (const r of rows) {
      if (r.files === null || byTree.has(r.tree)) continue
      byTree.set(r.tree, new Map(decodeFiles(r.files)))
    }
    const changed = new Set<string>()
    const maps = [...byTree.values()]
    for (let i = 0; i < maps.length; i++) {
      for (let j = i + 1; j < maps.length; j++) {
        for (const rel of diffOutputTrees(maps[i]!, maps[j]!)) changed.add(rel)
      }
    }
    return {
      hash: rows[0]!.hash,
      taskId: rows[0]!.task_id,
      crossPlatform,
      changed: [...changed].sort(),
      changedComplete,
      reports: rows.map((r) => ({
        os: r.os,
        arch: r.arch,
        tree: r.tree,
        runId: r.run_id,
        host: r.host,
        at: r.created_at,
      })),
    }
  }

  /**
   * Opportunistic prune, throttled: drop rows past the age horizon, then, if
   * the workspace still exceeds its byte ceiling, delete oldest rows until
   * under (LogStore's mechanics; rows here are independent, not run-grouped).
   */
  private maybePrune(): void {
    const at = this.now()
    if (at - this.lastPruneAt < PRUNE_INTERVAL_MS) return
    this.lastPruneAt = at
    this.db.prepare('DELETE FROM output_fp WHERE created_at < ?').run(at - retentionMs())

    const total = (
      this.db
        .prepare('SELECT COALESCE(SUM(COALESCE(LENGTH(files), 0) + 64), 0) AS n FROM output_fp')
        .get() as { n: number }
    ).n
    const ceiling = maxBytes()
    if (total <= ceiling) return
    const rows = this.db
      .prepare(
        `SELECT hash, os, arch, tree, COALESCE(LENGTH(files), 0) + 64 AS bytes
         FROM output_fp ORDER BY created_at ASC`,
      )
      .all() as Array<{ hash: string; os: string; arch: string; tree: string; bytes: number }>
    let over = total - ceiling
    const del = this.db.prepare(
      'DELETE FROM output_fp WHERE hash = ? AND os = ? AND arch = ? AND tree = ?',
    )
    for (const r of rows) {
      if (over <= 0) break
      del.run(r.hash, r.os, r.arch, r.tree)
      over -= r.bytes
    }
  }
}

function decodeFiles(blob: Uint8Array): Array<[string, string]> {
  const isZstd = blob.length >= 4 && ZSTD_MAGIC.every((b, i) => blob[i] === b)
  const bytes = isZstd ? Bun.zstdDecompressSync(blob) : blob
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as Array<[string, string]>
}
