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
 * An artifact or temp file without an `entries` row is never reaped
 * younger than this: a crashed save's temp is stale long before it. A
 * row-less artifact may still be in use (another vx version's open dropped
 * its row), so past this it is judged by the prune policy, its file
 * time standing for `accessed_at`. A hit renews a file time older than
 * this, so the file time trails the last use by at most this much, and
 * the policy reads the file time plus this as the last use.
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
 * `EMFILE`, so an open under a low `ulimit -n` reached the user as a bare
 * `vx: SQLiteError: unable to open database file`. One
 * open of a file that exists says which it was. Any other `CANTOPEN` is
 * the path itself.
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
  // SQLite's unix VFS opens no path past 512 bytes, the `-journal` it may
  // add counted: a long one was blamed on permissions.
  const bytes = Buffer.byteLength(path.resolve(dbFile))
  if (bytes > SQLITE_PATH_MAX) {
    return new UserError(
      `the cache index ${dbFile} could not be opened (${(err as Error).message}) — ` +
        `its path is ${bytes} bytes and SQLite opens none past ${SQLITE_PATH_MAX}; ` +
        'point the cache at a shorter directory (--cache-dir, VX_CACHE_DIR)',
      'VX_E_FS',
    )
  }
  // Any other: a directory, or a file this user may not open, where the
  // index goes. It reached every verb as a stack.
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
 * The inline artifacts' tables (schema.ts): dropped from a workspace index
 * whose entries moved to a store, where an unqualified name would find them
 * first, and never by a schema reset.
 */
const ARTIFACT_TABLES = ['artifacts', 'artifacts_meta']

/**
 * The `artifacts` table's own layout (`artifacts_meta.layout`): another value
 * drops the table. It is read only where the schema was not this vx's (a
 * reset, a new index or store, a store moved), so a change to it bumps
 * `SCHEMA_VERSION` too: a warm open reads no statement for it.
 */
const ARTIFACT_LAYOUT = 'a2'

/**
 * A preview's index connection and the schema it records, which the open
 * keeps and reuses. A version other than this vx's is the index an opener
 * that writes resets; an unreadable file is left to the open to refuse.
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
    // No stamp read (no table yet, busy, not a database): the main open
    // reads it again and refuses what it must.
    return { db, version: undefined }
  }
}

/** The largest compressed log a probe loads with its entry. */
const LOG_INLINE_BYTES = 4096

/**
 * Each asked key's entry row, its stored log while that is small, and its
 * inline artifact's last use, null when the artifact is a file. A larger
 * log is only flagged (`stdout_apart`), and read when its hit replays: a
 * warm run probes every key in one batch and replays the hits as the
 * scheduler reaches them, so every log joined here was held until its
 * replay (500 hits printing 1 MiB each held 3.4 GB). A small one rides
 * along, still compressed: a read apart per hit cost a warm run of 300
 * short logs ~1 ms of 44. `length` reads a blob's size, not its pages.
 * Driven by the keys, so a key with an inline artifact and no row (a reset
 * kept it) answers too, `hash` null: the miss learns there is something to
 * adopt in the statement that found no entry.
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
   * The largest entry kept in the index, as one zstd tar (fewer files to
   * make): written in its rows' transaction, with no temp and no rename
   * (docs/design/cache-save-cpu-2026-10.md). 0 keeps every entry as files.
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
 * An `entry_stdout` row's log: a zstd frame of its UTF-8, which keeps
 * a leading U+FEFF a bound string loses. Null, no row, reads as ''. The
 * index is vx's own, so the frame is trusted, as a tree's files are.
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
   * Each entry `save()` wrote: its files' bytes, summed as the rows went in,
   * for the miss row's `outputs` (a read back was one statement a miss;
   * principle 9). Taken once, by `outputBytes`.
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
   * Local-layer read/write gates for the task ARTIFACT path only.
   * `get()` returns null when `!read`; `save()` skips the artifact +
   * index write when `!write`. Everything else (recordRun, stats,
   * prune, ingest, hashing) is unaffected — those are bookkeeping a
   * run policy must not disable. Default: both true.
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
   * Set when THIS open found an index written by another `SCHEMA_VERSION`
   * and dropped every table. The next open sees the current version and
   * reports null. vx prints nothing for it: the cache is vx's to keep.
   */
  readonly schemaReset: SchemaReset | null = null

  /**
   * Set when THIS open found the shared store written under another
   * `SCHEMA_VERSION` and dropped its inventory; the artifacts stay and are
   * indexed again as they hit. Never printed: the cache is vx's to keep.
   */
  readonly storeReset: SchemaReset | null = null
  /** This open stamped the store's schema: it was new or another vx's. */
  storeStamped = false
  valueSalt: string | undefined

  constructor(
    readonly cacheDir: string,
    localPolicy: { read: boolean; write: boolean } = { read: true, write: true },
    /**
     * The workspace root, where the file hasher asks git for the object format
     * (file-hashes.ts), and whose output stamps and snapshots this handle
     * reads in a named cache dir.
     */
    repoDir?: string,
    /**
     * The largest artifact, decoded, this cache saves, ingests or
     * restores (zstd.ts). Lowered only by a test, through
     * `RunOptions.artifactCeiling`: 2 GiB of output is out of a test's reach.
     */
    readonly artifactCeiling: number = MAX_DECOMPRESSED_ARTIFACT_BYTES,
    /**
     * `'inspect'`: a reading verb (`why`, `last`, `info`). It never resets
     * the index: a schema it cannot read is refused, named, and left as it
     * was. `'preview'`: a dry prune or a `--dry` plan, which reads such an
     * index as the reset the real prune or run does first leaves it, empty,
     * with the store still reached, so it names what that prune takes.
     */
    mode: 'open' | 'inspect' | 'preview' = 'open',
    /**
     * The shared store's directory, unversioned: every key is seeded with
     * `CACHE_VERSION`, so two vx versions never read each other's entries,
     * and the store's own schema is `store_meta.schema` (`matchStoreSchema`). Or
     * `null` for an index that holds its entries itself (a `cacheDir`).
     * Undefined follows the layout the index records: a reading verb, a
     * plugin's handle.
     */
    storeRoot?: string | null,
    readonly store: StoreOptions = DEFAULT_STORE,
  ) {
    this.inspecting = mode !== 'open'
    this.read = localPolicy.read
    // The directory exists before the DB opens — bun:sqlite won't create
    // parent dirs for us. A directory this user cannot write into is a
    // read-only cache for every reader (`vx show`, `why`, `last`, the
    // doctor, the watch sweep): the write axis goes off, so the file-hash
    // memo skips its upserts instead of dying in SQLite on the first miss (an unprivileged user on
    // a root-owned `.vx`). A run wants more than a quiet
    // read-only cache — `assertWritable()`.
    // A reading verb over a directory with no index yet reads an empty one
    // in memory and makes nothing on disk: `vx last --cache-dir .vx/cahce`
    // created the typo's directory, a `.gitignore` and a database, then
    // said "no recorded runs yet".
    const dbFile = path.join(cacheDir, 'cache.db')
    this.dbFile = dbFile
    let absent = mode !== 'open' && !existsSync(dbFile)
    // A preview reads an index of another schema as the empty one a reset
    // leaves. The version is read on the connection the index keeps, once:
    // a second connection for it cost a plan a statement (perf-guard).
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
    // A directory this user cannot write with no index in it yet: SQLite
    // cannot make one, and its `unable to open database file` stack reached
    // the user before `assertWritable` could name the directory (a
    // read-only mount). Nothing there to
    // read, so an empty index in memory, as a reader's typo gets.
    const memory = absent || (this.writeBlocked !== null && !existsSync(dbFile))
    this.empty = memory
    try {
      this.db = early?.db ?? new Database(memory ? ':memory:' : dbFile, { create: true })
    } catch (err) {
      throw cantOpenIndex(dbFile, err) ?? err
    }
    // busy_timeout makes concurrent writers wait for the lock instead of
    // failing immediately with SQLITE_BUSY. Two parallel `vx run`
    // invocations in CI is a normal pattern; without this the second one
    // crashes in recordRun(). FIRST, before the journal-mode switch: that
    // pragma takes a lock of its own, and set after it the timeout did not
    // cover it — two CLI runs opening one cache at the same instant met
    // `database is locked` right here, on macOS's slower disk first
    // (the lock is taken after the
    // cache opens, so the open is the one moment two runs still overlap).
    // A file SQLite cannot read as a database answers the first statement
    // that reads it, and reached every verb as `SQLiteError: file is not a
    // database` and a stack, `vx run` and the doctor included.
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
      // Keep `-wal` and `-shm` when the last connection closes. A closed
      // index otherwise deletes them, and a cache directory this user may
      // not write (a CI cache restored read-only) cannot make them again:
      // every open there failed `attempt to write a readonly database`
      // before the not-writable refusal could name the directory.
      if (!absent) this.db.fileControl(SQLITE_FCNTL_PERSIST_WAL, 1)
      // Any non-negative limit makes the last clean close truncate a
      // persistent `-wal` to zero bytes once it is checkpointed (SQLite's
      // walClose). At the default (-1) it kept every frame, so each later
      // connection recovered them at open and copied them into the
      // database again at its close: 738 frames, 4.5 MB, on a 1,000-project
      // cache. The file stays; 64 MiB is far above what a run
      // writes, so the limit never trims a WAL mid-run.
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

    // Schema-version gate runs BEFORE the rest of the schema lands so
    // a column rename (e.g. `sha256` → `content_hash`) actually
    // takes effect on stale DBs. Pre-alpha: no migrations, just drop
    // and recreate. Artifacts on disk become orphans: a lookup never
    // sees them (rows first, then the file), the next save of the same
    // key renames over them, and `prune()`'s orphan sweep unlinks the
    // rest.
    //
    // The write half runs under the write lock and reads the row again: two
    // processes opening one NEW cache both read no row, and the second
    // insert died on the primary key. A warm
    // open reads the current version and takes no lock.
    const readVersion = (): string | undefined =>
      (
        this.db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
          | { value: string }
          | undefined
      )?.value
    // Any other schema is reset by an opener that may write it: the index is
    // an inventory the artifacts rebuild, whichever vx wrote it. A reading verb
    // leaves it as it was.
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
            // `main.` on every name: unqualified, a table the index lacks
            // resolves to an attached store's (none is attached yet; this
            // keeps it so).
            if (found !== undefined) {
              this.db.exec(
                'DROP TABLE IF EXISTS main.entries; DROP TABLE IF EXISTS main.runs; DROP TABLE IF EXISTS main.file_hashes; DROP TABLE IF EXISTS main.blob_sizes; DROP TABLE IF EXISTS main.blob_verdicts; DROP TABLE IF EXISTS main.output_files; DROP TABLE IF EXISTS main.output_stamps; DROP TABLE IF EXISTS main.invocations; DROP TABLE IF EXISTS main.run_task_inputs; DROP TABLE IF EXISTS main.entry_inputs; DROP TABLE IF EXISTS main.config_evals; DROP TABLE IF EXISTS main.config_closures; DROP TABLE IF EXISTS main.output_dirs; DROP TABLE IF EXISTS main.entry_stdout; DROP TABLE IF EXISTS main.task_durations; DROP TABLE IF EXISTS main.plugin_blobs; DROP TABLE IF EXISTS main.task_outcomes; DROP TABLE IF EXISTS main.store_meta; DROP TABLE IF EXISTS main.fold_memo; DROP TABLE IF EXISTS main.remote_hits; DROP TABLE IF EXISTS main.steps; DROP TABLE IF EXISTS main.warnings; DROP TABLE IF EXISTS main.failures; DROP TABLE IF EXISTS main.lockfile_memos; DROP TABLE IF EXISTS main.run_ids;',
              )
            }
            // The tables land under the same write lock as the stamp: made
            // after it, another vx's reset could stamp its own schema in
            // between and keep these tables under it. An index beside a
            // store keeps no entry tables (they would shadow the store's).
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

    // Where the entry tables live: `store_dir` names the shared store
    // this index was last opened with; absent, the index holds them itself.
    const recorded = readable(
      () =>
        (
          this.db.prepare("SELECT value FROM schema_meta WHERE key = 'store_dir'").get() as {
            value: string
          } | null
        )?.value,
    )
    // A store named by the caller is the one a run opens (today's), and
    // every mode reads it: a dry prune names what the real one takes, and
    // `vx info` the store the next run fills, not one a moved HOME left.
    let storeDir = storeRoot === undefined ? recorded : (storeRoot ?? undefined)
    // Every mode settles the store as a run does, the reading ones without
    // touching it: `vx info` and a dry prune read the entries runs use, not
    // a store another user owns (one `sudo vx run`).
    const root = typeof storeRoot === 'string' ? storeRoot : null
    if (storeDir !== undefined && (this.writeBlocked === null || absent)) {
      if (storeBlocked(storeDir, root, mode === 'open') !== null) {
        // A home this user cannot write (a container, a read-only mount):
        // the entries stay in this workspace rather than fail the run.
        const fallback = cacheDir
        if (fallback !== storeDir) {
          storeDir = fallback
          if (mode === 'open') openCacheDir(fallback)
        }
      }
    }
    // An index that held its entries itself (no store yet: a repository
    // before its first commit) hands them to the store below.
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
    // `has` asks only whether the row is there and where its artifact is,
    // with no stdout joined. A column off the index, so the table row is
    // still read and a corrupt table refuses here as it does on `get`
    // (`SELECT 1` answers from the index alone).
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
    // INSERT OR IGNORE: re-saving the same hash (idempotent ingest /
    // overlapping concurrent saves) leaves the existing rows untouched —
    // identical inputs derive the identical hash, so the rows are too.
    this.insertEntryInput = lazyStatement(
      this.db,
      `
      INSERT OR IGNORE INTO entry_inputs(entry_hash, components)
      VALUES (?, ?)
    `,
    )
    // The slices: each owns its statements over this handle and its table(s);
    // the schema above is the one place every table is declared.
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
      // directory may be shared. Not keyed by the store, which a
      // repository's first commit adds, and the run after restored all.
      repoDir !== undefined && cacheDir !== path.join(repoDir, '.vx', 'cache')
        ? repoDir
        : undefined,
    )
    this.folds = new IndexFoldMemo(this.db, this.write && !this.inspecting)
    this.localMemo = new LocalMemo(this.files, this.folds, this.outputs, (op) => guard(this, op))
    this.remoteHits = new IndexRemoteHits(this.db, this.writeBlocked === null && !this.inspecting)

    // A CACHE_VERSION bump keeps the index but moves every key, so the run
    // after an upgrade misses everything, in silence: the cache is vx's to
    // keep. The version is recorded for whoever reads the
    // index by hand; a reading verb writes nothing.
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
 * Run `op` against the index, mapping SQLite's "not a database" — a page
 * corrupt past the ones the open reads — to the open's own refusal. The
 * open reads the header and `schema_meta` alone, so a file
 * corrupt deeper answered the first lookup that reached the bad page: every
 * task of a run failed as an "internal error", and `vx cache clean` printed
 * a stack. Every other error passes through as it was.
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
 * Which file a "not a database" answer came from: SQLite does not say,
 * and the entries live in the attached store, so naming the index alone
 * sent the user to remove a sound file. Asked only on that refusal.
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
 * The entries an index held itself, moved into the store it now opens:
 * the same keys over the same bytes, so the first run after a
 * repository's first commit replays what the run before it saved. Then
 * dropped from the index, where an unqualified name would shadow the
 * store's. An artifact file that cannot be renamed there (another
 * device) is left for `prune`, and its entry is a miss.
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
 * Attach the shared store as `store`, with the pragmas the index takes:
 * WAL for both, so a workspace's run and another's share the store as
 * two runs on one `--cache-dir` share an index. A reading verb over a
 * store with no file or no tables yet reads an empty one in memory.
 *
 * Every checkout of a repository shares its store, each with a run lock
 * of its own, and a `vx cache clean` in one holds the store alone
 * (`holdStore`) until it has deleted it. A writing open meeting that hold
 * answers SQLITE_BUSY within a second, for its caller to wait and open
 * again (prepare.ts). One let in once the clean let go opened the
 * store.db the clean unlinked, and saved its entry into it: it makes the
 * store again (`remake`, private and ignored) and opens that. Once in,
 * its lock keeps a clean out until it closes.
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
      // One with no tables yet is read empty in memory too: the journal
      // switch and the table creation below are writes, under no write
      // lock, racing an opener making that store.
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
 * The store is an inventory of the artifacts beside it, and only this vx
 * reads it: a store another `SCHEMA_VERSION` wrote has its tables dropped
 *, the artifacts kept. Each is indexed again from its
 * own bytes on its next hit (`adopt`). A reading verb reads such a store
 * as empty and changes nothing. Creates the store's tables either way.
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
  // transactions, another vx's open landing after the drop made its own
  // tables, and this one's `CREATE IF NOT EXISTS` kept them under its stamp.
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
 * A reading open over an index or store of another schema reads it as
 * the reset a writing open makes leaves it: empty, but for the inline
 * artifacts, which a reset keeps. They are read from the file in place,
 * through a view that shadows the empty table (a TEMP name is found
 * first), so a dry prune names the row-less ones the real prune reaps.
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
 * `artifacts` holds the layout this vx writes, or is dropped and made
 * again: its version is its own (`ARTIFACT_LAYOUT`), apart from the
 * schema's, so a schema reset keeps it. Silent, as a reset is. Asked
 * only where the schema was not this vx's (`ARTIFACT_LAYOUT`).
 */
function matchArtifactLayout(ix: StoreIndex, schema: 'main' | 'store'): void {
  const read = (): string | undefined =>
    (
      ix.db.prepare(`SELECT value FROM ${schema}.artifacts_meta WHERE key = 'layout'`).get() as {
        value: string
      } | null
    )?.value
  // Read first: a workspace's first open of a current store asks too,
  // and must not wait on the store's write lock to learn it holds `a1`.
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
 * args after `--`): xxh3 under a random salt this store keeps. `vx why`
 * and its JSON print it, and an unkeyed xxh3 in
 * a public CI log let anyone confirm or brute-force a short secret
 *. Salted, a digest still says whether a value changed, and says
 * nothing without this cache's `schema_meta`. Asked for on a miss only.
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
  // A store this process may not write keeps the salt for the process:
  // nothing it digests is persisted.
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

/** tmp suffix mixes pid + hrtime + a random hex chunk so two saves of
 *  the same hash from the same process (or from two forked workers that
 *  happen to share a wall-clock ms) don't pick the same tmp filename and
 *  race on the rename. */
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
  // The file time is the last use another vx version's sweep can see:
  // its open dropped this index's rows (`pickVictims`).
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
  // LRU bookkeeping: on a full disk the bumps are dropped, never the prune
  // or the stats that asked for them.
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
 * The files a second connection writes a run's hits through
 * (history-stream.ts); undefined when the store keeps no history on disk.
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
