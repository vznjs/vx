# `src/memo/` — what a warm run remembers

The memos a task's key and hit read on this machine, each over a table of
the index the store opens (index-db.md): file hashes, task folds,
lockfile parses, output rows and stamps, remote hits. A memo never decides
a refusal and never answers for a file a task may have written since it
learned it (CLAUDE.md, rule 9). The store hands them out as one object,
`Cache.memo` (cache.md).

A memo whose answer is named by a token declares what it depends on with
`memoParts` (util.md): the run keys, the graph, its dependents count, the
fold probe, the config bundle. A memo whose row records its dependencies
compares them on read instead: a file's stat stamp, a lockfile parse's
version, bytes and extra files. A remote hit depends on its key alone.

## `src/memo/local-memo.ts` — the store's memos as one object

### Purpose

`LocalMemo` holds the slices the store opened (`FileHashStore`,
`FoldMemo`, `OutputIndex`) and the state between them: the blob sizes a
run holds until its tasks start, the mtimes a restore left, the
relative-path memo. Each read or write runs through the store's guard, so
an unreadable page is refused as the store refuses one.

### Public surface

```ts
// What `Cache.memo` hands out. The database slices stay private.
export interface StoreMemo {
  hashFile(filePath: string): Promise<string>
  hashBytes(bytes: Uint8Array, nearPath: string): string
  hashFiles(paths: readonly string[]): Promise<Map<string, string>>
  knownBlobSizes(oids: readonly string[]): Map<string, number>
  rememberBlobSizes(sizes: ReadonlyMap<string, number>): void
  holdBlobSizes(): void // held until storeHeldBlobSizes or the store's close
  storeHeldBlobSizes(): void // stored 250 per event-loop turn while the run's tasks run
  blobVerdict(digest: string): string[] | undefined
  rememberBlobVerdict(digest: string, paths: readonly string[]): void
  readonly folds: FoldMemo
  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]>
  stampedRowsOf(hash: string): readonly OutputFileRow[] | undefined // as this process last stamped them: no query
  foldedStamps(files: readonly StampProbe[]): Set<string> // each of files (`rel\0ino:ctime`) a stamp (pending or flushed) holds under an entry whose entry_inputs folded the file's oid at rel
  isOutputsCurrent(projectDir: string, expected: readonly OutputFileRow[]): boolean
  recordOutputDirs(
    hash: string,
    projectDir: string,
    prefixes: readonly string[],
    holds?: (files: readonly string[]) => boolean,
  ): Promise<void>
  recordOutputStamps(hash: string, projectDir: string, workspaceRoot: string): void
  loadOutputDirsBatch(hashes: readonly string[]): Map<string, OutputDirRow[]>
  outputDirsCurrent(projectDir: string, rows: readonly OutputDirRow[]): boolean
  // Reads ahead what a hit on each task's last key will ask, while the run
  // waits for git: its output rows, and from 2,048 files their stats on a
  // thread. It reads until `done` says the wait is over; `warmSettled`
  // waits for the thread; `dropWarm` ends their use.
  warmOutputs(
    tasks: Iterable<readonly [taskId: string, projectDir: string]>,
    done: () => boolean,
  ): Promise<void>
  warmSettled(): Promise<void>
  dropWarm(): void
}
export class LocalMemo implements StoreMemo {
  // `read` false (the local READ axis off): nothing is read ahead.
  constructor(
    files: FileHashStore,
    folds: FoldMemo,
    outputs: OutputIndex,
    guard: Guard,
    read?: boolean,
  )
}
```

### Reading ahead

A warm run proves every output file of every hit by a stat, after git has
answered, and did nothing while git walked. `warmOutputs` uses that wait:
it asks `FoldMemo.lastKeys` for each task's last key, reads those entries'
rows (`OutputIndex.warmRows`; the probe's batch read takes the same
arrays, once), and from 2,048 files hands their paths to a `StatThread`.
`isOutputsCurrent` reads the thread's numbers for a rows array it was
given them for, under the same directory, and stats the rest itself.
payload (45 builds, 14,484 output files): a no-op went from 164 to 118 ms.
It reads only while git walks: once git has answered nothing here is free,
and the site's 9,603-task no-op, whose git starts first, read 6 ms slower
when it read on. The run waits for the thread (`warmSettled`) just before
the graph starts. A key with no row is not remembered as having none, and
an entry whose rows are replaced forgets the ones read ahead: rows written
before the probe (a store that lost its inventory takes its entries back)
are the ones it reads.

A stat taken before the graph started proves nothing once anything may
have written. A run calls `dropWarm` when a command that is no probed hit
is dispatched, when a hit restores, when a task takes the run path, after
a plugin's `setup`, and when the graph ends. A task keyed anew wastes its
read: ~1 µs a row, for files it is about to write again.

### Tests

`tests/cache-hash-files.test.ts`, `tests/fold-memo.test.ts`,
`tests/output-stamps-scale.test.ts`, `tests/shared-store-memos.test.ts`,
`tests/whole-second-stamps.test.ts`, `tests/warm-outputs.test.ts`.

### Replacing this module

A layer's memo is `CacheLayer.memo` (`TaskMemo`, cache.md): a layer that
keeps no index of its own hands out the local store's.

## `src/memo/file-hashes.ts` — the per-file blob-OID memo

### Purpose

`FileHashStore`: the per-file blob-OID memo over `file_hashes` (a symlink hashes as its target string) and the repo's object format.

### Public surface

```ts
export class FileHashStore {}
// A file's identity as the key folds it: its blob OID, prefixed by its git
// mode unless that is a plain file's (100644). A blob OID holds no mode, so
// a `chmod +x` or a symlink swapped for a file of its target's bytes would
// keep the key; the plain mode stays unprefixed. `hashFile` spells it the
// same way from a stat, and the git enumeration from `ls-files -s`.
export function fileIdentity(mode: string, oid: string): string
```

## `src/memo/fold-memo.ts` — each task's last key by its probe

### Purpose

`FoldMemo` (`IndexFoldMemo` over the rows): each task's last key over `fold_memo`, by a probe that is `foldHead` seeded into the task's `filesToken` (inputs.md). `computeTaskHash` reads a warm task's key back instead of resolving and folding its files; rows are written at close, and a prune drops a row no run rewrote for 30 days.

### Public surface

```ts
// `Cache.memo.folds` hands out the interface; the rows' own class stays
// in the memo module. No handle reaches a plugin.
export interface FoldMemo {
  get(taskId: string, probe: string): string | undefined
  set(taskId: string, probe: string, key: string): void
  // Each task's last key whatever its probe, in one read: a guess at its
  // next (`warmOutputs`). A task never folded is absent.
  lastKeys(taskIds: readonly string[]): Map<string, string>
}
export class IndexFoldMemo implements FoldMemo {}
```

## `src/memo/fs-clock.ts` — the file system clock

### Purpose

How far the workspace's file system clock runs behind this process's, measured once a run; `racyWindowMs` adds it. And `fsClockNow`, "now" read off that clock itself.

### Public surface

```ts
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

// "Now" on the clock that stamps the next write (fs-clock.ts): a stamp read
// off a file written and removed in `dir`, `Date.now()` less the lag when
// it cannot be written. The coarse kernel tick under the measured lag puts a
// write up to a tick before a `Date.now()` read ahead of it; `vx watch`'s
// arm and cycle start and the re-check's command start read it instead.
// The file's times are read before its first stamp, so Linux 6.13+ stamps
// it from the fine clock: a write made before the call reads as before it.
export function fsClockNow(dir: string): number
// The dir a reader that makes no cache dir (a plan, `vx watch`'s opening
// stamp) stamps in: the cache dir once made, else `.vx`. The stamp file
// lives an instant, and a `git add -A` in the committed `.vx` failed on it.
export function clockDir(cacheDir: string, workspaceRoot: string): string
// What a stamp's own precision may hide: 1000 ms for a whole-second stamp,
// 2000 for an even one (FAT), else 0.
export function stampGrainMs(stampMs: number): number
```

## `src/memo/output-index.ts` — output rows and the two proofs of a hit

### Purpose

`OutputIndex`: `output_files` / `output_dirs` rows and the two proofs a hit runs before skipping a restore. The batched `getMany` hands both batch reads its live hashes as one JSON array, each hash once, and the rows are joined from it: an `IN (SELECT … json_each(?))` builds a lookup of every hash first (~3 ms of 8,002 hits, 2026-11-07).

### Public surface

```ts
// Namespace discriminator for workspace outputs in the artifact and
// the output_files rows: project rows store the bare project-relative
// path; workspace rows store the full `workspace-outputs/<rel-to-root>`
// archive entry name.
export const WORKSPACE_OUTPUT_PREFIX = 'workspace-outputs/'

// The output-directory short-circuit's bounds: a hit with more than
// OUTPUT_DIRS_CAP directories under its outputs records one
// OUTPUT_DIRS_OVER_CAP row (never current; the hit keeps the walk and does
// not snapshot again), and a snapshot holding one whose mtime is within
// OUTPUT_DIRS_RACY_MS of it is dropped (the next hit walks).
export const OUTPUT_DIRS_CAP = 8192
export const OUTPUT_DIRS_OVER_CAP = -3
export const OUTPUT_DIRS_RACY_MS = 50
// A row's mode bits for a link and a directory, and whether a directory's
// disk mode is wider than the row's (a restore narrows it back).
export const LINK_MODE = 0o120000
export const DIR_MODE = 0o040000
export function wideDirMode(disk: number): boolean
// Every directory above the rows' paths, which a restore makes first.
export function rowAncestors(rows: readonly OutputFileRow[]): string[]
// `dir` and a slash: a row's path appended to it is the file's.
export const baseOf: (dir: string) => string
// A file `foldedStamps` asks about: its inode and ctime now, and what git holds for it.
export interface StampProbe {
  ino: number
  ctimeMs: number
  rel: string // workspace-relative, POSIX: as an `entry_inputs` file component names it
  oid: string
}
export interface OutputFileRow {
  path: string
  mtimeMs: number
  size: number
  mode: number
  ino?: number // the inode and ctime this machine saw after the save or restore (`recordOutputStamps`)
  ctimeMs?: number
}
export interface OutputDirRow {
  path: string
  mtimeMs: number
}
export class OutputIndex {}
```

## `src/memo/stat-thread.ts` — many stats on a thread

### Purpose

`StatThread`: `statSync` of a list of paths on a worker thread, answered as
five numbers a path, the ones `isOutputsCurrent` compares (`STAT_FIELDS`; a
NaN mode where the stat threw). `statSync` is ~2 µs of the main thread a file, and a warm
run asks one per output file of every hit: 14,484 files were 38 ms asked
there and 4 ms asked here (the spawn and the post). A thread that fails
answers undefined and every file is asked where it always was. The worker
is source, not a file, as `exec/spawn-off.ts`'s is.

### Public surface

```ts
export const STAT_FIELDS = 5
export class StatThread {
  stat(paths: readonly string[]): Promise<Float64Array | undefined>
  hold(): void // holds the process open for the answers
  end(): void
}
```

### Tests

`tests/warm-outputs.test.ts`.

## `src/memo/remote-hits.ts` — the keys a remote last said it holds

### Purpose

Kept across runs and processes in `remote_hits`, so any run with a remote
cache plans on them at once instead of waiting on a `hasMany`. A whole
answer rewrites the rows; a pull that finds a key gone forgets it, and
one that serves a hit no answer covered keeps it.

### Public surface

```ts
export interface RemoteHits {
  get(hashes: readonly string[]): Map<string, RemoteHit>
  record(asked: readonly string[], found: ReadonlyMap<string, RemoteHit>, now?: number): void
  forget(hash: string): void
}
export class IndexRemoteHits implements RemoteHits {}
```

## `src/memo/config-stamps.ts` — each config as `vx lock` read it

### Purpose

`vx lock` and a passing `vx lock --check` stamp each config file (size,
mtime, xxh3 of its bytes, ctime, inode) before evaluating it, and keep the stamps with
the lock's digest in the cache dir's `config-stamps.json`. A run reads its
configs from the lock, so `stampsBesideLock(…).edited` names the in-scope
config files whose bytes moved since: the run refuses them with "run
`vx lock`". Asked only while the lock's bytes are the stamped ones and the
stamps are this workspace's (a pull, a clone or a cache dir another
checkout shares asks nothing). A commit since changes nothing: a config
edit committed with no `vx lock` is refused, and so is a pulled one whose
commit kept the lock. Read once per version of the file. The stat match only ever skips the read, and
it holds ctime and the inode as the file-hash memo does: size and mtime alone
skipped a same-length edit whose mtime was set back, and the run used the locked
config. A stamp without them reads the bytes. A config `edited` names is
evaluated before the refusal (`orchestrator/projects.ts`): one that evaluates as
the lock holds runs, and `restampConfigs` stamps it again. The stamp held the
last `vx lock`'s bytes, so a config restored with its lock (`git checkout`) was
refused while `vx lock --check` passed. A refusal is decided by the file's
bytes now, never by a memo (rule 9).

### Public surface

```ts
export interface ConfigStamps {
  at: number // epoch ms before the first stat: the racy window runs from here
  configs: Record<string, [number, number, string, number?, number?]> // size, mtime, xxh3, ctime, inode
  reads?: Record<string, string[]> // the files a `project` plugin made each project's config from, by dir
}
export const CONFIG_STAMPS_FILE = 'config-stamps.json' // a cache clear deletes it
export function takeConfigStamps(root: string, files: readonly string[]): Promise<ConfigStamps>
export function writeConfigStamps(
  root: string,
  cacheDir: string,
  stamps: ConfigStamps,
): Promise<void>
// The stamps beside the lock `lock`, one stat a load: undefined when none were taken here
export interface LockStamps {
  reads: Record<string, string[]> // the files a `project` plugin made each project's config from, by dir
  present: (rel: string) => boolean // whether `rel` was there when `vx lock` ran
  edited: (files: readonly ConfigStat[]) => Promise<string[]> // ConfigStat: { file, size, mtimeMs, ctimeMs, ino }
}
export function stampsBesideLock(
  root: string,
  cacheDir: string,
  lock: string,
): Promise<LockStamps | undefined>
// Stamp `rels` again beside the stamps of lock `lock`: a run found them to evaluate as the lock holds
export function restampConfigs(
  root: string,
  cacheDir: string,
  lock: string,
  rels: readonly string[],
): Promise<void>
```

## `src/memo/lockfile-memo.ts` — a lockfile claimant's parse

### Purpose

`readLockfileMemo` / `writeLockfileMemo` over a `LockfileMemo`: a lockfile claimant's parse, one `lockfile_memos` row per file and claimant, on a connection of its own (lockfile-claim.md).

### Public surface

```ts
export interface LockfileMemo {
  version: number // the claimant's own counter: bumped when it digests differently
  lock: string // xxh3 of the lockfile's bytes
  extras: Record<string, string>
  importers: Record<string, string> | null
  edges: Record<string, unknown>
  recorded?: Record<string, readonly string[]>
}
export function readLockfileMemo(
  cacheDir: string,
  file: string,
  claimant: string,
): LockfileMemo | undefined
export function writeLockfileMemo(
  cacheDir: string,
  file: string,
  claimant: string,
  memo: LockfileMemo,
): boolean
```
