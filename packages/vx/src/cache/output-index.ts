// The output fingerprint index: per-entry `output_files` rows (size, mode,
// millisecond mtime), this workspace's `output_stamps` (inode and ctime) and
// `output_dirs` rows (directory mtimes), and the two
// proofs a cache hit runs against the tree before deciding not to restore.
// Owns its statements over the store's handle; `Cache` delegates, and
// writes the file rows through `replaceFileRows` inside its own save
// transaction.

/** `mtime_ms` of a recorded output prefix that did not exist when the snapshot was taken. */
const ABSENT_DIR_MTIME = -1
/**
 * `mtime_ms` of a recorded output prefix that was a regular file: a literal
 * output naming one (`public/app.js`). The set under it is the file alone
 * while it stays a regular file; its bytes are the per-file check's.
 */
const FILE_PREFIX_MTIME = -2

import type { Database } from 'bun:sqlite'
import { inHashes, lazyStatement } from './schema.js'
import { lstatSync, statSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import {
  OUTPUT_DIRS_CAP,
  OUTPUT_DIRS_RACY_MS,
  type OutputDirRow,
  isIndexFull,
  racyWindowMs,
  type OutputFileRow,
  WORKSPACE_OUTPUT_PREFIX,
} from './layer.js'

export class OutputIndex {
  private readonly insertOutputFile: ReturnType<Database['prepare']>
  private readonly deleteOutputFiles: ReturnType<Database['prepare']>
  private readonly insertOutputDir: ReturnType<Database['prepare']>
  private readonly deleteOutputDirs: ReturnType<Database['prepare']>
  private readonly entryExists: ReturnType<Database['prepare']>
  private readonly stampOutputFile: ReturnType<Database['prepare']>
  private readonly deleteStamps: ReturnType<Database['prepare']>
  /**
   * Snapshots taken and not yet written, the last per hash. A snapshot is
   * read by the NEXT run's hit check, never by the task that took it, so
   * the rows land in one transaction at the first read, at prune, at
   * stats or at close — the way `accessed_at` bumps do — instead of one
   * commit per task: 1,000 of them were the whole `output dir snapshots`
   * stage, 47–72 ms at run end (item 622).
   */
  private readonly pendingDirs = new Map<string, Array<[string, number]> | null>()
  /** Stamps taken and not yet written, flushed with the directory snapshots. */
  private readonly pendingStamps = new Map<string, Array<[string, number, number]>>()

  constructor(private readonly db: Database) {
    this.insertOutputFile = lazyStatement(
      this.db,
      `
      INSERT INTO output_files(entry_hash, path, size_bytes, mode, mtime_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(entry_hash, path) DO UPDATE SET
        size_bytes = excluded.size_bytes,
        mode       = excluded.mode,
        mtime_ms   = excluded.mtime_ms
    `,
    )
    this.deleteOutputFiles = lazyStatement(this.db, 'DELETE FROM output_files WHERE entry_hash = ?')
    this.insertOutputDir = lazyStatement(
      this.db,
      'INSERT INTO output_dirs(entry_hash, path, mtime_ms) VALUES (?, ?, ?)',
    )
    this.deleteOutputDirs = lazyStatement(this.db, 'DELETE FROM output_dirs WHERE entry_hash = ?')
    this.entryExists = lazyStatement(this.db, 'SELECT 1 FROM entries WHERE hash = ?')
    this.stampOutputFile = lazyStatement(
      this.db,
      'INSERT INTO output_stamps(entry_hash, path, ino, ctime_ms) VALUES (?, ?, ?, ?) ON CONFLICT(entry_hash, path) DO UPDATE SET ino = excluded.ino, ctime_ms = excluded.ctime_ms',
    )
    this.deleteStamps = lazyStatement(this.db, 'DELETE FROM output_stamps WHERE entry_hash = ?')
  }

  /**
   * Drop this workspace's stamps and snapshots of `hashes`, whose entries
   * are gone: they live apart from the entry (it may be another database's),
   * so no cascade takes them.
   */
  forget(hashes: readonly string[]): void {
    if (hashes.length === 0) return
    for (const h of hashes) {
      this.pendingStamps.delete(h)
      this.pendingDirs.delete(h)
    }
    const { test, params } = inHashes(hashes)
    this.db.prepare(`DELETE FROM output_stamps WHERE entry_hash ${test}`).run(...params)
    this.db.prepare(`DELETE FROM output_dirs WHERE entry_hash ${test}`).run(...params)
  }

  /** `forget` every entry no longer stored: another workspace's prune of a shared store. */
  forgetGone(): void {
    this.db.transaction(() => {
      this.db.exec(
        'DELETE FROM output_stamps WHERE entry_hash NOT IN (SELECT hash FROM entries); DELETE FROM output_dirs WHERE entry_hash NOT IN (SELECT hash FROM entries)',
      )
    })()
  }

  /**
   * Replace an entry's file rows. Called INSIDE the store's save transaction,
   * so an entry and its fingerprints land together (an UPDATE on the same
   * hash refreshes rather than appends).
   */
  replaceFileRows(hash: string, rows: ReadonlyArray<[string, number, number, number]>): void {
    // A stamp taken for the rows this replaces describes their files, not these.
    this.pendingStamps.delete(hash)
    this.deleteOutputFiles.run(hash)
    this.deleteStamps.run(hash)
    for (const [rel, size, mode, mtime] of rows) {
      this.insertOutputFile.run(hash, rel, size, mode, mtime)
    }
  }

  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]> {
    const out = new Map<string, OutputFileRow[]>()
    if (hashes.length === 0) return out
    // `db.query` (not `db.prepare`) caches the compiled statement keyed by
    // the SQL text, which `inHashes` keeps to two: the single-hash warm-hit
    // path (called up to 3× per hit) reuses one instead of recompiling.
    // A reader in the same process (`vx watch`'s next cycle, a test) sees
    // the stamps taken, not only the ones flushed: overlaid below from
    // memory. A flush here committed a transaction per read, and a restore
    // reads its rows twice.
    const { test, params } = inHashes(hashes)
    const stmt = this.db.query(
      `SELECT f.entry_hash, f.path, f.size_bytes, f.mode, f.mtime_ms, s.ino, s.ctime_ms FROM output_files f LEFT JOIN output_stamps s ON s.entry_hash = f.entry_hash AND s.path = f.path WHERE f.entry_hash ${test}`,
    )
    const rows = stmt.all(...params) as Array<{
      entry_hash: string
      path: string
      size_bytes: number
      mode: number
      mtime_ms: number
      ino: number | null
      ctime_ms: number | null
    }>
    for (const r of rows) {
      let list = out.get(r.entry_hash)
      if (!list) {
        list = []
        out.set(r.entry_hash, list)
      }
      const row: OutputFileRow = {
        path: r.path,
        size: r.size_bytes,
        mode: r.mode,
        mtimeMs: r.mtime_ms,
      }
      if (r.ino !== null && r.ctime_ms !== null) {
        row.ino = r.ino
        row.ctimeMs = r.ctime_ms
      }
      const pending = this.pendingStamps.get(r.entry_hash)
      if (pending !== undefined) {
        for (const [rel, ino, ctime] of pending) {
          if (rel !== r.path) continue
          row.ino = ino
          row.ctimeMs = ctime
          break
        }
      }
      list.push(row)
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
          Math.abs(s.mtimeMs - e.mtimeMs) < 1 &&
          // And the file is the one THIS machine last saw under this
          // entry: two entries whose outputs carry one fixed mtime (a
          // `tar -x`, `cp -p`, SOURCE_DATE_EPOCH) and one size matched
          // each other's rows, and a hit left the other entry's bytes in
          // place under a green run (item 886). No task sets a ctime; the
          // inode is weaker than it looks, since ext4 gives a restore's new
          // file the inode the clean freed (item 941). A row without a stamp
          // (an ingest, a changed file at stamping) is never current. The
          // residual: a same-size rewrite, in place or as a new file on the
          // same inode, inside the coarse clock tick of the stamp, with the
          // mtime forged back.
          e.ino !== undefined &&
          s.ino === e.ino &&
          Math.floor(s.ctimeMs) === e.ctimeMs
        )
      } catch {
        return false
      }
    })
    return results.every(Boolean)
  }

  /**
   * Snapshot every directory under each of `prefixes` for `hash`, for a
   * tree that equals the entry's set. The run takes it at run end, when
   * the directories are past the racy window, and by then another task or
   * process may have written into them: `holds` is asked with the files
   * the walk saw, and a tree it refuses records nothing (item 1087).
   * Symlinked directories are not descended (the output walk refuses them
   * too). Over `OUTPUT_DIRS_CAP` directories, or on any error, the rows
   * are cleared and the next hit keeps the walk.
   */
  async recordOutputDirs(
    hash: string,
    projectDir: string,
    prefixes: readonly string[],
    holds?: (files: readonly string[]) => boolean,
  ): Promise<void> {
    const rows: Array<[string, number]> = []
    const files: string[] = []
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
      if (!st.isDirectory()) {
        // A literal output naming a file walked its glob on every hit: two
        // of this repo's site tasks, ~6 ms of each warm run (U-5).
        if (!isPrefix || !st.isFile()) return false
        rows.push([rel, FILE_PREFIX_MTIME])
        files.push(rel)
        return true
      }
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
        } else {
          files.push(`${rel}/${e.name}`)
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
    const now = Date.now()
    if (rows.some(([, mtime]) => mtime > now - racyWindowMs(mtime, OUTPUT_DIRS_RACY_MS))) ok = false
    if (ok && holds !== undefined && !holds(files)) ok = false
    this.pendingDirs.set(hash, ok ? rows : null)
  }

  /**
   * Stamp `hash`'s rows with each file's inode and ctime, once a save or
   * a restore has left the tree equal to the entry. A file whose size,
   * mode or mtime no longer matches its row is left unstamped, so a
   * write that landed since is never vouched for; the next hit restores.
   * Written with the directory snapshots, in one transaction.
   */
  recordOutputStamps(hash: string, projectDir: string, workspaceRoot: string): void {
    const rows = this.loadOutputFilesBatch([hash]).get(hash) ?? []
    const stamps: Array<[string, number, number]> = []
    for (const e of rows) {
      const ws = e.path.startsWith(WORKSPACE_OUTPUT_PREFIX)
      const abs = ws
        ? path.join(workspaceRoot, e.path.slice(WORKSPACE_OUTPUT_PREFIX.length))
        : path.join(projectDir, e.path)
      try {
        const s = statSync(abs)
        if (
          s.size === e.size &&
          (s.mode & 0o777) === (e.mode & 0o777) &&
          Math.abs(s.mtimeMs - e.mtimeMs) < 1
        ) {
          stamps.push([e.path, s.ino, Math.floor(s.ctimeMs)])
        }
      } catch {
        // gone: left unstamped
      }
    }
    if (stamps.length > 0) this.pendingStamps.set(hash, stamps)
  }

  /** Land every pending stamp and snapshot in one transaction each; a null snapshot clears its rows. */
  flushOutputDirs(): void {
    // A memo either way: on a full disk the pending rows are dropped (the
    // next hit walks, or restores), never a failed run (A-14).
    try {
      this.flushPending()
    } catch (err) {
      if (!isIndexFull(err)) throw err
    }
  }

  private flushPending(): void {
    if (this.pendingStamps.size > 0) {
      const stamps = [...this.pendingStamps]
      this.pendingStamps.clear()
      this.db.transaction(() => {
        for (const [hash, rows] of stamps) {
          // A stamp outlives nothing: an entry pruned since has no rows to vouch for.
          if (this.entryExists.get(hash) === null) continue
          for (const [rel, ino, ctime] of rows) this.stampOutputFile.run(hash, rel, ino, ctime)
        }
      })()
    }
    if (this.pendingDirs.size === 0) return
    const pending = [...this.pendingDirs]
    this.pendingDirs.clear()
    this.db.transaction(() => {
      for (const [hash, rows] of pending) {
        this.deleteOutputDirs.run(hash)
        // The rows describe the entry: one pruned by another process
        // between the snapshot and this flush has nothing to describe.
        if (rows === null || this.entryExists.get(hash) === null) continue
        for (const [rel, mtime] of rows) this.insertOutputDir.run(hash, rel, mtime)
      }
    })()
  }

  loadOutputDirsBatch(hashes: readonly string[]): Map<string, OutputDirRow[]> {
    const out = new Map<string, OutputDirRow[]>()
    if (hashes.length === 0) return out
    // A reader in the same process (`vx watch`'s next cycle, a test) sees
    // what was snapshotted, not what was flushed.
    this.flushOutputDirs()
    const { test, params } = inHashes(hashes)
    const rows = this.db
      .query(`SELECT entry_hash, path, mtime_ms FROM output_dirs WHERE entry_hash ${test}`)
      .all(...params) as Array<{
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
      if (r.mtimeMs === FILE_PREFIX_MTIME) return st.isFile()
      return st.isDirectory() && Math.abs(st.mtimeMs - r.mtimeMs) < 1
    })
    return results.every(Boolean)
  }
}
