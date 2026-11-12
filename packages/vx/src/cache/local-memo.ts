// The memos a task's key and hit read on this machine, as one object over
// the store's index: file hashes, blob sizes and verdicts, folds, output
// rows and stamps. The store opens the index and hands each slice in.

import path from 'node:path'
import { relPosix } from '../util/index.js'
import type { FileHashStore } from './file-hashes.js'
import type { FoldMemo } from './fold-memo.js'
import type { OutputDirRow, OutputFileRow } from './layer.js'
import type { OutputIndex } from './output-index.js'

// About 1.3 ms of inserts per turn: a task's exit waits at most that.
const HELD_SLICE = 250

/** Runs an index read or write, its error refused as the store refuses one. */
type Guard = <T>(op: () => T) => T

/** The memos a store hands its callers (`Cache.memo`); `LocalMemo` is the one core opens. */
export interface StoreMemo {
  hashFile(filePath: string): Promise<string>
  hashBytes(bytes: Uint8Array, nearPath: string): string
  hashFiles(paths: readonly string[]): Promise<Map<string, string>>
  knownBlobSizes(oids: readonly string[]): Map<string, number>
  rememberBlobSizes(sizes: ReadonlyMap<string, number>): void
  holdBlobSizes(): void
  storeHeldBlobSizes(): void
  blobVerdict(digest: string): string[] | undefined
  rememberBlobVerdict(digest: string, paths: readonly string[]): void
  /** Each task's last key by its probe (`computeTaskHash`). */
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
  /**
   * The mtime each file the last restore of a key left, by row path
   * (`extractArtifactStream`'s `dated`): its stamps take that, not the
   * row's saved one. Taken by `recordOutputStamps`.
   */
  readonly datedMtimes = new Map<string, Map<string, number>>()
  private held: Array<[string, number]> | undefined
  private heldTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * The held sizes being stored, `oid\0size` in OID order, and how many
   * are: fields, not a closure's, so the store lets them go.
   */
  private storing: string[] | undefined
  private stored = 0
  /**
   * `relPosix` against the run's workspace root, memoized: the same three
   * thousand files are re-relativized for every task of the project, which
   * is 132,000 calls for 3,000 answers on this repo's own gate. Cleared
   * when a caller arrives with a different root, so the memo can never
   * answer for a workspace it did not measure.
   */
  private relMemo = new Map<string, string>()
  private relMemoRoot: string | undefined
  /** `root` and a slash, when a file under it is relative by slicing; else undefined. */
  private relPrefix: string | undefined

  constructor(
    /** The per-file (mtime, size) → blob-OID memo behind `hashFile`. */
    private readonly files: FileHashStore,
    /** Each task's last key by its probe (`computeTaskHash`). */
    readonly folds: FoldMemo,
    private readonly outputs: OutputIndex,
    private readonly guard: Guard,
  ) {}

  /**
   * Content-hash a file with an mtime+size fast path: a git blob OID, from
   * the memo when the file's stat matches the row it was hashed at.
   */
  hashFile(filePath: string): Promise<string> {
    return this.guard(() => this.files.hashFile(filePath))
  }

  /**
   * `hashFile`, and `seen` told the ctime of the stat its digest came from
   * (the re-check's tie rule, `InputFact.ctimeMs`).
   */
  hashFileSeen(filePath: string, seen: (ctimeMs: number) => void): Promise<string> {
    return this.guard(() => this.files.hashFile(filePath, seen))
  }

  hashBytes(bytes: Uint8Array, nearPath: string): string {
    return this.files.hashBytes(bytes, nearPath)
  }

  hashFiles(paths: readonly string[]): Promise<Map<string, string>> {
    return this.guard(() => this.files.hashFiles(paths))
  }

  /** `BlobSizeMemo`: the sizes of these blobs this index has learned. */
  knownBlobSizes(oids: readonly string[]): Map<string, number> {
    return this.guard(() => this.files.knownBlobSizes(oids))
  }

  /** `BlobSizeMemo`: remember blob sizes, honouring the local WRITE axis. */
  rememberBlobSizes(sizes: ReadonlyMap<string, number>): void {
    if (this.held !== undefined) for (const e of sizes) this.held.push(e)
    else this.guard(() => this.files.rememberBlobSizes(sizes))
  }

  /**
   * Hold the blob sizes remembered from now on until `storeHeldBlobSizes`
   * or the store's close: a run learns them before its first task, where
   * storing 40,030 cost a cold 9,603-task run 217 ms.
   */
  holdBlobSizes(): void {
    this.held ??= []
  }

  /**
   * Store the held blob sizes `HELD_SLICE` per event-loop turn from the
   * next turn on, while the run's tasks run; the store's close stores the rest.
   */
  storeHeldBlobSizes(): void {
    const held = this.held
    this.held = undefined
    if (held === undefined || held.length === 0) return
    // In OID order, so each slice appends at the key index's right edge:
    // in git's path order every slice dirtied pages across the whole
    // index, and the 160 commits of a cold 9,603-task run cost its main
    // thread ~5x more. Sorted as `oid\0size` strings with no
    // comparator: a JS comparator over 40,000 entries was 32 ms of a cold
    // 8,002-task run's main thread before its first task, the native
    // string sort 8. `\0` sorts below every OID character,
    // so the order is the OIDs'. No entry outlives this: the strings are
    // all the store keeps.
    const keys: string[] = []
    for (let i = 0; i < held.length; i++) keys.push(`${held[i]![0]}\0${held[i]![1]}`)
    keys.sort()
    this.storing = keys
    this.stored = 0
    this.heldTimer = setTimeout(() => this.storeHeldSlice(), 0)
  }

  // A closure over the sizes kept all of them while anything held it (the
  // rest's getter, a fired timer's callback): a cold 9,603-task run's
  // 38,331 to its end, ~5 MB of heap.
  private storeHeldSlice(): void {
    const held = this.storing
    if (held === undefined) return
    const at = this.stored
    this.stored = at + HELD_SLICE
    this.guard(() => this.files.rememberBlobSizes(heldSizes(held, at, this.stored)))
    if (this.stored < held.length) this.heldTimer = setTimeout(() => this.storeHeldSlice(), 0)
    else {
      this.heldTimer = undefined
      this.storing = undefined
    }
  }

  /** Every size still held or not yet stored, taken: the store's close writes them at once. */
  takeHeldBlobSizes(): Map<string, number> | undefined {
    clearTimeout(this.heldTimer)
    const held =
      this.held !== undefined
        ? new Map(this.held)
        : this.storing !== undefined
          ? heldSizes(this.storing, this.stored, this.storing.length)
          : undefined
    this.held = undefined
    this.storing = undefined
    this.heldTimer = undefined
    return held
  }

  /** `BlobSizeMemo`: the paths an index with this digest distrusts, when known. */
  blobVerdict(digest: string): string[] | undefined {
    return this.guard(() => this.files.blobVerdict(digest))
  }

  /** `BlobSizeMemo`: remember a verdict, honouring the local WRITE axis. */
  rememberBlobVerdict(digest: string, paths: readonly string[]): void {
    this.guard(() => this.files.rememberBlobVerdict(digest, paths))
  }

  /** `file` relative to `root`, POSIX-separated. */
  relFor(root: string, file: string): string {
    if (root !== this.relMemoRoot) {
      this.relMemoRoot = root
      this.relMemo.clear()
      this.relPrefix =
        path.sep === '/' && path.isAbsolute(root) && path.normalize(root) === root
          ? root.endsWith('/')
            ? root
            : `${root}/`
          : undefined
    }
    // An input file is a normalized absolute path (`resolveInputs` makes
    // every one), and under a normalized root that is the root, a slash and
    // its relative path: a slice, where the memo hashed the whole path per
    // file per task (~15 ms over 36,000 files).
    const prefix = this.relPrefix
    if (prefix !== undefined && file.startsWith(prefix)) return file.slice(prefix.length)
    let rel = this.relMemo.get(file)
    if (rel === undefined) this.relMemo.set(file, (rel = relPosix(root, file)))
    return rel
  }

  // The slices' proofs and hashes are returned as the slice's own promise:
  // an `async` wrapper added a promise and a microtask hop per call, and a
  // 1,000-hit warm run pays the proofs 2,000 times (+3 ms on `classify + probe`).

  /**
   * Each of `hashes`' output-file fingerprints, in one SQL round trip.
   * Hashes with no rows (cache misses) are absent from the result.
   */
  loadOutputFilesBatch(hashes: readonly string[]): Map<string, OutputFileRow[]> {
    return this.guard(() => this.outputs.loadOutputFilesBatch(hashes))
  }

  /**
   * Whether every `expected` row's file under `projectDir` still matches
   * it (size, mode, mtime, and the stamp a save or restore left). Pure FS
   * check: a mismatch, a missing file or a stat error is false.
   */
  isOutputsCurrent(projectDir: string, expected: readonly OutputFileRow[]): boolean {
    return this.outputs.isOutputsCurrent(projectDir, expected)
  }

  /**
   * Snapshot every directory under each of `prefixes` after a save or
   * restore: unchanged mtimes on a later hit prove no file was added or
   * removed where the glob could see. `holds` false records nothing.
   */
  recordOutputDirs(
    hash: string,
    projectDir: string,
    prefixes: readonly string[],
    holds?: (files: readonly string[]) => boolean,
  ): Promise<void> {
    return this.outputs.recordOutputDirs(hash, projectDir, prefixes, holds)
  }

  /** Stamp `hash`'s output rows once a save or restore left the tree equal to the entry. */
  recordOutputStamps(hash: string, projectDir: string, workspaceRoot: string): void {
    const dated = this.datedMtimes.get(hash)
    this.datedMtimes.delete(hash)
    this.outputs.recordOutputStamps(hash, projectDir, workspaceRoot, dated)
  }

  loadOutputDirsBatch(hashes: readonly string[]): Map<string, OutputDirRow[]> {
    return this.guard(() => this.outputs.loadOutputDirsBatch(hashes))
  }

  outputDirsCurrent(projectDir: string, rows: readonly OutputDirRow[]): boolean {
    return this.outputs.outputDirsCurrent(projectDir, rows)
  }
}

function heldSizes(held: readonly string[], from: number, to: number): Map<string, number> {
  const out = new Map<string, number>()
  for (let i = from; i < Math.min(to, held.length); i++) {
    const k = held[i]!
    const at = k.indexOf('\0')
    out.set(k.slice(0, at), Number(k.slice(at + 1)))
  }
  return out
}
