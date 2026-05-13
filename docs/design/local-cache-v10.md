# Local cache — v10 → v13

> **Status:** v13 shipped. This doc covers the design history from v10
> (the move to SQLite + on-disk outputs) through v13 (the current
> unified per-entry layout). Each version's rationale is preserved so
> later contributors can see _why_ the layout looks the way it does.

## TL;DR — what the cache looks like today (v13)

```
<cacheDir>/                         (default: <workspaceRoot>/.vx/cache)
├── cache.db                        SQLite metadata + run history
├── cache.db-wal                    write-ahead log
├── cache.db-shm                    shared memory
└── <hash>/                         one directory per cache entry
    ├── stdout                      captured stdout (text)
    ├── stderr                      captured stderr (text)
    └── outputs/                    declared output files, project-relative
        └── dist/index.js
        └── ...
```

One entry is one directory. Eviction is `rm -rf <hash>/`. Concurrent
readers and writers coordinate via SQLite's WAL plus atomic
`rename(2)` of the per-entry temp dir. Outputs stay as files (not
BLOBs) because cache-hit restore is a recursive file copy into the
project anyway.

See [`docs/caching.md`](../caching.md) for user-facing reference and
[`docs/modules/cache.md`](../modules/cache.md) for the module-level
contract.

## Why SQLite + on-disk outputs (v10)

The pre-v10 cache stored everything under `<hash>/`:

```
<cacheDir>/<hash>/
├── meta.json        # taskId, command, exitCode, durationMs, outputFiles, stdout, stderr
└── outputs/
    └── <project-relative paths>
```

Rough edges as the cache grew:

- **No index.** Listing entries meant reading the directory. Sizes,
  ages, project/task associations required parsing every `meta.json`.
- **No eviction.** Old entries piled up. "Delete older than N days" was
  doable with `find` but inefficient; "evict LRU until under X MB"
  required summing sizes from disk.
- **No run history.** Couldn't answer "what's my cache hit rate" or
  "which tasks ran in the last hour and how long did they take?"
- **Metadata reads are stat-storms.** Each existence check stats
  `<hash>/meta.json`. At thousands of entries × multiple tasks per
  run, this added up.

**v10 inverts the model:** SQLite holds the metadata index; outputs
stay as files on disk. Same model Nx adopted in their 19.x line for
the same reasons.

```sql
CREATE TABLE entries (
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

CREATE TABLE runs (...);
CREATE TABLE schema_meta (...);
```

Why these tables:

- **`entries`** is the cache index: one row per cached output. Drives
  HEAD checks, restore, and eviction.
- **`runs`** is the run history: one row per task execution (hit or
  miss, success or failure). Drives stats and debugging.
- **`schema_meta`** carries the schema version. Bumped when the schema
  changes; we nuke + recreate on mismatch (pre-alpha).

Concurrency:

- `PRAGMA journal_mode = WAL` + `PRAGMA synchronous = NORMAL` — WAL
  allows concurrent readers + one writer without conflicts.
- `PRAGMA busy_timeout = 5000` — concurrent `vx run` invocations
  queue instead of failing with `SQLITE_BUSY`.

## v10 → v11: analytics columns

Adds nullable analytics columns to the `runs` table without changing
existing semantics:

| Column               | Source                                      |
| -------------------- | ------------------------------------------- |
| `run_id`             | ULID stamped by orchestrator per invocation |
| `cpu_ms`             | `Bun.spawn().resourceUsage().cpuTime` total |
| `peak_rss_bytes`     | `resourceUsage().maxRSS * 1024`             |
| `wallclock_start_ns` | `hrtime.bigint()` relative to run t=0       |
| `wallclock_end_ns`   | same                                        |
| `cache_hit`          | convenience boolean (derivable from status) |
| `bytes_uploaded`     | remote-cache push size (`LayeredCache`)     |
| `bytes_downloaded`   | remote-cache pull size on hit               |

Why nullable: old rows shouldn't disappear, and the runner / remote
layer populates these progressively. Querying with `WHERE cpu_ms IS
NULL` shows you the rows from before the column landed.

Use cases unlocked:

- `--profile` Chrome-trace JSON (hrtime spans).
- `--summarize` per-run JSON (every analytics field).
- Direct `sqlite3 cache.db` queries for slow-task ranking, hit-rate
  graphs, CI dashboards.

## v11 → v12: project package.json folded in

Pre-v12, the cache key incorporated the workspace fingerprint
(lockfile + workspace yaml) and each input file's contents. It did
NOT incorporate the project's `package.json` bytes directly. A
narrow `cache.inputs.files: ['src/**']` would miss:

- A new `dependencies` entry that's already in the lockfile (the
  lockfile changes, so the workspace fingerprint covers it).
- A `scripts.build` rewrite that doesn't affect anything in `src/`.
- A `version` bump.

**v12 folds `sha256(<projectDir>/package.json)`** into every task's
cache key as a separate `projectPackageJsonHash` field on
`CacheKeyInput`. Matches Turbo / Nx's "implicit dependencies"
behaviour. One-line addition in `cache.ts:key()` + a
`hashProjectPackageJson` helper in `orchestrator/execute-task.ts`.

## v12 → v13: unified per-entry layout

v12's on-disk layout still had a sibling `logs/` tree:

```
<cacheDir>/
├── cache.db
├── <hash>/                # outputs, mixed with metadata
│   └── dist/...
└── logs/
    ├── <hash>.stdout
    └── <hash>.stderr
```

Two operational annoyances:

- **Eviction was multi-step.** `rm <hash>/` + `rm logs/<hash>.stdout`
  - `rm logs/<hash>.stderr`. Easy to miss one branch.
- **Outputs and metadata were intermingled.** `<hash>/dist/...` mixes
  user-controlled paths with our internal layout. If a future cache
  version added a per-entry metadata file under `<hash>/`, namespace
  collision would be a real concern (user output named `meta.json` →
  collision).

**v13 moves to one-directory-per-entry, fully namespaced:**

```
<cacheDir>/<hash>/
├── stdout
├── stderr
└── outputs/<rel paths>
```

Eviction: `rm -rf <hash>/`. Future per-entry metadata: `<hash>/<file>`
adds cleanly without colliding with user output paths.

The runner-side `<cacheDir>/logs/<run_id>/<project>__<task>.{stdout,
stderr}` dump from earlier versions was deleted in the same change.
Reasoning: successful runs already capture stdout/stderr per cache
entry; failures stream live AND surface on `TaskOutcome.stderr`; CI
captures parent stdout natively; structured per-task metadata lives
in the `runs` SQLite table. The sibling dump was pure redundancy.

## What's NOT in here (yet)

- **HMAC integrity check on cache entries.** A corrupted disk could
  return wrong bytes; we trust the filesystem.
- **Compression.** Typical `dist/` is ~1–10 MB per entry; compressing
  on disk costs more than it saves locally. The remote-cache layer
  uses tar.gz for transport.
- **Symlink-aware traversal.** Bun globs the real tree.
- **LRU eviction during a `vx run`.** Capture is there
  (`size_bytes`, `accessed_at`); auto-evict isn't. `vx cache prune
--max-size <X>` is user-driven.

## Concurrent `vx run` invocations on the same filesystem

WAL handles the SQLite side. Output writes use the existing tmpdir +
atomic rename pattern (`<hash>.tmp-<pid>-<ms>/` → `<hash>/`). If two
processes race on the same hash, both can write the temp dir; the
first to rename wins; the second's rename fails on `EEXIST` and we
treat the entry as "already written" and proceed. The SQLite upsert
is idempotent.

Concurrent invocations across hosts on the same shared filesystem
work but the WAL guarantee is per-host. Cross-host coordination is
the remote cache's job — that's the workstream covered by
[`design/remote-cache.md`](./remote-cache.md).

## When to bump CACHE_VERSION

See [`docs/caching.md` § Bumping CACHE_VERSION](../caching.md#bumping-cache_version).

Bumps to date:

- v9 → v10 (PR #7): SQLite metadata + on-disk outputs introduced.
- v10 → v11 (PR #19): analytics columns added (nullable, backwards-
  compatible for reads).
- v11 → v12 (PR #42): project package.json hash folded in.
- v12 → v13 (PR #65): unified per-entry layout; run-logs sibling tree
  removed.

The version is the constant `CACHE_VERSION` in `src/cache/cache.ts`.
Bumping orphans every previously-stored entry. Pre-alpha tolerates
this freely.
