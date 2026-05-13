// Content-addressed task cache, v10.
//
// SQLite holds metadata + run history (indexed by-hash, queryable for
// stats and eviction). Output files stay on disk under <cacheDir>/<hash>/
// so cache-hit restore is a direct file copy. stdout and stderr are
// kept as separate text files to preserve stream identity on replay.
//
// Replace this module to plug in remote storage. The contract is:
//   key()           : derive a stable hash from a task's identity + inputs
//   get(hash)       : retrieve a previous run's metadata, or null
//   restoreOutputs  : copy stored output files into the project dir
//   save            : persist outputs + metadata under a hash
//   recordRun       : append a row to the run history table (for stats)
//   close           : release the SQLite handle

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { relPosix } from '../util/paths.js'

const CACHE_VERSION = 'vx-cache-v13'
const SCHEMA_VERSION = 'v11'

export interface CacheKeyInput {
  taskId: string
  /**
   * Hash of the resolved task config (post-evaluation). Folds in everything
   * the user wrote — command, env declarations (passThrough names + define
   * key/value pairs), dependsOn, cache.inputs declarations, outputs — including
   * values that arrived via `import` at config-load time.
   */
  taskConfigHash: string
  /**
   * Runtime values of declared cache-input env names (from parent at hash
   * time). Independent of `exec.env`; lives here for cache identity.
   */
  envValues: Array<[name: string, value: string]>
  /** Absolute paths to input files. */
  inputFiles: string[]
  workspaceRoot: string
  /** Cache keys of upstream tasks this one depends on, sorted. */
  upstreamHashes: string[]
  /**
   * Workspace-level fingerprint — typically a hash of `pnpm-lock.yaml` +
   * `pnpm-workspace.yaml`. Folds resolved dep versions and workspace shape
   * into every task's key, so a lockfile bump invalidates everything.
   */
  workspaceFingerprint: string
  /**
   * CLI args forwarded to the task (after `--`). Folded into the key so that
   * the same command with different forwarded args is treated as a distinct
   * run, never a spurious cache hit.
   */
  forwardArgs?: readonly string[]
  /**
   * Hash of the project's `package.json` bytes. Folded into the key
   * implicitly (Turbo / Nx parity) so dep changes invalidate every
   * task in that project, even when `cache.inputs.files` doesn't
   * cover package.json. Empty string when the project has no
   * package.json (impossible in practice — workspace discovery
   * requires one — but we don't fail-loud here).
   */
  projectPackageJsonHash: string
}

export interface CacheEntry {
  hash: string
  taskId: string
  command: string
  exitCode: number
  durationMs: number
  outputFiles: string[]
  stdout: string
  stderr: string
  storedAt: string
  /**
   * Where this hit was resolved from. `'local'` for a SQLite-backed
   * Cache; `'remote'` when LayeredCache pulled the artifact from the
   * remote layer this lookup (even though it's been materialized into
   * local for next time). Lets the orchestrator surface
   * `cache-hit-remote` so users see when remote caching actually saved
   * them work vs. a stale-local replay.
   */
  source?: 'local' | 'remote'
}

export interface RunRecord {
  hash: string
  project: string
  task: string
  status: 'success' | 'failed' | 'cache-hit' | 'cache-hit-remote' | 'skipped'
  exitCode: number
  durationMs: number
  forwardArgs?: readonly string[]
  startedAt: number // ms-epoch wall clock
  endedAt: number // ms-epoch wall clock
  /**
   * Optional analytics columns. Populated by the orchestrator/runner;
   * stored as NULL on rows from older runs. Surfaced via `vx stats`
   * and consumable from CI by reading cache.db directly.
   */
  runId?: string // ULID shared across every task in one `vx run` invocation
  cpuMs?: number // sum of user + system CPU time for the child process
  peakRssBytes?: number // peak resident set size of the child process
  wallclockStartNs?: bigint // hrtime span relative to run t=0
  wallclockEndNs?: bigint
  cacheHit?: boolean // convenience for flamegraph color; derivable from status
  bytesUploaded?: number // remote-cache push size; null if no remote layer
  bytesDownloaded?: number // remote-cache pull size on hit
}

export interface CacheStats {
  entryCount: number
  totalBytes: number
  runCountLast24h: number
  hitCountLast24h: number
}

export interface PruneOptions {
  /** Drop entries last accessed before this ms-epoch threshold. */
  olderThanMs?: number
  /**
   * After applying olderThanMs, if the cache still exceeds this size in
   * bytes, evict LRU (smallest `accessed_at` first) until under it.
   */
  maxBytes?: number
}

export interface PruneResult {
  evicted: number
  bytesFreed: number
}

/**
 * The shape every cache implementation honors. `Cache` (the local v10
 * implementation) and `LayeredCache` both `implements` this so the
 * orchestrator's `executeTask` can take either without a discriminated
 * union and we get a compile-time guarantee the surfaces stay congruent.
 */
export interface CacheLayer {
  key(input: CacheKeyInput): Promise<string>
  get(hash: string): Promise<CacheEntry | null>
  restoreOutputs(hash: string, projectDir: string): Promise<void>
  save(args: {
    hash: string
    entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles'>
    projectDir: string
    outputFiles: string[]
  }): Promise<void>
  recordRun(run: RunRecord): void
  stats(): CacheStats
  prune(options: PruneOptions): Promise<PruneResult>
  close(): void
}

export type SaveArgs = Parameters<CacheLayer['save']>[0]

interface EntryRow {
  hash: string
  project: string
  task: string
  command: string
  exit_code: number
  duration_ms: number
  size_bytes: number
  created_at: number
  accessed_at: number
}

export class Cache implements CacheLayer {
  private readonly db: Database
  private readonly insertEntry: ReturnType<Database['prepare']>
  private readonly selectEntry: ReturnType<Database['prepare']>
  private readonly bumpAccessed: ReturnType<Database['prepare']>
  private readonly insertRun: ReturnType<Database['prepare']>

  constructor(private readonly cacheDir: string) {
    // Ensure the directory exists before opening the DB — bun:sqlite
    // won't create parent dirs for us. The constructor stays sync
    // because callers use `new Cache(...)` directly; `mkdirSync` keeps
    // that property without a subprocess fork.
    mkdirSync(cacheDir, { recursive: true })
    this.db = new Database(path.join(cacheDir, 'cache.db'), { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    // busy_timeout makes concurrent writers wait for the lock instead of
    // failing immediately with SQLITE_BUSY. Two parallel `vx run`
    // invocations in CI is a normal pattern; without this the second one
    // crashes in recordRun().
    this.db.exec('PRAGMA busy_timeout = 5000')

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        hash         TEXT PRIMARY KEY,
        project      TEXT NOT NULL,
        task         TEXT NOT NULL,
        command      TEXT NOT NULL,
        exit_code    INTEGER NOT NULL,
        duration_ms  INTEGER NOT NULL,
        size_bytes   INTEGER NOT NULL,
        created_at   INTEGER NOT NULL,
        accessed_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        hash                TEXT NOT NULL,
        project             TEXT NOT NULL,
        task                TEXT NOT NULL,
        status              TEXT NOT NULL,
        exit_code           INTEGER NOT NULL,
        duration_ms         INTEGER NOT NULL,
        forward_args        TEXT,
        started_at          INTEGER NOT NULL,
        ended_at            INTEGER NOT NULL,
        -- v11 analytics columns. Nullable until the runner / orchestrator
        -- PRs populate them. Storing them now means we can swap on the
        -- producer side without touching the schema again.
        run_id              TEXT,
        cpu_ms              INTEGER,
        peak_rss_bytes      INTEGER,
        wallclock_start_ns  INTEGER,
        wallclock_end_ns    INTEGER,
        cache_hit           INTEGER,
        bytes_uploaded      INTEGER,
        bytes_downloaded    INTEGER
      );
      CREATE INDEX IF NOT EXISTS runs_hash       ON runs(hash);
      CREATE INDEX IF NOT EXISTS runs_started_at ON runs(started_at);
      CREATE INDEX IF NOT EXISTS runs_project    ON runs(project, task);
      CREATE INDEX IF NOT EXISTS runs_run_id     ON runs(run_id);
    `)

    const meta = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
      | { value: string }
      | undefined
    if (!meta) {
      this.db
        .prepare("INSERT INTO schema_meta(key, value) VALUES ('version', ?)")
        .run(SCHEMA_VERSION)
    } else if (meta.value !== SCHEMA_VERSION) {
      // Pre-alpha: schema mismatch means rebuild. Nuke entries + runs.
      // Outputs on disk become orphans; they'll be ignored on next miss.
      this.db.exec('DELETE FROM entries; DELETE FROM runs;')
      this.db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(SCHEMA_VERSION)
    }

    this.insertEntry = this.db.prepare(`
      INSERT INTO entries(hash, project, task, command, exit_code, duration_ms, size_bytes, created_at, accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        project      = excluded.project,
        task         = excluded.task,
        command      = excluded.command,
        exit_code    = excluded.exit_code,
        duration_ms  = excluded.duration_ms,
        size_bytes   = excluded.size_bytes,
        accessed_at  = excluded.accessed_at
    `)
    this.selectEntry = this.db.prepare('SELECT * FROM entries WHERE hash = ?')
    this.bumpAccessed = this.db.prepare('UPDATE entries SET accessed_at = ? WHERE hash = ?')
    this.insertRun = this.db.prepare(`
      INSERT INTO runs(
        hash, project, task, status, exit_code, duration_ms, forward_args,
        started_at, ended_at,
        run_id, cpu_ms, peak_rss_bytes, wallclock_start_ns, wallclock_end_ns,
        cache_hit, bytes_uploaded, bytes_downloaded
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,  ?, ?, ?, ?, ?,  ?, ?, ?)
    `)
  }

  async key(input: CacheKeyInput): Promise<string> {
    const h = new Bun.CryptoHasher('sha256')
    h.update(`${CACHE_VERSION}\n`)
    h.update(`task:${input.taskId}\n`)
    h.update(`workspace:${input.workspaceFingerprint}\n`)
    h.update(`pkg:${input.projectPackageJsonHash}\n`)
    h.update(`config:${input.taskConfigHash}\n`)

    const forwarded = input.forwardArgs ?? []
    h.update(`forward-args:${forwarded.length}\n`)
    for (const a of forwarded) h.update(`${a}\0`)

    h.update(`env-values:${input.envValues.length}\n`)
    for (const [n, v] of input.envValues) h.update(`${n}=${v}\n`)

    const upstream = [...input.upstreamHashes].sort()
    h.update(`upstream:${upstream.length}\n`)
    for (const u of upstream) h.update(`${u}\n`)

    const sortedInputs = [...input.inputFiles].sort()
    h.update(`inputs:${sortedInputs.length}\n`)
    for (const file of sortedInputs) {
      const rel = relPosix(input.workspaceRoot, file)
      const fileHash = await hashFile(file)
      h.update(`${rel}\0${fileHash}\n`)
    }

    return h.digest('hex')
  }

  async get(hash: string): Promise<CacheEntry | null> {
    const row = this.selectEntry.get(hash) as EntryRow | undefined
    if (!row) return null

    // Verify the on-disk artifact actually exists. The DB and the
    // filesystem can drift if someone manually deletes a <hash>/ dir.
    // existsSync is required here: `Bun.file(dir).exists()` returns
    // false for directories — Bun.file is a file-only API.
    if (!existsSync(this.entryDir(hash))) return null

    this.bumpAccessed.run(Date.now(), hash)

    const stdout = await readMaybe(this.logPath(hash, 'stdout'))
    const stderr = await readMaybe(this.logPath(hash, 'stderr'))
    const outputFiles = existsSync(this.outputsDir(hash))
      ? await listRelativeFiles(this.outputsDir(hash))
      : []

    return {
      hash: row.hash,
      taskId: `${row.project}#${row.task}`,
      command: row.command,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
      outputFiles,
      stdout,
      stderr,
      storedAt: new Date(row.created_at).toISOString(),
      source: 'local',
    }
  }

  async restoreOutputs(hash: string, projectDir: string): Promise<void> {
    const src = this.outputsDir(hash)
    // Same caveat as above: src is a directory; use existsSync.
    if (!existsSync(src)) return
    await copyDir(src, projectDir)
  }

  async save(args: {
    hash: string
    entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles'>
    projectDir: string
    outputFiles: string[]
  }): Promise<void> {
    // Layout (v13):
    //   <hash>/
    //   ├── stdout                ← captured stdout
    //   ├── stderr                ← captured stderr
    //   └── outputs/<rel paths>   ← files restoreOutputs() copies back
    // Stage everything under a sibling tmp dir; rename atomically so
    // a concurrent reader sees either no entry or a complete one.
    const dir = this.entryDir(args.hash)
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`
    await rm(tmp, { recursive: true, force: true })
    await mkdir(tmp, { recursive: true })

    let totalBytes = 0
    const relOutputs: string[] = []
    const tmpOutputs = path.join(tmp, 'outputs')
    for (const f of args.outputFiles) {
      const rel = path.relative(args.projectDir, f)
      const dest = path.join(tmpOutputs, rel)
      // Bun.write auto-creates parent dirs.
      await Bun.write(dest, Bun.file(f))
      const s = await stat(dest)
      totalBytes += s.size
      relOutputs.push(rel.split(path.sep).join('/'))
    }

    await Bun.write(path.join(tmp, 'stdout'), args.entry.stdout)
    await Bun.write(path.join(tmp, 'stderr'), args.entry.stderr)
    totalBytes += Buffer.byteLength(args.entry.stdout) + Buffer.byteLength(args.entry.stderr)

    await rm(dir, { recursive: true, force: true })
    await rename(tmp, dir)

    const [project, task] = splitTaskId(args.entry.taskId)
    const now = Date.now()
    this.insertEntry.run(
      args.hash,
      project,
      task,
      args.entry.command,
      args.entry.exitCode,
      args.entry.durationMs,
      totalBytes,
      now,
      now,
    )
  }

  recordRun(run: RunRecord): void {
    this.insertRun.run(
      run.hash,
      run.project,
      run.task,
      run.status,
      run.exitCode,
      run.durationMs,
      run.forwardArgs ? JSON.stringify(run.forwardArgs) : null,
      run.startedAt,
      run.endedAt,
      run.runId ?? null,
      run.cpuMs ?? null,
      run.peakRssBytes ?? null,
      run.wallclockStartNs !== undefined ? run.wallclockStartNs : null,
      run.wallclockEndNs !== undefined ? run.wallclockEndNs : null,
      run.cacheHit === undefined ? null : run.cacheHit ? 1 : 0,
      run.bytesUploaded ?? null,
      run.bytesDownloaded ?? null,
    )
  }

  stats(): CacheStats {
    const aggregate = this.db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM entries')
      .get() as { n: number; bytes: number }
    const since = Date.now() - 24 * 60 * 60 * 1000
    const runs = this.db
      .prepare(
        "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'cache-hit' THEN 1 ELSE 0 END), 0) AS hits FROM runs WHERE started_at >= ?",
      )
      .get(since) as { total: number; hits: number }
    return {
      entryCount: aggregate.n,
      totalBytes: aggregate.bytes,
      runCountLast24h: runs.total,
      hitCountLast24h: runs.hits,
    }
  }

  async prune(options: PruneOptions): Promise<PruneResult> {
    const { olderThanMs, maxBytes } = options
    if (olderThanMs === undefined && maxBytes === undefined) {
      throw new Error('prune: pass at least one of `olderThanMs` or `maxBytes`')
    }

    const victims = new Set<string>()
    let bytesFreed = 0

    if (olderThanMs !== undefined) {
      const rows = this.db
        .prepare('SELECT hash, size_bytes FROM entries WHERE accessed_at < ?')
        .all(olderThanMs) as Array<{ hash: string; size_bytes: number }>
      for (const r of rows) {
        victims.add(r.hash)
        bytesFreed += r.size_bytes
      }
    }

    if (maxBytes !== undefined) {
      const totalRow = this.db
        .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM entries')
        .get() as { bytes: number }
      let remaining = totalRow.bytes - bytesFreed
      if (remaining > maxBytes) {
        const candidates = (
          victims.size === 0
            ? (this.db
                .prepare('SELECT hash, size_bytes FROM entries ORDER BY accessed_at ASC')
                .all() as Array<{ hash: string; size_bytes: number }>)
            : (this.db
                .prepare(
                  `SELECT hash, size_bytes FROM entries WHERE hash NOT IN (${[...victims].map(() => '?').join(',')}) ORDER BY accessed_at ASC`,
                )
                .all(...[...victims]) as Array<{ hash: string; size_bytes: number }>)
        ) satisfies Array<{ hash: string; size_bytes: number }>
        for (const row of candidates) {
          if (remaining <= maxBytes) break
          victims.add(row.hash)
          bytesFreed += row.size_bytes
          remaining -= row.size_bytes
        }
      }
    }

    // Perform the deletions: DB row + on-disk dir (logs live inside).
    const deleteEntry = this.db.prepare('DELETE FROM entries WHERE hash = ?')
    for (const hash of victims) {
      deleteEntry.run(hash)
      await rm(this.entryDir(hash), { recursive: true, force: true })
    }

    return { evicted: victims.size, bytesFreed }
  }

  close(): void {
    this.db.close()
  }

  private entryDir(hash: string): string {
    return path.join(this.cacheDir, hash)
  }

  private outputsDir(hash: string): string {
    return path.join(this.cacheDir, hash, 'outputs')
  }

  private logPath(hash: string, stream: 'stdout' | 'stderr'): string {
    return path.join(this.cacheDir, hash, stream)
  }
}

function splitTaskId(id: string): [string, string] {
  const i = id.indexOf('#')
  if (i < 0) return [id, '']
  return [id.slice(0, i), id.slice(i + 1)]
}

async function readMaybe(p: string): Promise<string> {
  const f = Bun.file(p)
  if (!(await f.exists())) return ''
  return await f.text()
}

async function listRelativeFiles(root: string, sub = ''): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(path.join(root, sub), { withFileTypes: true })
  for (const e of entries) {
    const childRel = sub === '' ? e.name : `${sub}/${e.name}`
    if (e.isDirectory()) {
      out.push(...(await listRelativeFiles(root, childRel)))
    } else if (e.isFile()) {
      out.push(childRel)
    }
  }
  return out.sort()
}

async function hashFile(filePath: string): Promise<string> {
  const h = new Bun.CryptoHasher('sha256')
  // Bun.file(...).stream() yields Uint8Array chunks lazily — no
  // whole-file load into memory even for large artifacts. Async-iterable.
  for await (const chunk of Bun.file(filePath).stream()) h.update(chunk)
  return h.digest('hex')
}

async function copyDir(src: string, dest: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true })
  await mkdir(dest, { recursive: true })
  for (const e of entries) {
    const s = path.join(src, e.name)
    const d = path.join(dest, e.name)
    if (e.isDirectory()) {
      await copyDir(s, d)
    } else if (e.isFile()) {
      await Bun.write(d, Bun.file(s))
    }
  }
}
