// The output fingerprint index: per-entry `output_files` rows (size, mode, ms
// mtime), this workspace's `output_stamps` (inode, ctime) and `output_dirs`
// (directory mtimes), and the two proofs a hit runs before deciding not to
// restore. `Cache` delegates; file rows are written inside its save
// transaction.

/** `mtime_ms` of a recorded output prefix that did not exist when the snapshot was taken. */
const ABSENT_DIR_MTIME = -1
/**
 * `mtime_ms` of a recorded output prefix that was a regular file (a literal
 * output naming one): its set is the file alone.
 */
const FILE_PREFIX_MTIME = -2

import type { Database } from 'bun:sqlite'
import { inHashes, lazyStatement, isIndexFull } from '../index-db/index.js'
import { modeMatches } from '../util/index.js'
import { stampGrainMs, racyWindowMs } from './fs-clock.js'
import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

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
 * A directory with no recorded mode holds what it was left with: the save
 * records only modes narrower than 0755 (`narrowDirModes`).
 */
export function wideDirMode(disk: number): boolean {
  return (disk & 0o755) === 0o755 || modeMatches(disk, 0o755)
}

/**
 * The directories on the way to `rows` with no row of their own: those the
 * entry records no mode for besides its empty ones.
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
const FILES_STAMPS =
  'LEFT JOIN output_stamps s ON s.entry_hash = f.entry_hash AND s.root = ? AND s.path = f.path'
const FILES_JOINED = `${FILES_SELECT} FROM json_each(?) q JOIN output_files f ON f.entry_hash = q.value ${FILES_STAMPS}`
/**
 * A row as loaded, with its stamp's mtime: a restore that wrote the file dated
 * it now.
 */
interface StampedRow extends OutputFileRow {
  stampMtimeMs?: number
}

const DIRS_JOINED =
  'SELECT d.entry_hash, d.path, d.mtime_ms FROM json_each(?) q JOIN output_dirs d ON d.entry_hash = q.value AND d.root = ?'

export class OutputIndex {
  private readonly insertOutputFile: ReturnType<Database['prepare']>
  private readonly deleteOutputFiles: ReturnType<Database['prepare']>
  private readonly insertOutputDir: ReturnType<Database['prepare']>
  private readonly deleteOutputDirs: ReturnType<Database['prepare']>
  private readonly entryExists: ReturnType<Database['prepare']>
  private readonly stampOutputFile: ReturnType<Database['prepare']>
  private readonly deleteStamps: ReturnType<Database['prepare']>
  /**
   * Snapshots not yet written, last per hash. Read only by the next run's hit
   * check, so they land in one transaction at the first read, prune, stats or
   * close, like `accessed_at` bumps: a commit per task was 47-72 ms at run end
   * for 1,000.
   */
  private readonly pendingDirs = new Map<string, Array<[string, number]> | null>()
  /**
   * Directory modes a `true` `outputDirsCurrent` just read, so the
   * `isOutputsCurrent` asked next in the same check reads them here, not by a
   * second stat. Taken by that call, never read past it.
   */
  private dirModes: Map<string, number> | undefined
  /**
   * Stamps not yet written, flushed with the snapshots, by path: rows × stamps
   * scanning was ~7 s for a 40,000-file output.
   */
  private readonly pendingStamps = new Map<string, Map<string, [number, number, number]>>()
  /**
   * The rows the last batched probe loaded: a hit's restore and the stamps
   * after it read here, not the index. A stamp taken since is overlaid by
   * `loadOutputFilesBatch`. Dropped when an entry's rows are replaced; rows of
   * a since-pruned entry serve a restore that finds no artifact.
   */
  private readonly held = new Map<string, readonly OutputFileRow[]>()
  private rootKey: number | undefined

  /**
   * `memo` false: an unwritable cache dir. Hits still restore, but stamps and
   * snapshots are not queued (the flush failed the task with SQLITE_READONLY).
   * `sharedRoot`: the root of an index other workspaces may share, which keys
   * this one's stamps and snapshots.
   */
  constructor(
    private readonly db: Database,
    private readonly memo = true,
    private readonly sharedRoot?: string,
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
      'INSERT INTO output_dirs(entry_hash, root, path, mtime_ms) VALUES (?, ?, ?, ?)',
    )
    this.deleteOutputDirs = lazyStatement(
      this.db,
      'DELETE FROM output_dirs WHERE entry_hash = ? AND root = ?',
    )
    this.entryExists = lazyStatement(this.db, 'SELECT 1 FROM entries WHERE hash = ?')
    this.stampOutputFile = lazyStatement(
      this.db,
      'INSERT INTO output_stamps(entry_hash, root, path, ino, ctime_ms, mtime_ms) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(entry_hash, root, path) DO UPDATE SET ino = excluded.ino, ctime_ms = excluded.ctime_ms, mtime_ms = excluded.mtime_ms',
    )
    this.deleteStamps = lazyStatement(this.db, 'DELETE FROM output_stamps WHERE entry_hash = ?')
  }

  /**
   * The `root` column of this workspace's stamps and snapshots: clones sharing
   * a cache dir each saw their own disk. A hash of the real path; 0 for an
   * index only this workspace opens.
   */
  private get root(): number {
    if (this.rootKey !== undefined) return this.rootKey
    let real = this.sharedRoot
    if (real !== undefined) {
      try {
        real = realpathSync(real)
      } catch {
        // A root gone: its spelling keys it.
      }
    }
    this.rootKey = real === undefined ? 0 : Number(BigInt.asUintN(52, BigInt(Bun.hash(real))))
    return this.rootKey
  }

  /**
   * Drop every workspace's stamps and snapshots of `hashes`: they live apart
   * from the entry, so no cascade takes them.
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
   * Replace an entry's file rows, inside the store's save transaction, so entry
   * and fingerprints land together. Answers the files' bytes.
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
   * `distinct`: `hashes` as a JSON array with no repeats, which the probe has.
   * Rows are joined from it, not filtered by an `IN` that builds a lookup first
   * (~1.5 ms of 8,002 hits).
   */
  loadOutputFilesBatch(hashes: readonly string[], distinct?: string): Map<string, OutputFileRow[]> {
    const out = new Map<string, OutputFileRow[]>()
    if (hashes.length === 0) return out
    // `db.query` caches the compiled statement by SQL text, which `inHashes`
    // keeps to two. A reader in this process sees stamps taken, not only
    // flushed: overlaid from memory, since a flush per read committed a
    // transaction each.
    let sql = FILES_JOINED
    let params: Array<string | number> = [distinct!, this.root]
    if (distinct === undefined || hashes.length === 1) {
      const where = inHashes(hashes)
      sql = `${FILES_SELECT} FROM output_files f ${FILES_STAMPS} WHERE f.entry_hash ${where.test}`
      params = [this.root, ...where.params]
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
    // No outputs: trivially current.
    const known = this.dirModes
    this.dirModes = undefined
    if (expected.length === 0) return true
    // statSync, deliberately: since the directory short-circuit a warm hit
    // stats a handful of paths, and an async stat's thread-pool round trip
    // cannot be overlapped (1,000 warm hits: 422 to 368 ms).
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
          // Millisecond comparison (sub-ms tolerance for the utimes round trip)
          // against the mtime the file carried when stamped.
          Math.abs(s.mtimeMs - (e.stampMtimeMs ?? e.mtimeMs)) < 1 &&
          // And the file is the one this machine last saw: two entries whose
          // outputs share a fixed mtime (`tar -x`, `cp -p`, SOURCE_DATE_EPOCH)
          // and size matched each other's rows, leaving the other's bytes under
          // a green run. No task sets a ctime; the inode is weak (ext4 reuses a
          // freed one). A row without a stamp is never current. Residual: a
          // same-size rewrite inside the stamp's clock tick with the mtime
          // forged back.
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
      const abs = path.join(projectDir, dir)
      const mode = known?.get(abs) ?? statSync(abs, { throwIfNoEntry: false })?.mode
      if (mode === undefined || !wideDirMode(mode)) return false
    }
    return true
  }

  /**
   * Snapshot every directory under `prefixes` for `hash`, for a tree equal to
   * the entry. Taken at run end, past the racy window, when others may have
   * written: `holds` is asked with the files seen, and a refused tree records
   * nothing. Symlinked dirs are not descended. Over `OUTPUT_DIRS_CAP` one row
   * says so; on any error rows are cleared. Either way the next hit walks.
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
    // Synchronous: async lstat and readdir per directory are two thread-pool
    // round trips.
    const walk = (rel: string, isPrefix = false): boolean => {
      const abs = path.join(projectDir, rel)
      let st
      try {
        st = lstatSync(abs)
      } catch {
        // A declared prefix the task never produced (`build/**` beside
        // `dist/**`) is recorded absent, checked to still not exist. Refusing
        // the snapshot made every such task re-glob each warm hit (medusa: 210
        // ms of a 2.5 s no-op).
        if (isPrefix) {
          rows.push([rel, ABSENT_DIR_MTIME])
          return true
        }
        return false
      }
      if (!st.isDirectory()) {
        // A literal output naming a file walked its glob on every hit: two
        // of this repo's site tasks, ~6 ms of each warm run.
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
   * Stamp `hash`'s rows with each file's inode, ctime and mtime once a save or
   * restore left the tree equal to the entry. `dated` holds the mtime a restore
   * left each file with. A file whose size, mode or mtime differs, or whose
   * whole-second ctime is still racy, stays unstamped, so a later write is
   * never vouched for. Written with the snapshots in one transaction.
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
    const now = Date.now()
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
          (Math.abs(s.mtimeMs - at) < 1 || secondOf(s.mtimeMs, at)) &&
          // Git's racy-clean rule: on whole-second file systems a same-size
          // rewrite in the same second keeps every stamped field. Left
          // unstamped; a sub-second ctime is trusted.
          (stampGrainMs(s.ctimeMs) === 0 || s.ctimeMs < now - racyWindowMs(s.ctimeMs, 0))
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
    // next hit walks, or restores), never a failed run.
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
      // IMMEDIATE: the body reads before it writes, and a deferred transaction
      // could not wait for the lock (run-history.ts).
      this.db
        .transaction(() => {
          for (const [hash, rows] of stamps) {
            // A stamp outlives nothing: an entry pruned since has no rows to vouch for.
            if (this.entryExists.get(hash) === null) continue
            for (const [rel, [ino, ctime, mtime]] of rows)
              this.stampOutputFile.run(hash, this.root, rel, ino, ctime, mtime)
          }
        })
        .immediate()
    }
    if (this.pendingDirs.size === 0) return
    const pending = [...this.pendingDirs]
    this.pendingDirs.clear()
    this.db.transaction(() => {
      for (const [hash, rows] of pending) {
        this.deleteOutputDirs.run(hash, this.root)
        // The rows describe the entry: one pruned by another process
        // between the snapshot and this flush has nothing to describe.
        if (rows === null || this.entryExists.get(hash) === null) continue
        for (const [rel, mtime] of rows) this.insertOutputDir.run(hash, this.root, rel, mtime)
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
    let params: Array<string | number> = [distinct!, this.root]
    if (distinct === undefined || hashes.length === 1) {
      const where = inHashes(hashes)
      sql = `SELECT entry_hash, path, mtime_ms FROM output_dirs WHERE root = ? AND entry_hash ${where.test}`
      params = [this.root, ...where.params]
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
    this.dirModes = undefined
    if (rows.length === 0) return false
    const modes = new Map<string, number>()
    const results = rows.map((r) => {
      const abs = path.join(projectDir, r.path)
      let st
      try {
        // No throw for a missing dir: every restore after a clean asks
        // about one, and an exception per hit cost more than the stat.
        st = lstatSync(abs, { throwIfNoEntry: false })
      } catch {
        return r.mtimeMs === ABSENT_DIR_MTIME
      }
      if (st === undefined) return r.mtimeMs === ABSENT_DIR_MTIME
      if (r.mtimeMs === ABSENT_DIR_MTIME) return false
      if (r.mtimeMs === FILE_PREFIX_MTIME) return st.isFile()
      if (!st.isDirectory()) return false
      // A directory, not a link to one: its stat is this lstat.
      modes.set(abs, st.mode)
      return Math.abs(st.mtimeMs - r.mtimeMs) < 1
    })
    const current = results.every(Boolean)
    if (current) this.dirModes = modes
    return current
  }
}

/**
 * Artifact and `output_files` prefix for `outputs.workspaceFiles`: project
 * outputs keep project-relative rows, workspace rows the full
 * `workspace-outputs/<rel-to-root>` entry name, with no schema change. The name
 * is reserved: a project glob under it is refused at load (config-schema.ts), a
 * file another glob reaches there at save (`planArtifact`).
 */
export const WORKSPACE_OUTPUT_PREFIX = 'workspace-outputs/'

/**
 * Per-output-file fingerprint by entry, batch-loaded once per run
 * (`loadOutputFilesBatch`), so the currency probe is a Map lookup plus stats.
 *
 * `path` is project-relative, except workspace outputs, which carry the
 * `WORKSPACE_OUTPUT_PREFIX` entry name and anchor at the root.
 */
export interface OutputFileRow {
  path: string
  size: number
  mode: number
  mtimeMs: number
  /**
   * The inode and ctime this machine saw after the save or restore that left
   * the file equal to the entry. Absent until then and on any ingest: never
   * current.
   */
  ino?: number
  ctimeMs?: number
}

/** One directory under a whole-subtree output glob, as it stood after the last save or restore on THIS machine. */
export interface OutputDirRow {
  path: string
  mtimeMs: number
}

/**
 * More directories than this under a task's output prefixes: record
 * nothing, keep the walk. Rows are 60 bytes and the check one stat per
 * directory, so the cap bounds pathological trees, not a budget (256
 * refused a real 535-directory build, which then walked every warm hit).
 */
export const OUTPUT_DIRS_CAP = 8192

/**
 * `mtime_ms` of the row a snapshot over `OUTPUT_DIRS_CAP` leaves: never
 * current, so the hit walks and does not snapshot again.
 */
export const OUTPUT_DIRS_OVER_CAP = -3

/**
 * A directory mtime within this many ms of the snapshot is racy and drops the
 * snapshot: Linux timestamps are a kernel tick coarse (up to 10 ms), so a
 * same-tick write is invisible (git distrusts young stats for this too). Once
 * older, the tree is recorded.
 */
export const OUTPUT_DIRS_RACY_MS = 50
