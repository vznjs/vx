# `cache.ts` — content-addressed task cache

## Purpose

Compute cache keys, store cache entries, retrieve them, restore output
files on hit, record run history. The on-disk format, SQLite schema,
and key derivation logic live here.

## Files (2026-09-09 split, pure moves)

- `layer.ts` — the CONTRACT (`CacheLayer`) and every shape that crosses
  it: `CacheKeyInput`, `CacheEntry`, `RunRecord`, `InvocationRecord`,
  output fingerprint rows, stats and prune options, `CorruptArtifactError`,
  `ArtifactVanishedError`.
  No implementation.
- `key-fold.ts` — `foldKey`, the whole key derivation as a function of
  `CacheKeyInput`, a file hasher and a relativizer, and `CACHE_VERSION`,
  its first part. It touches no store, so the site's playground bundles
  it to derive the keys the CLI would; `Cache.key` delegates to it
  (item 691).
- `policy.ts` — `CachePolicy` (local/remote × read/write) and the
  `--cache=<spec>` grammar.
- `zstd.ts` — artifact framing: the declared-size gate against a
  decompression bomb, the bounded one-call and streamed decoders.
- `file-hashes.ts` — `FileHashStore`: the per-file blob-OID memo over
  `file_hashes` (a symlink hashes as its target string) and the repo's
  object format.
- `config-evals.ts` — `ConfigEvalTable`: the `config_evals` /
  `config_closures` tables behind the `ConfigEvalStore` contract, with
  their retention.
- `output-index.ts` — `OutputIndex`: `output_files` / `output_dirs` rows
  and the two proofs a hit runs before skipping a restore.
- `run-history.ts` — `RunHistory`: `runs` + `invocations` writes (one
  transaction per run), the SQL binders, and the 30-day retention (run
  on a writing handle's close only: a reading verb's `Cache.inspect` and
  a dry-run prune delete nothing, item 1004).
- `schema.ts` — `createTables`: every table's DDL, the one place each is
  declared, with what each row means.
- `cache.ts` — opening the index (`SCHEMA_VERSION` check and reset), the
  entry store (get / save / ingest / restore / prune), and the `Cache`
  class that composes the four slices above over one handle and
  delegates to them. Re-exports `layer.ts`, `policy.ts` and `zstd.ts`
  so `./cache.js` stays one import path for the index, the sibling
  layers and the tests.

## Public surface

```ts
/**
 * Shape every cache implementation honors. Both Cache (local v10) and
 * LayeredCache (local + remote) implement it. Orchestrator uses
 * CacheLayer so callers don't need a discriminated union.
 */
export interface CacheLayer {
  readonly local?: Cache | undefined // the local handle this layer wraps (LayeredCache)
  readonly hasRemote?: boolean
  remoteHasMany?(hashes: readonly string[]): Promise<Set<string> | null> // one batched probe; null = no batch info, probe per hash
  markRemoteAbsent?(hashes: Iterable<string>): void
  drainUploads?(): Promise<void> // await the background write-through uploads
  key(input: CacheKeyInput): Promise<string>
  get(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null>
  getMany?(hashes: readonly string[]): Promise<Map<string, CacheEntry>>
  has(hash: string): Promise<'local' | 'remote' | null>
  prefetch(hash: string, ctx?: CacheGetContext): Promise<boolean>
  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]>
  isOutputsCurrent(projectDir: string, expected: readonly OutputFileRow[]): Promise<boolean>
  // The output-directory short-circuit (A-2): record, load, and judge the
  // stamps of a hit's output dirs, so a current tree is not re-walked.
  recordOutputDirs?(
    hash: string,
    projectDir: string,
    prefixes: readonly string[],
    holds?: (files: readonly string[]) => boolean,
  ): Promise<void>
  recordOutputStamps?(hash: string, projectDir: string, workspaceRoot: string): void
  loadOutputDirsBatch?(hashes: readonly string[]): Map<string, OutputDirRow[]>
  outputDirsCurrent?(projectDir: string, rows: readonly OutputDirRow[]): Promise<boolean>
  // workspaceRoot anchors the artifact's `workspace-outputs/` entries
  // (cache.outputs.workspaceFiles); omitted → only `outputs/` restores.
  restoreOutputs(hash: string, projectDir: string, workspaceRoot?: string): Promise<void>
  save(args: SaveArgs): Promise<void>
  ingest(hash: string, body: Blob | Response, meta: IngestMeta): Promise<void> // adopt an artifact a remote served
  // The ONE run-history write: a whole `vx run` atomically, the per-task
  // `runs` rows + one `invocations` header row in ONE transaction. The
  // input-fingerprint rows (entry_inputs) do NOT live here — they ride
  // the entry-save transaction (miss path only), so a warm run is free.
  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void
  stats(opts?: CacheStatsOptions): CacheStats // { project? } narrows both aggregates
  hashFile(filePath: string): Promise<string>
  outputsPath(hash: string): string
  prune(options: PruneOptions): Promise<PruneResult>
  close(): void
}

export type SaveArgs = {
  hash: string
  // exitCode is not accepted: vx caches only successes, stored as 0
  entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles' | 'exitCode'>
  projectDir: string
  outputFiles: string[] // absolute paths
  skipLocalWrite?: boolean // ChainedCache: an earlier layer already wrote it locally
  workspaceOutputFiles?: string[] // absolute paths of outputs.workspaceFiles matches
  workspaceRoot?: string // required alongside workspaceOutputFiles
  inputComponents?: readonly TaskInputRow[] // entry_inputs rows, written in the save's transaction
}

// Namespace discriminator for workspace outputs in the artifact and
// the output_files rows: project rows store the bare project-relative
// path; workspace rows store the full `workspace-outputs/<rel-to-root>`
// archive entry name.
export const WORKSPACE_OUTPUT_PREFIX = 'workspace-outputs/'

// `restoreOutputs` found no artifact where the probe found one, or a
// corrupt one (A-52): a MISS (execute-task.ts runs the task).
export class ArtifactVanishedError extends Error {
  readonly hash: string
}

// The output-directory short-circuit's bounds: a hit with more than
// OUTPUT_DIRS_CAP directories under its outputs records none and keeps the
// walk, and a snapshot holding one whose mtime is within
// OUTPUT_DIRS_RACY_MS of it is dropped (the next hit walks).
export const OUTPUT_DIRS_CAP = 8192
export const OUTPUT_DIRS_RACY_MS = 50

// git's racy-clean window, in ms: a file changed this close to when its
// digest was learned is hashed again rather than trusted by its stat —
// by the file-hash memo, and by the pre-save input re-check (task-hash.md).
export const FILE_HASH_RACY_MS = 50

// The window for one stamp: `windowMs`, plus a second when the stamp has no
// sub-second part (a file system that keeps whole seconds), two on an even
// second (FAT32) — the file hasher, the output-directory snapshot and the
// re-check all ask it (A-2, A-38).
export function racyWindowMs(stampMs: number, windowMs: number): number

export class Cache implements CacheLayer {
  // repoDir: where the file hasher asks git for the object format — the
  // workspace root in a run, so it shares the enumeration's `rev-parse`
  // (git-inputs.md). Absent, the directory of the first file hashed.
  // artifactCeiling: the largest artifact, decoded, this cache saves,
  // ingests or restores — 2 GiB; lowered only by a test, through
  // `RunOptions.artifactCeiling` (tests/artifact-ceiling.test.ts).
  constructor(
    cacheDir: string,
    localPolicy?: { read: boolean; write: boolean },
    repoDir?: string,
    artifactCeiling?: number,
    mode?: 'open' | 'inspect', // 'inspect' (Cache.inspect): a reading verb, never resets the index
  )
  // ... CacheLayer methods
  // Not on the layer contract: what prune's orphan sweep would reap right
  // now — `vx info`'s `orphans` row.
  orphanStats(): Promise<{ orphans: number; orphanBytes: number }>
}

export interface PruneOptions {
  olderThanMs?: number // ms-epoch cutoff; entries with accessed_at < this are evicted
  maxBytes?: number // after age pruning, evict LRU until total <= maxBytes
  dryRun?: boolean // pick victims and count orphans, delete nothing
}

export interface PruneResult {
  evicted: number
  bytesFreed: number
  orphans: number // artifacts / temps with no index row, an hour old or more
  orphanBytes: number
}

export interface CacheKeyInput {
  taskId: string
  taskConfigHash: string
  projectPackageJsonHash: string // (v12) project's package.json bytes
  envValues: Array<[name: string, value: string | undefined]> // undefined = unset
  runtimeValues?: Array<[command: string, output: string]> // (v23) cache.inputs.runtime; folded as a namespaced section
  workspaceRuntimeValues?: Array<[command: string, output: string]> // (v23) cache.inputs.workspaceRuntime; distinct namespace
  inputFiles: string[] // absolute paths (sorted by caller before pass)
  workspaceRoot: string
  upstreamHashes: string[]
  upstreamIds?: ReadonlyMap<string, string> // (Tier 3) hash → upstream task id, capture-NAMING only (not folded)
  // The dependency closure with group tasks expanded, for an executor that
  // ships inputs; never folded.
  upstreamGraft?: ReadonlyArray<{
    readonly taskId: string
    readonly hash: string
    readonly projectDir: string
  }>
  workspaceFingerprint: string
  forwardArgs?: readonly string[] // CLI args after `--`
  fileHashes?: ReadonlyMap<string, string> // (v20) abs path → git blob OID; mapped paths skip hashFile
  pluginParts?: ReadonlyArray<readonly [name: string, value: string]> // `key` stage parts; folded as `plugin:<n>`
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
  // v31: the hits by what they did to the disk; they sum to hitCount
  upToDateCount: number
  restoredLocalCount: number
  restoredRemoteCount: number
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
  kind: string // file|env|runtime|ws-runtime|upstream|plugin|package|config|forward|workspace
  name: string
  hash: string
}

export interface CacheEntry {
  hash: string
  taskId: string
  command: string // exec.command verbatim
  exitCode: number
  durationMs: number
  cpuMs?: number // the producing run's, from the artifact's sidecar
  peakRssBytes?: number
  outputFiles: string[] // project-relative POSIX paths
  outputRows?: OutputFileRow[] // the rows behind outputFiles, when the layer had them
  outputDirRows?: OutputDirRow[] // the directory short-circuit's rows, from getMany
  stdout: string // stderr is not cached
  storedAt: string // ISO timestamp
  source?: 'local' | 'remote' // (LayeredCache) which layer served the hit
}

export interface RunRecord {
  hash?: string // absent = no cache key derived (skipped, or persistent with no dependant); stored as ''
  project: string
  task: string
  status: 'success' | 'failed' | 'cache-hit' | 'cache-hit-remote' | 'skipped'
  exitCode: number
  durationMs: number
  forwardArgs?: readonly string[]
  startedAt: number // ms-epoch
  endedAt: number // ms-epoch
  // v11 analytics columns (all optional; populated by runner / orchestrator)
  runId?: string // UUIDv7 shared across all tasks in one `vx run`
  cpuMs?: number // user + system CPU time from Bun.spawn rusage
  peakRssBytes?: number // peak resident set size
  wallclockStartNs?: bigint // hrtime span relative to run t=0
  wallclockEndNs?: bigint
  cacheHit?: boolean // convenience for flamegraph color
  restored?: boolean // v31, on a hit: outputs restored (true) or already up to date (false)
  attempts?: number // >1 when the task retried (the within-run flaky signal)
  cached?: boolean // the task declared `cache`
  // v27: why it failed or was skipped, as the run's footer said it
  blockedBy?: string
  timedOut?: true
  sandboxViolations?: number
  notReady?: 'timeout' | 'exited' | 'spawn'
}

export interface CacheStats {
  entryCount: number
  totalBytes: number
  runCountLast24h: number
  hitCountLast24h: number
  restoredCountLast24h: number // of those hits, the ones that restored outputs
}

// The container and the index, versioned apart. CACHE_VERSION gates
// which stored BYTES are readable (bump when they would be wrong under
// an unchanged key, or when the container changes); SCHEMA_VERSION
// gates the SQLite schema, and a bump drops every table — which is why
// the first run after one says so and names `vx cache prune`.
export const CACHE_VERSION = 'vx-cache-v39' // key-fold.ts
// An input gone between its listing and its hash folds as this, never an
// identity a file has (A-55); absentOr maps ENOENT/ENOTDIR to it.
export const ABSENT_INPUT = 'absent' // key-fold.ts
export function absentOr(err: unknown): string
export const SCHEMA_VERSION = 'v31'
export function noteSchemaReset(cache: Cache, warn: (message: string) => void): void

// The two WHERE fragments every history query shares, so "a run that
// executed" and "a run with a key" mean one thing across metrics.ts,
// history.ts and failure-mode.ts.
export const EXECUTED_RUNS_SQL = "status <> 'skipped'"
export const KEYED_RUNS_SQL = "hash <> ''"

// The four independent cache axes, and the `--cache=<spec>` parser over
// them. `FULL_CACHE_POLICY` is every axis on — the default a run starts
// from before `--cache`, `--no-cache` and `--force` resolve.
export interface CachePolicy {
  localRead: boolean
  localWrite: boolean
  remoteRead: boolean
  remoteWrite: boolean
  remoteScope?: string // an untrusted scope: read own then trusted keys, write own
}
export const FULL_CACHE_POLICY: CachePolicy
export function parseCachePolicy(spec: string, base?: CachePolicy): CachePolicy
// The workspace's `cacheScope` applied: 'read-only' clears remoteWrite, a name sets remoteScope.
export function scopeCachePolicy(policy: CachePolicy, scope: string | undefined): CachePolicy
```

## Key derivation (`Cache.key`)

The key is a 16-hex-char xxHash3 digest (SHA-256 until `CACHE_VERSION`
v15), computed by `foldKey` (`key-fold.ts`) seed-chaining one part per
line, in this exact order:

```
<CACHE_VERSION>
task:<taskId>
workspace:<workspaceFingerprint>
pkg:<projectPackageJsonHash>
config:<taskConfigHash>
forward-args:<n>
  <arg> (n times, in caller order)
env-values:<n>
  <name>\0<value> (n times, in supplied order — caller pre-sorts;
                    bare <name> when unset)
runtime-values:<n>
  <command>\0<output> (n times)
ws-runtime-values:<n>
  <command>\0<output> (n times)
upstream:<n>
  <hash> (n times, after we sort inside key())
plugin:<n> (only when a `key` stage contributed parts)
  <name>\0<value> (n times)
inputs:<n>
  <relPath>\0<fileHash> (n times, sorted inside key() unless already sorted)
```

`<fileHash>` is the file's **git blob OID** (v20):
`hex(HASH("blob " + byteLength + "\0" + content))` in the repo's
object format (sha1 unless the repo uses `--object-format=sha256`).
The OID arrives from `CacheKeyInput.fileHashes` when the run's bulk
`git ls-files -s` harvested it AND the path survived the trust prunes
(clean per `git status`, not `skip-worktree`/`assume-unchanged`, and
not subject to a `text`/`eol`/`ident`/`filter`/`working-tree-encoding` clean filter — see "Clean
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
  `hashTaskConfig`, private to `orchestrator/task-hash.ts`).
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
    ├── .vx-meta.json        #   { version, key, files: { <entry>: [mode, mtimeMs] }, exec? }
    └── .vx-sum              #   CRC-32 of every entry above (v36)
```

`exec` is `{ cpuMs?, peakRssBytes? }` — what the producing execution
used, so an entry ingested from a remote knows it too (see caching.md
§ Artifact container); the save and the ingest both index it on the
`entries` row from the artifact, never from the caller.

`.vx-meta.json` exists because tar headers carry only second mtimes —
see `src/cache/archive.ts`, which owns pack, scan and extract, plus the
entry-name validation and containment checks that no tar reader can
make on vx's behalf. Both directions stream (`src/cache/tar-stream.ts`):
`packArtifactStream` reads each output as it is written, `scanArtifact`
lists entries for ingest's index rows, `extractArtifactStream` restores
through one staging extractor (write beside the target, rename after
the whole archive is read), so vx holds one chunk at a time either way;
a small artifact (≤ 4 MiB) is packed and decoded in one call instead.
At or below 256 KiB (`ON_THREAD_MAX`) that call, and a save's reads of
its outputs, run on the calling thread: a thread-pool round trip cost
more CPU than the work for a one-file artifact. A save scans the tar it
packed rather than decoding its own bytes back; an ingest decodes.

SQLite stores metadata only:

- **`entries`** — one row per cached output:
  `(hash, project, task, command, exit_code, duration_ms, size_bytes, created_at, accessed_at, cpu_ms, peak_rss_bytes)`.
- **`entry_stdout`** — an entry's captured stdout, `(hash, stdout)`, apart
  so the `accessed_at` bump does not rewrite it (v29).
- **`runs`** — one row per task execution (hit or miss):
  `(id, hash, project, task, status, exit_code, duration_ms, forward_args, started_at, ended_at)`.
- **`schema_meta`** — schema version sentinel. Mismatch → drop the
  tables and recreate (pre-alpha; no migration code). An open that does
  not read the current version re-reads it under `BEGIN IMMEDIATE`
  before it writes, so two processes opening one new cache at once
  insert one row, not two (the second died on the primary key,
  nx#28608); a warm open reads and takes no lock.

WAL mode is on (`PRAGMA journal_mode = WAL`) for non-blocking readers
during writes.

stderr is not stored; stdout rides both the artifact and the `entries`
row, so a hit replays it without opening the artifact.

## Atomic writes

`save()`:

1. Packs the entry — `stdout`, `outputs/<rel>`,
   `workspace-outputs/<rel>`, the `.vx-meta.json` sidecar and the
   `.vx-sum` CRC-32 of the entries before it (v36) — into
   `<cacheDir>/<hash>.tar.zst.tmp-<pid>-…` (streamed; an artifact of
   4 MiB or less is packed in memory and written there).
2. Scans the temp as a restore would (a readable archive whose sum
   matches, a `stdout` entry, its own key in the sidecar); a failure
   removes the temp.
3. In one `BEGIN IMMEDIATE` transaction, `rename(2)`s the temp to
   `<cacheDir>/<hash>.tar.zst` and writes the `entries` row
   (`ON CONFLICT(hash) DO UPDATE …`), the `output_files` rows and the
   `entry_inputs` rows, so bytes and rows go live together. A commit
   that fails after the rename unlinks the artifact: the old rows then
   name none, and the key misses (A-3). `ingest()` takes the same path.

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
  ones in one call. Same reader, same extractor, same 2 GiB ceiling —
  the one a save refuses past before it packs, so vx never stores an
  artifact its own restore would refuse.
- Throws `ArtifactVanishedError` when the artifact is gone (removed
  after the probe: a `vx cache prune` in another shell, another
  workspace's retention on a shared `--cache-dir`) — the caller treats
  that entry as a miss and runs the task. An artifact that is not a
  readable archive or lacks an output the index recorded
  (`CorruptArtifactError`) is dropped, unless the cache is read-only,
  and throws `ArtifactVanishedError` the same way (A-52). Throws
  `ArchiveSecurityError` on an unsafe name or an
  escape by name. A directory on the tree side that links out of the
  anchor is the tree's fault, not the artifact's: a `UserError` naming
  the link and its target (it is kept, never written through). A link
  that stays inside the anchor is written through, a dangling one too:
  its target directory is created first, decided on where the link
  resolves (`resolveThrough`), and only when a `mkdir` has failed, so a
  clean tree pays nothing. A cycle of links is a `UserError` by name.
  On any throw, nothing was renamed into place.

`get(hash)`:

- One indexed SELECT against `entries`.
- Verifies `<cacheDir>/<hash>.tar.zst` exists on disk; returns `null`
  if the DB row is present but the artifact was deleted out from under
  us.
- Marks the hash touched; `accessed_at` (the LRU order `prune`'s
  `maxBytes` evicts by) is written in one batch at prune, stats or close.
- Pure SQL: stdout from its `entry_stdout` row (one LEFT JOIN on the
  entry; none for an empty one), `outputFiles` from the
  `output_files` rows. The artifact is not opened — the caller decides
  when to call `restoreOutputs`.

## Run history & stats

`recordRunBundle()` is the one run-history write: one `runs` row for
every task — cache hits and misses, successes and failures — and one
`invocations` header row (command, git/CI/host context, tags, run-level
counts) **atomically in one transaction**. The per-row `recordRun` /
`recordRuns` forms left the contract on 2026-09-10; no caller took them. The Tier-3
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
  restoredCountLast24h: number // of those hits, the ones that restored outputs
}
```

`stats(opts?)` takes an optional `{ project }` scope, narrowing both the
entry aggregate and the 24h run aggregate to that project.

Surfaced by `vx info`.

## What this does NOT do

- Doesn't garbage-collect old entries unasked. Eviction is
  `vx cache prune --older-than <d>` / `--max-size <s>` (calls into
  `Cache.prune`), or the workspace's `cacheRetention` at the end of a
  run (`Cache.evictIfDue`); both sweep artifacts and temps the index
  has no row for, once they are an hour old (`docs/caching.md`
  § Storage layout). `evictIfDue` runs that sweep on its own when the
  policy has nothing due but the last sweep (`schema_meta`
  `orphans_swept_at`, stamped by every sweep) is an hour old: the
  policy sums index rows, so orphans never make it due.
- Doesn't verify an artifact it does not open: its `.vx-sum` (L-19) is
  checked on scan and restore only. The file existence check gates
  every hit; `restore
Outputs` additionally refuses when the archive cannot produce an output
  the `output_files` index recorded — and, for `<dir>/**` globs and bare
  literals that name a directory, the
  `output_dirs` rows that let a warm hit prove the set unchanged without a
  walk (`docs/caching.md` § A current tree) — (a restore that materializes nothing
  must never be reported as a hit — the caller has already wiped the
  declared outputs by then).

## `CACHE_VERSION` / `SCHEMA_VERSION`

`CACHE_VERSION` is currently `'vx-cache-v39'`; `SCHEMA_VERSION` is
`'v31'`. Bump `CACHE_VERSION` when:

- A new field is added to the cache KEY derivation (folded inside
  `key()`).
- The order or framing of existing key fields changes.
- The on-disk artifact layout changes (file placement, log paths), or
  the artifact BYTES already written are wrong — existing entries then
  carry bad content under a key the fixed code would still hit (v25:
  modes lost at pack time, long entry names dropped at parse time).

Bump `SCHEMA_VERSION` (independently — the gate drops + recreates
tables) when the SQLite schema changes. Only an earlier schema is
dropped, and only by a writing opener: `Cache.inspect(dir)` (a reading
verb) refuses any schema it cannot read, and every opener refuses a
newer one, each with a `UserError` that names the directory and both
versions and leaves the index as it was (item 896). Over a directory
with no `cache.db`, `Cache.inspect` reads an empty index in memory and
creates nothing on disk: no directory, no `.gitignore`, no database
(item 900). A `cache.db` SQLite cannot read (`SQLITE_NOTADB`,
`SQLITE_CORRUPT*` from the open's first statements) is refused by both
opens with a `UserError` naming the file and the remedy (remove it with
its `-wal` and `-shm`; the index holds nothing a run cannot rebuild):
it reached every verb as a raw stack (item 1005). Corruption deeper in
the file, past the pages the open reads, surfaces where it is read, and
there too as the same `UserError`: every lookup, save, prune, retention
pass, stats read, run record and config-evaluation read or write passes
through `guard` (A-8). Before, every task of a run failed on it as an
"internal error" and `vx cache prune` printed a stack. The open that drops them says
so: `Cache.schemaReset` carries a `SchemaReset`, `{ from, to }`, on that one open (null on
every later one), and `noteSchemaReset` prints one line — on the run's
status line, or a verb's stderr — ``[vx] cache index reset: schema v24 →
v25 (vx upgraded); every cached task misses once and re-saves, and
`vx cache prune` reclaims the old artifacts``. An upgrade's all-miss
run, and the `vx last` with nothing to show after it, are explained
rather than silent (`tests/schema-reset-notice.test.ts`). A
`CACHE_VERSION` bump alone keeps the index, so `Cache.formatChange`
carries `{ from, to }` on the open that first sees the new version (from
`schema_meta.cache_version`; a store with entries and no record reads
`an earlier format`), and the same `noteSchemaReset` prints
`[vx] cache format changed: …` instead (item 671). A new
`CacheKeyInput` field that is **NOT folded** (a pure side-channel like
`captureInto` / `upstreamIds`) needs neither bump: the key is
byte-identical. The Tier-3 tables (`invocations`, `entry_inputs`)
rolled `SCHEMA_VERSION` to `v22` but left `CACHE_VERSION` at `v24` for
exactly this reason — they persist components already fed to `key()`.

Bumping `CACHE_VERSION` invalidates every previously-stored entry.
Pre-alpha tolerates this freely. See
`.claude/skills/bump-cache-version/SKILL.md` for the file checklist.

## Tests

`cache.test.ts` covers:

- `Cache.key` exhaustively (determinism, sensitivity to each input).
- Storage shape: SQLite DB exists, one `<hash>.tar.zst` per entry.
- `save → get → restoreOutputs` round-trip.
- `get()` returns null when DB row exists but on-disk artifact was
  deleted.
- `recordRunBundle()` + `stats()` capture run counts and hit rate.

End-to-end cache write/read/restore is also covered by
`orchestrator.test.ts`.

## Replacing this module

Most likely replacement: **remote cache** — already a layer, not a
replacement: `docs/modules/layered-cache.md` is the seam, and
`@vzn/vx-migrate` (`turboCache()`, `nxCache()`) and `@vzn/vx-reapi` are
the wires that fill it.

The contract is small: `key()` is pure given inputs; `get()`, `save()`,
`restoreOutputs()` are the three I/O methods. A remote implementation
would:

- Keep `key()` identical (cache keys must match across machines).
- Replace `get()` with an HTTP/S3 fetch + local materialization.
- Replace `save()` with a local write + async upload.
- Optionally layer local-then-remote in a wrapping `Cache`.

CACHE_VERSION versioning becomes the migration story across deployed
clients.
