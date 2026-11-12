# `src/memo/` — what a warm run remembers

The memos a task's key and hit read on this machine, each over a table of
the index the store opens (index-db.md): file hashes, task folds,
lockfile parses, output rows and stamps, remote hits. A memo never decides
a refusal and never answers for a file a task may have written since it
learned it (CLAUDE.md, rule 9). The store hands them out as one object,
`Cache.memo` (cache.md).

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
}
export class LocalMemo implements StoreMemo {
  constructor(files: FileHashStore, folds: FoldMemo, outputs: OutputIndex, guard: Guard)
}
```

### Tests

`tests/cache-hash-files.test.ts`, `tests/fold-memo.test.ts`,
`tests/output-stamps-scale.test.ts`, `tests/shared-store-memos.test.ts`,
`tests/whole-second-stamps.test.ts`.

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

## `src/memo/remote-hits.ts` — the keys a remote last said it holds

### Purpose

Kept across runs and processes in `remote_hits`, so any run with a remote
cache plans on them at once instead of waiting on a `hasMany`. A whole
answer rewrites the rows; a pull that finds a key gone forgets it.

### Public surface

```ts
export interface RemoteHits {
  get(hashes: readonly string[]): Map<string, RemoteHit>
  record(asked: readonly string[], found: ReadonlyMap<string, RemoteHit>, now?: number): void
  forget(hash: string): void
}
export class IndexRemoteHits implements RemoteHits {}
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
