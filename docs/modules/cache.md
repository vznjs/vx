# `cache.ts` — content-addressed task cache

## Purpose

Compute cache keys, store cache entries, retrieve them, restore output
files on hit, record run history. The on-disk format, SQLite schema,
and key derivation logic live here.

## Public surface

```ts
/**
 * Shape every cache implementation honors. Both Cache (local v10) and
 * LayeredCache (local + remote) implement it. Orchestrator uses
 * CacheLayer so callers don't need a discriminated union.
 */
export interface CacheLayer {
  key(input: CacheKeyInput): Promise<string>
  get(hash: string): Promise<CacheEntry | null>
  restoreOutputs(hash: string, projectDir: string): Promise<void>
  save(args: SaveArgs): Promise<void>
  recordRun(run: RunRecord): void
  stats(): CacheStats
  prune(options: PruneOptions): Promise<PruneResult>
  close(): void
}

export type SaveArgs = {
  hash: string
  entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles'>
  projectDir: string
  outputFiles: string[] // absolute paths
}

export class Cache implements CacheLayer {
  constructor(cacheDir: string)
  // ... CacheLayer methods
}

export interface PruneOptions {
  olderThanMs?: number // ms-epoch cutoff; entries with accessed_at < this are evicted
  maxBytes?: number // after age pruning, evict LRU until total <= maxBytes
}

export interface PruneResult {
  evicted: number
  bytesFreed: number
}

export interface CacheKeyInput {
  taskId: string
  taskConfigHash: string
  envValues: Array<[name: string, value: string]>
  inputFiles: string[]
  workspaceRoot: string
  upstreamHashes: string[]
  workspaceFingerprint: string
  forwardArgs?: readonly string[] // CLI args after `--`
}

export interface CacheEntry {
  hash: string
  taskId: string
  command: string // exec.command verbatim
  exitCode: number
  durationMs: number
  outputFiles: string[] // project-relative POSIX paths
  stdout: string
  stderr: string
  storedAt: string // ISO timestamp
}

export interface RunRecord {
  hash: string
  project: string
  task: string
  status: 'success' | 'failed' | 'cache-hit' | 'skipped'
  exitCode: number
  durationMs: number
  forwardArgs?: readonly string[]
  startedAt: number // ms since epoch
  endedAt: number // ms since epoch
}

export interface CacheStats {
  entryCount: number
  totalBytes: number
  runCountLast24h: number
  hitCountLast24h: number
}
```

## Key derivation (`Cache.key`)

The key is a sha256 hex digest, computed by feeding values to the hash
in this exact order:

```
<CACHE_VERSION>\n
task:<taskId>\n
workspace:<workspaceFingerprint>\n
config:<taskConfigHash>\n
forward-args:<n>\n
  <arg>\0 (n times, in caller order)
env-values:<n>\n
  <name>=<value>\n (n times, in supplied order — caller pre-sorts)
upstream:<n>\n
  <hash>\n (n times, after we sort)
inputs:<n>\n
  <relPath>\0<fileHash>\n (n times, after we sort inputFiles)
```

`<fileHash>` is sha256 of the file contents. `<relPath>` is the POSIX-
relative path from `workspaceRoot` (so cache keys are stable across
platforms).

Determinism notes:

- The caller is responsible for canonicalizing `envValues` and
  `inputFiles` ordering (`inputs.ts` sorts both).
- `upstreamHashes` is sorted inside `key()` so caller order doesn't
  matter.
- `taskConfigHash` is the caller's responsibility (computed by
  `orchestrator.hashTaskConfig`).
- `forwardArgs` order matters (it's the literal CLI argv slice).

## Storage layout

```
<cacheDir>/
├── cache.db                 # SQLite (with cache.db-wal, cache.db-shm)
├── <hash>/                  # output files at project-relative paths
│   └── dist/...
└── logs/
    ├── <hash>.stdout        # captured stdout
    └── <hash>.stderr        # captured stderr
```

SQLite stores metadata only:

- **`entries`** — one row per cached output:
  `(hash, project, task, command, exit_code, duration_ms, size_bytes, created_at, accessed_at)`.
- **`runs`** — one row per task execution (hit or miss):
  `(id, hash, project, task, status, exit_code, duration_ms, forward_args, started_at, ended_at)`.
- **`schema_meta`** — schema version sentinel. Mismatch → drop the
  tables and recreate (pre-alpha; no migration code).

WAL mode is on (`PRAGMA journal_mode = WAL`) for non-blocking readers
during writes.

Output files stay as files on disk because cache-hit restore copies
them back into the project. stdout and stderr are stored as separate
text files to preserve stream identity on replay.

## Atomic writes

`save()`:

1. Materializes outputs into a temp dir `<cacheDir>/<hash>.tmp-<pid>-<ms>/`.
2. `rename(2)` to `<cacheDir>/<hash>/`. Atomic for empty target.
3. Writes `<cacheDir>/logs/<hash>.stdout` and `.stderr`.
4. Upserts the `entries` row (`ON CONFLICT(hash) DO UPDATE …`).

Reads via `get()` are non-blocking thanks to WAL.

## Restore semantics

`restoreOutputs(hash, projectDir)`:

- If `<cacheDir>/<hash>/` doesn't exist, no-op.
- Otherwise recursively copies into `projectDir`, creating parent
  directories as needed.
- Pre-existing local files at output paths are **overwritten**.

`get(hash)`:

- One indexed SELECT against `entries`.
- Verifies `<cacheDir>/<hash>/` exists on disk; returns `null` if the
  DB row is present but the artifact was deleted out from under us.
- Bumps `accessed_at` on hit (used for LRU eviction once implemented).
- Reads the log files and lists `<hash>/` files to reconstruct
  `outputFiles`. Doesn't restore them — the caller decides when to
  call `restoreOutputs`.

## Run history & stats

`recordRun()` appends one row to `runs` for every task — cache hits
and misses, successes and failures. `stats()` aggregates the last 24h
plus the entry table summary:

```ts
interface CacheStats {
  entryCount: number
  totalBytes: number
  runCountLast24h: number
  hitCountLast24h: number
}
```

A `vzn stats` CLI command can ship later; the data is captured today.

## What this does NOT do

- Doesn't compress entries. `dist/` of typical projects is ~1–10MB
  per entry; uncompressed is fine for local cache. Remote cache should
  add tar+zstd at the wire.
- Doesn't garbage-collect old entries automatically. Tracked size +
  LRU access timestamps support eviction; the policy and the
  `vzn cache prune` command haven't shipped yet.
- Doesn't verify entries are intact byte-for-byte. The file existence
  check is the only integrity gate.

## `CACHE_VERSION`

Currently `'vzn-cache-v10'`. Bump when:

- A new field is added to `CacheKeyInput`.
- The order or framing of existing key fields changes.
- The on-disk layout changes (file placement, log paths).
- The SQLite schema changes in a way that affects existing rows.

Bumping invalidates every previously-stored entry. Pre-alpha tolerates
this freely. See `.claude/skills/bump-cache-version/SKILL.md` for the
file checklist.

## Tests

`cache.test.ts` covers:

- `Cache.key` exhaustively (determinism, sensitivity to each input).
- v10 storage shape: SQLite DB exists, outputs at `<hash>/`,
  logs at `logs/<hash>.{stdout,stderr}`, no `meta.json`.
- `save → get → restoreOutputs` round-trip.
- `get()` returns null when DB row exists but on-disk artifact was
  deleted.
- `recordRun()` + `stats()` capture run counts and hit rate.

End-to-end cache write/read/restore is also covered by
`orchestrator.test.ts`.

## Replacing this module

Most likely replacement: **remote cache** (see
`docs/design/remote-cache.md`).

The contract is small: `key()` is pure given inputs; `get()`, `save()`,
`restoreOutputs()` are the three I/O methods. A remote implementation
would:

- Keep `key()` identical (cache keys must match across machines).
- Replace `get()` with an HTTP/S3 fetch + local materialization.
- Replace `save()` with a local write + async upload.
- Optionally layer local-then-remote in a wrapping `Cache`.

CACHE_VERSION versioning becomes the migration story across deployed
clients.
