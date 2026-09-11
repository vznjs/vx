// The output fingerprint index: per-entry `output_files` rows (size, mode,
// millisecond mtime) and `output_dirs` rows (directory mtimes), and the two
// proofs a cache hit runs against the tree before deciding not to restore.
// Owns its statements over the store's handle; `Cache` delegates, and
// writes the file rows through `replaceFileRows` inside its own save
// transaction.

/** `mtime_ms` of a recorded output prefix that did not exist when the snapshot was taken. */
const ABSENT_DIR_MTIME = -1

import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { lstatSync, statSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import {
  OUTPUT_DIRS_CAP,
  OUTPUT_DIRS_RACY_MS,
  type OutputDirRow,
  type OutputFileRow,
} from './layer.js'

export class OutputIndex {
  private readonly insertOutputFile: ReturnType<Database['prepare']>
  private readonly deleteOutputFiles: ReturnType<Database['prepare']>
  private readonly insertOutputDir: ReturnType<Database['prepare']>
  private readonly deleteOutputDirs: ReturnType<Database['prepare']>

  constructor(private readonly db: Database) {
    this.insertOutputFile = this.db.prepare(`
      INSERT INTO output_files(entry_hash, path, size_bytes, mode, mtime_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(entry_hash, path) DO UPDATE SET
        size_bytes = excluded.size_bytes,
        mode       = excluded.mode,
        mtime_ms   = excluded.mtime_ms
    `)
    this.deleteOutputFiles = this.db.prepare('DELETE FROM output_files WHERE entry_hash = ?')
    this.insertOutputDir = this.db.prepare(
      'INSERT INTO output_dirs(entry_hash, path, mtime_ms) VALUES (?, ?, ?)',
    )
    this.deleteOutputDirs = this.db.prepare('DELETE FROM output_dirs WHERE entry_hash = ?')
  }

  /**
   * Replace an entry's file rows. Called INSIDE the store's save transaction,
   * so an entry and its fingerprints land together (an UPDATE on the same
   * hash refreshes rather than appends).
   */
  replaceFileRows(hash: string, rows: ReadonlyArray<[string, number, number, number]>): void {
    this.deleteOutputFiles.run(hash)
    for (const [rel, size, mode, mtime] of rows) {
      this.insertOutputFile.run(hash, rel, size, mode, mtime)
    }
  }

  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]> {
    const out = new Map<string, OutputFileRow[]>()
    if (hashes.length === 0) return out
    // Inline placeholders for an IN-list — bun:sqlite doesn't ship
    // rarray, but `IN (?, ?, …)` with N≤~999 is fast and avoids per-
    // hash select.get() overhead. `db.query` (not `db.prepare`) caches the
    // compiled statement keyed by the SQL text — so the dominant single-hash
    // warm-hit path (called up to 3× per hit) reuses one statement instead of
    // recompiling on every call.
    const placeholders = hashes.map(() => '?').join(',')
    const stmt = this.db.query(
      `SELECT entry_hash, path, size_bytes, mode, mtime_ms FROM output_files WHERE entry_hash IN (${placeholders})`,
    )
    const rows = stmt.all(...(hashes as readonly SQLQueryBindings[])) as Array<{
      entry_hash: string
      path: string
      size_bytes: number
      mode: number
      mtime_ms: number
    }>
    for (const r of rows) {
      let list = out.get(r.entry_hash)
      if (!list) {
        list = []
        out.set(r.entry_hash, list)
      }
      list.push({ path: r.path, size: r.size_bytes, mode: r.mode, mtimeMs: r.mtime_ms })
    }
    return out
  }

  async isOutputsCurrent(projectDir: string, expected: readonly OutputFileRow[]): Promise<boolean> {
    // Empty manifest case (a task produced no outputs) → trivially
    // current; the on-disk tree under projectDir is whatever it was,
    // and nothing was supposed to land there.
    if (expected.length === 0) return true
    // statSync, deliberately. The async form measured faster on 2026-09-02,
    // when a hit walked its whole output tree; since the directory
    // short-circuit (`outputDirsCurrent`) a warm hit stats a handful of
    // paths, and each async stat costs a thread-pool round trip the
    // scheduler cannot overlap away (its concurrency is the worker count).
    // Re-measured 2026-09-09, 1,000 warm hits, interleaved A/B: the run
    // graph stage 100 → 54 ms, the whole process 422 → 368 ms.
    const results = expected.map((e) => {
      try {
        const s = statSync(path.join(projectDir, e.path))
        return (
          s.size === e.size &&
          (s.mode & 0o777) === (e.mode & 0o777) &&
          // MILLISECOND comparison (sub-ms tolerance for the float
          // round-trip through utimes). Save rows carry stat-ms and
          // restoreOutputs re-syncs restored files to the row value,
          // so equality holds exactly in steady state; legacy
          // second-precision rows converge on their first restore.
          // Residual blind spot: a same-size edit landing in the SAME
          // millisecond as the recorded write, or a deliberately
          // forged mtime (touch -r) — the trade every mtime-based
          // skip check accepts.
          Math.abs(s.mtimeMs - e.mtimeMs) < 1
        )
      } catch {
        return false
      }
    })
    return results.every(Boolean)
  }

  /**
   * Snapshot every directory under each of `prefixes` for `hash`. Called
   * after a save and after a restore, when the tree is known to equal the
   * entry's set. Symlinked directories are not descended (the output walk
   * refuses them too). Over `OUTPUT_DIRS_CAP` directories, or on any
   * error, the rows are cleared and the next hit keeps the walk.
   */
  async recordOutputDirs(
    hash: string,
    projectDir: string,
    prefixes: readonly string[],
  ): Promise<void> {
    const rows: Array<[string, number]> = []
    const walk = async (rel: string, isPrefix = false): Promise<boolean> => {
      const abs = path.join(projectDir, rel)
      let st
      try {
        st = await lstat(abs)
      } catch {
        // A declared prefix the task never produced (`build/**` beside
        // `dist/**`, medusa's `.medusa/**`) is recorded ABSENT: the check
        // then asks that it still not exist. Refusing the snapshot instead
        // made every such task re-glob its outputs on every warm hit — all
        // 83 of medusa's, 210 ms of a 2.5 s no-op (2026-09-11).
        if (isPrefix) {
          rows.push([rel, ABSENT_DIR_MTIME])
          return true
        }
        return false
      }
      if (!st.isDirectory()) return false
      rows.push([rel, st.mtimeMs])
      if (rows.length > OUTPUT_DIRS_CAP) return false
      let entries
      try {
        entries = await readdir(abs, { withFileTypes: true })
      } catch {
        return false
      }
      for (const e of entries) {
        if (e.isDirectory() && !e.isSymbolicLink()) {
          if (!(await walk(`${rel}/${e.name}`))) return false
        }
      }
      return true
    }
    let ok = true
    for (const prefix of prefixes) {
      if (!(await walk(prefix, true))) {
        ok = false
        break
      }
    }
    // All or nothing: a racy directory dropped alone would leave its
    // parent trusted while an addition inside it bumps only the dropped one.
    const youngest = Date.now() - OUTPUT_DIRS_RACY_MS
    if (rows.some(([, mtime]) => mtime > youngest)) ok = false
    this.db.transaction(() => {
      this.deleteOutputDirs.run(hash)
      if (!ok) return
      for (const [rel, mtime] of rows) this.insertOutputDir.run(hash, rel, mtime)
    })()
  }

  loadOutputDirsBatch(hashes: readonly string[]): Map<string, OutputDirRow[]> {
    const out = new Map<string, OutputDirRow[]>()
    if (hashes.length === 0) return out
    const placeholders = hashes.map(() => '?').join(',')
    const rows = this.db
      .query(
        `SELECT entry_hash, path, mtime_ms FROM output_dirs WHERE entry_hash IN (${placeholders})`,
      )
      .all(...(hashes as readonly SQLQueryBindings[])) as Array<{
      entry_hash: string
      path: string
      mtime_ms: number
    }>
    for (const r of rows) {
      const list = out.get(r.entry_hash)
      const row = { path: r.path, mtimeMs: r.mtime_ms }
      if (list) list.push(row)
      else out.set(r.entry_hash, [row])
    }
    return out
  }

  /** True iff every recorded directory exists with its recorded mtime (ms). Same forged-mtime trade as the file check. */
  async outputDirsCurrent(projectDir: string, rows: readonly OutputDirRow[]): Promise<boolean> {
    if (rows.length === 0) return false
    const results = rows.map((r) => {
      let st
      try {
        st = lstatSync(path.join(projectDir, r.path))
      } catch {
        return r.mtimeMs === ABSENT_DIR_MTIME
      }
      if (r.mtimeMs === ABSENT_DIR_MTIME) return false
      return st.isDirectory() && Math.abs(st.mtimeMs - r.mtimeMs) < 1
    })
    return results.every(Boolean)
  }
}
