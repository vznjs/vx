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
  its first part. It touches no store; `Cache.key` delegates to it
  (item 691).
  `foldHead` is the same fold up to the input files, which come last.
- `fold-memo.ts` — `FoldMemo` (`IndexFoldMemo` over the rows): each task's last key over `fold_memo`, by
  a probe that is `foldHead` seeded into the task's `filesToken`
  (inputs.md). `computeTaskHash` reads a warm task's key back instead of
  resolving and folding its files; rows are written at close, and a prune
  drops a row no run rewrote for 30 days.
- `policy.ts` — `CachePolicy` (local/remote × read/write) and the
  `--cache-policy=<spec>` grammar.
- `zstd.ts` — artifact framing: the declared-size gate against a
  decompression bomb, the bounded one-call and streamed decoders.
- `file-hashes.ts` — `FileHashStore`: the per-file blob-OID memo over
  `file_hashes` (a symlink hashes as its target string) and the repo's
  object format.
- `linked-inputs.ts` — the content behind a symlinked input, folded after
  its target string: a file's identity, or every file under a linked
  directory (caching.md § key). `filesBehind(dir)` lists what a linked
  directory keys; `vx watch` judges a change to one by the same list.
  `behindLink(link, hashFile)` is the digest the key folds for one; the
  item-743 re-check follows each linked input again with it.
- `fs-clock.ts` — how far the workspace's file system clock runs behind
  this process's, measured once a run; `racyWindowMs` adds it.
- `output-index.ts` — `OutputIndex`: `output_files` / `output_dirs` rows
  and the two proofs a hit runs before skipping a restore.
- `run-history.ts` — `RunHistory`: `runs` + `invocations` writes (one
  transaction per run), the SQL binders, and the 30-day retention (run
  by a prune only, never a run's close; a dry-run prune deletes nothing,
  item 1004).
- `run-notes.ts` — `keepRunNotes` / `keptSteps` / `keptWarnings` /
  `keptFailures`: what a run said beside its rows (`steps`, `warnings`,
  `failures`), the newest 50 runs per table (metrics.md), one `RunNotes`.
- `lockfile-memo.ts` — `readLockfileMemo` / `writeLockfileMemo` over a `LockfileMemo`: a
  lockfile claimant's parse, one `lockfile_memos` row per file and
  claimant, on a connection of its own (lockfile-claim.md).
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
/** How a save keeps an entry locally (`cache.store`). */
export interface StoreOptions {
  embeddings: number // bytes; 0 keeps every entry as files
  decompress: boolean
}
export const DEFAULT_STORE: StoreOptions // { embeddings: 32 * 1024, decompress: true }

/**
 * Shape every cache implementation honors. Both Cache (local v10) and
 * LayeredCache (local + remote) implement it. Orchestrator uses
 * CacheLayer so callers don't need a discriminated union.
 */
export interface CacheLayer {
  readonly local?: Cache | undefined // the local handle this layer wraps (LayeredCache)
  readonly hasRemote?: boolean
  localHasMany?(hashes: readonly string[]): Promise<Set<string>> // the keys the local store holds; the prefetch probes the remote for the rest
  remoteKnown?(hashes: readonly string[]): Map<string, ArtifactInfo> // the keys the index says a remote holds (remote_hits); their pulls wait on no probe
  remoteHasMany?(hashes: readonly string[]): Promise<Map<string, ArtifactInfo> | null> // one hasMany per readable remote; null = a remote cannot batch or did not answer; a whole answer rewrites remote_hits
  remoteHasEach?(
    hashes: readonly string[],
    concurrency: number,
  ): Promise<Map<string, ArtifactInfo> | null> // `has` per key per readable remote, for a remote whose batch did not answer; null = one failed
  markRemoteAbsent?(hashes: Iterable<string>): void
  probeBeforeUpload?(hashes: Promise<readonly string[]>): void // `--force`: one batch probe per remote written but not read; a key it holds is not uploaded
  drainUploads?(): Promise<void> // await the background write-through uploads
  stopUploads?(): void // a stopped run: start no more uploads, and let drainUploads resolve now
  key(input: CacheKeyInput): Promise<string>
  get(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null>
  getSaved?(hash: string, ctx?: CacheGetContext): Promise<CacheEntry | null> // past the read policy: an entry this run's agent saved
  getMany?(
    hashes: readonly string[],
    ctx?: (hash: string) => CacheGetContext, // each hash's get context: an unindexed artifact is adopted
  ): Promise<Map<string, CacheEntry>>
  has(hash: string): Promise<'local' | 'remote' | null>
  prefetch(hash: string, ctx?: CacheGetContext): Promise<boolean>
  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]>
  isOutputsCurrent(projectDir: string, expected: readonly OutputFileRow[]): boolean
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
  outputDirsCurrent?(projectDir: string, rows: readonly OutputDirRow[]): boolean
  // workspaceRoot anchors the artifact's `workspace-outputs/` entries
  // (cache.outputs.workspaceFiles); omitted → only `outputs/` restores.
  // outputs: the task's declared globs; an entry outside them fails the
  // whole restore (restorableOutput).
  restoreOutputs(
    hash: string,
    projectDir: string,
    workspaceRoot?: string,
    outputs?: DeclaredOutputs,
  ): Promise<void>
  save(args: SaveArgs): Promise<void>
  ingest(hash: string, body: Blob | Response, meta: IngestMeta): Promise<void> // adopt an artifact a remote served
  // The ONE run-history write: a whole `vx run` atomically, the per-task
  // `runs` rows + one `invocations` header row in ONE transaction. The
  // input-fingerprint rows (entry_inputs) do NOT live here — they ride
  // the entry-save transaction (miss path only), so a warm run is free.
  recordRunBundle(bundle: { runs: readonly RunRecord[]; invocation: InvocationRecord }): void
  stats(opts?: CacheStatsOptions): CacheStats // { project? } narrows both aggregates
  hashFile(filePath: string): Promise<string>
  outputsPath(hash: string): string // a file-backed artifact's path; a small one lives in the index
  artifactSize?(hash: string): number | undefined // the stored artifact's compressed size, wherever it lives
  outputBytes?(hash: string): number | undefined // the entry this process just saved: its files' bytes, uncompressed; asked once
  prune(options: PruneOptions): Promise<PruneResult>
  close(): void
}

export type SaveArgs = {
  hash: string
  // exitCode is not accepted: vx caches only successes, stored as 0
  entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles' | 'exitCode'>
  projectDir: string
  outputFiles: string[] // absolute paths
  workspaceOutputFiles?: string[] // absolute paths of outputs.workspaceFiles matches
  workspaceRoot?: string // required alongside workspaceOutputFiles; an output symlink must stay inside it
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

// The run's remote traffic, filled by each remote lane and the run keeper
// (a kept task counts under its id): what the footer's remote part counts.
export interface RemoteTraffic {
  inFlight: number
  readonly keys: Map<string, RemoteKeyTraffic>
}

// The output-directory short-circuit's bounds: a hit with more than
// OUTPUT_DIRS_CAP directories under its outputs records one
// OUTPUT_DIRS_OVER_CAP row (never current; the hit keeps the walk and does
// not snapshot again), and a snapshot holding one whose mtime is within
// OUTPUT_DIRS_RACY_MS of it is dropped (the next hit walks).
export const OUTPUT_DIRS_CAP = 8192
export const OUTPUT_DIRS_OVER_CAP = -3
export const OUTPUT_DIRS_RACY_MS = 50

// git's racy-clean window, in ms: a file changed this close to when its
// digest was learned is hashed again rather than trusted by its stat —
// by the file-hash memo, and by the pre-save input re-check (task-hash.md).
export const FILE_HASH_RACY_MS = 50

// The window for one stamp: `windowMs`, plus a second when the stamp has no
// sub-second part (a file system that keeps whole seconds), two on an even
// second (FAT32) — the file hasher, the output-directory snapshot and the
// re-check all ask it (A-2, A-38). Plus the measured file-system clock lag.
export function racyWindowMs(stampMs: number, windowMs: number): number

// How far the workspace's file system clock runs behind `Date.now()`
// (fs-clock.ts): measured once a run from a stamp written in the cache dir
// (prepare.ts), and every racy window is widened by it when it is past the
// kernel's 20 ms tick. Set by a test to simulate a lagging file system.
export function measureFsClockLag(dir: string): void
export function setFsClockLag(lagMs: number): void

// What a symlinked directory input keys (linked-inputs.ts): every regular
// file and link under `dir`, relative and sorted, `.git`, `node_modules`,
// `.vx/cache` and `.yarn/cache` skipped. `vx watch` judges a change behind
// a link by the same list.
export function filesBehind(dir: string): string[]

// The content behind a symlinked input as the key folds it: a file's
// identity, or a digest of every file `filesBehind` lists. The run's
// re-check compares it again before a miss is saved.
export function behindLink(
  link: string,
  hashFile: (file: string) => Promise<string>,
  seen?: ReadonlySet<string>,
): Promise<string>

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
  dry?: boolean // pick victims and count orphans, delete nothing
}

export interface PruneResult {
  evicted: number
  bytesFreed: number
  orphans: number // row-less artifacts the policy takes by file time, and temps an hour old
  orphanBytes: number
}

export interface CacheKeyInput {
  taskId: string
  taskConfigHash: string
  envValues: Array<[name: string, value: string | undefined]> // undefined = unset
  runtimeValues?: Array<[command: string, output: string]> // (v23) inputs.runtime; folded as a namespaced section
  workspaceRuntimeValues?: Array<[command: string, output: string]> // (v23) inputs.workspaceRuntime; distinct namespace
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
  forwardArgs?: readonly string[] // CLI args after `--`
  fileHashes?: ReadonlyMap<string, string> // (v20) abs path → git blob OID; mapped paths skip hashFile
  pluginParts?: ReadonlyArray<readonly [name: string, value: string]> // `key` stage parts; folded as `plugin:<n>`
  platform?: string // the platform a task naming `exec.platforms` runs on; folded only when set
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
  cachePolicy: string // the --cache-policy spec, e.g. 'local:rw,remote:r'
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
}

// One key component as `key()` folded it (a `captureInto` row); task-hash,
// miss-save, metrics and miss-reason pass these, never redeclaring the shape.
export interface TaskInputComponent {
  kind: string
  name: string
  hash: string
}

// (Tier 3) One cache-key component row for `entry_inputs`, keyed by the
// cache-entry hash. Persisted inside the entry-save transaction (miss
// path only), via INSERT OR IGNORE.
export interface TaskInputRow {
  entryHash: string
  kind: string // file|env|runtime|ws-runtime|upstream|plugin|package|config|forward|workspace|format
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
  stdout: string // the output log: both streams in order (output-log.ts)
  storedAt: string // ISO timestamp
  source?: 'local' | 'remote' // (LayeredCache) which layer served the hit
  sizeBytes?: number // the artifact's compressed size, from the index
  fetchMs?: number // (LayeredCache) a remote hit this run pulled: download + ingest
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
  remoteError?: string // v40: each failed remote read or write of its key, `; `-joined
  peakCores?: number // v43: sampled, most cores one interval burned
  avgRssBytes?: number // v43: sampled, mean resident memory
  placement?: string // v44: where an executor ran it (`small#1`)
  placementCores?: number // v44: that machine's cores
  placementMemoryBytes?: number // v44: and memory
  keylessBy?: string // v46: the task with no inputs its key folded
  def?: string // v48: the task's definition (`taskDefinition`), which history reads by
  cpuShare?: number // v49: the share of a core its threads got there; history divides its CPU by it
  queuedMs?: number // v51: waited ready for a slot
  outputBytes?: number // v51: its output files' bytes, restored or saved
  blocks?: number // v51: the tasks downstream of it in the run
  flakyPasses?: number // v51: the flaky record its row quoted
  flakyFailures?: number
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
// the first run after one says so and names `vx cache clean`.
export const CACHE_VERSION = 'vx-cache-v48' // key-fold.ts
// An input gone between its listing and its hash folds as this, never an
// identity a file has (A-55); absentOr maps ENOENT/ENOTDIR to it.
export const ABSENT_INPUT = 'absent' // key-fold.ts
export function absentOr(err: unknown): string
// The fold up to the input files, which `foldKey` folds last (key-fold.ts).
export function foldHead(input: CacheKeyInput, digestValue?: (value: string) => string): bigint
// Each task's last key by its probe, over `fold_memo` (fold-memo.ts).
// `Cache.foldMemo()` hands out the interface; the rows' own class,
// `IndexFoldMemo`, stays in the cache module, as `IndexRemoteHits` does
// behind `Cache.remoteHits`. No handle reaches a plugin (2026-10-29).
export interface FoldMemo {
  get(taskId: string, probe: string): string | undefined
  set(taskId: string, probe: string, key: string): void
}
// Core's own readers (`vx last`, `vx why`, the history provider) take the
// index handle from `indexDb(cache)`, never from a `Cache` member.
export function indexDb(cache: Cache): Database
export const SCHEMA_VERSION = 'v47'
// What vx wrote in a cache dir (index, artifacts, run history, its `*`
// ignore): all a clear of a dir the user named may delete (item 968).
export function vxCacheEntries(cacheDir: string): string[]

// The two WHERE fragments every history query shares, so "a run that
// executed" and "a run with a key" mean one thing across metrics.ts,
// history.ts and failure-mode.ts.
export const EXECUTED_RUNS_SQL = "status <> 'skipped'"
export const KEYED_RUNS_SQL = "hash <> ''"
export function branchSource(branch: string | null): string // task_durations.source: 'branch:<name>'

// The four independent cache axes, and the `--cache-policy=<spec>` parser over
// them. `FULL_CACHE_POLICY` is every axis on — the default a run starts
// from before `--cache-policy`, `--no-cache` and `--force` resolve.
export interface CachePolicy {
  localRead: boolean
  localWrite: boolean
  remoteRead: boolean
  remoteWrite: boolean
}
export const FULL_CACHE_POLICY: CachePolicy
export function parseCachePolicy(spec: string, base?: CachePolicy): CachePolicy
export function formatCachePolicy(p: CachePolicy): string // the spec parseCachePolicy reads: local:rw,remote:r
// `--no-cache` (all off) beats `--force` (reads off), over whichever spec set the base
export interface CacheFlags {
  noCache?: boolean
  force?: boolean
}
export function applyCacheFlags(policy: CachePolicy, flags: CacheFlags | undefined): CachePolicy
export function cachesNothing(p: CachePolicy): boolean // no axis on: no cache answers for any task
```

## Key derivation (`Cache.key`)

The key is a 16-hex-char xxHash3 digest (SHA-256 until `CACHE_VERSION`
v15), computed by `foldKey` (`key-fold.ts`) seed-chaining one part per
line, in this exact order:

```
<CACHE_VERSION>
task:<taskId>
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

By default the entries and artifacts live in the repository's shared
store (`storeRoot`, `~/.vx/<id>/cache`, `workspace/resolveStoreRoot`)
and the workspace's `.vx/cache` holds only its own index, which attaches
`store.db` as `store`. A named `cache.dir` (`storeRoot` null) holds
everything in `cache.db`.

```
~/.vx/<id>/cache/            # the shared store (unversioned: keys are seeded with CACHE_VERSION)
├── store.db                 # entries, entry_stdout, output_files, entry_inputs, store_meta,
│                            # artifacts + artifacts_meta (the small artifacts, v33)
└── <hash>.tree/             # an artifact past INLINE_MAX, as plain files (v47);
                             # <hash>.tar.zst instead with cache.store.decompress off

<root>/.vx/cache/            # or a named <cacheDir>, which then also holds the store's tables and artifacts
└── cache.db                 # SQLite (with cache.db-wal, cache.db-shm): runs, memos, output stamps

<hash>.tar.zst               # per-entry artifact (tar + zstd, vx's own streaming tar code):
    ├── stdout               #   captured stdout (always present)
    ├── outputs/             #   declared output files, project-relative
    ├── workspace-outputs/   #   declared outputs.workspaceFiles,
    │                        #   WORKSPACE-ROOT-relative (when any)
    ├── .vx-meta.json        #   { version, key, files: { <entry>: [mode, mtimeMs] }, dirs?, links?, dirModes?, exec? }
    └── .vx-sum              #   CRC-32 of every entry above (v36)
```

`cache.store` (`StoreOptions`, `DEFAULT_STORE`, the Cache's last
constructor argument) picks the local form: `embeddings` keeps an entry up
to that size inline, `decompress: false` keeps a file-backed one as the
tar.zst, and otherwise it is `<hash>.tree/`: the same entries unpacked (`writeTree`
at save, the validated tar extracted at ingest, `sealTree`), stdout in
its `entry_stdout` row. A tree restore checks nothing (the tree holds no
`.vx-sum`; the archive's sum is checked when it is unpacked) and copies each file with `Bun.write` (copy_file_range, a clone where
the filesystem has one; never a hard link). Into existing outputs, a
workspace output or a link it feeds `extractArtifactStream` the
tree packed back (`packArtifactStream(planOfTree(…))`). `pinArtifact`
packs a tree into the upload's tar.zst.

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
packed rather than decoding its own bytes back, in memory and on the
calling thread (`scanTarBytes`); an ingest decodes and scans the stream.
An ingest into the tree form is one pass: a body up to 4 MiB is fetched
whole, decoded in one call, and extracted straight into a temp tree whose
scan (`extractArtifactStream`'s `onScan`) indexes the rows and whose sum
is the archive's, so no temp archive, second decode or read-back happens;
a larger body goes to a temp file first and still decodes once.
Both scanners run one header decoder (`TarDecoder`), so a save indexes
the rows a restore reads and refuses the names a restore refuses
(`tests/scan-tar-bytes.test.ts`).

An artifact of at most `INLINE_MAX` (32 KiB) compressed is not a file:
its exact `<hash>.tar.zst` bytes are a row of the store's `artifacts`
table, `(hash, at, bytes)` (v33). Every reader takes the inline bytes
first, then the file. `at` is the last use, renewed as a file time is
(a hit over an hour old), for the sweep of row-less artifacts.
`artifacts` is in no drop a `SCHEMA_VERSION` reset makes (neither
`STORE_TABLES` nor the index's list): a reset keeps the bytes, as it
keeps files, and each is indexed again from them on its next hit
(`adopt`): the lookup that finds no row is driven by the asked keys, so
it reports a row-less inline artifact in the same statement, and a miss
asks `artifacts` only then. Its own version is `artifacts_meta.layout`
(`'a2'`); another value drops the table, silently. It is read only
where the schema was not this vx's (a reset, a new index or store, a
store moved), so a warm open spends no statement on it and a layout
change bumps `SCHEMA_VERSION` too. A reading open over an index or store
of another schema (`vx cache clean --dry` after an upgrade) reads
them through a TEMP view over the file, so it names the row-less ones
the real prune reaps. A workspace index whose entries move to a store
drops its own `artifacts`, which an unqualified name would otherwise
find first.

SQLite stores metadata, and the small artifacts above:

- **`entries`** — one row per cached output:
  `(hash, project, task, command, exit_code, duration_ms, size_bytes, created_at, accessed_at, cpu_ms, peak_rss_bytes)`.
- **`entry_stdout`** — an entry's captured stdout, `(hash, stdout)`, apart
  so the `accessed_at` bump does not rewrite it (v29).
- **`runs`** — one row per task execution (hit or miss):
  `(id, hash, project, task, status, exit_code, duration_ms, forward_args, started_at, ended_at)`.
- **`store_meta`** — the shared store's `SCHEMA_VERSION`. Another
  version drops the store's tables, prints nothing, and keeps every
  artifact, indexed again from its own bytes when its task next hits.
- **`fold_memo`** — each task's last key, `(task_id, probe, key, seen_at)`
  (v42, `fold-memo.ts`). A memo: the key a row names is the one the whole
  fold derives under that probe.
- **`schema_meta`** — schema version sentinel. Mismatch → drop the
  tables and recreate (pre-alpha; no migration code). An open that does
  not read the current version re-reads it under `BEGIN IMMEDIATE`
  before it writes, so two processes opening one new cache at once
  insert one row, not two (the second died on the primary key,
  nx#28608); a warm open reads and takes no lock.

WAL mode is on (`PRAGMA journal_mode = WAL`) for non-blocking readers
during writes.

The task's output rides both the artifact and the `entries` row, so a
hit replays it without opening the artifact. It is both streams in the
order the run printed them, one string (`orchestrator/output-log.ts`:
RS + `e` / `o` where the stream switches, a literal RS doubled), so a
layer carries it as it carried stdout (v42).

## Atomic writes

`save()`:

1. Packs the entry — `stdout`, `outputs/<rel>`,
   `workspace-outputs/<rel>`, the `.vx-meta.json` sidecar and the
   `.vx-sum` CRC-32 of the entries before it (v36). An artifact of
   4 MiB or less is packed in memory; a larger one streams into
   `<cacheDir>/<hash>.tar.zst.tmp-<pid>-…`.
2. Scans it as a restore would (a readable archive whose sum
   matches, a `stdout` entry, its own key in the sidecar, an integer mode and a
   Date-sized mtime for each file); a failure
   removes the temp. An artifact of at most `INLINE_MAX` compressed
   is never written to a file; a larger one in memory is written to
   the temp first.
3. In one `BEGIN IMMEDIATE` transaction, upserts an inline artifact
   into `artifacts` — moving aside any file of the key, unlinked after
   the commit — or `rename(2)`s the temp to
   `<cacheDir>/<hash>.tar.zst` and deletes the key's inline bytes; and
   writes the `entries` row (`ON CONFLICT(hash) DO UPDATE …`), the
   `output_files` rows and the `entry_inputs` rows, so bytes and rows
   go live together and a key's bytes are in one place as of every
   commit. An inline save that fails leaves the previous entry whole,
   bytes and rows: nothing was written outside the transaction. A
   commit that fails after a rename unlinks the artifact: the old rows
   then name none, and the key misses (A-3). `ingest()` takes the same
   path; a remote body of at most `INLINE_MAX` (its size, or counted
   as it streams) is read to memory and stored inline.

`restoreOutputs()` reads an inline artifact and the entry's
`output_files` rows in one read transaction, so a re-save in another
process cannot pair its rows with the other bytes. The rows a probe
held (X-162) serve it only while the blob's `at` is the one the probe
read; a re-save or renewal since moves it and the rows are read again
in the blob's snapshot. `pinArtifact()`
(the upload's body) hands an inline artifact over as a `Blob` of its
bytes, read once; a file as a private hard link.

Reads via `get()` are non-blocking thanks to WAL.

## Restore semantics

`restoreOutputs(hash, projectDir, workspaceRoot?, outputs?)`:

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
  after the probe: a `vx cache clean` in another shell, another
  workspace's retention on a shared `--cache-dir`) — the caller treats
  that entry as a miss and runs the task. An artifact that is not a
  readable archive or lacks an output the index recorded
  (`CorruptArtifactError`) is dropped, unless the cache is read-only,
  and throws `ArtifactVanishedError` the same way (A-52). So is one
  holding an unsafe name or an escape by name (`ArchiveSecurityError`,
  as the `CorruptArtifactError`'s cause): the save proved every name
  safe, so the bytes changed since (X-115). A directory on the tree side that links out of the
  anchor is the tree's fault, not the artifact's: a `UserError` naming
  the link and its target (it is kept, never written through). A link
  that stays inside the anchor is written through, a dangling one too:
  its target directory is created first, decided on where the link
  resolves (`resolveThrough`), and only when a `mkdir` has failed, so a
  clean tree pays nothing. A cycle of links is a `UserError` by name.
  A path that resolves into the anchor's own `.git` (any case) is
  refused as a link out is (a deeper `.git` is an output, as by name), and an artifact's link into one is an
  `ArchiveSecurityError` (`writableUnder` in util, the rule the output
  clean holds a glob root's link and a recorded row to as well).
  A path holding a backslash is resolved link by link (`realOf`): Bun's
  `realpath` answers ENOENT for any such path.
  A directory where an entry holds a file (one `dist/**` covers and the
  clean, which takes files only, left) is refused as it is staged, with
  `EISDIR`: its rename would fail after others landed.
  On any throw, nothing was renamed into place.

`get(hash)`:

- One indexed SELECT against `entries`, joined to `artifacts` for
  whether the artifact is inline (`at` only: it sits before `bytes`, so
  no blob is read).
- An inline artifact needs nothing more. A file is `stat`ed: `null` if
  the DB row is present but the artifact was deleted out from under
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
`invocations` header row (command, git/CI/host context, run-level
counts) **atomically in one transaction**, with one shared-store
`task_durations` row per executed success, tagged `branchSource(branch)`
(`'branch:<name>'`, `'branch:'` with none) and the commit: what a
duration forecast reads (`history.md`). The per-row `recordRun` /
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
  `vx cache clean --older-than <d>` / `--max-size <s>` (calls into
  `Cache.prune`), never a run; it sweeps artifacts the index has no row
  for by the same policy, on file times, and temps once an hour old
  (`docs/caching.md` § Storage layout).
- Doesn't verify an artifact it does not open: its `.vx-sum` (L-19) is
  checked on scan and restore only. The file existence check gates
  every hit; `restore
Outputs` additionally refuses when the archive cannot produce an output
  the `output_files` index recorded — and, for `<dir>/**` globs and bare
  literals (a directory, or a file recorded as one), the
  `output_dirs` rows that let a warm hit prove the set unchanged without a
  walk (`docs/caching.md` § A current tree) — (a restore that materializes nothing
  must never be reported as a hit — the caller has already wiped the
  declared outputs by then).

## `CACHE_VERSION` / `SCHEMA_VERSION`

`CACHE_VERSION` is currently `'vx-cache-v51'`; `SCHEMA_VERSION` is
`'v51'`. Bump `CACHE_VERSION` when:

- A new field is added to the cache KEY derivation (folded inside
  `key()`).
- The order or framing of existing key fields changes.
- The on-disk artifact layout changes (file placement, log paths), or
  the artifact BYTES already written are wrong — existing entries then
  carry bad content under a key the fixed code would still hit (v25:
  modes lost at pack time, long entry names dropped at parse time).

Bump `SCHEMA_VERSION` (independently — the gate drops + recreates
tables) when the SQLite schema changes. Any other schema, earlier or
newer, is dropped by a writing opener (2026-10-06: the index is
an inventory the artifacts rebuild); `Cache.inspect(dir)` (a reading
verb) refuses a schema it cannot read with a `UserError` that names the
directory and both versions and leaves the index as it was (item 896). Over a directory
with no `cache.db`, `Cache.inspect` reads an empty index in memory and
creates nothing on disk: no directory, no `.gitignore`, no database
(item 900). A shared `store.db` with no file or no tables yet is read
the same way, so a reading verb never writes a store another opener may
be making. A `cache.db` SQLite cannot read (`SQLITE_NOTADB`,
`SQLITE_CORRUPT*` from the open's first statements) is refused by both
opens with a `UserError` naming the file and the remedy (remove it with
its `-wal` and `-shm`; the index holds nothing a run cannot rebuild):
it reached every verb as a raw stack (item 1005). Corruption deeper in
the file, past the pages the open reads, surfaces where it is read, and
there too as the same `UserError`: every lookup, save, prune, retention
pass, stats read, run record and config-evaluation read or write passes
through `guard` (A-8). Before, every task of a run failed on it as an
"internal error" and `vx cache clean` printed a stack. The open that drops them records it:
`Cache.schemaReset` carries a `SchemaReset`, `{ from, to }`, on that one open (null on
every later one). A `CACHE_VERSION` bump alone keeps the index, so
`Cache.formatChange` carries `{ from, to }` on the open that first sees
the new version (from `schema_meta.cache_version`; a store with entries
and no record reads `an earlier format`). Neither is printed, nor is a
shared store moved to or fallen back from: the cache is vx's to keep
(2026-10-06; `tests/schema-reset-notice.test.ts`). A new
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
