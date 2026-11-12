// Saving an entry: packing its outputs, writing the artifact and its
// index rows, and ingesting one a remote served.

import { existsSync, linkSync, renameSync, utimesSync } from 'node:fs'
import { lstat, mkdir, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  UserError,
  diskBytes,
  formatBytes,
  isOutOfFds,
  OUT_OF_FDS_HINT,
  relPosix,
  span,
  splitTaskId,
  rawEncode,
} from '../util/index.js'
import {
  ArchiveSecurityError,
  type ArtifactPlan,
  extractArtifactStream,
  scanArtifact,
  scanTarBytes,
  packArtifactBytes,
  packArtifactStream,
  planArtifact,
  writeTree,
} from './archive.js'
import {
  type CacheEntry,
  CorruptArtifactError,
  type DeclaredOutputs,
  type IngestMeta,
  type SaveArgs,
  type TaskInputComponent,
  type TaskInputRow,
} from './layer.js'
import { WORKSPACE_OUTPUT_PREFIX, DIR_MODE, LINK_MODE } from '../memo/index.js'
import { bytesOf, decodedTar, STREAM_DECODE_FROM, zstdCompress, zstdEncoder } from './zstd.js'
import { WalCheckpointer } from './checkpointer.js'
import { declaredName, treePlan, usageOfEntry } from './restore.js'
import {
  NO_INDEX,
  StoreIndex,
  guard,
  historyFilesOf,
  storedHere,
  tarPath,
  tempPath,
  tempTreePath,
  treePathOf,
} from './store-index.js'

/** SQLite's own default, back on a connection whose checkpoint thread failed. */
const WAL_AUTOCHECKPOINT = 1000

/**
 * An entry's key components as its one `entry_inputs` row: JSON `[kind, name,
 * hash]` triples in (kind, name) order, the first of a repeat kept.
 */
function encodeEntryInputs(components: readonly TaskInputComponent[]): string {
  const byId = new Map<string, TaskInputComponent>()
  for (const c of components) {
    const id = `${c.kind}\0${c.name}`
    if (!byId.has(id)) byId.set(id, c)
  }
  const ids = [...byId.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify(
    ids.map((id) => {
      const c = byId.get(id)!
      return [c.kind, c.name, c.hash]
    }),
  )
}

/** The lstats `treeBytes` has in flight at once. */
const TREE_STAT_BATCH = 4096

/** The bytes a tree-form artifact holds on disk, its directories too, as `vx info` counts them. */
export async function treeBytes(dir: string): Promise<number> {
  const none = { size: 0, blocks: 0 }
  let n = diskBytes(await lstat(dir).catch(() => none))
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  // Stats in batches: one at a time was 736 ms of a 20k-file save; all at once
  // would hold every Stats.
  for (let i = 0; i < entries.length; i += TREE_STAT_BATCH) {
    const batch = entries.slice(i, i + TREE_STAT_BATCH)
    const stats = await Promise.all(
      batch.map((e) => lstat(path.join(e.parentPath, e.name)).catch(() => none)),
    )
    for (const st of stats) n += diskBytes(st)
  }
  return n
}

/** A tree the save wrote from its own outputs, with the scan its tar would give. */
interface SavedTree {
  tree: string
  scan: Awaited<ReturnType<typeof scanArtifact>>
  bytes: number
}

/**
 * Refuse an artifact whose names no restore can lay out as one tree
 * (`outputs/out.txt` beside `outputs/out.txt/x`), or, given the task's declared
 * outputs, that names a file outside them (it could overwrite an input or plant
 * a git hook). Thrown at ingest, so the bytes never reach the local store and
 * the read is a miss.
 */
function assertArtifactNames(
  hash: string,
  entries: ReadonlyArray<{ name: string }>,
  declared: DeclaredOutputs | undefined,
  dirs: readonly string[] = [],
): void {
  const names = new Set(entries.map((e) => e.name))
  for (const d of dirs) {
    if (names.has(d)) {
      throw new CorruptArtifactError(hash, `artifact holds ${d} as a file and as a directory`)
    }
    names.add(d)
  }
  for (const name of names) {
    for (let sep = name.indexOf('/'); sep !== -1; sep = name.indexOf('/', sep + 1)) {
      if (names.has(name.slice(0, sep))) {
        throw new CorruptArtifactError(
          hash,
          `artifact holds ${name.slice(0, sep)} as a file and as a directory`,
        )
      }
    }
  }
  if (declared === undefined) return
  const ok = declaredName(declared)
  const dirSet = new Set(dirs)
  for (const name of names) {
    if (!ok(name, dirSet.has(name))) {
      throw new CorruptArtifactError(
        hash,
        `artifact carries ${name}, which is not one of the task's declared outputs`,
      )
    }
  }
}

/** What `ingest` reads a remote body through. */
interface ChunkReader {
  read(): Promise<{ done: true; value?: undefined } | { done: false; value: Uint8Array }>
  cancel(reason?: unknown): Promise<void>
}

/**
 * Read `reader` until it ends or holds more than `max` bytes: `done` and
 * the whole body, or the bytes read so far for `prepended` to put back.
 */
async function readUpTo(
  reader: ChunkReader,
  max: number,
): Promise<{ done: boolean; bytes: Uint8Array }> {
  const chunks: Uint8Array[] = []
  let n = 0
  while (n <= max) {
    const r = await reader.read()
    if (r.done) return { done: true, bytes: Buffer.concat(chunks, n) }
    chunks.push(r.value)
    n += r.value.byteLength
  }
  return { done: false, bytes: Buffer.concat(chunks, n) }
}

/** `head`, then the rest of `reader`: a body `readUpTo` started, whole again. */
function prepended(head: Uint8Array, reader: ChunkReader): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(head)
    },
    async pull(controller) {
      const r = await reader.read()
      if (r.done) controller.close()
      else controller.enqueue(r.value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

export function assertWritable(ix: StoreIndex): void {
  if (ix.writeBlocked === null) return
  throw new UserError(
    `cache directory ${ix.cacheDir} is not writable (${ix.writeBlocked}) — every run records its ` +
      `history there; make it writable by this user, or pass --cache-dir <path>`,
  )
}

export function readOnlyNotice(ix: StoreIndex): string | null {
  // A reading handle over no index: nothing was refused it.
  if (ix.writeBlocked === null || ix.writeBlocked === NO_INDEX) return null
  if (ix.empty) assertWritable(ix)
  return (
    `cache directory ${ix.cacheDir} is not writable (${ix.writeBlocked}) — serving hits ` +
    `from it; this run saves nothing and records no history`
  )
}

export async function save(
  ix: StoreIndex,
  args: {
    hash: string
    /** See `CacheLayer.save` — `exitCode` is not a caller's to supply. */
    entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles' | 'exitCode'>
    projectDir: string
    outputFiles: string[]
    outputDirs?: string[]
    workspaceOutputFiles?: string[]
    workspaceOutputDirs?: string[]
    workspaceRoot?: string
    inputComponents?: readonly TaskInputRow[]
    /** See `CacheLayer.save`. */
  },
): Promise<void> {
  // One `<hash>.tar.zst` per entry, holding only what a hit re-materializes:
  // `stdout` (always, maybe empty), `outputs/<rel>`, `workspace-outputs/<rel>`.
  // Metadata lives in SQLite; a remote ingest takes it as arguments.
  //
  // Local writes off (`local:,remote:rw`): no artifact and no row here; the
  // LayeredCache packs the bytes itself for the upload.
  if (!ix.write) return
  // A reading cache saves only on a miss. With `--force` a held key is re-run
  // and its entry kept; its bytes are this run's too, so the row's `outputs`
  // counts them.
  if (!ix.read && guard(ix, () => storedHere(ix, args.hash))) {
    const rows = ix.localMemo.loadOutputFilesBatch([args.hash]).get(args.hash) ?? []
    ix.savedBytes.set(
      args.hash,
      rows.reduce((n, r) => n + r.size, 0),
    )
    ix.keptHashes.add(args.hash)
    return
  }
  // The constructor makes the cache directory; doing it again per save cost two
  // round trips.
  const endPack = span('save: pack')
  const packed = await packForSave(ix, args).catch((err: unknown) => {
    // A save that could not open an output names the limit, not only
    // the file, which is fine.
    if (isOutOfFds(err)) {
      throw new UserError(
        `save of ${args.hash} could not open a file (${err.message}) — ${OUT_OF_FDS_HINT}`,
      )
    }
    throw err
  })
  endPack()
  const bytes = await guard(ix, () =>
    writeArtifactAndIndex(
      ix,
      args.hash,
      'tar' in packed ? packed.compressed : 'plan' in packed ? packed.saved : packed,
      {
        taskId: args.entry.taskId,
        command: args.entry.command,
        durationMs: args.entry.durationMs,
        ...(args.inputComponents !== undefined ? { inputComponents: args.inputComponents } : {}),
      },
      'tar' in packed ? packed.tar : undefined,
    ),
  )
  ix.savedBytes.set(args.hash, bytes)
}

export function localWritesEnabled(ix: StoreIndex): boolean {
  return ix.write
}

export function packSavedBytes(ix: StoreIndex, args: SaveArgs): Promise<Uint8Array> {
  return packArtifact(ix, args)
}

export async function pinArtifact(
  ix: StoreIndex,
  hash: string,
): Promise<{ body: Blob; release: () => Promise<void> }> {
  const blob = guard(ix, () => ix.selectBlob.get(hash) as { bytes: Uint8Array } | null)
  if (blob !== null) return { body: new Blob([blob.bytes]), release: async () => {} }
  const pinned = tempPath(ix, hash)
  try {
    linkSync(tarPath(ix, hash), pinned)
    // The link shares the artifact's mtime, as adopt's does: an old mtime made
    // the pin look like an orphan temp to another process's sweep mid-upload.
    const now = new Date()
    utimesSync(pinned, now, now)
  } catch (err) {
    const tree = treePathOf(ix, hash)
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || !existsSync(tree)) throw err
    // A tree is packed into the artifact a remote expects here, in the
    // upload queue, off the save; a small one in memory.
    const plan = treePlan(ix, hash, tree, ix.outputs.rowsOf(hash))
    if (plan.size <= STREAM_DECODE_FROM) {
      const bytes = await zstdCompress(await packArtifactBytes(plan))
      return { body: new Blob([bytes]), release: async () => {} }
    }
    await Bun.write(
      pinned,
      new Response(packArtifactStream(plan).pipeThrough(zstdEncoder())),
    ).catch(async (e: unknown) => {
      await unlink(pinned).catch(() => undefined)
      throw e
    })
  }
  return { body: Bun.file(pinned), release: () => unlink(pinned).catch(() => undefined) }
}

export async function ingest(
  ix: StoreIndex,
  hash: string,
  body: Blob | Response,
  meta: IngestMeta,
): Promise<void> {
  const tmpPath = tempPath(ix, hash)
  // Bound the compressed bytes too: a remote body that never ends would fill
  // the disk. No artifact under the ceiling compresses past zstd's own bound.
  const cap = ix.artifactCeiling + (ix.artifactCeiling >> 8) + 64 * 1024
  const past = (): CorruptArtifactError =>
    new CorruptArtifactError(
      hash,
      `remote body runs past ${cap} bytes (the artifact ceiling's bound)`,
    )
  // Every refusal releases the remote body: a held response pins its
  // connection, and a layer that settles on the body's end never hears.
  let counted: ReadableStream<Uint8Array> | undefined
  let reader: ChunkReader | undefined
  let small: Uint8Array | undefined
  // A store of plain files decodes a body up to the bulk bound in one call
  // straight into the tree, with no temp archive.
  const held = ix.store.decompress
    ? Math.max(ix.store.embeddings, STREAM_DECODE_FROM)
    : ix.store.embeddings
  try {
    const length =
      body instanceof Blob ? body.size : Number(body.headers.get('content-length') ?? 0)
    if (length > cap) throw past()
    if (body instanceof Blob) {
      if (length <= held && held > 0) small = await body.bytes()
      else await Bun.write(tmpPath, body)
    } else {
      let source = body.body
      if (source === null) small = new Uint8Array(0)
      else if (length <= held && held > 0) {
        // Counted as it streams: a length the server did not send, or
        // one it sent short, cannot read a large body to memory.
        const r: ChunkReader = source.getReader()
        reader = r
        const head = await readUpTo(r, held)
        if (head.done) small = head.bytes
        else source = prepended(head.bytes, r)
      }
      if (small === undefined) {
        let n = 0
        counted = source?.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              n += chunk.byteLength
              if (n > cap) controller.error(past())
              else controller.enqueue(chunk)
            },
          }),
        )
        await Bun.write(tmpPath, new Response(counted ?? null))
      }
    }
  } catch (err) {
    // A failed write leaves the pipe's end unlocked; cancelling it
    // cancels the source. A body refused by its length is cancelled itself.
    if (!(body instanceof Blob)) {
      void (counted ?? reader ?? body.body)?.cancel(err).catch(() => undefined)
    }
    await unlink(tmpPath).catch(() => undefined)
    throw err
  }
  await guard(ix, () => writeArtifactAndIndex(ix, hash, small ?? { tmpPath }, meta))
}

/** Archive name → absolute source path for every declared output. */
function outputsOf(
  ix: StoreIndex,
  args: {
    projectDir: string
    outputFiles: string[]
    outputDirs?: string[]
    workspaceOutputFiles?: string[]
    workspaceOutputDirs?: string[]
    workspaceRoot?: string
  },
): Map<string, string> {
  const outputs = new Map<string, string>()
  for (const f of args.outputFiles) {
    outputs.set(`outputs/${relPosix(args.projectDir, f)}`, f)
  }
  // Caller passes workspaceRoot whenever workspaceOutputFiles is
  // non-empty; the rels are root-anchored by construction.
  for (const f of args.workspaceOutputFiles ?? []) {
    outputs.set(`${WORKSPACE_OUTPUT_PREFIX}${relPosix(args.workspaceRoot!, f)}`, f)
  }
  return outputs
}

/**
 * The compressed artifact in memory, for an upload when local writes are off:
 * the bytes must be captured while the outputs are on disk. Both packers name
 * entries straight into the archive; neither writes the final cache path, the
 * index step's job.
 */
async function packArtifact(
  ix: StoreIndex,
  args: {
    hash: string
    entry: Omit<CacheEntry, 'hash' | 'storedAt' | 'outputFiles' | 'exitCode'>
    projectDir: string
    outputFiles: string[]
    outputDirs?: string[]
    workspaceOutputFiles?: string[]
    workspaceOutputDirs?: string[]
    workspaceRoot?: string
  },
): Promise<Uint8Array> {
  // `stdout` is always present, even empty, so the layout is predictable.
  const plan = await planWithin(ix, args)
  if (plan.size <= STREAM_DECODE_FROM) return await zstdCompress(await packArtifactBytes(plan))
  return bytesOf(packArtifactStream(plan).pipeThrough(zstdEncoder()))
}

/**
 * Refuse a plan whose tar is past the ceiling every restore enforces: here it
 * costs a stat per output; left to the scan it cost a whole compress and decode
 * and called the task's own outputs corrupt.
 */
export async function planWithin(
  ix: StoreIndex,
  args: Parameters<typeof packArtifact>[1],
): Promise<ArtifactPlan> {
  const plan = await planArtifact({
    key: args.hash,
    stdout: args.entry.stdout ?? '',
    outputs: outputsOf(ix, args),
    dirs: [
      ...(args.outputDirs ?? []).map((d) => `outputs/${relPosix(args.projectDir, d)}`),
      ...(args.workspaceOutputDirs ?? []).map(
        (d) => `${WORKSPACE_OUTPUT_PREFIX}${relPosix(args.workspaceRoot!, d)}`,
      ),
    ],
    exec: usageOfEntry(args.entry),
    root: args.workspaceRoot ?? args.projectDir,
    projectDir: args.projectDir,
  })
  if (plan.size > ix.artifactCeiling) {
    throw new Error(
      `${args.entry.taskId} is not cached: its outputs pack to ${formatBytes(plan.size)}, past the ` +
        `${formatBytes(ix.artifactCeiling)} artifact ceiling a restore enforces — narrow outputs.files`,
    )
  }
  return plan
}

/**
 * Pack for the local save. A large artifact streams from disk into the
 * compressor and the temp, never sitting in memory. The streamed compressor
 * costs more per byte and ~35 µs to set up, so a small one is packed and
 * compressed in memory in one call.
 */
export async function packArtifactToTemp(
  ix: StoreIndex,
  tmpPath: string,
  args: Parameters<typeof packArtifact>[1],
): Promise<{ compressed: Uint8Array; tar: Uint8Array } | { tmpPath: string }> {
  const plan = await planWithin(ix, args)
  if (plan.size <= STREAM_DECODE_FROM) {
    const tar = await packArtifactBytes(plan)
    return { compressed: await zstdCompress(tar), tar }
  }
  const sink = Bun.file(tmpPath).writer()
  try {
    for await (const chunk of packArtifactStream(plan).pipeThrough(zstdEncoder())) {
      await sink.write(chunk)
    }
  } catch (err) {
    // An output that vanished or changed shape between the plan's stat
    // and its read: the partial temp must not outlive the failure.
    await sink.end()
    await unlink(tmpPath).catch(() => undefined)
    throw err
  }
  await sink.end()
  return { tmpPath }
}

/**
 * The save's local form: inline for a small entry when the store embeds, else a
 * `.tar.zst` or a tree of the outputs.
 */
async function packForSave(
  ix: StoreIndex,
  args: Parameters<typeof packArtifact>[1],
): Promise<
  | { compressed: Uint8Array; tar: Uint8Array }
  | { tmpPath: string }
  | { plan: true; saved: SavedTree }
> {
  if (!ix.store.decompress) return packArtifactToTemp(ix, tempPath(ix, args.hash), args)
  const plan = await planWithin(ix, args)
  if (ix.store.embeddings > 0 && plan.size <= ix.store.embeddings) {
    const tar = await packArtifactBytes(plan)
    return { compressed: await zstdCompress(tar), tar }
  }
  const tree = tempTreePath(ix, args.hash)
  try {
    const scan = await writeTree(plan, tree)
    return { plan: true, saved: { tree, scan, bytes: await treeBytes(tree) } }
  } catch (err) {
    await rm(tree, { recursive: true, force: true })
    throw err
  }
}

/**
 * Atomically write `compressed` to `<hash>.tar.zst`, or inline when at most
 * `cache.store.embeddings` bytes, and build the rows from the archive itself.
 * Shared by `save()` and `ingest()`, so both index the same values.
 */
export async function writeArtifactAndIndex(
  ix: StoreIndex,
  hash: string,
  given: Uint8Array | { tmpPath: string } | SavedTree,
  meta: IngestMeta,
  /**
   * The tar `compressed` was made from, when this process packed it: it is
   * scanned as is rather than decoded back out of the bytes just encoded.
   */
  tar?: Uint8Array,
): Promise<number> {
  // Validate BEFORE anything touches the final path: network bytes that went
  // live first would leave a corrupt artifact for every later reader. The parse
  // also yields the `output_files` rows, the headers a restore will see.
  const finalPath = tarPath(ix, hash)
  const saved = 'tree' in given ? given : undefined
  const compressed = 'tree' in given ? new Uint8Array(0) : given
  // An inline artifact is written in the rows' transaction below: no
  // temp, no rename.
  const inline =
    saved === undefined &&
    ix.store.embeddings > 0 &&
    compressed instanceof Uint8Array &&
    compressed.byteLength <= ix.store.embeddings
      ? compressed
      : null
  // A remote hit this store keeps as plain files is decoded once, into the
  // tree, and checked there: nothing names the tree until the rows go in.
  const oneTree = saved === undefined && inline === null && tar === undefined && ix.store.decompress
  let tmpPath: string | undefined
  if (saved !== undefined) {
    // The tree save wrote and scanned its own outputs.
  } else if (inline === null && compressed instanceof Uint8Array && !oneTree) {
    const temp = tempPath(ix, hash)
    tmpPath = temp
    // The temp is written before validation so a large artifact is scanned as a
    // file stream, in bounded pieces. node's writeFile, not Bun.write, which
    // copies the buffer first.
    const endWrite = span('save: write temp')
    // A failed write leaves the temp, an orphan only an hour on. Off this
    // thread even when small: creating the file on the main thread cost more.
    await writeFile(temp, compressed).catch(async (err: unknown) => {
      await unlink(temp).catch(() => undefined)
      throw err
    })
    endWrite()
  } else if (!(compressed instanceof Uint8Array)) {
    // `save` or `ingest` already streamed the artifact into its temp.
    tmpPath = compressed.tmpPath
  }
  let scanned: Awaited<ReturnType<typeof scanArtifact>>
  let tree = saved?.tree
  try {
    const endScan = span('save: scan')
    if (saved !== undefined) {
      scanned = saved.scan
    } else if (oneTree) {
      const dir = tempTreePath(ix, hash)
      tree = dir
      let scan: Awaited<ReturnType<typeof scanArtifact>> | undefined
      await extractArtifactStream(
        await decodedTar(
          compressed instanceof Uint8Array ? compressed : Bun.file(tmpPath!),
          hash,
          ix.artifactCeiling,
        ),
        dir,
        path.join(dir, WORKSPACE_OUTPUT_PREFIX),
        undefined,
        undefined,
        undefined,
        (s) => {
          scan = s
        },
      )
      scanned = scan!
      // An artifact with no outputs extracts nothing, so nothing made `dir`.
      await mkdir(dir, { recursive: true })
    } else if (tar !== undefined) {
      // Our own tar, in memory: read in place, on this thread.
      scanned = scanTarBytes(tar)
    } else {
      // ingest() is the UNTRUSTED boundary: refuse a bomb, declared or
      // sizeless, before it expands into memory.
      const source =
        compressed instanceof Uint8Array && compressed.byteLength <= STREAM_DECODE_FROM
          ? compressed
          : Bun.file(tmpPath!)
      scanned = await scanArtifact(await decodedTar(source, hash, ix.artifactCeiling))
    }
    endScan()
    // Invariant: every artifact carries a `stdout` entry. Its
    // absence means the bytes decompressed but aren't a vx artifact.
    if (scanned.stdout === null) {
      throw new CorruptArtifactError(hash, 'missing stdout entry')
    }
    if (scanned.key !== hash) {
      throw new CorruptArtifactError(
        hash,
        scanned.key === undefined
          ? 'artifact records no cache key'
          : `artifact was stored under another key (${scanned.key})`,
      )
    }
    assertArtifactNames(hash, scanned.entries, meta.outputs, [
      ...scanned.dirs,
      ...scanned.links.map(([name]) => name),
    ])
  } catch (err) {
    if (tmpPath !== undefined) await unlink(tmpPath).catch(() => undefined)
    if (tree !== undefined) await rm(tree, { recursive: true, force: true })
    if (err instanceof ArchiveSecurityError || err instanceof CorruptArtifactError) throw err
    throw new CorruptArtifactError(hash, 'artifact is not a readable archive', err)
  }
  const { entries } = scanned
  let totalBytes =
    saved !== undefined
      ? saved.bytes
      : compressed instanceof Uint8Array
        ? compressed.byteLength
        : Bun.file(tmpPath!).size
  // A remote hit this store keeps as plain files: the archive passed its
  // checks above, so it is unpacked once here and its temp goes.
  if (oneTree && tmpPath !== undefined) {
    await unlink(tmpPath).catch(() => undefined)
    tmpPath = undefined
  }
  if (tree === undefined && inline === null && ix.store.decompress) {
    const dir = tempTreePath(ix, hash)
    try {
      const source =
        compressed instanceof Uint8Array && compressed.byteLength > 0
          ? compressed
          : Bun.file(tmpPath!)
      await extractArtifactStream(
        await decodedTar(source, hash, ix.artifactCeiling),
        dir,
        path.join(dir, WORKSPACE_OUTPUT_PREFIX),
      )
      await mkdir(dir, { recursive: true })
    } catch (err) {
      await rm(dir, { recursive: true, force: true })
      if (tmpPath !== undefined) await unlink(tmpPath).catch(() => undefined)
      throw err
    }
    if (tmpPath !== undefined) await unlink(tmpPath).catch(() => undefined)
    tmpPath = undefined
    tree = dir
  }
  // A tree keeps its files as they are: counted on disk as a saved tree
  // counts them, not as the archive it was unpacked from (`--max-size`, stats).
  if (tree !== undefined && saved === undefined) totalBytes = await treeBytes(tree)
  const outputFileRows: Array<[string, number, number, number]> = []
  // Output-file rows for the skip-restore check: a project entry's bare rel, a
  // workspace entry's full `workspace-outputs/<rel>`. Mode and millisecond
  // mtime come from the artifact's sidecar, so save and ingest index the same
  // values a restore lays down, and `isOutputsCurrent` compares equal right
  // after.
  for (const e of entries) {
    let rowPath: string | null = null
    if (e.name.startsWith('outputs/')) {
      const rel = e.name.slice('outputs/'.length)
      if (rel.length > 0) rowPath = rel
    } else if (e.name.startsWith(WORKSPACE_OUTPUT_PREFIX)) {
      if (e.name.length > WORKSPACE_OUTPUT_PREFIX.length) rowPath = e.name
    }
    if (rowPath === null) continue
    outputFileRows.push([rowPath, e.size, e.mode & 0o777, Math.floor(e.mtimeMs)])
  }
  // An empty directory's row is its rel with a trailing slash; one with a mode
  // to restore carries it beside `DIR_MODE`.
  const dirModes = new Map(scanned.dirModes)
  const dirRow = (d: string): void => {
    const mode = dirModes.get(d)
    dirModes.delete(d)
    outputFileRows.push([
      `${d.startsWith('outputs/') ? d.slice('outputs/'.length) : d}/`,
      0,
      mode === undefined ? 0 : DIR_MODE | mode,
      0,
    ])
  }
  for (const d of scanned.dirs) dirRow(d)
  for (const d of [...dirModes.keys()]) dirRow(d)
  // A link's row: its rel, the target's length and CRC-32 in place of size and
  // mtime, and the link type in the mode, so the check never follows it.
  for (const [name, to] of scanned.links) {
    const bytes = new TextEncoder().encode(to)
    outputFileRows.push([
      name.startsWith('outputs/') ? name.slice('outputs/'.length) : name,
      bytes.byteLength,
      LINK_MODE,
      Bun.hash.crc32(bytes),
    ])
  }
  // Compressed before the write lock is taken: logs are most of what the
  // index held as text.
  const stdoutBlob = scanned.stdout === '' ? null : await zstdCompress(rawEncode(scanned.stdout))

  const [project, task] = splitTaskId(meta.taskId)
  const now = Date.now()

  // One transaction, one fsync, for the entry, its output rows and its
  // `entry_inputs`, so a warm run that saves nothing writes none.
  const insertEntry = ix.insertEntry
  const upsertStdout = ix.upsertStdout
  const deleteStdout = ix.deleteStdout
  const outputs = ix.outputs
  let outputBytes = 0
  const insertEntryInput = ix.insertEntryInput
  const inputComponents = meta.inputComponents
  // The artifact goes live INSIDE the IMMEDIATE write transaction: renamed
  // first and indexed after, a failed commit left bytes beside the previous
  // save's rows, and two writers of one key could pair one's bytes with the
  // other's rows. A commit failing after the rename takes the artifact back
  // out; rows naming no artifact read as a miss.
  //
  // A previous artifact is moved aside, never renamed over: replacing a file
  // flushes delayed blocks on ext4 while the lock is held. A reader between the
  // renames finds a miss; one holding the old file reads it whole. The aside is
  // a temp name, so a crash leaves an orphan the sweep takes.
  //
  // An inline save and a file save each remove the key's other form in the same
  // transaction: a key's live bytes are in one place.
  let aside: string[] = []
  let renamed: string | undefined
  const upsertBlob = ix.upsertBlob
  const deleteBlob = ix.deleteBlob
  const treePath = treePathOf(ix, hash)
  // Both file forms are moved aside: a key re-saved under another
  // `cache.store` leaves one live artifact.
  const moveAside = (): string[] => {
    const moved: string[] = []
    for (const [from, to] of [
      [finalPath, tempPath(ix, hash)],
      [treePath, tempTreePath(ix, hash)],
    ] as const) {
      try {
        renameSync(from, to)
        moved.push(to)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }
    return moved
  }
  const index = () => {
    if (inline !== null) {
      aside = moveAside()
      upsertBlob.run(hash, now, inline)
    } else {
      aside = moveAside()
      const live = tree !== undefined ? treePath : finalPath
      renameSync(tree ?? tmpPath!, live)
      ix.artifactNames?.add(path.basename(live))
      renamed = live
      deleteBlob.run(hash)
    }
    insertEntry.run(
      hash,
      project,
      task,
      meta.command,
      // exitCode is pinned: vx caches only successes. The column stays because
      // the read side classifies a non-zero row (a foreign cache.db) `failed`
      // rather than green.
      0,
      meta.durationMs,
      totalBytes,
      now,
      now,
      // From the artifact, on both paths: a save indexes what it just
      // packed, an ingest what the producing machine packed.
      scanned.exec?.cpuMs ?? null,
      scanned.exec?.peakRssBytes ?? null,
      ix.runId ?? null,
    )
    if (stdoutBlob === null) deleteStdout.run(hash)
    else upsertStdout.run(hash, stdoutBlob)
    outputBytes = outputs.replaceFileRows(hash, outputFileRows)
    // INSERT OR IGNORE: identical inputs derive this same hash, so a
    // re-save's row is identical — keep the first, skip the rest.
    if (inputComponents !== undefined && inputComponents.length > 0) {
      insertEntryInput.run(hash, encodeEntryInputs(inputComponents))
    }
  }
  const endTx = span('save: index tx')
  try {
    // Built inside the try: on a database a stopping run closed mid-download it
    // throws, and the temp must still go.
    await indexInBatch(ix, index)
  } catch (err) {
    endTx()
    const left = renamed ?? tree ?? tmpPath
    if (left !== undefined) await rm(left, { recursive: true, force: true })
    for (const a of aside) await rm(a, { recursive: true, force: true })
    throw err
  }
  endTx()
  for (const a of aside) await rm(a, { recursive: true, force: true })
  return outputBytes
}

/**
 * Run `write` in one write transaction with every save arriving this turn: it
 * settles once committed, or rejects with its own error (its savepoint rolled
 * back) or the commit's. A transaction per save spent half its index time on
 * BEGIN and COMMIT on the main thread.
 */
export function indexInBatch(ix: StoreIndex, write: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    ix.indexQueue.push({
      write,
      settle: (err) => (err === undefined ? resolve() : reject(err)),
    })
    if (ix.indexQueue.length === 1) setImmediate(() => flushIndex(ix))
  })
}

export function flushIndex(ix: StoreIndex): void {
  const batch = ix.indexQueue
  if (batch.length === 0) return
  ix.indexQueue = []
  const failed = new Map<number, unknown>()
  try {
    ix.db
      .transaction(() => {
        for (let i = 0; i < batch.length; i++) {
          // An error that rolls the whole transaction back (a full disk, a busy
          // lock) leaves nothing to go on in: the rest fail with it.
          if (failed.size > 0 && !ix.db.inTransaction) {
            failed.set(i, failed.values().next().value)
            continue
          }
          try {
            // Nested: a savepoint, so one write's failure undoes only its own rows.
            ix.db.transaction(batch[i]!.write)()
          } catch (err) {
            failed.set(i, err)
          }
        }
      })
      .immediate()
  } catch (err) {
    for (let i = 0; i < batch.length; i++) batch[i]!.settle(failed.get(i) ?? err)
    return
  }
  if (ix.checkpoints === 'armed') startCheckpointer(ix)
  for (let i = 0; i < batch.length; i++) batch[i]!.settle(failed.get(i))
}

export function checkpointOffThread(ix: StoreIndex): void {
  if (ix.checkpoints === undefined && historyFilesOf(ix) !== undefined) ix.checkpoints = 'armed'
}

function startCheckpointer(ix: StoreIndex): void {
  const files = historyFilesOf(ix)!
  ix.db.exec('PRAGMA wal_autocheckpoint = 0')
  ix.checkpoints = new WalCheckpointer(files, () => {
    // No thread: the run's connection checkpoints as it did.
    ix.db.exec(`PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT}`)
  })
}

export async function stopCheckpoints(ix: StoreIndex): Promise<void> {
  const c = ix.checkpoints
  ix.checkpoints = undefined
  if (c instanceof WalCheckpointer) await c.stop()
}
