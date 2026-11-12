// Reading the store: an entry by its key, many at once, whether one is
// there, and an artifact the index lost, adopted from its own bytes.

import { existsSync, linkSync, readdirSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { ArchiveSecurityError } from './archive.js'
import {
  type CacheEntry,
  type CacheGetContext,
  CorruptArtifactError,
  type IngestMeta,
} from './layer.js'
import { type OutputFileRow } from '../memo/index.js'
import { writeArtifactAndIndex } from './save.js'
import {
  ORPHAN_GRACE_MS,
  SELECT_ENTRIES,
  StoreIndex,
  artifactStat,
  guard,
  stdoutText,
  storedHere,
  storedLog,
  tarPath,
  tempPath,
} from './store-index.js'

/**
 * Row-less lookups answered by a stat each until the artifact directory is
 * listed once: a warm run's few misses stat, a cold run's thousands share one
 * listing.
 */
const ADOPT_STATS = 64

/**
 * A hit renews `accessed_at` only once older than this (renewing every hit
 * rewrote thousands of rows at close). The prune reads it plus this as the last
 * use.
 */
export const ACCESS_REFRESH_MS = 60 * 60 * 1000

type LiveRow = EntryRow & { hash: string }

interface EntryRow {
  key: string
  /** Null for a row-less inline artifact. */
  hash: string | null
  project: string
  task: string
  command: string
  exit_code: number
  duration_ms: number
  size_bytes: number
  /** The compressed log when no more than `LOG_INLINE_BYTES`, else null. */
  stdout: Uint8Array | null
  /** 1 when the log is larger, and read apart; null when none was stored. */
  stdout_apart: number | null
  created_at: number
  accessed_at: number
  cpu_ms: number | null
  peak_rss_bytes: number | null
  inline_at: number | null
}

/**
 * The entry a row answers. Its log is a getter, decompressed on each access
 * and, past `LOG_INLINE_BYTES`, read then, so an entry held until its replay
 * holds no log text. Read it once.
 */
function entryOf(
  row: LiveRow,
  fileRows: OutputFileRow[],
  log: (hash: string) => string,
): CacheEntry {
  // Assigned, not spread, and the date formatted only when read: a warm probe
  // builds one per hit and reads neither.
  const entry: CacheEntry = {
    hash: row.hash,
    taskId: `${row.project}#${row.task}`,
    command: row.command,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    sizeBytes: row.size_bytes,
    outputFiles: fileRows.map((r) => r.path),
    outputRows: fileRows,
    get stdout() {
      return row.stdout_apart === 1 ? log(row.hash) : storedLog(row.stdout)
    },
    get storedAt() {
      return new Date(row.created_at).toISOString()
    },
    source: 'local',
  }
  if (row.cpu_ms !== null) entry.cpuMs = row.cpu_ms
  if (row.peak_rss_bytes !== null) entry.peakRssBytes = row.peak_rss_bytes
  return entry
}

export async function get(
  ix: StoreIndex,
  hash: string,
  ctx?: CacheGetContext,
): Promise<CacheEntry | null> {
  // Local reads disabled (e.g. `--force` / `--cache-policy=local:w`): report a
  // miss so the task re-executes. The artifact + index are untouched.
  if (!ix.read) return null
  return guard(ix, async () => {
    const entry = await readEntry(ix, hash)
    if (entry !== null || ctx === undefined || !ix.write) return entry
    return (await adopt(ix, hash, ctx)) ? readEntry(ix, hash) : null
  })
}

/**
 * Index an artifact the index does not know, from its own bytes: the artifact
 * is the record, the index an inventory, so a reset index loses nothing. It is
 * checked as an ingest checks a remote's (key, names); a failure is a miss. An
 * inline artifact is indexed in one transaction with its bytes.
 */
async function adopt(ix: StoreIndex, hash: string, ctx: CacheGetContext): Promise<boolean> {
  // Built only for an artifact found: its command is masked on read.
  const meta = (): IngestMeta => ({
    taskId: ctx.taskId,
    command: ctx.command,
    durationMs: 0,
    ...(ctx.outputs !== undefined ? { outputs: ctx.outputs } : {}),
  })
  // Only a key whose lookup saw a row-less inline artifact asks for it: a
  // statement per miss otherwise, on every cold save.
  const blob = ix.rowless.delete(hash)
    ? (ix.selectBlob.get(hash) as { bytes: Uint8Array } | null)
    : null
  if (blob !== null) return adopted(ix, writeArtifactAndIndex(ix, hash, blob.bytes, meta()))
  const finalPath = tarPath(ix, hash)
  if (!artifactFileMayExist(ix, hash)) return false
  const tmpPath = tempPath(ix, hash)
  try {
    // A second name for the same bytes: the index step renames it over
    // the artifact inside its write transaction, as for a save.
    linkSync(finalPath, tmpPath)
    // The link shares the artifact's mtime, hours old for one that needs
    // adopting: another process's sweep would read the temp as a crashed
    // save's.
    const now = new Date()
    utimesSync(tmpPath, now, now)
  } catch {
    return false
  }
  return adopted(ix, writeArtifactAndIndex(ix, hash, { tmpPath }, meta()))
}

/**
 * Whether `hash` may have a file artifact: a stat for the first `ADOPT_STATS`
 * asks, then one listing. A name removed since fails the link, a miss; a file
 * written after the listing has its own row.
 */
function artifactFileMayExist(ix: StoreIndex, hash: string): boolean {
  const name = `${hash}.tar.zst`
  if (ix.artifactNames === undefined) {
    if (++ix.adoptStats <= ADOPT_STATS) return existsSync(path.join(ix.artifactDir, name))
    try {
      ix.artifactNames = new Set(readdirSync(ix.artifactDir))
    } catch {
      ix.artifactNames = new Set()
    }
  }
  return ix.artifactNames.has(name)
}

/** An adoption's verdict: an artifact that fails the checks is a miss. */
async function adopted(ix: StoreIndex, indexing: Promise<unknown>): Promise<boolean> {
  try {
    await indexing
    return true
  } catch (err) {
    if (err instanceof CorruptArtifactError || err instanceof ArchiveSecurityError) return false
    throw err
  }
}

export function getIngested(ix: StoreIndex, hash: string): Promise<CacheEntry | null> {
  return guard(ix, () => readEntry(ix, hash))
}

export function getSaved(ix: StoreIndex, hash: string): Promise<CacheEntry | null> {
  return getIngested(ix, hash)
}

async function readEntry(ix: StoreIndex, hash: string): Promise<CacheEntry | null> {
  const row = ix.selectEntry.get(hash) as EntryRow | null
  if (row === null) return null
  if (row.hash === null) {
    ix.rowless.add(hash)
    return null
  }

  if (row.inline_at !== null) {
    if (row.inline_at < Date.now() - ORPHAN_GRACE_MS) ix.staleInline.add(hash)
  } else {
    // Verify the artifact file actually exists. The DB and the
    // filesystem can drift if someone manually deletes the cache dir.
    const st = artifactStat(ix, hash)
    if (st === undefined) return null
    if (st.mtimeMs < Date.now() - ORPHAN_GRACE_MS) ix.staleTimes.add(hash)
  }

  // Deferred: per-hit UPDATEs cost ~60 ms across a full-cache run. Flushed as
  // one UPDATE by flushAccessed(), when accessed_at is read.
  if (row.accessed_at < Date.now() - ACCESS_REFRESH_MS) ix.touched.add(hash)

  // Pure SQL: the artifact is not touched, so a hit's cost does not scale with
  // its size. restoreOutputs reads it only when extracting.
  const fileRows = ix.localMemo.loadOutputFilesBatch([hash]).get(hash) ?? []
  const entry = entryOf(row as LiveRow, fileRows, (h) => logOf(ix, h))
  entry.outputDirRows = ix.localMemo.loadOutputDirsBatch([hash]).get(hash) ?? []
  return entry
}

export function holdsNothing(ix: StoreIndex): boolean {
  if (!ix.read) return true
  if (guard(ix, () => ix.db.query('SELECT 1 FROM artifacts LIMIT 1').get()) != null) {
    return false
  }
  let names: string[]
  try {
    names = readdirSync(ix.artifactDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false
    names = []
  }
  ix.artifactNames ??= new Set(names)
  return !names.some((n) => n.endsWith('.tar.zst') || n.endsWith('.tree'))
}

export async function getMany(
  ix: StoreIndex,
  hashes: readonly string[],
  ctx?: (hash: string) => CacheGetContext,
): Promise<Map<string, CacheEntry>> {
  return guard(ix, async () => {
    const out = await getManyEntries(ix, hashes)
    if (ctx === undefined || !ix.read || !ix.write || out.size === hashes.length) return out
    // An artifact the index does not know is still a hit (`adopt`).
    for (const hash of hashes) {
      if (out.has(hash) || !(await adopt(ix, hash, ctx(hash)))) continue
      const entry = await readEntry(ix, hash)
      if (entry !== null) out.set(hash, entry)
    }
    return out
  })
}

async function getManyEntries(
  ix: StoreIndex,
  hashes: readonly string[],
): Promise<Map<string, CacheEntry>> {
  const out = new Map<string, CacheEntry>()
  if (!ix.read || hashes.length === 0) return out
  const found = (
    hashes.length === 1
      ? [ix.selectEntry.get(hashes[0]!)].filter((r) => r !== null)
      : ix.db.query(SELECT_ENTRIES).all(JSON.stringify(hashes))
  ) as EntryRow[]
  const graceStart = Date.now() - ORPHAN_GRACE_MS
  const refreshStart = Date.now() - ACCESS_REFRESH_MS
  // A hash asked twice is one row here: the output queries join from the
  // live hashes as given (`loadOutputFilesBatch`'s `distinct`).
  const seen = new Set<string>()
  const live: LiveRow[] = []
  const liveHashes: string[] = []
  for (const r of found) {
    if (r.hash === null) {
      ix.rowless.add(r.key)
      continue
    }
    if (seen.has(r.hash)) continue
    seen.add(r.hash)
    if (r.inline_at !== null) {
      if (r.inline_at < graceStart) ix.staleInline.add(r.hash)
    } else {
      const st = artifactStat(ix, r.hash)
      if (st === undefined) continue
      if (st.mtimeMs < graceStart) ix.staleTimes.add(r.hash)
    }
    live.push(r as LiveRow)
    liveHashes.push(r.hash)
  }
  if (seen.size === 0) return out
  const distinct = JSON.stringify(liveHashes)
  const fileRows = ix.outputs.loadOutputFilesBatch(liveHashes, distinct)
  ix.outputs.hold(fileRows)
  ix.heldInlineAt.clear()
  for (const r of live) if (r.inline_at !== null) ix.heldInlineAt.set(r.hash, r.inline_at)
  const dirRows = ix.outputs.loadOutputDirsBatch(liveHashes, distinct)
  for (const row of live) {
    if (row.accessed_at < refreshStart) ix.touched.add(row.hash)
    const entry = entryOf(row, fileRows.get(row.hash) ?? [], (h) => logOf(ix, h))
    entry.outputDirRows = dirRows.get(row.hash) ?? []
    out.set(row.hash, entry)
  }
  return out
}

export async function has(ix: StoreIndex, hash: string): Promise<'local' | 'remote' | null> {
  return guard(ix, () => hasEntry(ix, hash))
}

export async function localHasMany(
  ix: StoreIndex,
  hashes: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>()
  for (const hash of hashes) if ((await has(ix, hash)) === 'local') out.add(hash)
  return out
}

async function hasEntry(ix: StoreIndex, hash: string): Promise<'local' | 'remote' | null> {
  if (!ix.read) return null
  return storedHere(ix, hash) ? 'local' : null
}

export function outputsPath(ix: StoreIndex, hash: string): string {
  return tarPath(ix, hash)
}

export function outputBytes(ix: StoreIndex, hash: string): number | undefined {
  const bytes = ix.savedBytes.get(hash)
  ix.savedBytes.delete(hash)
  return bytes
}

export function kept(ix: StoreIndex, hash: string): boolean {
  return ix.keptHashes.delete(hash)
}

export function artifactSize(ix: StoreIndex, hash: string): number | undefined {
  return guard(
    ix,
    () =>
      (
        ix.db.query('SELECT size_bytes FROM entries WHERE hash = ?').get(hash) as {
          size_bytes: number
        } | null
      )?.size_bytes,
  )
}

function logOf(ix: StoreIndex, hash: string): string {
  return guard(ix, () => stdoutText(ix, hash))
}
