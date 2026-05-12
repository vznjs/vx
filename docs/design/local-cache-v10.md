# Local cache v10 — SQLite metadata + on-disk outputs

> **Status:** accepted. Implementation lands in the same PR as this doc.

## What we're solving

The v9 local cache stores everything under `.vx/cache/<hash>/`:

```
.vx/cache/<hash>/
├── meta.json    # taskId, command, exitCode, durationMs, outputFiles, stdout, stderr, storedAt
└── outputs/
    └── <project-relative paths>
```

That works but has rough edges as the cache grows:

- **No index.** Listing entries means reading the directory. Sizes,
  ages, project/task associations require parsing every `meta.json`.
- **No eviction.** Old entries pile up. "Delete older than N days" is
  doable with `find` but inefficient; "evict LRU until under X MB" is
  inefficient without summing sizes from disk.
- **No run history.** We can't answer "what's my cache hit rate" or
  "which tasks ran in the last hour and how long did they take?"
- **Metadata reads are stat-storms.** Each existence check is a stat of
  `.vx/cache/<hash>/meta.json`. At thousands of entries × multiple
  tasks per run, this adds up.

v10 inverts the model: **SQLite holds the metadata index, outputs stay
as files on disk.** Same model NX adopted (verified empirically — see
research session notes).

## Layout

```
.vx/
└── cache/
    ├── cache.db                 # SQLite (with cache.db-wal, cache.db-shm)
    ├── cache.db.lock            # cross-process flock file
    ├── <hash>/                   # output files at project-relative paths
    │   └── dist/index.js
    │   └── ...
    └── logs/
        └── <hash>                # captured stdout+stderr (combined, single text file)
```

Why this shape:

- **Outputs as files** because restore copies them back into the
  project dir — the destination is a real filesystem either way. BLOBs
  in SQLite would just be a detour.
- **Single combined log per hash** matches NX + Turbo convention.
  Splitting stdout/stderr requires per-line markers; not worth the
  complexity for what's effectively replay-to-terminal.
- **SQLite for metadata only** because that's what the access pattern
  needs: indexed by-hash lookup, size aggregation, run history.

## Schema

```sql
CREATE TABLE entries (
  hash         TEXT PRIMARY KEY,
  project      TEXT NOT NULL,
  task         TEXT NOT NULL,
  command      TEXT NOT NULL,
  exit_code    INTEGER NOT NULL,
  duration_ms  INTEGER NOT NULL,
  size_bytes   INTEGER NOT NULL,        -- total bytes under <hash>/ + logs/<hash>
  created_at   INTEGER NOT NULL,         -- ms since epoch
  accessed_at  INTEGER NOT NULL          -- ms since epoch, bumped on cache.get
);

CREATE TABLE runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  hash           TEXT NOT NULL,
  project        TEXT NOT NULL,
  task           TEXT NOT NULL,
  status         TEXT NOT NULL,          -- 'success' | 'failed' | 'cache-hit' | 'skipped'
  exit_code      INTEGER NOT NULL,
  duration_ms    INTEGER NOT NULL,
  forward_args   TEXT,                   -- JSON, nullable
  started_at     INTEGER NOT NULL,       -- ms since epoch
  ended_at       INTEGER NOT NULL
);

CREATE INDEX runs_hash       ON runs(hash);
CREATE INDEX runs_started_at ON runs(started_at);
CREATE INDEX runs_project    ON runs(project, task);

CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- INSERT INTO schema_meta (key, value) VALUES ('version', 'v10');
```

Why two tables:

- **`entries`** is the cache index: one row per cached output. Drives
  HEAD checks, restore, and eviction.
- **`runs`** is the run history: one row per task execution (hit or
  miss). Drives stats and debugging. Independent of cache state — we
  log even cache-hits and failures.
- **`schema_meta`** carries the schema version. Bumped when the schema
  changes; we nuke + recreate on mismatch (pre-alpha).

## Concurrency

- `PRAGMA journal_mode = WAL` + `PRAGMA synchronous = NORMAL` — same as
  NX. WAL allows concurrent readers + one writer without conflicts.
- Cross-process exclusive lock via `flock(cache.db.lock)` from
  `bun:lock` or Node's `fs.openSync` + `flock` syscall (Bun supports
  `bun:lock` style? — fall back to writing a sentinel file).
- Output-file writes use the existing tmpdir + atomic rename pattern.
  Same as v9, no change.
- Multiple `vx run` invocations on the same host race for the same
  hash via OS file-rename atomicity. WAL handles the SQLite side.

## Atomic write protocol

For a cache miss → write sequence:

1. Materialize outputs into `.vx/cache/<hash>.tmp.<pid>/` (mirroring
   project-relative paths).
2. Write combined stdout+stderr to `.vx/cache/logs/<hash>.tmp.<pid>`.
3. Compute `size_bytes` (sum of all files written).
4. `rename(2)` `<hash>.tmp.<pid>/` → `<hash>/` (atomic for empty
   target; if target exists, our entry was already written by another
   process — discard).
5. `rename(2)` `logs/<hash>.tmp.<pid>` → `logs/<hash>`.
6. SQL `INSERT INTO entries ... ON CONFLICT(hash) DO UPDATE SET
accessed_at = excluded.accessed_at` (idempotent on second-writer).
7. SQL `INSERT INTO runs` (always, even on cache hits — but for hits
   the materialize step is skipped).

If step 4 fails because the dir already exists, we treat it as
"another process won the race" — clean up our tmp dir, proceed as if
the entry is ours. The SQLite upsert handles the index.

## API: `LocalCacheV10`

Replaces the current `Cache` class in `src/cache.ts`. Same public
methods, plus stats accessors:

```ts
class LocalCacheV10 {
  constructor(cacheDir: string)

  // Existing surface (matches v9):
  key(input: CacheKeyInput): Promise<string>
  get(hash: string): Promise<CacheEntry | null>
  restoreOutputs(hash: string, projectDir: string): Promise<void>
  save(args: SaveArgs): Promise<void>

  // New:
  recordRun(args: RunRecord): Promise<void> // called by orchestrator after each task
  stats(): CacheStats // for `vx stats` (future)
  prune(options: PruneOptions): Promise<number> // for `vx cache prune` (future)
  close(): void // db handle cleanup
}
```

`CacheEntry` keeps the same shape externally (the orchestrator already
consumes it). Internally we hydrate it from the entries row + read the
log file as needed.

## Migration

- Bump `CACHE_VERSION` from `vx-cache-v9` to `vx-cache-v10` in
  `src/cache.ts`. All existing entries become unreachable (different
  hashes). Tasks rebuild on next run.
- No data migration code. Pre-alpha.
- Old `.vx/cache/<hash>/meta.json` files are simply orphaned; they'll
  never be read. A future `vx cache clean` will sweep them. Until
  then, they cost a few KB each — negligible.

## What's out of scope (this PR)

- **`vx stats` CLI command.** The data is captured; the command can
  ship in a follow-up.
- **`vx cache prune` CLI command.** Same — the `prune()` method
  exists, no command yet.
- **LRU eviction on write.** We capture `size_bytes` but don't
  auto-evict yet. Eviction policy needs explicit user-facing controls
  (max size? max age? both?). Defer until use cases force it.
- **Remote cache integration.** Layered with v10 via `LayeredCache` —
  but that's a separate workstream.
- **Concurrent `vx run` invocations from multiple machines on the same
  filesystem.** WAL is per-host; cross-host concurrency is the remote
  cache's job.

## Why this is the right move

- **Solves real ergonomic gaps.** Eviction, stats, run history were
  all out of reach with the v9 manifest. The DB makes them trivial.
- **Single new dep, native to Bun.** `bun:sqlite` is built-in; no
  install-time compilation, no platform-specific binaries to ship.
- **Same restore performance.** Output files stay on disk; restore is
  still a copy. The win is on metadata-side queries.
- **Matches an industry pattern.** NX shipped this in Nx 19+ for the
  same reasons; we verified the model empirically.
- **Backwards-compatible API.** Orchestrator code that calls
  `cache.get(hash)` / `cache.save(...)` doesn't change. The internals
  are entirely behind the existing `Cache` interface.

## Implementation order

1. Add `bun:sqlite` usage in a new `LocalCacheV10` class (don't
   replace `Cache` yet — write side by side).
2. Wire schema creation + WAL setup + lock file.
3. Implement `key()` (unchanged from v9).
4. Implement `save()` writing both filesystem and DB.
5. Implement `get()` + `restoreOutputs()` reading from DB + filesystem.
6. Implement `recordRun()` for run history.
7. Swap the orchestrator's import: `Cache` → `LocalCacheV10`.
8. Delete the old `Cache` class.
9. Rename `LocalCacheV10` → `Cache` (public name stays).
10. Tests: bump fixtures, add SQLite-specific tests, verify existing
    e2e tests still pass under the new storage.
11. Update `docs/caching.md` and `docs/modules/cache.md`.
12. Bump `CACHE_VERSION` to `vx-cache-v10`.
