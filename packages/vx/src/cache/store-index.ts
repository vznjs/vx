// The opened index: cache.db (and the shared store it attaches), its
// statements and the state one open keeps. Every store function takes it.

import { Database } from 'bun:sqlite'
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  utimesSync,
} from 'node:fs'
import path from 'node:path'
import {
  createArtifactTables,
  createTables,
  inHashes,
  lazyStatement,
  SQLITE_FCNTL_PERSIST_WAL,
  unreadableIndex,
  isIndexFull,
  closeDb,
  SCHEMA_VERSION,
} from '../index-db/index.js'
import { UserError, isOutOfFds, OUT_OF_FDS_HINT, xxh3hex, decodeRaw } from '../util/index.js'
import {
  FileHashStore,
  OutputIndex,
  IndexFoldMemo,
  IndexRemoteHits,
  LocalMemo,
  type RemoteHits,
} from '../memo/index.js'
import { MAX_DECOMPRESSED_ARTIFACT_BYTES } from './zstd.js'
import { CACHE_VERSION } from './key-fold.js'
import { WalCheckpointer } from './checkpointer.js'
import { repoFacts } from './git-inputs.js'
import { openCacheDir, storeBlocked } from './cache-dir.js'

/** Asks whether an open database file is still the one at its name (`attachStore`). */
const SQLITE_FCNTL_HAS_MOVED = 20

/**
 * An artifact or temp without an `entries` row is never reaped younger than
 * this. Past it, a row-less artifact (another vx version may have dropped its
 * row) is judged by the prune policy, its file time plus this standing for its
 * last use; a hit renews a file time older than this.
 */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000

export interface SchemaReset {
  from: string
  to: string
}

/** The refusal for an index SQLite cannot read, at the open or at any later read or write. */
function unreadableIndexError(dbFile: string, err: unknown): UserError {
  return new UserError(
    `the cache index ${dbFile} is not a database SQLite can read (${(err as Error).message}) — ` +
      `it holds nothing a run cannot rebuild: remove it with its -wal and -shm files and ` +
      `re-run, and \`vx cache clean\` reclaims the artifacts it indexed`,
  )
}

/** The longest index path SQLite opens: its unix `MAX_PATHNAME`, 512, less `-journal`. */
const SQLITE_PATH_MAX = 512 - '-journal'.length

/**
 * SQLite reports a descriptor it could not get as `SQLITE_CANTOPEN`, never
 * `EMFILE`. One open of a file that exists says which it was; any other
 * `CANTOPEN` is the path itself.
 */
function cantOpenIndex(dbFile: string, err: unknown): UserError | undefined {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code !== 'string' || !code.startsWith('SQLITE_CANTOPEN')) return undefined
  try {
    closeSync(openSync(process.execPath, 'r'))
  } catch (probe) {
    if (!isOutOfFds(probe)) return undefined
    return new UserError(
      `the cache index ${dbFile} could not be opened (${(err as Error).message}) — ${OUT_OF_FDS_HINT}`,
      'VX_E_FDS',
    )
  }
  // SQLite's unix VFS opens no path past 512 bytes, its `-journal` suffix
  // counted.
  const bytes = Buffer.byteLength(path.resolve(dbFile))
  if (bytes > SQLITE_PATH_MAX) {
    return new UserError(
      `the cache index ${dbFile} could not be opened (${(err as Error).message}) — ` +
        `its path is ${bytes} bytes and SQLite opens none past ${SQLITE_PATH_MAX}; ` +
        'point the cache at a shorter directory (--cache-dir, VX_CACHE_DIR)',
      'VX_E_FS',
    )
  }
  // Any other: a directory, or a file this user may not open, where the index
  // goes.
  return new UserError(
    `the cache index ${dbFile} could not be opened (${(err as Error).message}) — ` +
      'it is not a file this user can open; move it away and re-run (vx rebuilds the index)',
    'VX_E_FS',
  )
}

/** The tables a store holds: dropped from a workspace index that held them itself. */
const STORE_TABLES = [
  'entry_inputs',
  'output_files',
  'entry_stdout',
  'task_durations',
  'task_outcomes',
  'blob_sizes',
  'plugin_blobs',
  'remote_hits',
  'store_meta',
  'entries',
]

/**
 * The inline artifacts' tables: dropped from a workspace index whose entries
 * moved to a store, where an unqualified name would find them first; never by a
 * schema reset.
 */
const ARTIFACT_TABLES = ['artifacts', 'artifacts_meta']

/**
 * The `artifacts` table's own layout (`artifacts_meta.layout`); another value
 * drops the table. Read only where the schema was not this vx's, so a change to
 * it bumps `SCHEMA_VERSION` too.
 */
const ARTIFACT_LAYOUT = 'a2'

/**
 * A preview's index connection and the schema it records, kept for the open.
 * Another version is what a writing opener resets; an unreadable file is left
 * to the open to refuse.
 */
function previewIndex(dbFile: string): { db: Database; version: string | undefined } | undefined {
  let db: Database
  try {
    db = new Database(dbFile, { create: true })
  } catch {
    // The main open names why.
    return undefined
  }
  try {
    const version = (
      db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as {
        value: string
      } | null
    )?.value
    return { db, version }
  } catch {
    // No stamp read (no table yet, busy, not a database): the main open reads
    // again and refuses what it must.
    return { db, version: undefined }
  }
}

/** The largest compressed log a probe loads with its entry. */
const LOG_INLINE_BYTES = 4096

/**
 * Each asked key's entry row, its stored log while small, and its inline
 * artifact's last use (null for a file). A larger log is only flagged
 * (`stdout_apart`) and read when its hit replays: joined, every log stayed held
 * until its replay (500 hits of 1 MiB held 3.4 GB). Driven by the keys, so an
 * inline artifact with no row answers too, `hash` null, for the miss to adopt.
 */
const selectEntries = (keys: string): string =>
  `SELECT q.value AS key, e.*, CASE WHEN length(s.stdout) <= ${LOG_INLINE_BYTES} THEN s.stdout END AS stdout, length(s.stdout) > ${LOG_INLINE_BYTES} AS stdout_apart, a.at AS inline_at FROM ${keys} q LEFT JOIN entries e ON e.hash = q.value LEFT JOIN entry_stdout s ON s.hash = e.hash LEFT JOIN artifacts a ON a.hash = q.value WHERE e.hash IS NOT NULL OR a.at IS NOT NULL`

const SELECT_ENTRY = selectEntries('(SELECT ? AS value)')

export const SELECT_ENTRIES = selectEntries('json_each(?)')

/** Why a reading handle (`'inspect'`, `'preview'`) writes nothing: no index to read was there. */
export const NO_INDEX = 'no index there yet'

/** How a save keeps an entry locally (`cache.store`). */
export interface StoreOptions {
  /**
   * The largest entry kept in the index as one zstd tar, written in its rows'
   * transaction with no temp or rename (docs/design/cache-save-cpu-2026-10.md).
   * 0 keeps every entry as files.
   */
  embeddings: number
  /** A file-backed entry is a `<hash>.tree` of plain files; off, one `<hash>.tar.zst`. */
  decompress: boolean
}

export const DEFAULT_STORE: StoreOptions = {
  embeddings: 32 * 1024,
  decompress: true,
}

/**
 * An `entry_stdout` row's log: a zstd frame of its UTF-8, which keeps a leading
 * U+FEFF a bound string loses. No row reads as ''. The index is vx's own, so
 * the frame is trusted.
 */
export function storedLog(blob: Uint8Array | null): string {
  return blob === null ? '' : decodeRaw(Bun.zstdDecompressSync(blob))
}

export class StoreIndex {
  readonly db: Database
  readonly insertEntry: ReturnType<Database['prepare']>
  readonly deleteEntryRow: ReturnType<Database['prepare']>
  readonly selectEntry: ReturnType<Database['prepare']>
  readonly upsertStdout: ReturnType<Database['prepare']>
  readonly deleteStdout: ReturnType<Database['prepare']>
  readonly selectStdout: ReturnType<Database['prepare']>
  readonly selectUsage: ReturnType<Database['prepare']>
  readonly entryExists: ReturnType<Database['prepare']>
  readonly selectBlob: ReturnType<Database['prepare']>
  readonly upsertBlob: ReturnType<Database['prepare']>
  readonly deleteBlob: ReturnType<Database['prepare']>
  readonly touched = new Set<string>()
  /** Hit artifacts whose file time is past the grace: renewed at the flush (`ORPHAN_GRACE_MS`). */
  readonly staleTimes = new Set<string>()
  /** The same for inline artifacts, whose `at` stands for the file time. */
  readonly staleInline = new Set<string>()
  /**
   * The `at` of each inline artifact the last probe held rows for: a restore
   * serves those rows only while the blob still carries it.
   */
  readonly heldInlineAt = new Map<string, number>()
  /** Keys the last lookups found an inline artifact for and no row: `adopt`'s to read. */
  readonly rowless = new Set<string>()
  /** Row-less lookups that stat'ed their artifact path (`artifactFileMayExist`). */
  adoptStats = 0
  /** The artifact directory's names, listed once past `ADOPT_STATS`; this process's writes kept in it. */
  artifactNames: Set<string> | undefined
  /** Saves' index writes waiting for this turn's one transaction (`indexInBatch`). */
  indexQueue: Array<{ write: () => void; settle: (err?: unknown) => void }> = []
  /** The checkpoint thread: `armed` until a save commits (`checkpointOffThread`). */
  checkpoints: 'armed' | WalCheckpointer | undefined
  readonly insertEntryInput: ReturnType<Database['prepare']>
  /** The per-file (mtime, size) → blob-OID memo behind `hashFile`. */
  readonly files: FileHashStore
  /** The memos a task's key and hit read, over `files`, `folds` and `outputs`. */
  readonly localMemo: LocalMemo
  readonly outputs: OutputIndex
  /**
   * Each entry `save()` wrote and its files' summed bytes, for the miss row's
   * `outputs` without reading back. Taken once, by `outputBytes`.
   */
  readonly savedBytes = new Map<string, number>()
  /** Each key a `--force` save found stored and kept: no save of this run's. Taken once, by `kept`. */
  readonly keptHashes = new Set<string>()
  /** The run this cache saves for: each entry it writes records it (`entries.run_id`). */
  runId: string | undefined
  readonly folds: IndexFoldMemo
  /** What the remotes said they hold, across runs (remote-hits.ts). */
  readonly remoteHits: RemoteHits

  /**
   * Local read/write gates for the task ARTIFACT path only: `get()` returns
   * null when `!read`, `save()` skips when `!write`. Bookkeeping (recordRun,
   * stats, prune, ingest, hashing) is unaffected.
   */
  readonly read: boolean
  readonly write: boolean
  /** A reading verb's handle (`Cache.inspect`): it prunes no history. */
  readonly inspecting: boolean
  /** Why this process cannot write into `cacheDir`, or `null`; decided at open. */
  readonly writeBlocked: string | null
  /** The index is in memory: nothing on disk to read. */
  readonly empty: boolean
  readonly dbFile: string
  /** Where the artifacts live: the shared store, or `cacheDir` itself. */
  readonly artifactDir: string

  /** The shared store this index attached, or undefined when it holds its entries itself. */
  readonly storeDir: string | undefined

  /**
   * Set when THIS open found another `SCHEMA_VERSION` and dropped every table.
   * Never printed: the cache is vx's to keep.
   */
  readonly schemaReset: SchemaReset | null = null

  /**
   * Set when THIS open found the shared store under another `SCHEMA_VERSION`
   * and dropped its inventory; artifacts stay and are indexed again as they
   * hit.
   */
  readonly storeReset: SchemaReset | null = null
  /** This open stamped the store's schema: it was new or another vx's. */
  storeStamped = false
  valueSalt: string | undefined

  constructor(
    readonly cacheDir: string,
    localPolicy: { read: boolean; write: boolean } = { read: true, write: true },
    /**
     * The workspace root: where the file hasher asks git for the object format,
     * and whose output stamps this handle reads.
     */
    repoDir?: string,
    /**
     * The largest decoded artifact this cache saves, ingests or restores.
     * Lowered only by tests (`RunOptions.artifactCeiling`).
     */
    readonly artifactCeiling: number = MAX_DECOMPRESSED_ARTIFACT_BYTES,
    /**
     * `'inspect'`: a reading verb, which never resets the index. `'preview'`: a
     * dry prune or `--dry` plan, which reads another schema's index as the
     * reset would leave it.
     */
    mode: 'open' | 'inspect' | 'preview' = 'open',
    /**
     * The shared store's directory. Unversioned: keys are seeded with
     * `CACHE_VERSION`, and the store's schema is `store_meta.schema`. `null`
     * for an index holding its own entries; undefined follows what the index
     * records.
     */
    storeRoot?: string | null,
    readonly store: StoreOptions = DEFAULT_STORE,
  ) {
    this.inspecting = mode !== 'open'
    this.read = localPolicy.read
    // bun:sqlite makes no parent directory. A directory this user cannot write
    // is a read-only cache for every reader: the write axis goes off, so the
    // file-hash memo skips its upserts. A run wants more (`assertWritable()`).
    // A reading verb over a directory with no index reads an empty one in
    // memory and makes nothing on disk, so a typo in `--cache-dir` creates
    // nothing.
    const dbFile = path.join(cacheDir, 'cache.db')
    this.dbFile = dbFile
    let absent = mode !== 'open' && !existsSync(dbFile)
    // A preview reads another schema's index as the empty one a reset leaves.
    // The version is read once, on the index's own connection.
    let early: { db: Database; version: string | undefined } | undefined
    if (mode === 'preview' && !absent) {
      early = previewIndex(dbFile)
      if (early !== undefined && early.version !== undefined && early.version !== SCHEMA_VERSION) {
        closeDb(early.db)
        early = undefined
        absent = true
      }
    }
    this.writeBlocked = absent ? NO_INDEX : openCacheDir(cacheDir, repoDir)
    this.write = localPolicy.write && this.writeBlocked === null
    // A directory this user cannot write with no index yet: SQLite cannot make
    // one, so read an empty index in memory, as a reader's typo gets, and let
    // `assertWritable` name the directory.
    const memory = absent || (this.writeBlocked !== null && !existsSync(dbFile))
    this.empty = memory
    try {
      this.db = early?.db ?? new Database(memory ? ':memory:' : dbFile, { create: true })
    } catch (err) {
      throw cantOpenIndex(dbFile, err) ?? err
    }
    // busy_timeout makes a concurrent writer wait for the lock instead of
    // failing SQLITE_BUSY (two `vx run`s on CI). FIRST, before the journal-mode
    // switch: that pragma takes a lock of its own, and the open is the one
    // moment two runs still overlap. A file that is not a database answers the
    // first statement that reads it.
    const readable = <T>(read: () => T): T => {
      try {
        return read()
      } catch (err) {
        if (!unreadableIndex(err)) {
          const fds = cantOpenIndex(dbFile, err)
          if (fds === undefined) throw err
          try {
            closeDb(this.db)
          } catch {
            // The refusal is the error worth reporting.
          }
          throw fds
        }
        try {
          closeDb(this.db)
        } catch {
          // The refusal below is the error worth reporting.
        }
        throw unreadableIndexError(dbFile, err)
      }
    }
    readable(() => {
      this.db.exec('PRAGMA busy_timeout = 5000')
      this.db.exec('PRAGMA journal_mode = WAL')
      // Keep `-wal` and `-shm` when the last connection closes: a cache
      // directory this user may not write (a CI cache restored read-only)
      // cannot make them again, and every open there would fail before the
      // not-writable refusal names the directory.
      if (!absent) this.db.fileControl(SQLITE_FCNTL_PERSIST_WAL, 1)
      // A non-negative limit makes the last clean close truncate a persistent
      // `-wal` once checkpointed. At -1 every later connection replayed the
      // kept frames into the database again (4.5 MB on a 1,000-project cache).
      // 64 MiB is far above what a run writes, so it never trims mid-run.
      this.db.exec('PRAGMA journal_size_limit = 67108864')
      this.db.exec('PRAGMA synchronous = NORMAL')
      this.db.exec('PRAGMA foreign_keys = ON')
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS schema_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `)
    })

    // The schema gate runs before the schema lands, so a changed table takes
    // effect. Pre-alpha: no migrations, drop and recreate. Orphaned artifacts
    // are never seen by a lookup (rows first), a re-save renames over them, and
    // prune unlinks the rest.
    //
    // The write half re-reads the row under the write lock: two processes
    // opening one NEW cache both read no row. A warm open takes no lock.
    const readVersion = (): string | undefined =>
      (
        this.db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
          | { value: string }
          | undefined
      )?.value
    // An opener that may write resets any other schema: the index is an
    // inventory the artifacts rebuild. A reading verb leaves it as it was.
    const refuseUnreadable = (found: string): void => {
      if (mode !== 'open') {
        throw new UserError(
          `the cache at ${cacheDir} holds index schema ${found} from another vx version; this vx reads ${SCHEMA_VERSION}, so nothing in it is readable here, and this verb leaves it untouched. The next \`vx run\` resets it`,
          'VX_E_CACHE_VERSION',
        )
      }
    }
    const current = early?.version ?? readable(readVersion)
    if (current !== SCHEMA_VERSION) {
      try {
        if (current !== undefined) refuseUnreadable(current)
        this.schemaReset = this.db
          .transaction((): SchemaReset | null => {
            const found = readVersion()
            if (found === SCHEMA_VERSION) return null
            if (found !== undefined) refuseUnreadable(found)
            // `main.` on every name: unqualified, a table the index lacks would
            // resolve to an attached store's.
            if (found !== undefined) {
              this.db.exec(
                'DROP TABLE IF EXISTS main.entries; DROP TABLE IF EXISTS main.runs; DROP TABLE IF EXISTS main.file_hashes; DROP TABLE IF EXISTS main.blob_sizes; DROP TABLE IF EXISTS main.blob_verdicts; DROP TABLE IF EXISTS main.output_files; DROP TABLE IF EXISTS main.output_stamps; DROP TABLE IF EXISTS main.invocations; DROP TABLE IF EXISTS main.run_task_inputs; DROP TABLE IF EXISTS main.entry_inputs; DROP TABLE IF EXISTS main.config_evals; DROP TABLE IF EXISTS main.config_closures; DROP TABLE IF EXISTS main.output_dirs; DROP TABLE IF EXISTS main.entry_stdout; DROP TABLE IF EXISTS main.task_durations; DROP TABLE IF EXISTS main.plugin_blobs; DROP TABLE IF EXISTS main.task_outcomes; DROP TABLE IF EXISTS main.store_meta; DROP TABLE IF EXISTS main.fold_memo; DROP TABLE IF EXISTS main.remote_hits; DROP TABLE IF EXISTS main.steps; DROP TABLE IF EXISTS main.warnings; DROP TABLE IF EXISTS main.failures; DROP TABLE IF EXISTS main.lockfile_memos; DROP TABLE IF EXISTS main.run_ids;',
              )
            }
            // The tables land under the stamp's write lock: made after it,
            // another vx's reset could stamp its schema in between. An index
            // beside a store keeps no entry tables (they would shadow the
            // store's).
            createTables(this.db, 'main')
            const recordedStore = this.db
              .prepare("SELECT 1 FROM schema_meta WHERE key = 'store_dir'")
              .get()
            if (storeRoot === undefined ? recordedStore != null : storeRoot !== null) {
              for (const t of [...STORE_TABLES, ...ARTIFACT_TABLES])
                this.db.exec(`DROP TABLE main.${t}`)
            }
            this.db
              .prepare(
                "INSERT INTO schema_meta(key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
              )
              .run(SCHEMA_VERSION)
            return found === undefined ? null : { from: found, to: SCHEMA_VERSION }
          })
          .immediate()
      } catch (err) {
        try {
          closeDb(this.db)
        } catch {
          // The migration's own error is the one worth reporting.
        }
        throw err
      }
    }

    // Where the entry tables live: `store_dir` names the store this index was
    // last opened with; absent, the index holds them.
    const recorded = readable(
      () =>
        (
          this.db.prepare("SELECT value FROM schema_meta WHERE key = 'store_dir'").get() as {
            value: string
          } | null
        )?.value,
    )
    // A store the caller names is the one a run opens, and every mode reads it:
    // a dry prune names what the real one takes, `vx info` the store the next
    // run fills.
    let storeDir = storeRoot === undefined ? recorded : (storeRoot ?? undefined)
    // Every mode settles the store as a run does, the reading ones without
    // touching it, so they read the entries runs use.
    const root = typeof storeRoot === 'string' ? storeRoot : null
    if (storeDir !== undefined && (this.writeBlocked === null || absent)) {
      if (storeBlocked(storeDir, root, mode === 'open') !== null) {
        // A home this user cannot write: the entries stay in this workspace
        // rather than fail the run.
        const fallback = cacheDir
        if (fallback !== storeDir) {
          storeDir = fallback
          if (mode === 'open') openCacheDir(fallback)
        }
      }
    }
    // An index that held its entries itself (a repository before its first
    // commit) hands them to the store.
    const holds =
      storeDir !== undefined &&
      mode === 'open' &&
      this.writeBlocked === null &&
      readable(
        () =>
          this.db
            .prepare(
              "SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name IN ('entries', 'artifacts')",
            )
            .get() != null,
      )
    this.storeDir = storeDir
    this.artifactDir = storeDir ?? cacheDir
    if (storeDir !== undefined) {
      attachStore(this, storeDir, mode !== 'open', (dir) =>
        dir === cacheDir ? openCacheDir(dir) : storeBlocked(dir, root, true),
      )
      this.storeReset = matchStoreSchema(this, mode === 'open' && this.writeBlocked === null)
    } else {
      createTables(this.db, 'main')
      if (absent && existsSync(dbFile)) keepArtifacts(this, dbFile)
    }
    const foreign = storeDir === undefined ? current !== SCHEMA_VERSION : this.storeStamped
    if (mode === 'open' && this.writeBlocked === null && (foreign || storeDir !== recorded)) {
      readable(() => matchArtifactLayout(this, storeDir === undefined ? 'main' : 'store'))
    }
    if (holds) carryEntries(this, cacheDir, storeDir!)
    if (mode === 'open' && this.writeBlocked === null && storeDir !== recorded) {
      if (storeDir === undefined)
        this.db.prepare("DELETE FROM schema_meta WHERE key = 'store_dir'").run()
      else
        this.db
          .prepare(
            "INSERT INTO schema_meta(key, value) VALUES ('store_dir', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          )
          .run(storeDir)
    }

    this.deleteEntryRow = lazyStatement(this.db, 'DELETE FROM entries WHERE hash = ?')
    this.insertEntry = lazyStatement(
      this.db,
      `
      INSERT INTO entries(hash, project, task, command, exit_code, duration_ms, size_bytes, created_at, accessed_at, cpu_ms, peak_rss_bytes, run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        project        = excluded.project,
        task           = excluded.task,
        command        = excluded.command,
        exit_code      = excluded.exit_code,
        duration_ms    = excluded.duration_ms,
        size_bytes     = excluded.size_bytes,
        accessed_at    = excluded.accessed_at,
        cpu_ms         = excluded.cpu_ms,
        peak_rss_bytes = excluded.peak_rss_bytes,
        created_at     = excluded.created_at,
        run_id         = excluded.run_id
    `,
    )
    this.upsertStdout = lazyStatement(
      this.db,
      'INSERT INTO entry_stdout(hash, stdout) VALUES (?, ?) ON CONFLICT(hash) DO UPDATE SET stdout = excluded.stdout',
    )
    this.deleteStdout = lazyStatement(this.db, 'DELETE FROM entry_stdout WHERE hash = ?')
    this.selectStdout = lazyStatement(this.db, 'SELECT stdout FROM entry_stdout WHERE hash = ?')
    this.selectUsage = lazyStatement(
      this.db,
      'SELECT cpu_ms, peak_rss_bytes FROM entries WHERE hash = ? LIMIT 1',
    )
    this.selectEntry = lazyStatement(this.db, SELECT_ENTRY)
    // `has` reads only whether the row exists and where its artifact is. A
    // column off the index, so a corrupt table refuses here as on `get`.
    this.entryExists = lazyStatement(
      this.db,
      'SELECT e.exit_code, a.at AS inline_at FROM entries e LEFT JOIN artifacts a ON a.hash = e.hash WHERE e.hash = ?',
    )
    this.selectBlob = lazyStatement(this.db, 'SELECT at, bytes FROM artifacts WHERE hash = ?')
    this.upsertBlob = lazyStatement(
      this.db,
      'INSERT INTO artifacts(hash, at, bytes) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET at = excluded.at, bytes = excluded.bytes',
    )
    this.deleteBlob = lazyStatement(this.db, 'DELETE FROM artifacts WHERE hash = ?')
    // INSERT OR IGNORE: a re-save of one hash leaves its rows alone; identical
    // inputs make identical rows.
    this.insertEntryInput = lazyStatement(
      this.db,
      `
      INSERT OR IGNORE INTO entry_inputs(entry_hash, components)
      VALUES (?, ?)
    `,
    )
    // The slices: each owns its statements over this handle and its tables; the
    // schema above declares every table.
    this.files = new FileHashStore(
      this.db,
      (dir) => repoFacts(dir)?.objectFormat,
      cacheDir,
      this.write,
      repoDir,
    )
    this.outputs = new OutputIndex(
      this.db,
      this.writeBlocked === null && !this.inspecting,
      // Only the workspace's own `.vx/cache` is no other clone's: a named
      // directory may be shared. Not keyed by the store, which a repository's
      // first commit adds.
      repoDir !== undefined && cacheDir !== path.join(repoDir, '.vx', 'cache')
        ? repoDir
        : undefined,
    )
    this.folds = new IndexFoldMemo(this.db, this.write && !this.inspecting)
    this.localMemo = new LocalMemo(this.files, this.folds, this.outputs, (op) => guard(this, op))
    this.remoteHits = new IndexRemoteHits(this.db, this.writeBlocked === null && !this.inspecting)

    // A CACHE_VERSION bump keeps the index but moves every key, so the next run
    // misses everything, silently. The version is recorded for a reader of the
    // index; a reading verb writes nothing.
    const format = this.db
      .prepare("SELECT value FROM schema_meta WHERE key = 'cache_version'")
      .get() as { value: string } | null
    if (format?.value !== CACHE_VERSION && this.writeBlocked === null && !this.inspecting) {
      this.db
        .prepare(
          "INSERT INTO schema_meta(key, value) VALUES ('cache_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(CACHE_VERSION)
    }
  }
}

/**
 * Run `op`, mapping SQLite's "not a database" (a page corrupt past those the
 * open reads) to the open's own refusal, not an internal error on every task.
 * Other errors pass through.
 */
export function guard<T>(ix: StoreIndex, op: () => T): T {
  const refuse = (err: unknown): never => {
    throw indexErrorOf(ix, err)
  }
  try {
    const out = op()
    return (out instanceof Promise ? out.catch(refuse) : out) as T
  } catch (err) {
    return refuse(err)
  }
}

/**
 * Which file a "not a database" came from: SQLite does not say, and the entries
 * may live in the store. Asked only on that refusal.
 */
function unreadableFile(ix: StoreIndex): string {
  if (ix.storeDir === undefined) return ix.dbFile
  const storeFile = path.join(ix.storeDir, 'store.db')
  try {
    const row = ix.db.prepare('PRAGMA store.quick_check(1)').get() as {
      quick_check?: unknown
    } | null
    return row?.quick_check === 'ok' ? ix.dbFile : storeFile
  } catch {
    return storeFile
  }
}

/**
 * Move the entries an index held into the store it now opens: same keys, same
 * bytes, so the run after a repository's first commit replays the run before
 * it. Then drop them from the index, where they would shadow the store's. An
 * artifact that cannot be renamed there (another device) is left for `prune`;
 * its entry misses.
 */
function carryEntries(ix: StoreIndex, cacheDir: string, storeDir: string): void {
  const has = (schema: 'main' | 'store', table: string): boolean =>
    ix.db
      .prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table) != null
  const layout = (schema: 'main' | 'store'): string | undefined =>
    has(schema, 'artifacts_meta')
      ? (
          ix.db
            .prepare(`SELECT value FROM ${schema}.artifacts_meta WHERE key = 'layout'`)
            .get() as { value: string } | null
        )?.value
      : undefined
  if (storeDir !== cacheDir) {
    let names: string[] = []
    try {
      names = readdirSync(cacheDir)
    } catch {
      // No directory: nothing to carry.
    }
    for (const name of names) {
      if (!name.endsWith('.tar.zst') && !name.endsWith('.tree')) continue
      const to = path.join(storeDir, name)
      if (existsSync(to)) continue
      try {
        renameSync(path.join(cacheDir, name), to)
      } catch {
        // Another device: the artifact stays an orphan here.
      }
    }
  }
  ix.db
    .transaction(() => {
      // `entries` first: the other tables' rows reference it.
      for (const t of STORE_TABLES.toReversed()) {
        if (t !== 'store_meta' && has('main', t) && has('store', t)) {
          ix.db.exec(`INSERT OR IGNORE INTO store.${t} SELECT * FROM main.${t}`)
        }
      }
      if (
        has('main', 'artifacts') &&
        has('store', 'artifacts') &&
        layout('main') === ARTIFACT_LAYOUT &&
        layout('store') === ARTIFACT_LAYOUT
      ) {
        ix.db.exec('INSERT OR IGNORE INTO store.artifacts SELECT * FROM main.artifacts')
      }
      for (const t of [...STORE_TABLES, ...ARTIFACT_TABLES]) {
        ix.db.exec(`DROP TABLE IF EXISTS main.${t}`)
      }
    })
    .immediate()
}

/**
 * Attach the shared store as `store`, WAL like the index, so workspaces share
 * it. A reading verb over a store without file or tables reads an empty one in
 * memory.
 *
 * `vx cache clean` holds the store alone (`holdStore`) until it deleted it; a
 * writing open meeting that hold gets SQLITE_BUSY within a second and retries
 * (prepare.ts). One let in after the clean opened the unlinked store.db: it
 * makes the store again (`remake`). Once in, its lock keeps a clean out.
 */
function attachStore(
  ix: StoreIndex,
  storeDir: string,
  inspecting: boolean,
  remake: (dir: string) => string | null,
): void {
  const storeFile = path.join(storeDir, 'store.db')
  let absent = inspecting && !existsSync(storeFile)
  try {
    for (let retried = false; ;) {
      // The attach reads the store's schema: its first lock on it.
      if (!inspecting) ix.db.exec('PRAGMA busy_timeout = 1000')
      try {
        ix.db.prepare('ATTACH DATABASE ? AS store').run(absent ? ':memory:' : storeFile)
      } catch (err) {
        // A file whose directory went: SQLite cannot open its -wal there.
        const busy = (err as { code?: unknown }).code === 'SQLITE_BUSY'
        if (inspecting || busy || retried || remake(storeDir) !== null) throw err
        retried = true
        continue
      }
      // A store with no tables yet is read empty too: the journal switch and
      // table creation are writes under no lock, racing whoever makes it.
      if (
        inspecting &&
        !absent &&
        ix.db.prepare("SELECT 1 FROM store.sqlite_master WHERE name = 'entries'").get() == null
      ) {
        ix.db.exec('DETACH DATABASE store')
        ix.db.prepare('ATTACH DATABASE ? AS store').run(':memory:')
        absent = true
      }
      ix.db.exec('PRAGMA store.journal_mode = WAL')
      if (inspecting) break
      ix.db.exec('PRAGMA busy_timeout = 5000')
      // One stat, SQLite's: is the file open still the one at its name?
      const moved = new Int32Array(2)
      ix.db.fileControl('store', SQLITE_FCNTL_HAS_MOVED, moved)
      if (moved[0] === 0) break
      ix.db.exec('DETACH DATABASE store')
      const refused = remake(storeDir)
      if (refused !== null) throw new Error(`${storeFile} was deleted, and ${refused}`)
    }
    if (!absent) ix.db.fileControl('store', SQLITE_FCNTL_PERSIST_WAL, 1)
    ix.db.exec('PRAGMA store.journal_size_limit = 67108864')
    ix.db.exec('PRAGMA store.synchronous = NORMAL')
  } catch (err) {
    try {
      closeDb(ix.db)
    } catch {
      // The refusal below is the error worth reporting.
    }
    throw unreadableIndex(err)
      ? unreadableIndexError(storeFile, err)
      : (cantOpenIndex(storeFile, err) ?? err)
  }
}

/**
 * The store is an inventory of the artifacts beside it, read only by this vx:
 * another `SCHEMA_VERSION`'s store has its tables dropped and its artifacts
 * kept, each indexed again from its own bytes on its next hit (`adopt`). A
 * reading verb reads it as empty and changes nothing. Creates the tables either
 * way.
 */
function matchStoreSchema(ix: StoreIndex, writable: boolean): SchemaReset | null {
  const read = (): { has: boolean; found: string | undefined } => {
    const tables = new Set(
      (
        ix.db.prepare("SELECT name FROM store.sqlite_master WHERE type = 'table'").all() as Array<{
          name: string
        }>
      ).map((r) => r.name),
    )
    const found = tables.has('store_meta')
      ? (
          ix.db.prepare("SELECT value FROM store.store_meta WHERE key = 'schema'").get() as {
            value: string
          } | null
        )?.value
      : undefined
    return { has: tables.has('entries'), found }
  }
  const seen = read()
  if (seen.has && seen.found === SCHEMA_VERSION) {
    createTables(ix.db, 'store')
    return null
  }
  if (!writable) {
    const file = ix.db
      .prepare("SELECT file FROM pragma_database_list WHERE name = 'store'")
      .get() as {
      file: string
    }
    if (seen.has) {
      ix.db.exec('DETACH DATABASE store')
      ix.db.prepare('ATTACH DATABASE ? AS store').run(':memory:')
    }
    createTables(ix.db, 'store')
    if (seen.has && file.file !== '') keepArtifacts(ix, file.file)
    return null
  }
  // Re-read, drop, create and stamp under one write lock: as separate
  // transactions, another vx's tables could land after the drop and survive
  // under this stamp.
  return ix.db
    .transaction((): SchemaReset | null => {
      ix.storeStamped = true
      const now = read()
      let reset: SchemaReset | null = null
      if (now.has && now.found !== SCHEMA_VERSION) {
        for (const t of STORE_TABLES) {
          if (t !== 'store_meta') ix.db.exec(`DROP TABLE IF EXISTS store.${t}`)
        }
        reset = { from: now.found ?? 'an earlier schema', to: SCHEMA_VERSION }
      }
      createTables(ix.db, 'store')
      ix.db
        .prepare(
          "INSERT INTO store.store_meta(key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(SCHEMA_VERSION)
      return reset
    })
    .immediate()
}

/**
 * A reading open over another schema's index or store reads it as a writing
 * open's reset leaves it: empty but for the inline artifacts, which a reset
 * keeps. They are read in place through a TEMP view that shadows the empty
 * table, so a dry prune names what the real one reaps.
 */
function keepArtifacts(ix: StoreIndex, file: string): void {
  ix.db.prepare('ATTACH DATABASE ? AS kept').run(file)
  const layout = ix.db
    .prepare("SELECT 1 FROM kept.sqlite_master WHERE type = 'table' AND name = 'artifacts_meta'")
    .get()
    ? (
        ix.db.prepare("SELECT value FROM kept.artifacts_meta WHERE key = 'layout'").get() as {
          value: string
        } | null
      )?.value
    : undefined
  if (layout === ARTIFACT_LAYOUT) {
    ix.db.exec('CREATE TEMP VIEW artifacts AS SELECT hash, at, bytes FROM kept.artifacts')
  }
}

/**
 * `artifacts` holds this vx's layout or is remade: its version
 * (`ARTIFACT_LAYOUT`) is apart from the schema's, so a schema reset keeps it.
 * Asked only where the schema was not this vx's.
 */
function matchArtifactLayout(ix: StoreIndex, schema: 'main' | 'store'): void {
  const read = (): string | undefined =>
    (
      ix.db.prepare(`SELECT value FROM ${schema}.artifacts_meta WHERE key = 'layout'`).get() as {
        value: string
      } | null
    )?.value
  // Read first: a first open of a current store must not wait on its write lock
  // to learn it holds `a1`.
  if (read() === ARTIFACT_LAYOUT) return
  ix.db
    .transaction(() => {
      const found = read()
      if (found === ARTIFACT_LAYOUT) return
      if (found !== undefined) {
        ix.db.exec(`DROP TABLE ${schema}.artifacts`)
        createArtifactTables(ix.db, schema)
      }
      ix.db
        .prepare(
          `INSERT INTO ${schema}.artifacts_meta(key, value) VALUES ('layout', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(ARTIFACT_LAYOUT)
    })
    .immediate()
}

/**
 * The digest a value-bearing row holds (an env value, a runtime output,
 * forwarded args): xxh3 under a random salt this store keeps. `vx why` prints
 * it, and an unkeyed digest in a public CI log would let anyone brute-force a
 * short secret. Salted, it still says whether a value changed. Asked for on a
 * miss only.
 */
export function digestValue(ix: StoreIndex, value: string): string {
  ix.valueSalt ??= loadValueSalt(ix)
  return xxh3hex(`${ix.valueSalt}\0${value}`)
}

function loadValueSalt(ix: StoreIndex): string {
  const read = (): string | undefined =>
    (
      ix.db.prepare("SELECT value FROM store_meta WHERE key = 'value_salt'").get() as {
        value: string
      } | null
    )?.value
  const found = read()
  if (found !== undefined) return found
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex')
  // A store this process may not write keeps the salt for the process: nothing
  // it digests is persisted.
  if (ix.writeBlocked !== null || ix.inspecting) return salt
  // Two processes opening one new store: the first salt stands.
  ix.db
    .prepare(
      "INSERT INTO store_meta(key, value) VALUES ('value_salt', ?) ON CONFLICT(key) DO NOTHING",
    )
    .run(salt)
  return read() ?? salt
}

/** The index row and its artifact are both here, whatever the run may read. */
export function storedHere(ix: StoreIndex, hash: string): boolean {
  const row = ix.entryExists.get(hash) as { inline_at: number | null } | null
  if (row === null) return false
  return row.inline_at !== null || artifactStat(ix, hash) !== undefined
}

export function stdoutText(ix: StoreIndex, hash: string): string {
  const row = ix.selectStdout.get(hash) as { stdout: Uint8Array } | null
  return storedLog(row?.stdout ?? null)
}

/**
 * pid, hrtime and random hex, so two saves of one hash never pick the same temp
 * name.
 */
export function tempPath(ix: StoreIndex, hash: string): string {
  return `${tarPath(ix, hash)}.tmp-${process.pid}-${process.hrtime.bigint()}-${Math.random().toString(36).slice(2, 10)}`
}

export function tempTreePath(ix: StoreIndex, hash: string): string {
  return `${treePathOf(ix, hash)}.tmp-${process.pid}-${process.hrtime.bigint()}-${Math.random().toString(36).slice(2, 10)}`
}

/** Apply the deferred accessed_at bumps in one statement. */
export function flushAccessed(ix: StoreIndex): void {
  // Apart: a hit whose row is fresh still renews an old file time.
  if (ix.touched.size === 0 && ix.staleTimes.size === 0 && ix.staleInline.size === 0) {
    return
  }
  const hashes = [...ix.touched]
  ix.touched.clear()
  const now = Date.now()
  // The file time is the last use another vx version's sweep can see: its open
  // dropped this index's rows.
  const at = new Date(now)
  for (const hash of ix.staleTimes) {
    try {
      utimesSync(artifactStat(ix, hash)?.path ?? tarPath(ix, hash), at, at)
    } catch {
      // Gone, or another user's file: a sweep judges its old time.
    }
  }
  ix.staleTimes.clear()
  const inline = [...ix.staleInline]
  ix.staleInline.clear()
  // LRU bookkeeping: on a full disk the bumps are dropped, never the prune or
  // stats that asked.
  try {
    if (inline.length > 0) {
      const { test, params } = inHashes(inline)
      ix.db.prepare(`UPDATE artifacts SET at = ? WHERE hash ${test}`).run(now, ...params)
    }
    if (hashes.length > 0) writeAccessed(ix, hashes, now)
  } catch (err) {
    if (!isIndexFull(err)) throw err
  }
}

function writeAccessed(ix: StoreIndex, hashes: readonly string[], now: number): void {
  const { test, params } = inHashes(hashes)
  ix.db.prepare(`UPDATE entries SET accessed_at = ? WHERE hash ${test}`).run(now, ...params)
}

export function tarPath(ix: StoreIndex, hash: string): string {
  return path.join(ix.artifactDir, `${hash}.tar.zst`)
}

export function treePathOf(ix: StoreIndex, hash: string): string {
  return path.join(ix.artifactDir, `${hash}.tree`)
}

/** The key's file-backed artifact (tar or tree), the form this store writes asked first. */
export function artifactStat(
  ix: StoreIndex,
  hash: string,
): { path: string; tree: boolean; mtimeMs: number } | undefined {
  const order = ix.store.decompress ? [true, false] : [false, true]
  for (const tree of order) {
    const at = tree ? treePathOf(ix, hash) : tarPath(ix, hash)
    const st = statSync(at, { throwIfNoEntry: false })
    if (st !== undefined) return { path: at, tree, mtimeMs: st.mtimeMs }
  }
  return undefined
}

/**
 * The files a second connection writes a run's hits through; undefined when the
 * store keeps no history on disk.
 */
export function historyFilesOf(ix: StoreIndex): { index: string; store?: string } | undefined {
  if (ix.empty || ix.writeBlocked !== null || ix.inspecting) return undefined
  if (ix.storeDir === undefined) return { index: ix.dbFile }
  return { index: ix.dbFile, store: path.join(ix.storeDir, 'store.db') }
}

/** `err` as a reader of the index reports it: an unreadable page is refused by its file. */
export function indexErrorOf(ix: StoreIndex, err: unknown): unknown {
  return unreadableIndex(err) ? unreadableIndexError(unreadableFile(ix), err) : err
}
