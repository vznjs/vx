// Pruning the store: evicting entries by age or size, reaping orphan
// files, and the counts `vx info` reports.

import { statSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  inHashes,
  pruneHistoryRows,
  RUNS_VIEW,
  isIndexFull,
  EXECUTED_RUNS_SQL,
} from '../index-db/index.js'
import { diskBytes } from '../util/index.js'
import {
  type CacheStats,
  type CacheStatsOptions,
  type PruneOptions,
  type PruneResult,
} from './layer.js'
import { VX_ARTIFACT_NAME } from './cache-dir.js'
import { ACCESS_REFRESH_MS } from './lookup.js'
import { treeBytes } from './save.js'
import {
  ORPHAN_GRACE_MS,
  StoreIndex,
  flushAccessed,
  guard,
  tarPath,
  treePathOf,
} from './store-index.js'

/** What `vx cache clean` keeps of run history and the hash memos. */
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * What the orphan sweep may judge: a row-less artifact file or inline
 * artifact (`blob`, its hash), or a dead file — a temp, or a file an
 * inline artifact of its key shadows — which goes whatever the policy.
 */
interface RowlessFile {
  file?: string
  blob?: string
  size: number
  mtimeMs: number
  temp: boolean
}

/**
 * What a prune takes under `policy`: index rows by `accessed_at` and
 * row-less artifacts by file time, under one rule (a temp always). The
 * rows are the non-phantom ones; the files are past the in-flight grace.
 */
function pickVictims(
  rows: ReadonlyArray<{ hash: string; size_bytes: number; accessed_at: number }>,
  files: readonly RowlessFile[],
  policy: { olderThanMs?: number; maxBytes?: number },
): { hashes: Set<string>; bytesFreed: number; files: RowlessFile[] } {
  const { olderThanMs, maxBytes } = policy
  const hashes = new Set<string>()
  let bytesFreed = 0
  const taken: RowlessFile[] = []
  const kept: Array<{ at: number; size: number; row?: string; file?: RowlessFile }> = []
  let remaining = 0
  for (const r of rows) {
    const at = r.accessed_at + ACCESS_REFRESH_MS
    if (olderThanMs !== undefined && at < olderThanMs) {
      hashes.add(r.hash)
      bytesFreed += r.size_bytes
    } else {
      kept.push({ at, size: r.size_bytes, row: r.hash })
      remaining += r.size_bytes
    }
  }
  for (const f of files) {
    const at = f.mtimeMs + ORPHAN_GRACE_MS
    if (f.temp || (olderThanMs !== undefined && at < olderThanMs)) taken.push(f)
    else {
      kept.push({ at, size: f.size, file: f })
      remaining += f.size
    }
  }
  if (maxBytes !== undefined && remaining > maxBytes) {
    kept.sort((a, b) => a.at - b.at)
    for (const k of kept) {
      if (remaining <= maxBytes) break
      remaining -= k.size
      if (k.file !== undefined) taken.push(k.file)
      else {
        hashes.add(k.row!)
        bytesFreed += k.size
      }
    }
  }
  return { hashes, bytesFreed, files: taken }
}

/**
 * Artifacts `indexed` does not hold, and temps, past the in-flight grace
 * window: one readdir, one stat per candidate. `indexed` is asked only
 * once the readdir succeeded: with the directory gone, macOS answers a
 * read of the index SQLITE_IOERR_VNODE, and an unreadable directory
 * reports nothing.
 */
async function scanOrphanFiles(
  cacheDir: string,
  indexedHashes: () => { files: ReadonlySet<string>; inline: ReadonlySet<string> },
): Promise<RowlessFile[]> {
  let names: string[]
  try {
    names = await readdir(cacheDir)
  } catch {
    return []
  }
  const indexed = indexedHashes()
  const cutoff = Date.now() - ORPHAN_GRACE_MS
  const candidates: Array<{ name: string; temp: boolean }> = []
  for (const name of names) {
    const m = VX_ARTIFACT_NAME.exec(name)
    if (m === null) continue
    // A file whose key has an inline artifact is never read: readers take
    // the blob first. It is what an inline save of a re-built key left.
    const temp = m[2] !== undefined || indexed.inline.has(m[1]!)
    if (temp || !indexed.files.has(m[1]!)) candidates.push({ name, temp })
  }
  const found: RowlessFile[] = []
  await Promise.all(
    candidates.map(async ({ name, temp }) => {
      const file = path.join(cacheDir, name)
      try {
        const st = await stat(file)
        if ((name.includes('.tree') ? st.isDirectory() : st.isFile()) && st.mtimeMs <= cutoff) {
          const size = st.isDirectory() ? await treeBytes(file) : diskBytes(st)
          found.push({ file, size, mtimeMs: st.mtimeMs, temp })
        }
      } catch {
        // Gone between readdir and stat: not an orphan any more.
      }
    }),
  )
  return found
}

/** Bytes the files hold now; one gone counts 0. */
function sizeOf(files: readonly string[]): number {
  let total = 0
  for (const f of files) total += statSync(f, { throwIfNoEntry: false })?.size ?? 0
  return total
}

export function stats(ix: StoreIndex, opts: CacheStatsOptions = {}): CacheStats {
  return guard(ix, () => statsOf(ix, opts))
}

function statsOf(ix: StoreIndex, opts: CacheStatsOptions): CacheStats {
  flushAccessed(ix)
  ix.outputs.flushOutputDirs()
  const project = opts.project
  const scoped = project !== undefined
  const scopeParams: string[] = project === undefined ? [] : [project]
  const aggregate = ix.db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM entries${
        scoped ? ' WHERE project = ?' : ''
      }`,
    )
    .get(...scopeParams) as { n: number; bytes: number }
  const since = Date.now() - 24 * 60 * 60 * 1000
  const runs = ix.db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status IN ('cache-hit', 'cache-hit-remote') THEN 1 ELSE 0 END), 0) AS hits, COALESCE(SUM(restored = 1), 0) AS restored FROM main.runs WHERE started_at >= ? AND ${EXECUTED_RUNS_SQL}${
        scoped ? ' AND project = ?' : ''
      }`,
    )
    .get(since, ...scopeParams) as { total: number; hits: number; restored: number }
  return {
    entryCount: aggregate.n,
    totalBytes: aggregate.bytes,
    runCountLast24h: runs.total,
    hitCountLast24h: runs.hits,
    restoredCountLast24h: runs.restored,
  }
}

export async function prune(ix: StoreIndex, options: PruneOptions): Promise<PruneResult> {
  return guard(ix, () => pruneIndex(ix, options))
}

async function pruneIndex(
  ix: StoreIndex,
  options: PruneOptions,
  now: number = Date.now(),
): Promise<PruneResult> {
  flushAccessed(ix)
  // Before any entry is deleted, so a kept entry's pending snapshot is on
  // disk whatever the eviction does next. A pruned hash's snapshot cannot
  // orphan rows in either order: landed first, the cascade takes them;
  // landed after, the flush's own entry check drops them.
  ix.outputs.flushOutputDirs()
  const { olderThanMs, maxBytes, dry = false } = options
  if (olderThanMs === undefined && maxBytes === undefined) {
    throw new Error('prune: pass at least one of `olderThanMs` or `maxBytes`')
  }

  // Rows whose artifact is gone (deleted by hand, or by a disk cleaner):
  // never a hit, and their bytes are on no disk, but `--max-size` counted
  // them and evicted real entries to make room for them. None
  // is evicted or freed, whatever its age; the ones past the
  // grace window are dropped.
  const { phantoms, stale, rows, inline } = await phantomRows(ix)
  const picked = pickVictims(
    rows.filter((r) => !phantoms.has(r.hash)),
    await scanOrphans(ix),
    {
      ...(olderThanMs !== undefined ? { olderThanMs } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
    },
  )
  const victims = picked.hashes
  const { bytesFreed } = picked
  let orphanBytes = 0
  for (const o of picked.files) orphanBytes += o.size

  // Delete DB rows in a single transaction (one fsync; ON DELETE
  // CASCADE clears `output_files`) and unlink artifacts in parallel.
  // Replaces N round-trips + serialized rm with one transaction + a
  // Promise.all over the unlinks. The hash list binds as one `json_each`
  // parameter, so a huge eviction stays under any build's bound-parameter
  // ceiling.
  if (dry) {
    return { evicted: victims.size, bytesFreed, orphans: picked.files.length, orphanBytes }
  }
  if (victims.size > 0 || stale.length > 0) {
    const hashes = [...victims]
    const rows = [...hashes, ...stale]
    // Artifacts first: a row whose artifact is gone reads as a miss, so the
    // order is safe, and on a full disk the delete's own journal needs the
    // space the unlinks free. Rows-first failed there before any file went,
    // and the one verb meant to free a full disk freed nothing. An
    // inline artifact goes with its rows, in their transaction.
    await Promise.all(
      hashes
        .filter((h) => !inline.has(h))
        .flatMap((h) => [
          rm(tarPath(ix, h), { force: true }),
          rm(treePathOf(ix, h), { recursive: true, force: true }),
        ]),
    )
    const { test, params } = inHashes(rows)
    const deleteRows = ix.db.transaction(() => {
      ix.db.prepare(`DELETE FROM artifacts WHERE hash ${test}`).run(...params)
      ix.db.prepare(`DELETE FROM entries WHERE hash ${test}`).run(...params)
      ix.outputs.forget(rows)
    })
    try {
      deleteRows()
    } catch (err) {
      if (!isIndexFull(err)) throw err
      deleteRows()
    }
  }

  // This workspace's rows for entries another workspace pruned from a
  // shared store: never read (a lookup starts at the entry), only kept.
  try {
    ix.outputs.forgetGone()
  } catch (err) {
    if (!isIndexFull(err)) throw err
  }
  // History and memo rows a month old go with a prune, never a run's
  // close: five DELETEs on every run's exit was its slowest step
  //. `invocations` shares the window with `runs`, or `vx last`
  // would list a run whose task rows are gone.
  const orphans = await reapOrphans(ix, picked.files)
  // An evicted entry's deleted pages (an inline artifact, a row and a
  // stamp per output file) go to SQLite's free list and the file keeps its
  // size: give them back, or the bytes said freed are not, and a
  // `--max-size` clean left the store's index 90% free pages.
  if (victims.size > 0 || stale.length > 0) {
    releaseFreePages(ix, 'main')
    if (ix.storeDir !== undefined) releaseFreePages(ix, 'store')
  }
  // After the entries' release, so the shrink measured here is the history's
  // alone: a year of runs left 28k of 36k pages free in a 140 MB index.
  const cutoff = now - HISTORY_RETENTION_MS
  const historyRows =
    pruneHistoryRows(ix.db, cutoff) + ix.files.pruneOlderThan(cutoff) + ix.folds.prune(cutoff)
  const result = { evicted: victims.size, bytesFreed, ...orphans }
  if (historyRows === 0) return result
  const files = [
    ix.dbFile,
    ...(ix.storeDir === undefined ? [] : [path.join(ix.storeDir, 'store.db')]),
  ]
  const before = sizeOf(files)
  releaseFreePages(ix, 'main')
  if (ix.storeDir !== undefined) releaseFreePages(ix, 'store')
  return { ...result, historyRows, historyBytes: Math.max(0, before - sizeOf(files)) }
}

/**
 * VACUUM `schema` when it has free pages; busy or no room to rewrite
 * keeps the pages for reuse. A clean's step only: a run never pays it.
 */
function releaseFreePages(ix: StoreIndex, schema: 'main' | 'store'): void {
  try {
    const { freelist_count: free } = ix.db.prepare(`PRAGMA ${schema}.freelist_count`).get() as {
      freelist_count: number
    }
    if (free === 0) return
    ix.db.exec('DROP VIEW IF EXISTS temp.runs')
    try {
      ix.db.exec(`VACUUM ${schema}`)
    } finally {
      ix.db.exec(RUNS_VIEW)
    }
    ix.db.exec(`PRAGMA ${schema}.wal_checkpoint(TRUNCATE)`)
  } catch {
    // Another process holds the database, or the disk has no room for the copy.
  }
}

/**
 * Unlink the row-less files `pickVictims` took: a `<hash>.tar.zst` with
 * no `entries` row (another vx version's open dropped it, a `cache.db`
 * deleted by hand) past the policy, a `<hash>.tar.zst.tmp-*` a crashed
 * save never renamed, and a file an inline artifact shadows; and delete
 * the row-less inline artifacts it took. Nothing else reaps them — a
 * lookup starts at the row, and a save of the same key replaces the
 * bytes, so a key that never recurs leaks its bytes forever.
 */
export async function reapOrphans(
  ix: StoreIndex,
  taken: readonly RowlessFile[],
): Promise<{ orphans: number; orphanBytes: number }> {
  let orphans = 0
  let orphanBytes = 0
  const blobs = taken.filter((o) => o.blob !== undefined)
  if (blobs.length > 0) {
    // Only while still row-less: an adopt since the scan keeps it.
    const drop = ix.db.prepare(
      'DELETE FROM artifacts WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM entries WHERE hash = ?)',
    )
    try {
      ix.db.transaction(() => {
        for (const o of blobs) {
          if (drop.run(o.blob!, o.blob!).changes === 0) continue
          orphans += 1
          orphanBytes += o.size
        }
      })()
    } catch (err) {
      if (!isIndexFull(err)) throw err
      orphans = 0
      orphanBytes = 0
    }
  }
  await Promise.all(
    taken.map(async (o) => {
      if (o.file === undefined) return
      try {
        // unlink, not `rm({ force })`: force swallows ENOENT, and a file a
        // concurrent prune took first must not be counted as ours.
        await rm(o.file, { recursive: true })
        orphans += 1
        orphanBytes += o.size
      } catch {
        // Gone under us (a concurrent prune, a save's own cleanup): not ours.
      }
    }),
  )
  return { orphans, orphanBytes }
}

/**
 * Index rows whose artifact is not in the directory, with their recorded
 * sizes, and the ones among them last used before the grace window. The
 * rows are read BEFORE the directory: a save renames its artifact in
 * before its row commits, so every row read has its artifact listed
 * unless it is gone, and the count is exact. Only `stale` rows are
 * dropped — a row is never deleted on one listing's word while it may be
 * in use. An unreadable directory judges nothing.
 */
async function phantomRows(ix: StoreIndex): Promise<{
  phantoms: Map<string, number>
  stale: string[]
  rows: Array<{ hash: string; size_bytes: number; accessed_at: number }>
  /** The rows whose artifact is inline: present, whatever the directory holds. */
  inline: Set<string>
}> {
  const graceStart = Date.now() - ORPHAN_GRACE_MS
  const rows = ix.db
    .prepare(
      'SELECT e.hash, e.size_bytes, e.accessed_at, a.hash IS NOT NULL AS inline FROM entries e LEFT JOIN artifacts a ON a.hash = e.hash',
    )
    .all() as Array<{
    hash: string
    size_bytes: number
    accessed_at: number
    inline: number
  }>
  const inline = new Set(rows.filter((r) => r.inline === 1).map((r) => r.hash))
  let names: string[]
  try {
    names = await readdir(ix.artifactDir)
  } catch {
    return { phantoms: new Map(), stale: [], rows, inline }
  }
  const present = new Set(names)
  const phantoms = new Map<string, number>()
  const stale: string[] = []
  for (const r of rows) {
    if (r.inline === 1 || present.has(`${r.hash}.tar.zst`) || present.has(`${r.hash}.tree`))
      continue
    phantoms.set(r.hash, r.size_bytes)
    if (r.accessed_at < graceStart) stale.push(r.hash)
  }
  return { phantoms, stale, rows, inline }
}

export async function orphanStats(
  ix: StoreIndex,
): Promise<{ orphans: number; orphanBytes: number }> {
  const found = await scanOrphans(ix)
  let orphanBytes = 0
  for (const o of found) orphanBytes += o.size
  return { orphans: found.length, orphanBytes }
}

/**
 * Row-less artifacts and temps past the in-flight grace window: one
 * readdir, one stat per candidate, and the row-less inline artifacts,
 * their `at` standing for the file time.
 */
async function scanOrphans(ix: StoreIndex): Promise<RowlessFile[]> {
  // Asked once the directory read succeeded, as the rows are (scanOrphanFiles).
  let rowless: Array<{ hash: string; size: number; at: number }> = []
  const found = await scanOrphanFiles(ix.artifactDir, () => {
    rowless = ix.db
      .prepare(
        'SELECT hash, length(bytes) AS size, at FROM artifacts WHERE at <= ? AND hash NOT IN (SELECT hash FROM entries)',
      )
      .all(Date.now() - ORPHAN_GRACE_MS) as typeof rowless
    const rows = ix.db
      .prepare(
        'SELECT e.hash, a.hash IS NOT NULL AS inline FROM entries e LEFT JOIN artifacts a ON a.hash = e.hash',
      )
      .all() as Array<{ hash: string; inline: number }>
    const blobs = ix.db.prepare('SELECT hash FROM artifacts').all() as Array<{ hash: string }>
    return {
      files: new Set(rows.filter((r) => r.inline === 0).map((r) => r.hash)),
      inline: new Set(blobs.map((r) => r.hash)),
    }
  })
  for (const b of rowless) found.push({ blob: b.hash, size: b.size, mtimeMs: b.at, temp: false })
  // With a shared store, no artifact in `cacheDir` is indexed: they are
  // what this workspace saved before its entries moved out.
  if (ix.artifactDir === ix.cacheDir) return found
  const none = new Set<string>()
  return [...found, ...(await scanOrphanFiles(ix.cacheDir, () => ({ files: none, inline: none })))]
}
