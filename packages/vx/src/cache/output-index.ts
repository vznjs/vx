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
import { modeMatches } from './umask.js'
import { stampGrainMs } from './fs-clock.js'
import { lstatSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  OUTPUT_DIRS_CAP,
  OUTPUT_DIRS_OVER_CAP,
  OUTPUT_DIRS_RACY_MS,
  type OutputDirRow,
  isIndexFull,
  racyWindowMs,
  type OutputFileRow,
  WORKSPACE_OUTPUT_PREFIX,
} from './layer.js'

/**
 * The mode a symlink output's row carries (S_IFLNK): its size is the
 * target's byte length and its mtime the target's CRC-32.
 */
export const LINK_MODE = 0o120000

/**
 * The type bits a directory row carries beside a mode the restore applies
 * (`MetaFile.dirModes`); an empty directory's row without one is mode 0.
 */
export const DIR_MODE = 0o040000

/**
 * A directory the entry records no mode for holds what it was left with: the
 * save records only a mode that withholds what 0755 grants
 * (`narrowDirModes`), and a restore here leaves 0755 minus the umask.
 */
export function wideDirMode(disk: number): boolean {
  return (disk & 0o755) === 0o755 || modeMatches(disk, 0o755)
}

/**
 * The directories on the way to `rows` below their namespace that have no
 * row of their own, by row path without the slash: those the entry records
 * no mode for besides its empty ones. Climbs from each row until a
 * directory already met.
 */
export function rowAncestors(rows: readonly OutputFileRow[]): string[] {
  const seen = new Set<string>()
  for (const r of rows) if (r.path.endsWith('/')) seen.add(r.path.slice(0, -1))
  const out: string[] = []
  for (const r of rows) {
    const top = r.path.startsWith(WORKSPACE_OUTPUT_PREFIX) ? WORKSPACE_OUTPUT_PREFIX.length : 0
    const end = r.path.endsWith('/') ? r.path.length - 2 : r.path.length - 1
    for (let i = r.path.lastIndexOf('/', end); i > top; i = r.path.lastIndexOf('/', i - 1)) {
      const dir = r.path.slice(0, i)
      if (seen.has(dir)) break
      seen.add(dir)
      out.push(dir)
    }
  }
  return out
}

/**
 * A file system that keeps whole (or FAT's even) seconds stored a restore's
 * millisecond "now" as the second it falls in: that stamp, not a write.
 */
function secondOf(statMs: number, datedMs: number): boolean {
  const grain = stampGrainMs(statMs)
  return grain > 0 && datedMs >= statMs && datedMs - statMs < grain
}

/** A link row is current while a link with that target stands there; never followed. */
function linkCurrent(abs: string, e: { size: number; mtimeMs: number }): boolean {
  if (!lstatSync(abs).isSymbolicLink()) return false
  const to = readlinkSync(abs, 'buffer')
  return to.byteLength === e.size && Bun.hash.crc32(to) === e.mtimeMs
}

const FILES_SELECT =
  'SELECT f.entry_hash, f.path, f.size_bytes, f.mode, f.mtime_ms, s.ino, s.ctime_ms, s.mtime_ms AS stamp_mtime_ms'
const FILES_STAMPS = 'LEFT JOIN output_stamps s ON s.entry_hash = f.entry_hash AND s.path = f.path'
const FILES_JOINED = `${FILES_SELECT} FROM json_each(?) q JOIN output_files f ON f.entry_hash = q.value ${FILES_STAMPS}`
/**
 * A row as this index loads it: with its stamp, the mtime the file carried
 * when stamped, which a restore that wrote the file dated now and so is
 * not the row's saved one.
 */
interface StampedRow extends OutputFileRow {
  stampMtimeMs?: number
}

const DIRS_JOINED =
  'SELECT d.entry_hash, d.path, d.mtime_ms FROM json_each(?) q JOIN output_dirs d ON d.entry_hash = q.value'

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
  /**
   * Stamps taken and not yet written, flushed with the directory snapshots:
   * inode and ctime by path, so a batch read finds a row's stamp without
   * scanning them all (rows × stamps was ~7 s for a 40,000-file output).
   */
  private readonly pendingStamps = new Map<string, Map<string, [number, number, number]>>()
  /**
   * The rows the last batched probe loaded, by hash: a hit's restore and
   * the stamps after it read their rows here instead of the index, twice
   * a restore (X-162). Read for path, size, mode and mtime only; a stamp
   * taken since is the overlay `loadOutputFilesBatch` adds. Dropped when
   * an entry's rows are replaced, and replaced by the next probe; rows
   * held for an entry since pruned serve a restore that finds no artifact.
   * Another process's save under the same key is the race the hit's own
   * skip-restore check, which reads these rows, already runs.
   */
  private readonly held = new Map<string, readonly OutputFileRow[]>()

  /**
   * `memo` false: a cache directory this run cannot write. A restore still
   * serves the hit, but its stamps and directory snapshots are not queued:
   * the next lookup flushed them and failed its task (SQLITE_READONLY).
   */
  constructor(
    private readonly db: Database,
    private readonly memo = true,
  ) {
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
      'INSERT INTO output_stamps(entry_hash, path, ino, ctime_ms, mtime_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT(entry_hash, path) DO UPDATE SET ino = excluded.ino, ctime_ms = excluded.ctime_ms, mtime_ms = excluded.mtime_ms',
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
   * hash refreshes rather than appends). Answers the files' bytes.
   */
  replaceFileRows(hash: string, rows: ReadonlyArray<[string, number, number, number]>): number {
    // A stamp taken for the rows this replaces describes their files, not these.
    this.held.delete(hash)
    this.pendingStamps.delete(hash)
    this.deleteOutputFiles.run(hash)
    this.deleteStamps.run(hash)
    let bytes = 0
    for (const [rel, size, mode, mtime] of rows) {
      this.insertOutputFile.run(hash, rel, size, mode, mtime)
      bytes += size
    }
    return bytes
  }

  /** Hold a probe's rows for its restores (`held`), in place of the last probe's. */
  hold(rows: ReadonlyMap<string, readonly OutputFileRow[]>): void {
    this.held.clear()
    for (const [hash, list] of rows) this.held.set(hash, list)
  }

  /** The probe's rows of `hash` when held: no read. */
  heldRowsOf(hash: string): readonly OutputFileRow[] | undefined {
    return this.held.get(hash)
  }

  /** `hash`'s rows: the probe's when held, else read. Path, size, mode and mtime only. */
  rowsOf(hash: string): readonly OutputFileRow[] {
    return this.held.get(hash) ?? this.loadOutputFilesBatch([hash]).get(hash) ?? []
  }

  /**
   * `distinct`: `hashes` as a JSON array with no hash twice, which the probe
   * has to hand. The rows are then joined from it, not filtered by an `IN`
   * that builds a lookup of every hash first: ~1.5 ms of 8,002 hits, and as
   * much again for `loadOutputDirsBatch` (2026-11-07). A repeated hash
   * would repeat its rows, hence the caller's promise.
   */
  loadOutputFilesBatch(hashes: readonly string[], distinct?: string): Map<string, OutputFileRow[]> {
    const out = new Map<string, OutputFileRow[]>()
    if (hashes.length === 0) return out
    // `db.query` (not `db.prepare`) caches the compiled statement keyed by
    // the SQL text, which `inHashes` keeps to two: the single-hash warm-hit
    // path (called up to 3× per hit) reuses one instead of recompiling.
    // A reader in the same process (`vx watch`'s next cycle, a test) sees
    // the stamps taken, not only the ones flushed: overlaid below from
    // memory. A flush here committed a transaction per read, and a restore
    // reads its rows twice.
    let sql = FILES_JOINED
    let params = [distinct!]
    if (distinct === undefined || hashes.length === 1) {
      const where = inHashes(hashes)
      sql = `${FILES_SELECT} FROM output_files f ${FILES_STAMPS} WHERE f.entry_hash ${where.test}`
      params = where.params
    }
    const rows = this.db.query(sql).all(...params) as Array<{
      entry_hash: string
      path: string
      size_bytes: number
      mode: number
      mtime_ms: number
      ino: number | null
      ctime_ms: number | null
      stamp_mtime_ms: number | null
    }>
    for (const r of rows) {
      let list = out.get(r.entry_hash)
      if (!list) {
        list = []
        out.set(r.entry_hash, list)
      }
      const row: StampedRow = {
        path: r.path,
        size: r.size_bytes,
        mode: r.mode,
        mtimeMs: r.mtime_ms,
      }
      if (r.ino !== null && r.ctime_ms !== null && r.stamp_mtime_ms !== null) {
        row.ino = r.ino
        row.ctimeMs = r.ctime_ms
        row.stampMtimeMs = r.stamp_mtime_ms
      }
      const stamp = this.pendingStamps.get(r.entry_hash)?.get(r.path)
      if (stamp !== undefined) {
        row.ino = stamp[0]
        row.ctimeMs = stamp[1]
        row.stampMtimeMs = stamp[2]
      }
      list.push(row)
    }
    return out
  }

  isOutputsCurrent(projectDir: string, expected: readonly StampedRow[]): boolean {
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
        if (e.mode === LINK_MODE) return linkCurrent(path.join(projectDir, e.path), e)
        const s = statSync(path.join(projectDir, e.path))
        // An empty output directory: current while a directory stands there,
        // with the mode its row records, or one at least 0755 without.
        if (e.path.endsWith('/'))
          return (
            s.isDirectory() &&
            ((e.mode & 0o170000) === DIR_MODE ? modeMatches(s.mode, e.mode) : wideDirMode(s.mode))
          )
        return (
          s.size === e.size &&
          modeMatches(s.mode, e.mode) &&
          // MILLISECOND comparison (sub-ms tolerance for the float
          // round-trip through utimes), against the mtime the file carried
          // when stamped: the row's after a save; after a restore, now for
          // a file it wrote and the file's own where its bytes stood.
          Math.abs(s.mtimeMs - (e.stampMtimeMs ?? e.mtimeMs)) < 1 &&
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
          // mtime forged back or written in that tick (a save's or a
          // restore's file is dated in it).
          e.ino !== undefined &&
          s.ino === e.ino &&
          Math.floor(s.ctimeMs) === e.ctimeMs
        )
      } catch {
        return false
      }
    })
    if (!results.every(Boolean)) return false
    // A directory holding outputs has no row unless its mode is narrow, so
    // a chmod of one left the tree "current" (a stat per directory).
    for (const dir of rowAncestors(expected)) {
      const s = statSync(path.join(projectDir, dir), { throwIfNoEntry: false })
      if (s === undefined || !wideDirMode(s.mode)) return false
    }
    return true
  }

  /**
   * Snapshot every directory under each of `prefixes` for `hash`, for a
   * tree that equals the entry's set. The run takes it at run end, when
   * the directories are past the racy window, and by then another task or
   * process may have written into them: `holds` is asked with the files
   * the walk saw, and a tree it refuses records nothing (item 1087).
   * Symlinked directories are not descended (the output walk refuses them
   * too). Over `OUTPUT_DIRS_CAP` directories the one row left says so; on
   * any error the rows are cleared. Either way the next hit keeps the walk.
   */
  async recordOutputDirs(
    hash: string,
    projectDir: string,
    prefixes: readonly string[],
    holds?: (files: readonly string[]) => boolean,
  ): Promise<void> {
    if (!this.memo) return
    const rows: Array<[string, number]> = []
    const files: string[] = []
    let overCap = false
    // Synchronous, like the stats of `isOutputsCurrent`: an async lstat and
    // readdir per directory are two thread-pool round trips, and a
    // root-anchored glob's snapshot of solid's 47 directories took 4 ms of
    // the run's end that way (2026-10-22).
    const walk = (rel: string, isPrefix = false): boolean => {
      const abs = path.join(projectDir, rel)
      let st
      try {
        st = lstatSync(abs)
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
      if (rows.length > OUTPUT_DIRS_CAP) {
        overCap = true
        return false
      }
      let entries
      try {
        entries = readdirSync(abs, { withFileTypes: true })
      } catch {
        return false
      }
      for (const e of entries) {
        // The project itself is the prefix `''` of a root-anchored glob.
        const child = rel === '' ? e.name : `${rel}/${e.name}`
        if (e.isDirectory() && !e.isSymbolicLink()) {
          if (!walk(child)) return false
        } else {
          files.push(child)
        }
      }
      return true
    }
    let ok = true
    for (const prefix of prefixes) {
      if (!walk(prefix, true)) {
        ok = false
        break
      }
    }
    if (overCap) {
      this.pendingDirs.set(hash, [[prefixes[0]!, OUTPUT_DIRS_OVER_CAP]])
      return
    }
    // All or nothing: a racy directory dropped alone would leave its
    // parent trusted while an addition inside it bumps only the dropped one.
    const now = Date.now()
    if (rows.some(([, mtime]) => mtime > now - racyWindowMs(mtime, OUTPUT_DIRS_RACY_MS))) ok = false
    if (ok && holds !== undefined && !holds(files)) ok = false
    this.pendingDirs.set(hash, ok ? rows : null)
  }

  /**
   * Stamp `hash`'s rows with each file's inode, ctime and mtime, once a
   * save or a restore has left the tree equal to the entry. `dated` holds
   * the mtime a restore left each file with, by row path (now for one it
   * wrote); any other file is held to its row's. A file whose size, mode or mtime no
   * longer matches is left unstamped, so a write that landed since is
   * never vouched for; the next hit restores. Written with the directory
   * snapshots, in one transaction.
   */
  recordOutputStamps(
    hash: string,
    projectDir: string,
    workspaceRoot: string,
    dated?: ReadonlyMap<string, number>,
  ): void {
    if (!this.memo) return
    const rows = this.rowsOf(hash)
    const stamps = new Map<string, [number, number, number]>()
    for (const e of rows) {
      if (e.path.endsWith('/') || e.mode === LINK_MODE) continue
      const ws = e.path.startsWith(WORKSPACE_OUTPUT_PREFIX)
      const abs = ws
        ? path.join(workspaceRoot, e.path.slice(WORKSPACE_OUTPUT_PREFIX.length))
        : path.join(projectDir, e.path)
      try {
        const s = statSync(abs)
        const at = dated?.get(e.path) ?? e.mtimeMs
        if (
          s.size === e.size &&
          modeMatches(s.mode, e.mode) &&
          (Math.abs(s.mtimeMs - at) < 1 || secondOf(s.mtimeMs, at))
        ) {
          stamps.set(e.path, [s.ino, Math.floor(s.ctimeMs), Math.floor(s.mtimeMs)])
        }
      } catch {
        // gone: left unstamped
      }
    }
    if (stamps.size > 0) this.pendingStamps.set(hash, stamps)
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
      // IMMEDIATE: the body reads `entries` before it writes, and a
      // deferred transaction that did could not wait for the lock
      // (run-history.ts).
      this.db
        .transaction(() => {
          for (const [hash, rows] of stamps) {
            // A stamp outlives nothing: an entry pruned since has no rows to vouch for.
            if (this.entryExists.get(hash) === null) continue
            for (const [rel, [ino, ctime, mtime]] of rows)
              this.stampOutputFile.run(hash, rel, ino, ctime, mtime)
          }
        })
        .immediate()
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

  /** `distinct` as `loadOutputFilesBatch` takes it. */
  loadOutputDirsBatch(hashes: readonly string[], distinct?: string): Map<string, OutputDirRow[]> {
    const out = new Map<string, OutputDirRow[]>()
    if (hashes.length === 0) return out
    // A reader in the same process (`vx watch`'s next cycle, a test) sees
    // what was snapshotted, not what was flushed.
    this.flushOutputDirs()
    let sql = DIRS_JOINED
    let params = [distinct!]
    if (distinct === undefined || hashes.length === 1) {
      const where = inHashes(hashes)
      sql = `SELECT entry_hash, path, mtime_ms FROM output_dirs WHERE entry_hash ${where.test}`
      params = where.params
    }
    const rows = this.db.query(sql).all(...params) as Array<{
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
  outputDirsCurrent(projectDir: string, rows: readonly OutputDirRow[]): boolean {
    if (rows.length === 0) return false
    const results = rows.map((r) => {
      let st
      try {
        // No throw for a missing dir: every restore after a clean asks
        // about one, and an exception per hit cost more than the stat.
        st = lstatSync(path.join(projectDir, r.path), { throwIfNoEntry: false })
      } catch {
        return r.mtimeMs === ABSENT_DIR_MTIME
      }
      if (st === undefined) return r.mtimeMs === ABSENT_DIR_MTIME
      if (r.mtimeMs === ABSENT_DIR_MTIME) return false
      if (r.mtimeMs === FILE_PREFIX_MTIME) return st.isFile()
      return st.isDirectory() && Math.abs(st.mtimeMs - r.mtimeMs) < 1
    })
    return results.every(Boolean)
  }
}
