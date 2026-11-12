# `src/cache/` — the local cache and the remote seam

## `cache.ts` — content-addressed task cache

### Purpose

Compute cache keys, store cache entries, retrieve them, and restore
output files on a hit. The on-disk format and key derivation live here;
the tables are `index-db`'s, the memos `memo`'s, and the run history
`history`'s.

### Files

The store is one class over parts that each take its `StoreIndex`; the
memos it reads are the `memo` module's (memo.md), the history it writes
the `history` module's (history.md), and the tables `index-db`'s
(index-db.md).

- `layer.ts` — the CONTRACT (`CacheLayer`) and every shape that crosses
  it: `CacheKeyInput`, `CacheEntry`, `TaskMemo` (what a
  layer hands a key and a hit), stats and prune options, `CorruptArtifactError`,
  `ArtifactVanishedError`.
  No implementation.
- `key-fold.ts` — `foldKey`, the whole key derivation as a function of
  `CacheKeyInput`, a file hasher and a relativizer, and `CACHE_VERSION`,
  its first part. It touches no store; `Cache.key` delegates to it.
  `foldHead` is the same fold up to the input files, which come last.
- `policy.ts` — `CachePolicy` (local/remote × read/write) and the
  `--cache-policy=<spec>` grammar.
- `zstd.ts` — artifact framing: the declared-size gate against a
  decompression bomb, the bounded one-call and streamed decoders.
- `linked-inputs.ts` — the content behind a symlinked input, folded after
  its target string: a file's identity, or every file under a linked
  directory (caching.md § key). `filesBehind(dir)` lists what a linked
  directory keys; `vx watch` judges a change to one by the same list.
  `behindLink(link, hashFile)` is the digest the key folds for one; the
  inputs re-check follows each linked input again with it.
- `checkpointer.ts` — `WalCheckpointer`: once a run's first save commits
  (`checkpointOffThread`), the index's WAL checkpoints run PASSIVE on a
  thread of their own every 100 ms, through a second connection, and the
  run's connection checkpoints nothing until its close
  (`stopCheckpoints` first). A thread that fails hands them back.
- `store-index.ts` — `StoreIndex`: the open index (the `SCHEMA_VERSION`
  check and reset, the attached store, the prepared statements) and the
  state every part shares; `guard` refuses an unreadable page by its file.
- `lookup.ts` — reading entries: `get` / `getMany` (adopting an artifact
  with no row), `has`, the access times a hit refreshes.
- `restore.ts` — `restoreOutputs`: an entry's files back onto the tree,
  from a tar or a tree, re-read when the entry changed under it.
- `save.ts` — `save` / `ingest`: pack, write and index an entry, batched
  index writes, the off-thread checkpoints.
- `prune.ts` — `prune` / `stats` / `orphanStats`: eviction, orphans,
  and the 30-day history retention.
- `cache-dir.ts` — the directory itself: made private, its `*` ignore,
  the manifests and the locks a clean takes (`holdCacheDir`, `holdStore`).
- `cache.ts` — the `Cache` class: it opens a `StoreIndex` and delegates
  each layer method to its part. Re-exports `layer.ts`, `policy.ts` and
  `zstd.ts`.

### Public surface

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
  readonly memo: TaskMemo // the memos a key and a hit read (file hashes, output rows and stamps); memo.md
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
  // workspaceRoot anchors the artifact's `workspace-outputs/` entries
  // (outputs.workspaceFiles); omitted → only `outputs/` restores.
  // outputs: the task's declared globs; an entry outside them fails the
  // whole restore (restorableOutput; an empty directory, restorableOutputDir).
  restoreOutputs(
    hash: string,
    projectDir: string,
    workspaceRoot?: string,
    outputs?: DeclaredOutputs,
  ): Promise<void>
  save(args: SaveArgs): Promise<void>
  ingest(hash: string, body: Blob | Response, meta: IngestMeta): Promise<void> // adopt an artifact a remote served
  stats(opts?: CacheStatsOptions): CacheStats // { project? } narrows both aggregates
  outputsPath(hash: string): string // a file-backed artifact's path; a small one lives in the index
  artifactSize?(hash: string): number | undefined // the stored artifact's compressed size, wherever it lives
  outputBytes?(hash: string): number | undefined // the entry this process just saved: its files' bytes, uncompressed; asked once
  kept?(hash: string): boolean // the last save found the key stored and kept it (--force): no save; asked once
  prune(options: PruneOptions): Promise<PruneResult>
  close(): void
}

// What a layer hands a task's key and hit (layer.ts): the local store's
// memo, or a test double's. Core's own is `LocalMemo` (memo.md).
export interface TaskMemo {
  hashFile(filePath: string): Promise<string>
  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]>
  isOutputsCurrent(projectDir: string, expected: readonly OutputFileRow[]): boolean
  recordOutputDirs?(
    hash: string,
    projectDir: string,
    prefixes: readonly string[],
    holds?: (files: readonly string[]) => boolean,
  ): Promise<void>
  recordOutputStamps?(hash: string, projectDir: string, workspaceRoot: string): void
  loadOutputDirsBatch?(hashes: readonly string[]): Map<string, OutputDirRow[]>
  outputDirsCurrent?(projectDir: string, rows: readonly OutputDirRow[]): boolean
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

// `restoreOutputs` found no artifact where the probe found one, or a
// corrupt one (A-52): a MISS (execute-task.ts runs the task).
export class ArtifactVanishedError extends Error {
  readonly hash: string
}

// A body whose bytes are wrong, not cut short: the hit is a miss and the
// re-run's save is sent over that remote's copy (`put` gets `replace`).
export class CorruptArtifactError extends Error {
  readonly hash: string
}

// The run's remote traffic, filled by each remote lane and the run keeper
// (a kept task counts under its id): what the footer's remote part counts.
export interface RemoteTraffic {
  inFlight: number
  readonly keys: Map<string, RemoteKeyTraffic>
}

// `memo.hashFile(file)`, and `seen` told the ctime of the stat the digest
// came from when the memo is core's own `LocalMemo` with its own hasher:
// the describe records it for the re-check's tie rule (task-hash.md). Any
// other memo tells nothing, and the tie then counts as the command's write.
export function hashFileSeen(
  memo: TaskMemo,
  file: string,
  seen: (ctimeMs: number) => void,
): Promise<string>

// Each of `files` by `memo.hashFile`'s answer, with one memo query for
// them all when the memo is core's own (`hashFiles`); any other memo is
// asked per file. A file that cannot be hashed is absent: the key's fold
// asks `hashFile` for it, and the error is that call's.
export function hashFilesOf(memo: TaskMemo, files: readonly string[]): Promise<Map<string, string>>

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
  // In a named cache dir it also keys the output stamps and directory
  // snapshots this handle reads and writes: clones sharing one keep their own.
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
  get memo(): StoreMemo // the store's own memos over its index (memo.md); a layer's memo is this one
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
  historyRows?: number // run history and memo rows past 30 days dropped; absent when none went
  historyBytes?: number // bytes the index files shrank by once those rows' pages went back
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
  stdout: string // the output log: both streams in order (output-log.ts); a local entry reads it on access
  storedAt: string // ISO timestamp; a local entry formats it on access
  source?: 'local' | 'remote' // (LayeredCache) which layer served the hit
  sizeBytes?: number // the artifact's compressed size, from the index
  fetchMs?: number // (LayeredCache) a remote hit this run pulled: download + ingest
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
// Core's own readers (`vx last`, `vx why`, the history provider) take the
// index handle from `indexDb(cache)`, never from a `Cache` member.
export function indexDb(cache: Cache): Database
// The history writer's two other answers from the store: the salted digest
// value-bearing rows hold, and whether this open may write the index (one
// it cannot write keeps no history).
export function valueDigest(cache: Cache): (value: string) => string
export function indexWritable(cache: Cache): boolean
// What such a reader throws for `err`: a page SQLite cannot read is the
// open's own refusal, naming the file (`vx last`, `vx why`).
export function indexError(cache: Cache, err: unknown): unknown
// Wait until no other connection has `<storeDir>/store.db` open (a run in
// any checkout holds it from its run lock to its end; WAL connections keep a shared lock),
// then hold it alone until the release. Nothing to hold without the file.
export function holdStore(storeDir: string, log: (line: string) => void): Promise<() => void>
// A cache directory with no store (`--cache-dir`, `cache.dir`, `VX_CACHE_DIR`),
// which workspaces may share: a run holds `<dir>/cache.lock` shared from
// before its cache opens to its end, `vx cache clean` exclusive; each waits
// for the other, saying so after a second. A clean deletes the file it
// holds, so a taker checks the name still is that file. A run finding no
// index yet makes the directory and the file first, so the index it makes
// is held; a clean finding none, an unwritable directory, or one the open
// refuses (`workspaceRoot`'s, as the open asks it) holds nothing.
export function holdCacheDir(
  dir: string,
  mode: 'shared' | 'exclusive',
  log: (line: string) => void,
  signal?: AbortSignal,
  workspaceRoot?: string,
): Promise<() => void>
// The files a second connection writes a run's hits through; undefined
// when the store keeps no history on disk.
export function historyFiles(cache: Cache): { index: string; store?: string } | undefined
// An entry_stdout row's log, its zstd frame decoded (v52); null reads as ''.
// `vx last --log` reads the row itself.
export function storedLog(blob: Uint8Array | null): string
export function taskEntryHashes(layer: CacheLayer, taskId: string): string[] // every entry this machine holds for the task (an additive miss reads their rows)
// What vx wrote in a cache dir (index, artifacts, run history, its `*`
// ignore): all a clear of a dir the user named may delete (item 968).
export function vxCacheEntries(cacheDir: string): string[]

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
export function cachePolicyEnvRefusal(spec: string): string | null // why VX_CACHE_POLICY is refused, checked before any verb
// `--no-cache` (all off) beats `--force` (reads off), over whichever spec set the base
export interface CacheFlags {
  noCache?: boolean
  force?: boolean
}
export function applyCacheFlags(policy: CachePolicy, flags: CacheFlags | undefined): CachePolicy
export function cachesNothing(p: CachePolicy): boolean // no axis on: no cache answers for any task
```

### Key derivation (`Cache.key`)

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
to `Cache.memo.hashFile`, which hashes the WORKTREE bytes in-process behind
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

### Storage layout

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
at save, the validated tar extracted at ingest), each at its
`output_files` row's path: a project output at its rel, a workspace one
under `workspace-outputs/`, an output link as the link (v53). The tree
keeps no sidecar and no `outputs/` level: stdout is its `entry_stdout`
row, and every other fact the sidecar holds (modes, mtimes, empty and
moded directories, the key, `exec`) is in its rows, but a link's target,
which the link itself keeps. `planOfTree` rebuilds the sidecar from the
rows, each link held to its row's length and CRC-32. A tree restore checks nothing (the tree holds no
`.vx-sum`; the archive's sum is checked when it is unpacked) and copies each file with `Bun.write` (copy_file_range, a clone where
the filesystem has one; never a hard link): a missing top directory is
built in `.vx/tmp/` (`copyStaging`) and renamed into place once, a
missing file in a directory that stands is copied straight to its place.
A link, held to its row's length and CRC-32, is laid as written once
`linksRestorable` finds the extractor would lay it (the same checks, bounded by the
workspace). Every copy settles before a failure's cleanup. Into existing outputs, a workspace
output, a link the extractor refuses, or where that rename would cross a filesystem or a setgid
directory it feeds `extractArtifactStream` the tree packed back
(`packArtifactStream(planOfTree(…))`), so the extract at ingest leaves where a link points to
that restore, the one that knows the workspace: bounded by the tree, a link into a sibling
project was refused. `pinArtifact`
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
  `(hash, project, task, command, exit_code, duration_ms, size_bytes, created_at, accessed_at, cpu_ms, peak_rss_bytes, run_id)`;
  `run_id` and `created_at` name the run that wrote the entry as it stands and when (v54).
- **`entry_stdout`** — an entry's captured stdout, `(hash, stdout)`, apart
  so the `accessed_at` bump does not rewrite it (v29); a zstd frame of its
  bytes as the task wrote them (v52, `rawEncode`), as text the logs outweighed every inline artifact.
- **`runs`** — one row per task execution (hit or miss):
  `(id, hash, project, task, status, exit_code, duration_ms, forward_args, started_at, ended_at, run, …)`.
  `run` is the run's row in **`run_ids`** `(id, run_id)` (v53): the
  36-char id and its index were a third of what an all-hit run added.
  Each connection's TEMP view `runs` shadows the table and shows `run_id`
  in its place, so readers and `vx last --sql` read the old columns; a
  reader that needs no `run_id` names `main.runs` (the view's join is
  not dropped from an aggregate), and writers always do. TEMP, so an
  older vx resetting the index never meets a view its `DROP TABLE runs`
  refuses.
- **`store_meta`** — the shared store's `SCHEMA_VERSION`. Another
  version drops the store's tables, prints nothing, and keeps every
  artifact, indexed again from its own bytes when its task next hits.
- **`fold_memo`** — each task's last key, `(task_id, probe, key, seen_at)`
  (v42, `fold-memo.ts`). A memo: the key a row names is the one the whole
  fold derives under that probe. A page of it SQLite cannot read is no
  memo: every fold is made afresh.
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

### Atomic writes

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
in the blob's snapshot. With the rows held, no transaction is opened:
an inline artifact is its blob read alone (one statement is its own
snapshot), and a file artifact whose tree stands is read with no
statement at all, since an inline save moves the tree aside in the
commit that adds its blob (2026-11-07: ~70 ms of a 1,600-restore run's
main thread). The tree's inode is taken once, before the copy, and
asked again after it to catch a swap; the project directory and the
staging directory are each stat'ed once per restore (the staging
directory made synchronously: a run's first restores arrive together, and
each thread-pool `mkdir` waited behind the others' work), and the copy-out
asks what stands at each path synchronously, on dentries the walk just
looked up. `pinArtifact()`
(the upload's body) hands an inline artifact over as a `Blob` of its
bytes, read once; a file as a private hard link.

Reads via `get()` are non-blocking thanks to WAL.

### Restore semantics

`restoreOutputs(hash, projectDir, workspaceRoot?, outputs?)`:

- If the artifact has no `outputs/` or `workspace-outputs/` entries,
  no-op.
- Otherwise extracts `outputs/<rel>` into `projectDir/<rel>` and —
  when `workspaceRoot` is given — `workspace-outputs/<rel>` into
  `workspaceRoot/<rel>`, creating parent directories as needed.
- Pre-existing local files at output paths are **overwritten** — by
  rename, never by a write through a planted link, and never with a
  moment of absence. A tree entry copies each such file to a temp beside
  it and renames it over once every copy landed: sent through the tar
  extractor, a hit over the last build's 20,000 files took 6.5 s, against
  3 s copied and 1.6 s into an empty tree. A file that already holds
  the entry's bytes stays, its mtime with it, as the extractor keeps one.
- Artifacts above 4 MiB compressed are decoded as a stream; smaller
  ones in one call. Same reader, same extractor, same 2 GiB ceiling —
  the one a save refuses past before it packs, so vx never stores an
  artifact its own restore would refuse.
- Throws `ArtifactVanishedError` when the artifact is gone (removed
  after the probe: a `vx cache clean` in another shell, another
  workspace's retention on a shared `--cache-dir`) — the caller treats
  that entry as a miss and runs the task. An artifact that is not a
  readable archive or lacks an output the index recorded, or a tree
  still in place that lacks one of its files (`CorruptArtifactError`,
  `<rel> is missing from its stored tree`) or holds anything but a file
  at one's place (`<rel> is not a file in its stored tree`: a FIFO there
  hung the copy-out's open), is dropped, unless the cache is read-only,
  and throws `ArtifactVanishedError` the same way (A-52). So is one
  holding an unsafe name or an escape by name (`ArchiveSecurityError`,
  as the `CorruptArtifactError`'s cause): the save proved every name
  safe, so the bytes changed since (X-115). A file artifact (tar or
  tree) has no blob `at`, so a re-save in another process after the
  probe pairs the probe's held rows with the new bytes: a failure whose
  entry's rows changed since restores once more on the rows read now,
  and an entry is dropped only while its rows, checked under the write
  lock, are the ones that failed, so another process's fresh entry is
  never dropped (a miss instead). A directory on the tree side that links out of the
  anchor is the tree's fault, not the artifact's: a `UserError` naming
  the link and its target (it is kept, never written through). A link
  that stays inside the anchor is written through, a dangling one too:
  its target directory is created first, decided on where the link
  resolves (`resolveThrough`), and only when a `mkdir` has failed, so a
  clean tree pays nothing. A cycle of links is a `UserError` by name.
  A path that resolves into the anchor's own `.git` (any case) is
  refused as a link out is (a deeper `.git` is an output, as by name), and an artifact's link into one is an
  `ArchiveSecurityError` (`writableUnder` in util, the rule the output
  clean holds a glob root's link and a recorded row to as well). An
  artifact's link is out when its target, read segment by segment from
  the link's directory, steps above the anchor at any point, even if it
  comes back (`linkRefused`, which the save asks too). A target with a
  `..` is walked on disk too, from the link's real directory, each link
  already there before the last `..` followed (`linkLandsRefused`): a
  committed `up -> ..` made `../up/../x` read as inside and land out.
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
- Pure SQL: `outputFiles` from the `output_files` rows. The log is
  `CacheEntry.stdout`, a getter: a compressed log of up to 4 KiB comes
  with the entry (one LEFT JOIN; none for an empty one) and is
  decompressed on access; a larger one is read from its `entry_stdout`
  row on access. A warm run probes every key in one batch and replays
  the hits later, so each log is held only while its hit replays: 500
  hits printing 1 MiB each held 3.4 GB RSS, now 0.2 GB. Read it once. The artifact is not opened — the caller decides
  when to call `restoreOutputs`.

### Run history & stats

`recordRunBundle()` is the run-history write at a run's end: one `runs`
row for every task — cache hits and misses, successes and failures — and
one `invocations` header row (command, git/CI/host context, run-level
counts) **atomically in one transaction**, less the hits a
`HistoryStream` already wrote while the graph ran (a warm run's 8,002
rows were the main thread's last ~65 ms; from 2,048 hits their batches
land beside the graph instead, and the header still comes last, so `vx last` lists a
run only once all its rows are in), with one shared-store
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

### What this does NOT do

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

### `CACHE_VERSION` / `SCHEMA_VERSION`

`CACHE_VERSION` is currently `'vx-cache-v56'`; `SCHEMA_VERSION` is
`'v56'`. Bump `CACHE_VERSION` when:

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
(item 900). So does `'preview'` (a dry prune, and a `vx run --dry` with
no remote to probe). A shared `store.db` with no file or no tables yet is read
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
every later one). A `CACHE_VERSION` bump alone keeps the index and
records the new version in `schema_meta.cache_version`; every key moves,
so each cached task misses once. Neither is printed, nor is a
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

### Tests

`cache.test.ts` covers:

- `Cache.key` exhaustively (determinism, sensitivity to each input).
- Storage shape: SQLite DB exists, one `<hash>.tar.zst` per entry.
- `save → get → restoreOutputs` round-trip.
- `get()` returns null when DB row exists but on-disk artifact was
  deleted.
- `recordRunBundle()` + `stats()` capture run counts and hit rate.

End-to-end cache write/read/restore is also covered by
`orchestrator.test.ts`.

### Replacing this module

Most likely replacement: **remote cache** — already a layer, not a
replacement: `docs/modules/cache.md` is the seam, and
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

## `src/cache/layered-cache.ts` — the local cache with the declared remotes behind it

### Purpose

Puts the declared **`RemoteCacheLayer`**s — the plugin seam for remote
caching — behind the local `Cache`, in declared order, and exposes the
same `CacheLayer` interface. The orchestrator doesn't know
which layer it's talking to, and core ships **no wire client**: the
remote layer comes from a plugin's `cache` capability (e.g. the
`@vzn/vx-reapi` CAS client), which `resolveCache` wraps here, or from an
embedder via `RunOptions.remoteCache`. Core builds every
`LayeredCache`; it is not on the public façade.

- **Read-through**: try local; on miss, ask each readable remote in
  declared order, stream the first hit's body into local, return with
  `source: 'remote'`.
- **Write-through with async upload**: write to local synchronously
  (packed once however many remotes), then PUT to every writable remote
  in the background (bounded at 4 concurrent per remote;
  `run()` awaits `drainUploads()` before `cache.close()`, and before the
  telemetry summary, which reports them). A stopped run (Ctrl-C,
  SIGTERM, an embedder's abort) calls `stopUploads()`: queued uploads
  never start and the drain stops waiting on the ones in flight. A read
  in flight is given up too: the lookup is not awaited, and a download's
  body errors, so its ingest removes its temp and lands nothing; the next
  run fetches it again. Each upload is tallied on the
  local `Cache` it wraps (`uploads`: count, bytes, summed ms, failed),
  so every plugin's remote reports without a seam method. Remote
  errors are logged, not thrown — the task already succeeded; failed
  uploads shouldn't fail the user's run. A remote hit this run pulled
  carries `fetchMs`, its download and ingest.
- **Prefetch + in-flight dedup**: `prefetch(hash)` warms local from
  remote in the background; an in-flight map shared with `get`
  guarantees **at most one walk of the remotes per key**, and a settled
  miss blocks a second lazy probe.
- **One remote's boundary** is its `RemoteLane` (`remote-lane.ts`): what
  the run lets it do, its shape checks, its upload pool and its
  warnings. This layer owns the order, the local store and provenance.
- **Task keys reach every remote plain.** Which branch a read may see is
  the remote's call (`turboCache()`'s `scope`, below).

### Public surface

```ts
export interface RemoteOpenContext extends PluginSecrets {
  readonly ci: boolean
  warn(message: string): void // one line naming the plugin; the remote stays on
}

/** What a remote knows of a stored artifact; `{}` when the wire says nothing. */
export interface ArtifactInfo {
  readonly size?: number // the body's bytes
  readonly durationMs?: number // the producing task's run
}

export interface RemoteCacheLayer {
  /** Where the artifacts live, named in every degrade warning; never a credential. */
  readonly endpoint?: string
  /** Optional: true once a failure turned the layer off for the run (a refused token, no answer): that failure is the run's, said once, on no task's key, so the footer's `✗` counts no task for it. */
  readonly off?: boolean
  /** Optional: get ready (a credential). Once per run, before the first task, only when the policy reads or writes it. */
  open?(ctx: RemoteOpenContext): Promise<void>
  /** Optional: this run's access (an OIDC exchange's token, never a stored secret), lent to a machine that runs its tasks; asked after `open`. */
  lend?(): Promise<LentAccess | undefined>
  /** Existence probe (drives the plan path's `--dry` remote prediction); `null` = absent. */
  has(hash: string): Promise<ArtifactInfo | null>
  /** Optional batch probe: the stored subset in one round-trip; `null` = use per-hash. */
  hasMany?(hashes: readonly string[]): Promise<Map<string, ArtifactInfo> | null>
  /** Fetch an artifact; `null` = miss; `undefined` = no answer (the layer is off), which keeps the index's hits. Errors THROW. `body` is read once, by core; one it errors with `CorruptArtifactError` is bad bytes there. */
  get(
    hash: string,
  ): Promise<{ body: Blob | Response; durationMs: number | undefined } | null | undefined>
  /** Store an artifact (fire-and-forget from LayeredCache's PoV). File-backed when local holds it. A held key keeps its bytes unless `replace`. `false`: nothing sent, nothing failed; no upload counted. */
  put(hash: string, body: Blob, meta: { durationMs: number; replace?: true }): Promise<void | false>
  /** Optional: the run found `hash` in no remote and a `put` follows; a wire that checks first can skip it. */
  missing?(hash: string): void
}

export class LayeredCache implements CacheLayer {
  constructor(local: Cache, remotes: readonly ResolvedRemote[], uploadConcurrency?: number) // declared order
  prefetch(hash: string, ctx?: CacheGetContext): Promise<boolean>
  drainUploads(): Promise<void>
  stopUploads(): void
  // CacheLayer methods — see docs/modules/cache.md.
}
```

### Which branch a read sees

A task key carries no branch (VZN, 2026-10-20). Each remote gets the
run's refs (`ctx.refs`, own branch first, then its base and the default
branch) and decides. `turboCache()` names them on every read in
`x-artifact-read-scopes` (`scope: 'header'`, the default), or keys each
entry on its ref and asks every ref's key in one batch (`scope: 'key'`,
for a server that ignores the header). Where a write lands is never the
client's call: the server checks the CI OIDC token against its trust
policy. `nxCache()` and `vx-reapi` send no scope.

### Bodies stream, both ways

No artifact sits whole in memory on the remote path
(`docs/design/streaming-remote-2026-09.md`). `get` resolves a `Blob` or a
`Response`: an HTTP wire returns its `fetch` `Response` itself, a chunked
wire `new Response(readableStream)`, bytes in hand `new Blob([bytes])`.
`Cache.ingest` writes it to its temp with `Bun.write`, which streams a
`Response` and copies a file `Blob` without collecting either, then
validates from the temp; a body that fails mid-stream or fails validation
leaves no temp. A body past the artifact ceiling's zstd bound (by its
length header, its Blob size, or a running count) is refused before it
fills the disk (L-5). `put` receives a `Bun.file` over a private hard
link to the local artifact (`Cache.pinArtifact`), made when the job starts
and unlinked when it ends, so a queued upload holds a path, not a buffer,
and every read of the body sees the same bytes: a re-save of the key
renames others over the live name, and a body opened by that name read
them mid-upload. A plugin that must digest first reads `body.stream()`
twice. The one
exception is `--cache-policy=local:,remote:rw`: with no local artifact the bytes
are packed in memory during `save` and sent as `new Blob([bytes])`.

### Opening a remote

`open` is asked by `run()` alone, once, in declared order, after the
project load and before plugin `setup`, the status line and the first
task (`openRemotes`, `orchestrator/prepare.ts`), and only for a remote the
run's policy lets read or write. `--no-cache`, `--cache-policy=remote:`
and a plan (`--dry`, `vx show`) never call it, so every other method may
arrive unopened. One at a time: two remotes that ask on the terminal do
not interleave. A throw is a warning through the remote's `onError` and
clears its `read` and `write` (`ResolvedRemote`'s, which the lanes read
live), so the run goes on without it; every remote off this way is no
remote layer for the run's policy. `ctx.secret` is the supplying plugin's
keychain (`util.md`); `@vzn/vx-migrate`'s `turboCache()` and
`nxCache()` read a missing token from it here (2026-10-17).

### The never-fail contract

`RemoteCacheLayer` implementations THROW on every failure (network,
non-404 status, integrity mismatch, oversize body). `LayeredCache`
catches **everything** and degrades to a cache miss, reported to that
remote's `onError` — no remote failure of any kind may fail a run. A
corrupt remote body is additionally refused by `Cache.ingest`'s
validation (zstd checks), which this layer also degrades to a miss. A
result of the wrong SHAPE — a `get` whose `body` is not a `Blob` or a
`Response` (the pre-stream `ArrayBuffer` / `Uint8Array` included, named
as such: "body is a Uint8Array"), a `hasMany` that is not a `Map` or
`null` — is the plugin's bug, named as such through `onError`
("download <hash> failed: remote cache layer returned an invalid
result: get() resolved body is string (expected { body: Blob | Response,
durationMs } or null) — a plugin bug, degraded to a miss") and degraded
the same way, never reported as a corrupt artifact.

A probe's answer (`has`, `hasMany`, or one recorded by an earlier run)
is a hint, never the artifact: a key it says is held whose `get` returns
`null` (the server dropped it since) is a plain miss, and the task runs
(2026-10-23).

What `hasMany` said is recorded in the index's `remote_hits`
(`remote-hits.ts`), hits only, so another process trusts it
(`remoteKnown`): a pull of a kept hit starts at once, waiting on no
probe. A task's own lookup waits on no probe either: it GETs at once.
Waiting made every remote hit two round-trips, the probe then the GET
(~300 ms an up-to-date task on CI, 2026-10-24); a miss's GET answers as
fast as the probe would, so the cost is one GET for each task that asks
before the probe answers. A whole `hasMany` answer rewrites the rows it asked (new hits
in, gone ones out), and a `get` every remote answers with `null` drops
its row. A `get` that fails keeps it: the key may still be there.
A remote whose batch gives no answer is asked `has` per key when a run
needs the answer to plan (`remoteHasEach`); that whole answer is
recorded the same way, and one failed `has` is no answer.

### What a failure says

A wire's own message names nothing: Bun's abort is "The operation timed
out.", a refused connection "Unable to connect. Is the computer able to
access the url?", a gRPC status carries its elapsed time but no server
or key. The layer knows the call and the artifact, the plugin knows the
server, so the line `onError` receives carries all three:

```
probe <hash> at <endpoint> failed: <cause>
probe of <n> artifacts at <endpoint> failed: <cause>   (hasMany)
download <hash> from <endpoint> failed: <cause>        (get, and a body ingest refused)
upload <hash> to <endpoint> failed: <cause>            (put, and the in-memory pack)
```

`<endpoint>` is the layer's optional `endpoint` field (without one the
clause is left out); a URL's `user:pass@`, query and fragment are dropped
before it is printed, since the field is a plugin's and the line is a
log. The error's `cause` is the layer's original throw.

A run's requests are concurrent, so one fact (an unreachable server)
fails every request at once. Each remote says each failure CLASS once
per run: the class is the error's `code` when
it carries one (a gRPC status, an errno, Bun's `ECONNREFUSED`),
else its message with the artifact's hash taken out. The operation is
not part of it. The requests held back are counted, and `close()` says
`<n> more requests failed the same way: <cause>` per class that had
any (the cause's hash written `<hash>`, since the repeats are other
artifacts), after `run()` has drained every upload and prefetch.

### Read path

1. `local.get(hash)` — return immediately on local hit. If the hash
   was materialized FROM remote earlier this run (prefetch or a
   sibling's read-through), the source flips to `'remote'` so
   provenance stays honest.
2. If no remote may be read → miss. `prefetch` sits behind the
   same gate: nothing is warmed from a remote either (item 641).
3. `pullFromRemote(hash)` — shared with `prefetch` through the
   in-flight map: each readable remote's `get` in order, skipping one
   a batch probe found without it, until a body ingests →
   `local.ingest(body)` → re-read local. `durationMs` from the wire rides the ingested entry; the
   producing execution's `cpuMs` / `peakRssBytes` ride the artifact's
   own sidecar, so no wire needs to carry them.
4. A task waiting on its download gives it up when the rest of the
   body would take longer than running the task: twice the stored
   duration, for the save a run adds, and never under one weighing
   (25 ms: a sub-ms task is stored as 0), against the body's own pace
   so far, weighed every 25 ms. The task then runs here, a miss, and
   uploads nothing (the remote holds the key). Only a key the batch
   probe sized and timed is judged; any other is awaited. 500 tasks at
   30 ms and 4 MB/s per connection, 20 of them 8 MB: 3070 ms → 1807 ms
   (min of 5); 200 tiny tasks tie.

### Write path

1. `local.save(args)` — synchronous (honors its own local-write gate).
2. For each writable remote: queue the PUT in its bounded background
   pool with a file-backed `Blob` over the just-written local artifact
   (or, when local writes are disabled — `--cache-policy=local:,remote:rw` —
   bytes packed in memory NOW, while the outputs are still on disk).
   The task's worker slot is released immediately; `run()` drains
   before close.

### Delegation

`key / recordRunBundle / stats / prune / restoreOutputs` are pure
delegations to the local `Cache`. The remote layer doesn't participate
in cache identity, run history, or eviction — those are workspace-
local concerns.

### What this does NOT do

- No wire knowledge — URLs, headers, integrity digests, redirects,
  timeouts all live inside the `RemoteCacheLayer` implementation
  (e.g. `@vzn/vx-reapi`'s CAS client).
- No write-batching or retry on transient errors. Fire-and-forget.
- No deadline of its own. Every call is awaited: a `get` that never
  settles holds its task, and a `put` holds `drainUploads()`, which the
  run awaits before it closes, unless the run was stopped. The layer bounds its own requests: the
  first-party layers do, and the plugin guide's example shows how
  (item 856).

### Tests

`tests/layered-cache.test.ts` drives an in-memory stub
`RemoteCacheLayer` (counters for has/get/put) and asserts the
read-through / write-through / prefetch-dedup / degradation /
delegation contracts. `tests/orchestrator-remote.test.ts` covers the
end-to-end run paths (remote hit, plan prediction, never-fail,
at-most-once, injection precedence). `tests/slow-download.test.ts`
holds the judge: a body slower than its task runs the task, one faster
or unsized is awaited.

### Replacing this module

Most likely replacement: **a layered cache with a different topology**
(e.g., local → regional → global). Keep the public methods stable and
the orchestrator doesn't change. A different WIRE never touches this
module — implement `RemoteCacheLayer` in a plugin instead.

## `src/cache/remote-lane.ts` — one declared remote, as `LayeredCache` reaches it

### Purpose

Everything about one remote that does not depend on the others: what the
run lets it do, the boundary its answers cross, its upload pool and its
warnings. `LayeredCache` builds one lane per declared remote and owns the
order, the local store and provenance.

### Public surface

```ts
export function networkConcurrency(): number // min(96, max(cores × 3, 64)): requests at once to a remote
export function sayRemoteFault(r: ResolvedRemote, e: Error): void // its onError, else a `[vx] remote cache:` line on stderr
export interface ResolvedRemote {
  readonly remote: RemoteCacheLayer
  readonly plugin?: string // the plugin that supplied it: its keychain is what `open` reads
  read: boolean // the run's remote read; cleared when `open` throws
  write: boolean // the same for writes
  readonly onError?: (err: Error) => void // default: stderr
}

export type RemoteOp = 'probe' | 'download' | 'upload'

export class RemoteLane {
  constructor(resolved: ResolvedRemote, traffic: RemoteTraffic, uploadConcurrency?: number)
  get read(): boolean // `resolved.read`, read live
  get write(): boolean
  has(hash: string): Promise<ArtifactInfo | null> // a failure is null
  hasMany(hashes: readonly string[]): Promise<Map<string, ArtifactInfo> | null> // records the rest absent
  get(
    hash: string,
    fresh?: boolean,
  ): Promise<{ body: Blob | Response; durationMs?: number } | null | undefined> // undefined: no answer
  upload(hash, durationMs, body: () => { body: Blob; release? }, tally): void
  distrust(hash: string): void // its bytes here did not read back: uploaded again, held or not
  drain(): Promise<void>
  stop(): void // no upload starts; drain and reads stop waiting
  get whenStopped(): Promise<void> // settles at stop()
  close(): void // says the held-back repeats
  report(op: RemoteOp, subject: string | { batch: string }, err: unknown): void
}
```

### Rules

- **Never throws.** A throw, a malformed answer (a `body` that is not a
  `Blob` or `Response`, a `hasMany` that is not a `Map` or `null`) is a
  miss, reported once per failure class (see cache.md, "What a
  failure says").
- **Absences are its own.** A batch probe records the hashes this remote
  lacks; a later `get` of one skips the round-trip. A sibling's answer
  never marks this remote.
- **Uploads**: at most `cache.concurrency.upload` at once per remote, FIFO; `body()` is asked
  when the job starts, so a queued job holds no bytes; each landed or
  failed upload is tallied on the local cache's `uploads`. A key it holds
  is not sent again, unless its download here was a corrupt artifact
  (`distrust`): the re-run's save sends good bytes over the bad ones, its
  `put` told `replace`. Corrupt is a `CorruptArtifactError` by name, from
  core's ingest or the layer's own check of its body (a digest).
- `ResolvedRemote` is also what a plugin's `ctx.cache` and the run store
  walk (`cache.md`), so all three gate a remote the same way.

### Tests

`tests/layered-cache.test.ts` (one remote: shapes, warnings, uploads)
and `tests/resolve-cache.test.ts` (declared order, several remotes over
one local store).

## `src/cache/inputs.ts` — input/output glob resolution + cleaning

### Purpose

Turn a task's declared `inputs` into concrete data the cache key
can hash:

- a sorted list of absolute file paths whose contents will be hashed
- a sorted list of `[envName, hostValue]` pairs
- sorted `[command, output]` pairs for `inputs.runtime` and
  `workspaceRuntime` (each command run once per run through a memo)

Plus the helpers that resolve and clean `outputs.files` and
`outputs.workspaceFiles`.

### Public surface

The git side is `git-inputs.ts` (see git-inputs.md); this module
re-exports it for readers that reach it here: `GitFilesCache`,
`populateGitFilesCache`, `runGitLsFiles`, `startGitEnumeration`,
`applyGitEnumeration`, `gitPathspecs`, `parseCheckAttrOutput`,
`autocrlfConverts`, `gitStatWeakened`, `attributeFilesOutsideTree` and
the `GitEnumeration` type.

```ts
/** Does `task` declare this changed path an input? A project-relative
 *  path is matched against `inputs.files`, a workspace-relative one
 *  against `inputs.workspaceFiles`; own outputs and negations apply.
 *  null skips that half. `--affected`'s per-task seed. */
export function declaresInput(
  task: TaskConfig,
  projectRel: string | null,
  workspaceRel: string | null,
  dirLink?: boolean, // the path is a link to a directory: a glob that may reach below it counts, unless a negation takes back its whole tree
  untracked?: boolean, // git does not track it: under the task's own outputs it is no input
  projectDir?: string, // the task's project, workspace-relative: its outputs.files a workspaceFiles glob reaches
): boolean

/** May `inputs.workspaceFiles` name a file under `dir` (workspace-relative)?
 *  By the positive entries' static prefixes. A changed nested repository is
 *  one path for all its files; `--affected` asks this of it. */
export function workspaceFilesReachInto(task: TaskConfig, dir: string): boolean

/** Paths a task names outright (literals, globs' fixed prefixes): `files`
 *  project-relative, `workspaceFiles` root-relative. */
export function namedOutright(task: TaskConfig): { files: string[]; workspaceFiles: string[] }

/** The entries of `named` (absolute) a git-ignored input can be under, by
 *  the rule a key reads them: git lists nothing at or under one, or
 *  ignores a new file directly in it. `listed` is what git lists, absolute,
 *  with the directories above. `vx watch` judges a git-ignored edit there
 *  only: `src` of `src/**` over a listed `src` is none. */
export function namedIgnoredReach(
  root: string,
  named: readonly string[],
  listed: ReadonlySet<string>,
): string[]

/** What a probe answers here: an `inputs.runtime` command run in
 *  `projectDir`, or with `workspace` a `workspaceRuntime` one run in
 *  `workspaceRoot`. For an executor that checks a task's probes where it
 *  runs it (`TaskExecutor.runtime`). */
export function answerRuntime(
  command: string,
  projectDir: string,
  workspaceRoot: string,
  workspace?: boolean,
): Promise<string>

export interface ResolvedInputs {
  files: string[] // absolute paths, sorted
  listings: InputListing[] // what `files` was filtered from, for `addedInput`
  envValues: Array<[name: string, value: string | undefined]> // sorted by name; undefined = unset
  runtimeValues: Array<[command: string, output: string]> // sorted by command
  workspaceRuntimeValues: Array<[command: string, output: string]>
}

export interface ResolveInputsArgs {
  projectDir: string
  workspaceRoot: string
  envSource: NodeJS.ProcessEnv
  inputs: InputsConfig | undefined
  ownOutputs: readonly string[] // project-relative globs to exclude
  ownWorkspaceOutputs?: readonly string[] // root-relative `outputs.workspaceFiles` to exclude from `inputs.workspaceFiles`
  nestedProjectDirs: string[] // absolute dirs of nested projects
  gitFilesCache?: GitFilesCache // per-run memo of `git ls-files` per project
  runtimeCache?: Map<string, Promise<string>> // per-run memo of `inputs.runtime`, keyed projectDir + '\0' + command
  workspaceRuntimeCache?: Map<string, Promise<string>> // per-run memo of `workspaceRuntime`, keyed by command
  runtimeScope?: string // a task id: both memos above answer this task's probes apart from every other's (X-34)
  workspaceFilesCache?: WorkspaceFilesCache // per-run memo of `inputs.workspaceFiles` per declaration
  projectFilesCache?: ProjectFilesCache // per-run memo of `inputs.files` per project + declaration
  skipFiles?: boolean // resolve no files: the caller folds them from a `filesToken` memo
}

export type WorkspaceFilesCache = Map<
  string,
  { snapshot: readonly string[]; result: Promise<string[]> }
>

export type ProjectFilesCache = Map<
  string,
  { snapshot: readonly string[]; result: readonly string[] }
>

// One git listing a task's input files were filtered from.
export interface InputListing {
  root: string // project dir, or the workspace root for `workspaceFiles`
  workspaceRoot: string // where git's location variables point; a nested repo's root is listed without them
  listed: readonly string[] // root-relative, as git listed them
  isInput: (rel: string) => boolean // the declaration's verdict
  linked: (rel: string) => boolean // a link to a directory here is an input; a negation counts only if it takes back the tree beneath
  nested: (rel: string) => boolean // inside a nested project
  prefixes: readonly string[] // directories a positive entry reaches, '' for the root
  literals: readonly string[]
}

// An input file that exists now and that `keyFiles` lacks, or undefined.
export function addedInput(
  listings: readonly InputListing[],
  keyFiles: ReadonlySet<string>,
  listedAt: number, // ms epoch the listings are as old as
): string | undefined

export async function resolveInputs(args: ResolveInputsArgs): Promise<ResolvedInputs>

// What a task's files fold to is a function of this token, or undefined (only resolving says).
export function filesToken(
  args: Pick<
    ResolveInputsArgs,
    | 'projectDir'
    | 'workspaceRoot'
    | 'inputs'
    | 'ownOutputs'
    | 'ownWorkspaceOutputs'
    | 'nestedProjectDirs'
    | 'gitFilesCache'
  >,
): string | undefined

// `inputs`, the task's own `inputs` (`files` under `projectDir`,
// `workspaceFiles` under `workspaceRoot`): an output directory linked into
// them refuses the task, here and in every walk below, the workspace
// twins too (X-55 through a link).
export interface OwnInputs {
  projectDir: string
  workspaceRoot: string
  declared: InputsConfig | undefined
}
export async function resolveOutputs(args: {
  projectDir: string
  outputs: readonly string[]
  nestedProjectDirs: string[]
  inputs?: OwnInputs | undefined
}): Promise<string[]>

// Whether resolveOutputs takes `rel`, without the walk: a directory
// snapshot's file list is held to the entry's rows through it.
export function outputWalkTakes(
  projectDir: string,
  outputs: readonly string[],
  nestedProjectDirs: string[],
): (rel: string) => boolean

// resolveOutputs, plus the empty directories the globs match: a save keeps them.
// `special` also lists the FIFOs, sockets and devices they name (Bun's walk
// skips them): a save leaves them out and warns, a clean removes them.
// `'later'` hands `findSpecial` instead: a hit's walk lists them only when
// it restores. `clearing` words a non-UTF-8 name's refusal for a clean.
export async function resolveOutputTree(args: {
  projectDir: string
  outputs: readonly string[]
  nestedProjectDirs: string[]
  inputs?: OwnInputs | undefined
  special?: boolean | 'later'
  clearing?: boolean
}): Promise<OutputTree> // { files, emptyDirs, special: string[], findSpecial?: () => string[] }

/**
 * Remove every file currently matching the declared output globs.
 * Called before every cache-miss exec AND before every cache-hit
 * restore so the project dir lands on a clean slate. Returns the
 * project-relative POSIX paths it removed (for
 * `GitFilesCache.markOutputsChanged`).
 */
export async function cleanOutputs(args: {
  projectDir: string
  outputs: readonly string[]
  nestedProjectDirs: string[]
  inputs?: OwnInputs | undefined
  committed?: (abs: string) => boolean // git tracks it: never removed (default: asks git)
  resolved?: readonly string[] | undefined // the walk's files, when the caller just walked
  beforeRun?: boolean // the command runs next: a directory the clean opened stays open
  kept?: string[] // filled with the committed files it found and left (absolute)
}): Promise<string[]>

// The same pair for `outputs.workspaceFiles`, anchored at the root with
// no project-dir exclusion; the clean returns the root-relative paths
// it removed, for `GitFilesCache.markWorkspaceOutputsChanged`.
export async function resolveWorkspaceOutputs(
  args: {
    workspaceRoot: string
    outputs: readonly string[]
    inputs?: OwnInputs | undefined
    clearing?: boolean
  },
  emptyDirs?: Set<string>, // filled with the empty directories the globs match
  special?: SpecialProbe, // its `find` set to list the FIFOs, sockets and devices they name
): Promise<string[]>
// `resolveOutputTree` for `outputs.workspaceFiles`: the files and the empty directories.
export async function resolveWorkspaceOutputTree(args: {
  workspaceRoot: string
  outputs: readonly string[]
  inputs?: OwnInputs | undefined
  special?: boolean | 'later'
  clearing?: boolean
}): Promise<OutputTree>
export async function cleanWorkspaceOutputs(args: {
  workspaceRoot: string
  outputs: readonly string[]
  inputs?: OwnInputs | undefined
  committed?: (abs: string) => boolean
  resolved?: readonly string[] | undefined
  beforeRun?: boolean
  kept?: string[]
}): Promise<string[]>

// No clean removes a file git tracks (2026-10-14); `committedFiles`
// answers from the run's enumeration, listing a dir it did not cover once.
export function committedFiles(
  cache: GitFilesCache | undefined,
  dir: string,
): (abs: string) => boolean

/** A literal entry compiles to itself plus its subtree: `src/` → `src`, `src/**`. */
export function asTrees(patterns: readonly string[]): string[]

// An ADDITIVE task (its outputs overlap an upstream's, with the edge that
// orders them; item 588) owns what its run added or changed, not what
// its glob selects: the stamp before, the diff after, and a clean by
// recorded rows rather than by glob. A file it found and left alone is
// its own too when `mine` says a save or restore of the task left it so.
// The diff is undefined when the run removed a file it found: no entry
// replays a removal, so none is saved.
export interface OutputStamp {
  size: number
  mtimeMs: number
  ino: number
  ctimeMs: number
}
export async function stampOutputs(args: {
  projectDir: string
  outputs: readonly string[]
  nestedProjectDirs: string[]
  inputs?: OwnInputs | undefined
}): Promise<Map<string, OutputStamp>>
export async function ownOutputsSince(
  args: {
    projectDir: string
    outputs: readonly string[]
    nestedProjectDirs: string[]
    inputs?: OwnInputs | undefined
  },
  before: ReadonlyMap<string, OutputStamp>,
  mine?: (abs: string) => boolean,
): Promise<string[] | undefined>
// The same two for root-anchored `outputs.workspaceFiles` (A-43).
export async function stampWorkspaceOutputs(args: {
  workspaceRoot: string
  outputs: readonly string[]
  inputs?: OwnInputs | undefined
}): Promise<Map<string, OutputStamp>>
export async function ownWorkspaceOutputsSince(
  args: { workspaceRoot: string; outputs: readonly string[]; inputs?: OwnInputs | undefined },
  before: ReadonlyMap<string, OutputStamp>,
  mine?: (abs: string) => boolean,
): Promise<string[] | undefined>
// No clean deletes a committed file, so before a retry these tell whether
// a failed attempt added, removed or touched one among the files a clean
// found: the pass is then not saved.
export function stampCommitted(
  files: readonly string[],
  committed: (abs: string) => boolean,
): Map<string, OutputStamp>
export function committedMoved(
  files: readonly string[],
  committed: (abs: string) => boolean,
  before: ReadonlyMap<string, OutputStamp>,
): boolean
export async function cleanOutputPaths(args: {
  projectDir: string
  rels: readonly string[]
  outputs: readonly string[]
}): Promise<void>
// Remove the `.vx-tmp-*` restore temps a killed run left beside the
// exact-file outputs; a temp whose writer is alive stays.
export function sweepRestoreTemps(
  base: string,
  outputs: readonly string[],
  committed?: (abs: string) => boolean,
): void
// Remove the `.vx/tmp/<pid>-0` staging a killed run left; a live run's
// stays. Once per run.
export function sweepStaging(workspaceRoot: string): void

// Kill every runtime probe still running that these memos (one run's
// runtimeCache and workspaceRuntimeCache) started, with its tree: a run's
// stop calls it, so a Ctrl-C does not wait a probe out, and another run in
// the process keeps its own (C-65).
export function stopRuntimeProbes(...memos: readonly Map<string, Promise<string>>[]): void
```

`filesToken` names what `resolveFiles` would resolve and the key would
fold for a task's files without resolving them: the project's
`filesDigest` (git-inputs.md), the workspace root and the declaration
`resolveFiles` keys its own memo on, and for `workspaceFiles` the
declaration and `declarationDigest` of the workspace paths its globs may
take in (git-inputs.md). It is undefined for a declaration that names a
gitignored path outright,
and a partition holding anything the enumeration did not vouch for (a
linked or undecodable file, a loose one within the racy window, or a
path a run already marked changed that the partition lists or the
declaration's globs take). `computeTaskHash` keys the fold memo on it
(task-hash.md).

### File resolution rules

The candidate file set comes from git — `git ls-files --cached
--others --exclude-standard` in the project directory — and the user's
`inputs.files` globs are applied as a filter on top. There is no
other walker: a project outside a git work tree is a `UserError`
("vx requires git").

1. **Candidate enumeration.** `git ls-files` yields tracked files PLUS
   untracked-but-not-ignored files. `.gitignore` cascades (workspace +
   every nested), plus `.git/info/exclude` + global excludes, are
   honored — git applies them for us. This matches what Turbo and Nx
   do internally. The listing is memoized per run in `GitFilesCache`
   (one spawn per project, or one workspace-wide spawn through
   `populateGitFilesCache`); a nested repository — a submodule, an
   embedded repository, which the workspace's git holds as one gitlink
   — is enumerated by its own git, whether a project sits inside it or
   it sits inside a project.
2. **Positive globs** — `inputs.files` strings without `!`.
   The default when `inputs.files` is undefined is `['**/*']`.
   Each is normalized (a leading `./`, inner `./` segments, doubled
   slashes, a trailing slash and a trailing `/.`) and checked against the candidate
   set via `Bun.Glob.match`. A literal entry — no glob character —
   means the file or its whole tree: `src/`, `src` and `dist` all
   compile to the path plus `<path>/**` (`asTrees`, defined in
   `util/paths.ts` and re-exported here — the graph's
   overlapping-output refusal reads the same rule), as in Turbo and
   every `.gitignore`. An entry git answers nothing for — a literal, or
   a glob's fixed prefix (`dist` of `dist/**`), with no listed path at
   or under it — is read from disk (`ignoredReach`, `ignoredInputs`):
   gitignored, named outright, so an input (2026-10-16). Outside
   the per-run memo, since a dependency writes there mid-run. One that
   does not exist (under a parent that is a file, too) stays silent
   until it does.
3. **Negative globs** — entries starting with `!`. The `!` is
   stripped; the rest becomes a `Bun.Glob` (a literal is a tree here
   too) and any matched path is removed.
4. **Always-ignored** — hard-coded
   (`.git/**`, `.vx/cache/**`,
   `.vx/projects.lock.json`, `vx.lock.json`, `.vx/.gitattributes`,
   `.vx/.gitignore`, `.vx/dependencies.lock.json`, `.vx/tmp/**`,
   `.vx/projects.lock.json.tmp-*`, `.vx/dependencies.lock.json.tmp-*`,
   `vx.lock.json.tmp-*`, relative to the project)
   — applied as a defense-in-depth even if git happens to track
   something there. `workspaceFiles` adds every project's review copy,
   `**/vx.lock.json`. They are reserved only where vx writes them: at any
   depth, a project's own `src/.vx/tmp/x` keyed nothing. The lock file is vx's own frozen-config metadata,
   never a task input, and `.vx/tmp/` is where vx's restores stage.
   `node_modules` is
   not here: the enumeration drops an UNTRACKED file under one that git
   does not ignore (`isInstalledPath`, an install); an ignored one is any
   ignored path, an input when named outright (a generated client); and
   a tracked one is a source. By
   path, a committed fixture under `tests/fixtures/node_modules/` left
   the key and an edit to it replayed the old output (X-4). Nor is a
   tool's temp file (2026-10-16): Bun's `.bun-build` intermediate
   and cross-compile extraction directory are the compile task's to
   exclude in its own `inputs`.
5. **Boundary ignores** — a path under a nested project's directory
   (relative to this project), by ancestor lookup, not a glob (A-11).
   Cross-project isolation contract.
6. **Own outputs** — declared `outputs.files` are excluded, and so
   are the task's `outputs.workspaceFiles` that land in its project; a
   `workspaceFiles` input drops both namespaces too. Prevents
   self-invalidation: an output one namespace reached through the other
   moved the key with every build, and no run was saved.
7. **Existence check** — `git ls-files --cached` can surface a
   deleted-but-tracked path; we drop entries that are not on disk so
   the hasher doesn't throw ENOENT. "On disk" is an `lstat`: a regular
   file or a symlink (to anything, or to nothing — its target string
   folds, as in git, then what it points to: cache/linked-inputs.ts); a directory is not an input (git lists a
   gitlink at its path and `**/*` matches it). Paths carrying a
   trusted index OID skip the probe (a clean tracked file necessarily
   exists), which is why `skip-worktree` / `assume-unchanged` entries
   have their OID dropped up front — git is not watching those, so
   their OID says nothing about whether the file is on disk.

The matched absolute paths are sorted alphabetically and returned,
with the listing each half was filtered from (`listings`).

`addedInput` is the save's check for a file added since that listing
(caching.md § re-checked before the save): it `lstat`s each listed
directory a positive entry reaches, reads one whose ctime moved since
`listedAt` (less the racy window), and asks `git ls-files` only when a
name there matches the declaration and the key lacks it, or names an
unlisted directory; a literal absent from the key that exists now is
asked too, and a new link to a directory a glob may match below
(`InputListing.linked`). Blind to a file added inside a directory that held no
listed file and was not itself created since the listing.

### Env resolution rules

Listed `inputs.env` names are looked up in `envSource` (the
host's `process.env`):

- Set names → `[name, value]` pair.
- Unset names → `[name, undefined]`, which the key folds apart from
  every value, `''` included, and from "name was never listed".
- Sorted by name for deterministic key ordering.
- A value holding U+FFFD is a `UserError` naming the variable, never
  its value. Bun decodes the environment lossily, so Latin-1 `é` and
  `è` both read as U+FFFD and keyed alike; no raw bytes are readable on
  every platform (Linux's `/proc/self/environ` misses what vx sets
  itself), so a value that truly holds U+FFFD is refused with them.

### Output resolution rules

`resolveOutputs` is a simpler glob pass:

- Globs run against the project dir (a literal is a tree here too); a
  `!` entry takes its matches back (A-44).
- The project root's `.git`, `.vx` and `vx.lock.json` excluded whatever the glob, and
  for `resolveWorkspaceOutputs` every project's `vx.lock.json` (`outputExcluded`: no task
  produces them and their loss is unrecoverable), and every
  `node_modules` unless a glob names one (A-13): `**/*.js` cleaned the
  installed files, while an install task's `node_modules/**` keeps them.
  The same holds for `resolveWorkspaceOutputs`. A project glob also takes
  one under its own literal directory (`.output/**` takes
  `.output/server/node_modules/**`, the build's own).
- Nested-project subtrees excluded (boundary isolation).
- **No gitignore filter** — outputs like `dist/` are usually
  gitignored on purpose, and we still want to capture them.
- **Only paths really inside the project**, after resolving each
  output's directory: Bun 1.4.0's `Glob.scan` descends into a
  symlinked directory, so `dist -> ../victim` yielded paths that are
  lexically inside the project while the files are not — and the
  caller deletes what this returns. A directory that will not resolve
  is refused (a broken link, or a race with the producing task).

Returns sorted absolute paths. `resolveWorkspaceOutputs` is the same
pass for `outputs.workspaceFiles`, anchored at the workspace root and
deliberately without the project-dir exclusion.

`cleanOutputs` removes every match, then the directories it emptied,
bottom-up, but only inside the trees the task declared (before a miss;
`cleanWorkspaceOutputs` too, and `cleanOutputPaths`, which a hit uses
after its in-place restore to remove the outputs its entry does not hold): below each
wildcard glob's root, and at or below each literal output (a directory
left standing where the entry or the task needs a file of the same name
blocks it). The glob's root stays, since the task writes under it and
removing it cost an rmdir and the task's mkdir (B-49). A directory above
it or holding a literal output (`out` for `out/a.txt`) stays, since a
sibling task running beside this one may have just made it and not yet
written into it. An additive task's clean by its recorded rows
(`cleanOutputPaths`, item 588) prunes by the same scope, from the
task's declared outputs. A
directory of this user's that withholds its own write (`chmod 555
dist/ro`) gets owner write for the remove and its mode back after, and
the prune reopens one the same way to remove an emptied subdirectory
(`tests/clean-readonly-dir.test.ts`). Before the command runs
(`beforeRun`) no mode is given back: a kept glob root the task made 555
(`chmod 555 dist`) refused the command's own write, and the task never
missed again. A declared output the process
cannot remove even so — another user's `dist/`, a read-only checkout —
is a `UserError` naming the path, not an internal error.

An output directory the task left unlistable (`chmod 000 dist/s` or
`111`) stopped the output walk with EACCES. A walk for a clean or a
restore gives this user's own read and search for its listing and the
mode back after; a save refuses it, `cannot list declared output
directory dist/s: EACCES — …`, as it cannot store what it cannot read.
An ignored input under a directory the walk cannot list is refused the
same way, `cannot list input directory <path>: EACCES — …`
(`tests/unlistable-input-dir.test.ts`).

### What this does NOT do

- Doesn't hash file content (that's `file-hashes.ts`'s `FileHashStore`
  under `orchestrator/task-hash.ts`).
- Doesn't apply `inputs.tasks` filtering (that's
  `orchestrator/upstream.ts`'s `filterUpstreamHashes`).
- Doesn't support workspace-relative globs in `inputs.files` —
  intentionally scoped per-project. For workspace-root-anchored files use
  `inputs.workspaceFiles` (root-relative globs); see
  [`../schema.md`](../schema.md). A workspace-level `globalInputs` field is
  an owner-rejected non-goal.
- Doesn't follow symlinks. Inputs come from git, which reports a link as
  a link, and the key reads what it points to (`linked-inputs.ts`); the OUTPUT scan yields symlinks as outputs (cached as the
  link, unlinked on clean) and never descends through one below
  a glob's literal head. A link IN that head (`dist -> real-out` for
  `dist/**`) is followed by the scan and the clean alike; one resolving
  outside the project is a `UserError` naming it (X-88). The heads that
  check finds absent the scan skips without asking again: a restore
  after a clean asked twice about each missing `dist` (2026-11-07).

### Tests

Two test files cover this module:

**`tests/inputs.test.ts`** — direct unit tests against `resolveInputs`,
`resolveOutputs`, `cleanOutputs`, each on a real git repository in the
fixture, plus the `gitFilesCache` memo, the single workspace-wide
spawn, the symlink edge cases and the runtime values. The git-path
block verifies:

- Nested `.gitignore` patterns are correctly anchored (the v13 bug).
- Untracked-but-not-ignored files participate immediately.
- Workspace-root `.gitignore` excludes via git.
- `.git/info/exclude` honored.
- Deleted-but-tracked files skipped (no ENOENT).
- Declared outputs still excluded under the git path.
- Nested-project boundary still excludes under the git path.
- Negation in `inputs.files` still strips under the git path.
- `node_modules` always-ignored even when force-added to git.

**`tests/inputs-moved.test.ts`** — `addedInput` end to end: a file
added mid-run in a listed directory, in a new one, a literal that
appears, and the control (an ignored file, a non-matching one).

**`tests/orchestrator.test.ts`** — e2e behaviour:

- default = all files (gitignore-aware)
- narrow globs limit cache busting
- negation excludes
- self-invalidation guard (declared outputs excluded)
- boundary isolation (nested project files don't leak)
- gitignored files excluded; negated gitignore re-included
- empty `files: []` produces stable hash
- env input value changes bust cache; unset, empty and unlisted are three keys

### Replacing this module

Possible directions:

- **Auto-tracking inputs is NOT one** (vite-task style syscall spying,
  the observed set becoming the next run's inputs): owner-rejected
  (CLAUDE.md § Rejected). Inputs stay declared. A task that wants its
  reads confined to what it declared asks for that with `exec.sandbox`.
- **Cross-project inputs** exist as `inputs.workspaceFiles`
  (root-relative globs, which may reach into another project's
  directory) and, for outputs of an upstream task, through `dependsOn`
  folding the upstream INPUT key. A per-project `{ project, files }`
  form is not planned: the two cover the cases, and project boundaries
  stay hard for plain `files` globs.
- **Enumeration from something other than git's index** (a VFS, a
  watchman daemon, a different VCS) — replace the one worktree walk in
  `resolveFiles`; the identity contract (a blob id for a tracked-clean
  file, a content hash otherwise) stays, since the cache key folds it.

## `src/cache/git-inputs.ts` — git-backed input enumeration

### Purpose

Talk to git once per run and turn the answer into what the resolver
trusts: `git ls-files -s` (paths with their index blob OIDs, stage 0,
regular files and symlinks), `git status --porcelain -z` (which of those
are dirty, plus the untracked; `--no-renames`, so a rename's source,
the original of a `git add -N` copy (item 976) or a deletion paired with
an unmerged path (A-59), is a deletion of its own), and `git check-attr --all` where a clean
filter (`text`, `eol`, `ident`, a `filter` driver, `working-tree-encoding`,
the legacy `crlf`, `core.autocrlf`) could make the blob
differ from the bytes on disk. The gate looks for a `.gitattributes`
among every listed path, untracked and modified ones too: git applies
those, and a scan of the trusted paths alone never saw them (item 977),
and an ignored one, which the status walk names with `--ignored=matching`
(A-19). `ls-files --debug` gives the worktree size the index recorded
for each entry, and a trusted OID whose blob is another size is dropped:
a filter since removed left a stat-clean entry git never re-reads (A-60).
A filter that kept the size passes the check; `caching.md` names it and
the remedy, `git add --renormalize .`.
The verdict is kept by a hash of the index file, the pathspecs and the
workspace's repo prefix (`blob_verdicts`; its paths are
workspace-relative), so a
warm run reads the file and one row and spawns nothing more; a changed
index spawns the `--debug` listing, asks the cache's `blob_sizes` memo and
`git cat-file --batch-check` per core for the unknown ones; `checkBlobSizes` runs the
check once per enumeration (a run starts it as its cache opens) and
`applyGitEnumeration` waits on it, so every caller of it gets it. Split from `inputs.ts` on 2026-09-10:
this file talks to git; `inputs.ts` decides which files a task declared
and where the project boundary is.

A scoped run passes each project dir as `:(literal)<dir>`: a dir is a
path, never pathspec magic. Raw, `:top` was read as `top` and listed
none of its files, and `*g` as a glob also listed `:top/src/log`, so
`:top`'s slice was not empty and an edit to its `src/f` left the key
(a stale hit).

git warns `could not open directory` and exits 0 when a walk cannot
enter a directory, so the files under it were in no key: past PATH_MAX
(4096 bytes on Linux) an edit there was a stale hit. The status walk and
`runGitLsFiles` refuse such a warning, naming the directory (git cuts its
message at 4096 bytes, so a long one is shown cut). A directory this user
may not enter is left out as before: no task of theirs reads under it
either, and a root-owned volume beside the projects must not stop every
run. One it may enter but not list (`chmod 111`) is refused, `git could
not list the directory <dir>: it can be entered but not read …`: a task
reads a file there by name, and an edit to it was a stale hit
(`tests/unlistable-input-dir.test.ts`).
A directory gone before git opened it (a run lock's staging directory in a
TMPDIR inside the workspace) holds no file to miss, so it is skipped too,
and so is one git's reason says was gone (`No such file or directory`,
`Not a directory`) though it is back by the check: a task re-created its
own output directory under another task's walk, which was refused as a
path too long (2026-11-10).
A cut message is never skipped: it may name a prefix of a real path.

Every enumeration spawn runs `git --no-optional-locks`. A plain `status`
refreshes the index under `index.lock` when files are stat-dirty, and the
user's own `git add` or `commit` failed on that lock while a vx run held
it: 12 of 1,165 across 80 runs, 0 of 1,121 with the flag (item 880). A
clean tree costs the same. The flag does not reach a porcelain `git diff`,
which refreshes regardless; `--affected`'s diff turns the refresh off
instead (`workspace.md`).

So vx never refreshes the real index, and a fresh checkout's is racily
clean: written in the second its files were, so git re-hashes every file
on every `status` until something rewrites it. When the index holds such
an entry, the enumeration copies it beside itself (`vx-index-<hash>`,
named by its bytes, keeping its mtime so git's racy rule still holds),
runs `git update-index -q --refresh` on the copy once, and points `status`
at it with `GIT_INDEX_FILE`. Later runs on the same index reuse the copy.
A synthetic 5,300-file clone: 310 to 223 ms a run; a refreshed tree pays
nothing. Skipped when a git location variable is set.

`ls-files` and `status` each read the index on their own, so the index
file is stamped (inode, ctime, size) before the listing spawns and after
the status ends; an index written between them trusts no OID and every
file hashes from disk. A `git reset` of a staged edit landing between the
two made the file clean to `status` while `ls-files` had listed the staged
blob, which then keyed the committed bytes. The blob-size check's
`--debug` listing, spawned later, holds the same stamp: an index written
since trusts no OID (A-60's check would judge entries the OIDs did not
come from). The stamp needs the index
path before the listing spawns, so `repoFacts` is asked first: one
enumeration on this repo, min of 30 interleaved fresh processes, 13.25
before against 13.23 ms after in a plain clone, 16.43 against 15.46 ms
in a linked worktree (its rev-parse spawn), 2026-10-29.

### Public surface

```ts
// Per-project file snapshots (the Map), with what the resolver needs beside them.
export class GitFilesCache extends Map<string, readonly string[]> {
  setWorkspaceRoot(root: string): void
  setWorktreeDirty(dirty: boolean | null): void // what `git status` said, for the run context
  get worktreeDirty(): boolean | null
  markOutputsChanged(projectDir: string, relPaths: readonly string[]): void // a save or restore wrote these
  noteTracked(scopes: readonly string[], absPaths: readonly string[]): void // what the index lists under these dirs
  noteTrackedLater(scopes: readonly string[], absPaths: () => Iterable<string>): void // the same, listed on the first committedIn question
  committedIn(dir: string): (abs: string) => boolean // git tracks it or a gitlink above it, never a link above it: never cleaned (lists an uncovered dir once)
  markWorkspaceOutputsChanged(workspaceRoot: string, relPaths: readonly string[]): void
  invalidateWorkspacePartition(): void
  clear(): void // every partition AND its OIDs and pending marks (a write that reached the workspace)
  oidsFor(projectDir: string): ReadonlyMap<string, string> | undefined // trusted index OIDs by path
  setOids(projectDir: string, oids: Map<string, string>): void
  filesDigest(projectDir: string, snapshot: readonly string[]): string | undefined // the partition's paths + OIDs (a file with none by its stat), none a link
  declarationDigest(
    root: string,
    snapshot: readonly string[],
    key: string,
    takes: (rel: string) => boolean,
    heads?: readonly string[], // its entries' fixed heads: only paths at, under or above one are asked, found in a sorted copy when git listed untracked paths last
  ): string | undefined // filesDigest of the workspace paths a workspaceFiles declaration may take in
  statOf(abs: string): Stats | undefined // a path's lstat, once until a partition moves
  identityOf(abs: string): string | undefined // a file's key identity (`hashFile`'s answer), once until the run marks a write to it
  get factsEpoch(): number // moves with every write the run marks
  learnIdentities(ids: ReadonlyMap<string, string>, epoch: number): void // kept only if no write since `epoch`
  noteFilesDigest(
    projectDir: string,
    snapshot: readonly string[],
    digest: () => string | undefined,
  ): void
  snapshotFor(projectDir: string, inputGlobs: readonly Bun.Glob[]): readonly string[] | undefined
  get undecodableNames(): ReadonlySet<string> // listed paths whose names are not UTF-8 (lossy spelling)
  markUndecodable(absPaths: readonly string[]): void
  setGitVars(listing: string | null): void // the enumeration's `git var -l`
  configValue(key: string): string | null | undefined // undefined: not read, ask git
  enumeratedAtMs: number | undefined // the enumeration's start: what `oidsFor` says is true as of then
  ignoredOutputs: ReadonlySet<string> // declared outputs (root-relative) git ignores whole, asked once per run (`orchestrator.md`)
  setIgnored(root: string, paths: readonly string[]): void // what `status --ignored=matching` named
  ignoredFilesIn(dir: string): string[] // the ignored files (not directories) that listing named under dir, absolute; a miss's undeclared state
  newFilesIgnored(dir: string): boolean // an ignored path lies under dir and git ignores a new file there (asked once per dir; a normalized dir under the root is relative as its rest, no path.relative; the first spawn asks every dir above an ignored path, up to 256; none for a dir `answerNewFilesIgnored` answered)
  answerNewFilesIgnored(dirs: readonly string[], ignored: (dir: string) => boolean): void // git's answer for root-relative dirs, asked beside the enumeration (`askIgnoredOutputs`); held until the next enumeration
}

export interface GitEnumeration {
  all: string[] // every path git listed, root-relative
  tracked: readonly string[] // every index path (a submodule as its gitlink), root-relative: never cleaned
  scopes: readonly string[] // the pathspecs listed, root-relative
  trusted: Map<string, string> // path → index OID, for the tracked-clean ones
  flagged: readonly string[] // tracked paths git does not look at on disk (assume-unchanged, skip-worktree)
  dirty: boolean | null
  vars: string | null // `git var -l` output, read once for config lookups
  changed: readonly string[] | null // what `status` listed (dirty, both sides of a rename, untracked)
  untracked: readonly string[] | null // status's untracked set, before nested repos expand (ls-files --others)
  undecodable: readonly string[] // listed paths whose names are not UTF-8, root-relative
  ignored: readonly string[] // what status named as ignored (`--ignored=matching`), root-relative, sorted
  startedAtMs: number // Date.now() before the spawns
  blobCheck: IndexBlobCheck // the blob-size check's input (A-60)
  catFile(stdin: string): Promise<{ exitCode: number; stdout: string } | null> // blob sizes (A-60)
}
export interface IndexBlobs {
  paths: string[] // regular stage-0 entries, index order (`ls-files --debug`)
  oids: string[]
  sizes: number[] // the worktree size the index recorded
  sameSecond: string[] // entries git cannot see a same-second rewrite of
}
export interface IndexBlobCheck {
  key: string | undefined // xxh3 of the index file, prefix and pathspecs: the verdict's key
  blobs(): Promise<IndexBlobs | null> // the `--debug` listing, spawned on a miss
  rekey(): Promise<string | undefined> // the key now: a verdict is stored only for its index
}
export interface BlobSizeMemo {
  knownBlobSizes(oids: readonly string[]): Map<string, number>
  rememberBlobSizes(sizes: ReadonlyMap<string, number>): void
  blobVerdict(digest: string): string[] | undefined
  rememberBlobVerdict(digest: string, paths: readonly string[]): void
}
export interface LazyGitEnumeration {
  start(): Promise<GitEnumeration> // the whole-tree enumeration, started once
  readonly started: Promise<GitEnumeration> | undefined
}
export function lazyGitEnumeration(workspaceRoot: string): LazyGitEnumeration
export function newFilesIgnoredIn(root: string, dirs: readonly string[]): Set<string> // which root-relative dirs git ignores a new file directly in, one check-ignore (`newFilesIgnored`'s probe)
export function freshProbe(dir: string): string // the path that probe asks for dir: a new file directly in it
export const MAX_SCOPED_PATHSPECS: number // 64: above it the walk is the whole tree
export function gitPathspecs(
  workspaceRoot: string,
  projectDirs: readonly string[],
  workspaceWide: boolean,
): string[]
export async function startGitEnumeration(
  workspaceRoot: string,
  pathspecs: readonly string[],
): Promise<GitEnumeration>
// The blob-size check, once per enumeration: started as the cache opens, awaited by applyGitEnumeration.
export function checkBlobSizes(enumeration: GitEnumeration, memo?: BlobSizeMemo): Promise<void>
export async function applyGitEnumeration(
  enumeration: GitEnumeration,
  workspaceRoot: string,
  projectDirs: readonly string[],
  cache: GitFilesCache,
  workspaceWide?: boolean,
  memo?: BlobSizeMemo, // the blob-size check's memo (`Cache`); absent, every size is asked
): Promise<void>
export async function populateGitFilesCache(
  workspaceRoot: string,
  projectDirs: readonly string[],
  cache: GitFilesCache,
  workspaceWide?: boolean,
): Promise<void> // start + apply in one call

export function runGitLsFiles(cwd: string, env?: Record<string, string>): GitLsResult // the synchronous per-project fallback

// Read off a plain `.git` directory (no location variable or
// `GIT_INDEX_FILE`, no include, no `.git` file), else one `git rev-parse
// --show-prefix --git-common-dir --show-object-format --git-path index
// --absolute-git-dir`; per directory per process; null (not remembered)
// when git fails. The sandbox reads the same memo for the git dirs it walls off.
export interface RepoFacts {
  prefix: string
  commonDir: string
  objectFormat: 'sha1' | 'sha256'
  indexFile: string
  gitDir: string // absolute
}
export function repoFacts(dir: string): RepoFacts | null
// The refusal the enumeration would throw (no git, not a work tree), asked
// before the picker; undefined, and free via repoFacts, when git tracks dir.
export function gitRefusal(dir: string): UserError | undefined
export function repoRootOf(workspaceRoot: string, gitPrefix: string): string // the repo root, from `--show-prefix`
// `lstat`, or undefined for no entry, under a parent that is a file (ENOTDIR) too
export function lstatOrAbsent(p: string): Stats | undefined
export function autocrlfConverts(gitVars: string): boolean // over `git var -l`
// `core.trustctime` off or `core.checkStat=minimal`: `git status` cannot see a
// same-size, time-keeping rewrite, so the enumeration trusts no OID (A-6).
export function gitStatWeakened(gitVars: string): boolean
// The attributes files git reads outside the tree: from 2.42 git names them
// (`GIT_ATTR_GLOBAL`, `GIT_ATTR_SYSTEM`); before, the lookup is mirrored.
export function attributeFilesOutsideTree(
  gitVars: string,
  env: Readonly<Record<string, string | undefined>>,
): string[]
```

`applyGitEnumeration` also digests each project's partition, its paths
and index OIDs joined and hashed once, when the enumeration trusted an
OID for every path and none is a symlink or an undecodable name.
`filesDigest` answers it only while the partition is that snapshot with
those OIDs and no path of the snapshot is marked changed: a
re-enumeration ends it for the run, and so does a save, clean or restore
that writes a listed path. One that writes only outside the snapshot (a
build's ignored `dist/`) leaves it: the listed files are as the digest
names them, and a task whose input globs take a marked path gets no
snapshot from `snapshotFor`, so no token. Refused on any mark, six in
seven of a cold 8,002-task bench run's keys stored no fold row, and the
restore after derived them again (2026-11-11). `declarationDigest` does
the same for the workspace partition, per `workspaceFiles` declaration:
the paths its globs may take in, each by OID, or by its stat and
whether git tracks it, once per declaration and partition; each path's
record once for every declaration, and a stat a project's digest took
is not taken again (`statOf`). An unsandboxed miss drops the workspace
partition; the next `workspaceFiles` task lists the root again
(`workspaceSnapshot`), and that listing, which carries no trusted OID,
is digested by stat alone. Refused there, the restore after a cold
vueuse build derived 11 of its 12 keys again (2026-11-12).

A file the index vouches no OID for (untracked, edited, or under a
`text`/`eol`/`filter` attribute, which drops every OID) is hashed from
the worktree. Its identity is held for the run (`identityOf`), so a
file several tasks read is stat'ed and hashed once, not once per task,
and the listing's existence check reads `statOf` too. A write the run
marks path by path (a save's or a restore's outputs) drops those paths'
identities, an undeclared write drops them all, a listing again drops
none, and an identity hashed before any write is not kept after it
(`factsEpoch`). The stats go on every one.

A marked path written through a linked directory (an output glob's head
may be a link that stays in the project, `out -> gen` for `out/**`) is
marked under the name it landed at too: marked only as `out/x`, the
`gen/x` a reader of `gen/**` keys kept its index OID and a stale hit
replayed the bytes from before the write. One that lands outside the
partition drops the partition, as an undeclared write does.

`gitPathspecs` scopes the spawn to the projects in the run when there
are at most `MAX_SCOPED_PATHSPECS` (64) of them and none is the root
itself; otherwise (or `workspaceWide`) it is `.`. A run that names more
projects than that starts the whole-tree walk early, as an unscoped run
does, since its configs cannot narrow it. A `git` that cannot be spawned at all — not
on `PATH` — is one `UserError` line (`gitSpawnRefusal`: "vx requires
git"), never a stack; a directory outside a work tree is the same
refusal with `git init` as the remedy.

`startGitEnumeration` is what `prepareRun` kicks off before the configs
load (the spawn overlaps evaluation). It spawns `ls-files`, `status` and
`var -l` (git's merged config and, from 2.42, the attributes files it
reads outside the tree) concurrently and asks `repoFacts` for the
prefix and the common dir while they run; the file hasher
(`file-hashes.ts`) asks the same memo for the object format at the same
directory (the workspace root, `new Cache(dir, policy, workspaceRoot)`),
so a cold run learns them ONCE whichever asks first — the
enumeration on an unscoped run, the config load on a scoped one
(`tests/git-spawns-once.test.ts` holds both as exact lists). A plain
repository (no `core.worktree` moving its work tree) answers off the
disk with no spawn at all (~3 ms a run;
`tests/repo-facts-disk.test.ts` holds it to git's answer). The config
read stays a spawn of its own: `rev-parse` prints no config value.
`lazyGitEnumeration` holds a run's whole-tree enumeration: an unscoped
run starts it at once; a `discover` hook's `worktreeChanges()` starts it
on a scoped one; the CLI's `--filter` pass starts it for a `[<since>]`
filter before the workspace config loads and hands it to its discovery
(`discoverCliProjects`' `git`), which the run takes over (`gitOfDiscovery`
finds its enumeration), and the run then reuses it rather than
spawn a scoped walk too (G-75).
`applyGitEnumeration` folds the result into the run's `GitFilesCache`, which `inputs.ts`'s `resolveFiles`
reads: a tracked-clean path carries a trusted OID and skips both the
existence probe and the hash; a dirty or untracked path falls back to a
content hash. The OID trust is pruned for merge-conflict stages,
gitlinks, paths a filter converts, and paths flagged skip-worktree /
assume-unchanged (`docs/caching.md` § Clean filters). An unmerged path,
which `ls-files` prints once per stage, is listed once: listed per stage,
its worktree bytes folded up to three times, so a conflict resolved on
disk keyed apart from the same bytes once added.

### A name that is not UTF-8

git prints a path's bytes as they are. A lossy decode turned `x\xffy`
into `x\ufffdy`, which names no file, so the path reached the input
set, failed the disk probe and dropped out of the key without a word:
every edit to it was a hit (turborepo#9345). An output holding no
U+FFFD after the lossy decode, which is every real repository's, is
done (0.07 ms more than before on a 15,000-record listing). One that
holds one is split at its NULs and each record decoded fatally, and the
records that fail are kept, spelled lossily so a glob still matches
them, in `GitEnumeration.undecodable` and
`GitFilesCache.undecodableNames`. `inputs.ts` refuses one a task's
globs select while it is on disk (`inputs.files matched … the
name is not valid UTF-8`), rather than dropping it: nothing in vx can
open a path a string cannot spell. The same refusal covers outputs,
where `Bun.Glob` decodes a name the same lossy way.

### Nested repositories

A submodule, or an embedded repository, is ONE entry of the workspace
repository's listing (a gitlink; `dir/` when untracked) and none of its
files — and under the pathspec naming the project, nothing at all. Its
slice of the workspace-wide enumeration is therefore EMPTY, which no
real project's is (a project has at least its `package.json`, tracked
or untracked), so the partition step stores no partition for it:
`resolveFiles` spawns `git ls-files` in the project's own directory,
which the nested repository answers, and the files hash by content — no
index OID is trusted from here. One spawn per such project per run; a
workspace without one pays nothing. (A directory ignored outright takes
the same path and still enumerates nothing, as before.) Before
2026-09-16 the empty slice was stored, `inputs matched no files`,
and the key never moved: a stale hit under a green run. `--affected` follows the same
shape: git reports the nested repository as one changed path (the
gitlink, or the untracked `dir/`), and every project under it is
selected (`affected.ts`).

The other direction, a nested repository INSIDE a project or under a
`workspaceFiles` glob (a vendored submodule under `**`): every listing —
the workspace-wide enumeration and the per-project `runGitLsFiles` —
replaces the one entry (a mode-160000 gitlink, or an untracked `dir/`)
with the files `git ls-files` lists inside it, prefixed by its path,
recursively (`expandNestedRepos`). They carry no index OID, so they hash
by content. One spawn per nested repository per listing; a listing with
none pays nothing. A gitlink with no `.git` behind it (a submodule never
initialised, or one whose `.git` was removed to vendor its files), or
with a `.git` git cannot open (a lost `.git/modules` entry), has no
repository to ask, so a walk lists what is there (`walkFiles`, A-61);
an empty one folds nothing. The nested `git ls-files` runs without the
variables that name a repository (`GIT_DIR`, `GIT_INDEX_FILE`, …, git's
own list for a submodule), and so does the per-project listing of a
project inside a nested repository and `addedInput`'s listing of it
(`listingEnv`): a pre-commit hook sets
them for the outer repository, and the nested listing read the outer index, dropping a file
the nested repository tracks under an ignore rule. Until 2026-09-27 (A-1) the
entry was dropped as a directory, the files never reached the key, and
an edit inside the nested repository was a hit on the old output while
`git status` named the path.

### What it does NOT do

- Read a config, apply a project boundary, or expand a glob — the
  resolver's business.
- Spawn git more than the documented number of times per run
  (`tests/restore-git-spawns.test.ts` counts them).

### Tests

`tests/git-oid.test.ts` (ls-files parsing, OID trust, symlinks,
renames), `tests/git-trust.test.ts` (end to end: working-tree shapes the
trust rule once misread into a stale hit), `tests/git-spawns-once.test.ts` (every git a cold run spawns,
scoped and unscoped), `tests/nested-repo-inputs.test.ts` (a project inside a
gitlink or an untracked embedded repository, and one inside a project:
its own git enumerates it, and a source change is a miss), `tests/inputs.test.ts` and `tests/inputs-resolution.test.ts`
(through the resolver), `tests/restore-git-spawns.test.ts` (spawn
count), `tests/cache-hash-files.test.ts`, `tests/affected*.test.ts`
(the same enumeration behind `--affected`), `tests/stale-hit-digest.test.ts`
(a task moves another's input mid-run by a save, a clean or a write
through a linked directory, tracked or loose: the reader reads the moved
files, and the files put back are not answered by a row stored mid-run).

### Replacing this module

Another VCS implements the same shape — a per-project snapshot of
paths with a trusted content id and a dirty set — and the resolver does
not change.

## `src/cache/scoped-cache.ts` — the key a scope stores a plugin entry under

### Purpose

A task key reaches every remote plain: core never scopes it (VZN,
2026-10-20). Which branch a read may see is the remote's business:
`turboCache()` names the run's refs on each read, or folds the ref into
the key (`scope: 'key'`), and the server's OIDC trust policy decides
where a write lands. A run's scope (`VX_CACHE_SCOPE`, a plugin's or the
branch's) now keys only what plugins store themselves: `ctx.cache`
entries (`plugin-cache.ts`) and run-store records (`run-store.ts`). So no
`RemoteCacheLayer` method takes a scope.

### Public surface

```ts
export function scopedKey(scope: string, hash: string): string
```

### Rules

- **The scope's key** is `xxh3("vx-cache-scope", scope, key)`, 16 hex
  like a task key, so every wire stores it unchanged.
- **The local store never knows a scope** (2026-10-17): every branch
  shares one local pool under the task keys.

## `src/cache/plugin-cache.ts` — a plugin's own entries in the cache

### Purpose

What `setup` and `schedule` receive as `ctx.cache` (orchestrator.md § `ctx.cache`;
design `design/shared-timings-2026-10.md`): a plugin keeps small blobs in
the cache the workspace declares, through the layers tasks use, without
reaching a remote itself (2026-10-14 21:06). `@vzn/vx-history`
is its first user.

### Public surface

```ts
export const PLUGIN_ENTRY_MAX_BYTES = 1048576
export interface PluginCache {
  get(key: string, scoped?: boolean): Promise<Uint8Array | null> // scoped defaults to true
  put(key: string, bytes: Uint8Array): Promise<void>
  has(key: string, scoped?: boolean): Promise<boolean | null>
  hasMany(keys: readonly string[], scoped?: boolean): Promise<Set<string> | null>
  getRun(name: string): Promise<Uint8Array | null> // run bytes core kept (run-store.ts), first readable remote, uncapped
}
export function pluginCache(plugin: string, host: PluginCacheHost): PluginCache
export const absentPluginCache: PluginCache // every answer absent: a context outside a run
// run-store.ts
export function runEntryName(runId: string, taskId: string, part: 'log' | 'outputs'): string
export function writesRunStore(remotes: readonly ResolvedRemote[]): boolean
export function putRunEntry(
  remotes: readonly ResolvedRemote[],
  scope: string | undefined,
  name: string,
  bytes: Uint8Array,
): Promise<boolean>
export function packRunOutputs(
  workspaceRoot: string,
  paths: readonly string[],
): Promise<Uint8Array | null>
```

### Rules

- **Keys are core's.** An entry's key is `xxh3('vx-plugin\0' + plugin +
'\0' + name)`, 16 hex like a task key, so every wire stores it
  unchanged and no plugin reaches another's entries or a task's.
- **Layers.** The local store (the shared store's `plugin_blobs`) first,
  then each remote `resolveCache` collected, in declared order. A remote
  hit is kept locally when the policy writes the local store.
- **Policy and scope.** The local axes gate the local store; each
  remote's policy (the run's) gates it. The local store keeps every
  entry under its name's key. A scoped run writes a remote only under the
  scope's key (`scopedKey`) and reads one key per request (2026-10-18):
  the scope's, or with `scoped` false the default. A run
  with no scope uses the default key either way.
- **Immutable.** A local write is `INSERT OR IGNORE`; a remote write
  asks `has` first and skips a present key.
- **Bounded.** An entry is at most `PLUGIN_ENTRY_MAX_BYTES`: a bigger
  `put` stores nothing, and a remote body over it is a miss, its stream
  cancelled at the cap. An empty `put` stores nothing, and an empty or
  odd remote body (no Blob or Response, a null body) is a miss, never
  kept: write-once would hide every later good body on this machine.
- **Never a throw.** Every failure is an absent answer (`null`, `false`, a
  skipped write). A remote's fault is said once per remote, call and
  message, as a task artifact's is (to the remote's `onError`, else
  stderr): unsaid, a remote down left DTE planning on no timings with
  no line saying why. `has` is `null` when no
  layer could answer; `hasMany` is `null` when a readable remote has no
  batch probe or its probe fails, so the plugin falls back to `get`.
- Entries are pruned by age with the run history (`pruneOlderThan`).

### Tests

`tests/plugin-cache.test.ts`.

### Run store (`run-store.ts`)

What a run that writes a remote keeps of itself (`docs/modules/orchestrator.md`
§ Run report and run bytes): `writesRunStore(remotes)` says whether any
remote takes the run's writes, `runEntryName(runId, taskId, 'log' | 'outputs')`
names an entry, `putRunEntry(remotes, scope, name, bytes)` writes it to
each writing remote once (a remote that fails it is said, as a remote
cache fault is, and the others still keep it), and `packRunOutputs(root, paths)` makes the plain
ustar of a failed task's outputs. Keys are `xxh3('vx-run\0' + name)`,
scoped as tasks are; `getRun` reads them. Never the local store.
