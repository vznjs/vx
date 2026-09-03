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
  // workspaceRoot anchors the artifact's `workspace-outputs/` entries
  // (cache.outputs.workspaceFiles); omitted → only `outputs/` restores.
  restoreOutputs(hash: string, projectDir: string, workspaceRoot?: string): Promise<void>
  save(args: SaveArgs): Promise<string | null>
  recordRun(run: RunRecord): void
  recordRuns(runs: readonly RunRecord[]): void
  // (Tier 3) Records a whole `vx run` atomically: the per-task `runs`
  // rows + one `invocations` header row in ONE transaction. Replaces
  // the bare recordRuns call in the orchestrator's end-of-run path. The
  // input-fingerprint rows (entry_inputs) do NOT live here — they ride
  // the entry-save transaction (miss path only), so a warm run is free.
  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void
  stats(): CacheStats
  prune(options: PruneOptions): Promise<PruneResult>
  close(): void
}

export type SaveArgs = {
  hash: string
  entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles'>
  projectDir: string
  outputFiles: string[] // absolute paths
  workspaceOutputFiles?: string[] // absolute paths of outputs.workspaceFiles matches
  workspaceRoot?: string // required alongside workspaceOutputFiles
}

// Namespace discriminator for workspace outputs in the artifact and
// the output_files rows: project rows store the bare project-relative
// path; workspace rows store the full `workspace-outputs/<rel-to-root>`
// archive entry name.
export const WORKSPACE_OUTPUT_PREFIX = 'workspace-outputs/'

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
  projectPackageJsonHash: string // (v12) project's package.json bytes
  envValues: Array<[name: string, value: string]>
  runtimeValues?: Array<[command: string, output: string]> // (v23) cache.inputs.runtime; folded as a namespaced section
  workspaceRuntimeValues?: Array<[command: string, output: string]> // (v23) cache.inputs.workspaceRuntime; distinct namespace
  inputFiles: string[] // absolute paths (sorted by caller before pass)
  workspaceRoot: string
  upstreamHashes: string[]
  upstreamIds?: ReadonlyMap<string, string> // (Tier 3) hash → upstream task id, capture-NAMING only (not folded)
  workspaceFingerprint: string
  forwardArgs?: readonly string[] // CLI args after `--`
  fileHashes?: ReadonlyMap<string, string> // (v20) abs path → git blob OID; mapped paths skip hashFile
  // (Tier 3) Pure side-channel: when set, key() pushes each component
  // (kind,name,hash) it folds, at the same fold sites. Does NOT change
  // the digest — used (on a cache MISS only) to persist entry_inputs
  // for the input diff. The warm/hit path passes no captureInto.
  captureInto?: Array<{ kind: string; name: string; hash: string }>
}

// (Tier 3) One header row per `vx run` invocation — see the
// `invocations` table in docs/caching.md.
export interface InvocationRecord {
  runId: string
  command: string
  requestedTasks: string // JSON string[]
  cachePolicy: string // compact flags, e.g. 'lR,lW,rR,rW'
  concurrency: number
  flow: 'focused' | 'broad' | null
  startedAt: number
  endedAt: number
  totalDurationMs: number
  taskCount: number
  failedCount: number
  hitCount: number
  hitLocalCount: number
  hitRemoteCount: number
  exitOk: boolean
  commitSha: string | null
  branch: string | null
  dirty: boolean | null
  ci: boolean
  ciProvider: string | null
  host: string | null
  os: string | null
  arch: string | null
  vxVersion: string
  tags: string // JSON object {k:v}
}

// (Tier 3) One cache-key component row for `entry_inputs`, keyed by the
// cache-entry hash. Persisted inside the entry-save transaction (miss
// path only), via INSERT OR IGNORE.
export interface TaskInputRow {
  entryHash: string
  kind: string // file|env|runtime|ws-runtime|upstream|package|config|forward|workspace
  name: string
  hash: string
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
  source?: 'local' | 'remote' // (LayeredCache) which layer served the hit
}

export interface RunRecord {
  hash?: string // absent = no cache key derived (skipped / persistent); stored as ''
  project: string
  task: string
  status: 'success' | 'failed' | 'cache-hit' | 'cache-hit-remote' | 'skipped'
  exitCode: number
  durationMs: number
  forwardArgs?: readonly string[]
  startedAt: number // ms-epoch
  endedAt: number // ms-epoch
  // v11 analytics columns (all optional; populated by runner / orchestrator)
  runId?: string // ULID shared across all tasks in one `vx run`
  cpuMs?: number // user + system CPU time from Bun.spawn rusage
  peakRssBytes?: number // peak resident set size
  wallclockStartNs?: bigint // hrtime span relative to run t=0
  wallclockEndNs?: bigint
  cacheHit?: boolean // convenience for flamegraph color
  attempts?: number // >1 when the task retried (the within-run flaky signal)
}

export interface CacheStats {
  entryCount: number
  totalBytes: number
  runCountLast24h: number
  hitCountLast24h: number
  /** Hits with a local executed-success baseline — the subset time saved can
   *  be estimated from. Always <= hitCountLast24h. */
  attributedHitsLast24h: number
}
```

## Key derivation (`Cache.key`)

The key is a 16-hex-char xxHash3 digest (SHA-256 until `CACHE_VERSION`
v15), computed by feeding values to the hash in this exact order:

```
<CACHE_VERSION>\n
task:<taskId>\n
workspace:<workspaceFingerprint>\n
pkg:<projectPackageJsonHash>\n
config:<taskConfigHash>\n
forward-args:<n>\n
  <arg>\0 (n times, in caller order)
env-values:<n>\n
  <name>=<value>\n (n times, in supplied order — caller pre-sorts)
upstream:<n>\n
  <hash>\n (n times, after we sort inside key())
inputs:<n>\n
  <relPath>\0<fileHash>\n (n times, after we sort inputFiles inside key())
```

`<fileHash>` is the file's **git blob OID** (v20):
`hex(HASH("blob " + byteLength + "\0" + content))` in the repo's
object format (sha1 unless the repo uses `--object-format=sha256`).
The OID arrives from `CacheKeyInput.fileHashes` when the run's bulk
`git ls-files -s` harvested it AND the path survived the trust prunes
(clean per `git status`, not `skip-worktree`/`assume-unchanged`, and
not subject to a `text`/`eol`/`ident` clean filter — see "Clean
filters" in `docs/caching.md`) — no I/O at all. Every other path goes
to `Cache.hashFile`, which hashes the WORKTREE bytes in-process behind
the `file_hashes` `(mtime, size, ctime, ino)` memo; that is the same
value the index holds whenever no filter applies. `<relPath>` is
the POSIX-relative path from `workspaceRoot` (so cache keys are
stable across platforms).

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
└── <hash>.tar.zst           # per-entry artifact (tar + zstd, vx's own streaming tar code):
    ├── stdout               #   captured stdout (always present)
    ├── outputs/             #   declared output files, project-relative
    ├── workspace-outputs/   #   declared outputs.workspaceFiles,
    │                        #   WORKSPACE-ROOT-relative (when any)
    └── .vx-meta.json        #   { version, files: { <entry>: [mode, mtimeMs] } }
```

`.vx-meta.json` exists because tar headers carry only second mtimes —
see `src/cache/archive.ts`, which owns pack, scan and extract, plus the
entry-name validation and containment checks that no tar reader can
make on vx's behalf. Both directions stream (`src/cache/tar-stream.ts`):
`packArtifactStream` reads each output as it is written, `scanArtifact`
lists entries for ingest's index rows, `extractArtifactStream` restores
through one staging extractor (write beside the target, rename after
the whole archive is read), so memory is bounded by a chunk either way;
a small artifact (≤ 4 MiB) is packed and decoded in one call instead.

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

1. Materializes the full entry into a temp dir
   `<cacheDir>/<hash>.tmp-<pid>-<ms>/` — outputs at
   `<tmp>/outputs/<rel>`, captured streams at `<tmp>/stdout` and
   `<tmp>/stderr`.
2. `rename(2)` to `<cacheDir>/<hash>/`. Atomic for an empty target;
   the dir's contents (outputs + logs) move as a unit.
3. Upserts the `entries` row (`ON CONFLICT(hash) DO UPDATE …`).

Reads via `get()` are non-blocking thanks to WAL.

## Restore semantics

`restoreOutputs(hash, projectDir, workspaceRoot?)`:

- If the artifact has no `outputs/` or `workspace-outputs/` entries,
  no-op.
- Otherwise extracts `outputs/<rel>` into `projectDir/<rel>` and —
  when `workspaceRoot` is given — `workspace-outputs/<rel>` into
  `workspaceRoot/<rel>`, creating parent directories as needed.
- Pre-existing local files at output paths are **overwritten** — by
  rename, never by a write through a planted link, and never with a
  moment of absence.
- Artifacts above 4 MiB compressed are decoded as a stream; smaller
  ones in one call. Same reader, same extractor, same 2 GiB ceiling.
- Throws (`CorruptArtifactError`) when the artifact vanished, is not
  a readable archive, or lacks an output the index recorded; throws
  `ArchiveSecurityError` on an unsafe name or an escape. Either way
  nothing was renamed into place.

`get(hash)`:

- One indexed SELECT against `entries`.
- Verifies `<cacheDir>/<hash>/` exists on disk; returns `null` if the
  DB row is present but the artifact was deleted out from under us.
- Bumps `accessed_at` on hit (used for LRU eviction once implemented).
- Reads `<hash>/stdout`, `<hash>/stderr`, and lists files under
  `<hash>/outputs/` to reconstruct `outputFiles`. Doesn't restore them
  — the caller decides when to call `restoreOutputs`.

## Run history & stats

`recordRun()` appends one row to `runs` for every task — cache hits
and misses, successes and failures. The orchestrator's end-of-run path
uses `recordRunBundle()` instead, which records the per-task `runs`
rows and one `invocations` header row (command, git/CI/host context,
tags, run-level counts) **atomically in one transaction**. The Tier-3
input-fingerprint rows (`entry_inputs`) are NOT written here — they
ride each entry's save transaction (`save`/`ingest`, miss path only)
via `INSERT OR IGNORE`, so a warm all-cache-hit run writes none of them.
`stats()` aggregates the last 24h plus the entry table summary:

```ts
interface CacheStats {
  entryCount: number
  totalBytes: number
  runCountLast24h: number
  hitCountLast24h: number
  attributedHitsLast24h: number
}
```

`stats(opts?)` takes an optional `{ project }` scope, narrowing both the
entry aggregate and the 24h run aggregate to that project.

`hitCountLast24h` counts every hit; `attributedHitsLast24h` counts only
those with a local executed-success baseline, which is the subset a
time-saved estimate can be computed from. They differ on a fresh runner
served by a warm remote cache, so the savings figure uses the second
while the hit count agrees with its siblings elsewhere.

Surfaced by `vx info` (and its `vx stats` alias).

## What this does NOT do

- Doesn't compress entries. `dist/` of typical projects is ~1–10MB
  per entry; uncompressed is fine for local cache. Remote cache should
  add tar+zstd at the wire.
- Doesn't garbage-collect old entries automatically. Eviction is
  user-driven via `vx cache prune --older-than <d>` / `--max-size <s>`
  (calls into `Cache.prune`).
- Doesn't verify entries are intact byte-for-byte. The file existence
  check is the integrity gate for the artifact as a whole; `restore
Outputs` additionally refuses when the archive cannot produce an output
  the `output_files` index recorded — and, for `<dir>/**` globs, the
  `output_dirs` rows that let a warm hit prove the set unchanged without a
  walk (`docs/caching.md` § A current tree) — (a restore that materializes nothing
  must never be reported as a hit — the caller has already wiped the
  declared outputs by then).

## `CACHE_VERSION` / `SCHEMA_VERSION`

`CACHE_VERSION` is currently `'vx-cache-v27'`; `SCHEMA_VERSION` is
`'v22'`. Bump `CACHE_VERSION` when:

- A new field is added to the cache KEY derivation (folded inside
  `key()`).
- The order or framing of existing key fields changes.
- The on-disk artifact layout changes (file placement, log paths), or
  the artifact BYTES already written are wrong — existing entries then
  carry bad content under a key the fixed code would still hit (v25:
  modes lost at pack time, long entry names dropped at parse time).

Bump `SCHEMA_VERSION` (independently — the gate drops + recreates
tables) when the SQLite schema changes. A new `CacheKeyInput` field that
is **NOT folded** (a pure side-channel like `captureInto` /
`upstreamIds`) needs neither bump: the key is byte-identical. The Tier-3
tables (`invocations`, `entry_inputs`) rolled `SCHEMA_VERSION` to `v22`
but left `CACHE_VERSION` at `v24` for exactly this reason — they persist
components already fed to `key()`.

Bumping `CACHE_VERSION` invalidates every previously-stored entry.
Pre-alpha tolerates this freely. See
`.claude/skills/bump-cache-version/SKILL.md` for the file checklist.

## Tests

`cache.test.ts` covers:

- `Cache.key` exhaustively (determinism, sensitivity to each input).
- v13 storage shape: SQLite DB exists, outputs under
  `<hash>/outputs/`, logs at `<hash>/stdout` and `<hash>/stderr`, no
  `meta.json`, no sibling `logs/` dir.
- `save → get → restoreOutputs` round-trip.
- `get()` returns null when DB row exists but on-disk artifact was
  deleted.
- `recordRun()` + `stats()` capture run counts and hit rate.

End-to-end cache write/read/restore is also covered by
`orchestrator.test.ts`.

## Replacing this module

Most likely replacement: **remote cache** (see
`docs/design/native-cache-wire-2026-07.md`).

The contract is small: `key()` is pure given inputs; `get()`, `save()`,
`restoreOutputs()` are the three I/O methods. A remote implementation
would:

- Keep `key()` identical (cache keys must match across machines).
- Replace `get()` with an HTTP/S3 fetch + local materialization.
- Replace `save()` with a local write + async upload.
- Optionally layer local-then-remote in a wrapping `Cache`.

CACHE_VERSION versioning becomes the migration story across deployed
clients.
