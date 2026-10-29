// Cache artifact container: a zstd-compressed tar, read and written by
// vx's own streaming tar code (`tar-stream.ts`).
//
// An artifact is a tar of:
//   stdout                       always present; the vx-artifact marker
//   outputs/<rel>                project-relative outputs
//   workspace-outputs/<rel>      workspace-root-relative outputs
//   .vx-meta.json                per-output mode + millisecond mtime
//
// Tar headers carry mode and SECOND mtimes; vx needs both exactly — a
// lost executable bit builds cold and breaks warm, and `isOutputsCurrent`
// skips a restore when size+mode+mtime match at millisecond precision —
// so the pack side stats each output once and writes both into
// `.vx-meta.json`, and the restore side applies them. That also makes a
// REMOTE-ingested entry's index rows millisecond-accurate.
//
// Both directions stream. `packArtifactStream` reads each output as it is
// written; `scanArtifact` lists what an artifact holds without
// materialising a byte; `extractArtifactStream` restores while never
// holding more than a chunk. `Bun.Archive` used to do all three and
// needed the whole tar in memory on every side — restoring a 150 MiB
// artifact peaked at 3.2× its size, saving one at 4.7× (measured
// 2026-09-03). Every regular entry is written to the workspace's staging
// directory (`.vx/tmp/<pid>-0/`, vx's own, never an output folder) and
// renamed over its target only once the WHOLE archive has been read and
// every name proven safe, so a poisoned entry anywhere — even the last
// one — leaves nothing behind but the empty directories it needed, which
// are pruned too, and a killed restore leaves its temps where the next
// run sweeps them (`sweepStaging`).
//
// What stays here is the part no tar reader can decide for us: WHERE an
// entry may land on disk. Every name is validated and every destination
// is proven to stay inside its anchor before a byte is written, because a
// cache artifact is attacker-reachable (a poisoned remote, a tampered
// local entry) and "zip slip" is the class.
//
// Tar entries that are not regular files (symlinks, hardlinks, devices,
// FIFOs) are never materialised — the reader reports them only to be
// skipped. An output symlink rides the sidecar instead (`links`), its
// target held to the workspace on both sides.

import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  futimesSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { UserError, writableUnder } from '../util/index.js'
import { WORKSPACE_OUTPUT_PREFIX } from './layer.js'
import {
  TarFormatError,
  type TarInput,
  tarEntries,
  tarEntriesSync,
  tarPack,
  tarPackInto,
  tarSize,
} from './tar-stream.js'
import { ON_THREAD_MAX } from './zstd.js'
import { readUmask, restoredMode } from './umask.js'

/** Archive entry name carrying the per-output mode/mtime sidecar. */
const META_ENTRY = '.vx-meta.json'

/** Archive entry name of the always-present stdout record. */
const STDOUT_ENTRY = 'stdout'

// One decoder, its defaults (a leading BOM dropped), for both scanners.
// `ignoreBOM`: a leading U+FEFF in a task's stdout is the task's.
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true })

/**
 * The last entry: a CRC-32 over every entry before it, each its name, a
 * NUL, then its body, as 8 lowercase hex digits (v36, L-19). Nothing else
 * checks an entry's BODY: tar sums its headers only, and neither zstd
 * writer asks for a frame checksum, so a byte flipped in a raw zstd block
 * (incompressible output: an image, a wasm, a tarball) decoded clean and
 * replayed wrong bytes under a green hit — 1,141 of 1,141 flips in a
 * random 8 KB body went unseen (probed). A CRC catches that transit or
 * storage damage; it is no defense against a store that forges artifacts,
 * which keys cannot tell apart from honest ones either.
 */
const SUM_ENTRY = '.vx-sum'
const SUM_SIZE = 8

/** The running CRC-32 over entries' names and bodies, as `SUM_ENTRY` defines it. */
class EntrySum {
  private crc = 0
  entry(name: string): void {
    this.crc = Bun.hash.crc32(new TextEncoder().encode(`${name}\0`), this.crc)
  }
  add(chunk: Uint8Array): void {
    this.crc = Bun.hash.crc32(chunk, this.crc)
  }
  async *through(body: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
    for await (const chunk of body) {
      this.add(chunk)
      yield chunk
    }
  }
  hex(): string {
    return (this.crc >>> 0).toString(16).padStart(SUM_SIZE, '0')
  }
}

/**
 * The reader's half: every regular entry is hashed as it is consumed, and
 * `check` is handed the sum entry's body. An archive whose sum is absent,
 * wrong, or followed by another entry is refused before anything it held
 * is committed.
 */
class SumCheck {
  private readonly sum = new EntrySum()
  private readonly names = new Set<string>()
  private seen: boolean = false
  /** The entry's body, hashed as the caller reads it; null for the sum entry itself (checked here). */
  async body(
    name: string,
    body: AsyncIterable<Uint8Array>,
  ): Promise<AsyncIterable<Uint8Array> | null> {
    if (!this.enter(name)) return this.sum.through(body)
    this.verify(await textOf(body))
    return null
  }
  /**
   * The next regular entry: true when it is the sum entry, whose text the
   * caller hands to `verify`; otherwise the caller hands its bytes to `add`.
   */
  enter(name: string): boolean {
    if (this.seen) throw new TarFormatError(`entry ${name} follows the artifact's checksum`)
    if (name === SUM_ENTRY) return true
    // vx never packs a name twice, and a restore staged both: their renames
    // ran together, so which body landed was a race the index never saw.
    if (this.names.has(name)) throw new ArchiveSecurityError(`archive holds ${name} twice`)
    this.names.add(name)
    this.sum.entry(name)
    return false
  }
  add(bytes: Uint8Array): void {
    this.sum.add(bytes)
  }
  verify(got: string): void {
    if (got !== this.sum.hex()) {
      throw new TarFormatError(
        `artifact content does not match its checksum (${got}, read ${this.sum.hex()})`,
      )
    }
    this.seen = true
  }
  done(): void {
    if (!this.seen) throw new TarFormatError('artifact carries no checksum')
  }
}

const drain = async (body: AsyncIterable<Uint8Array>): Promise<void> => {
  for await (const _ of body) {
    // read through the checksum
  }
}

/**
 * Sidecar shape. `files` maps an entry name to `[mode, mtimeMs]` — a
 * pair, not an object, because the sidecar is real entropy inside an
 * otherwise highly compressible artifact and per-file key names would
 * be paid for once per output.
 */
interface MetaFile {
  /** Bumped only if the sidecar's own shape changes; the artifact
   *  container is versioned by CACHE_VERSION, which gates reads. */
  version: 1
  /**
   * The cache key the artifact was packed under (v35, item 943). Ingest
   * refuses bytes whose key is not the one it asked for: nothing else ties
   * an artifact to its key, so a remote layer that answered one key with
   * another's bytes (a truncated or colliding mapping) replayed the other
   * task's outputs under a green `cache-hit-remote`.
   */
  key?: string
  files: Record<string, [mode: number, mtimeMs: number]>
  /**
   * The empty directories under the outputs, as entry names
   * (`outputs/dist/empty`): a tar of regular files cannot hold them, and
   * a hit that dropped them left another tree than the miss (v44).
   */
  dirs?: string[]
  /**
   * The symlinks under the outputs, entry name → the link's target as
   * written (relative, inside the workspace): a hit makes the link, as
   * Turbo and Nx do, where it once packed a copy of the target (v45).
   */
  links?: Record<string, string>
  /**
   * What the PRODUCING execution used (2026-09-12, additive: an artifact
   * without it reads as before). Rides the artifact so a machine that
   * never ran the task — a fresh CI runner on a remote hit — still learns
   * what it needs; every wire ships the bytes verbatim, so no seam
   * changes.
   */
  exec?: ExecUsage
}

/** CPU time and peak RSS of the execution that produced an artifact. */
export interface ExecUsage {
  cpuMs?: number
  peakRssBytes?: number
}

/** One regular file in an artifact, with its restore metadata resolved. */
interface ArchiveEntry {
  /** Full archive-relative name, e.g. `outputs/dist/index.js`. */
  name: string
  size: number
  /** Permission bits (0o777 mask) from the sidecar. */
  mode: number
  /** Modification time in ms since epoch from the sidecar. */
  mtimeMs: number
}

/**
 * Thrown when an entry's name would let it escape the extraction anchor
 * (absolute path, `..` traversal, doubled separator, Windows shapes).
 * Callers treat this as a corrupt / malicious artifact — log it, drop
 * the entry, re-run the task.
 */
export class ArchiveSecurityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveSecurityError'
  }
}

/** What `packArtifactStream` packs: stdout plus archive name → absolute source path. */
interface PackArgs {
  /** The cache key, recorded in the sidecar (item 943); ingest refuses an artifact without it. */
  key?: string
  stdout: string
  outputs: ReadonlyMap<string, string>
  /** Entry names of the empty directories under the outputs. */
  dirs?: readonly string[] | undefined
  /** The producing execution's usage, when the runner reported it. */
  exec?: ExecUsage | undefined
  /** The workspace root an output symlink's target must stay inside; absent, every link is refused. */
  root?: string
}

/** The largest second count ustar's 12-byte mtime field holds: 11 octal digits. */
const USTAR_MTIME_MAX = 8 ** 11 - 1

/** At or below this many outputs, `planArtifact` stats them on the calling thread. */
const ON_THREAD_STATS = 32

/** A packed artifact's plan: its entries with their stats, and the tar's exact size. */
export interface ArtifactPlan {
  inputs: TarInput[]
  size: number
}

/**
 * Stat every output once (size, and the sidecar's mode + millisecond
 * mtime) and lay out the tar — stdout first, the outputs, the sidecar
 * last — with its exact size, so the caller can choose the one-call pack
 * for a small artifact and the streamed one for a large one before a
 * byte is read. A symlinked output is stored as its link (`links`).
 */
export async function planArtifact(args: PackArgs): Promise<ArtifactPlan> {
  const meta: MetaFile = { version: 1, files: {} }
  // A few outputs are stat'ed on this thread: a pool round trip per stat
  // cost more than the stat. Many go to the pool together, as before.
  const few = args.outputs.size <= ON_THREAD_STATS
  const lstatOf = few ? async (p: string) => lstatSync(p) : lstat
  const readlinkOf = few ? async (p: string) => readlinkSync(p) : readlink
  if (args.key !== undefined) meta.key = args.key
  if (args.dirs !== undefined && args.dirs.length > 0) meta.dirs = [...args.dirs]
  const exec = usageOf(args.exec)
  if (exec !== undefined) meta.exec = exec
  const files = await Promise.all(
    [...args.outputs].map(async ([name, abs]) => {
      // The path as the config spells it: a root-anchored output's entry
      // name is vx's own `workspace-outputs/…` (M-66).
      const shown = name.startsWith('outputs/')
        ? `output ${name.slice('outputs/'.length)}`
        : name.startsWith(WORKSPACE_OUTPUT_PREFIX)
          ? `workspaceFiles output ${name.slice(WORKSPACE_OUTPUT_PREFIX.length)}`
          : `output ${name}`
      // The index stores a project row as its bare rel and reads one under
      // `workspace-outputs/` as a workspace output, so every hit of this
      // entry was "missing a recorded output", dropped and run again. The
      // loader refuses a glob written under the name; one that reaches it
      // otherwise (`**/*.js`, `w*/**`) is refused here, where names are known.
      if (name.startsWith(`outputs/${WORKSPACE_OUTPUT_PREFIX}`)) {
        throw new UserError(
          `${shown} is under workspace-outputs/, a name vx's artifacts reserve for outputs.workspaceFiles — write the task's files to another directory, or take them back with a '!' entry`,
        )
      }
      const st = await lstatOf(abs)
      if (st.isSymbolicLink()) {
        // Kept as the link, never read through: no byte of its target
        // enters the artifact, so a link to a file the task could not
        // read packs nothing of it (L-23).
        const to = await readlinkOf(abs)
        if (path.isAbsolute(to)) {
          throw new UserError(
            `${shown} is a symlink to an absolute path (${to}): vx restores a link as written, and an absolute one names this machine's checkout — make it relative, or take it back with a '!' entry`,
          )
        }
        if (args.root === undefined || !inside(path.resolve(path.dirname(abs), to), args.root)) {
          throw new UserError(
            `${shown} is a symlink to ${to}, outside the workspace: vx restores a link as written, and a project's outputs stay in its workspace — emit a file there, or take it back with a '!' entry`,
          )
        }
        return { name, link: to }
      }
      if (!st.isFile()) {
        throw new UserError(
          `${shown} is not a regular file: vx stores regular files and symlinks only — emit a file there, or narrow cache.outputs.files to the files the task produces, or take it back with a '!' entry`,
        )
      }
      const mode = st.mode & 0o777
      return {
        name,
        abs,
        size: st.size,
        mode,
        mtimeMs: Math.floor(st.mtimeMs),
        // ustar's octal field holds no sign and 11 digits: an mtime before
        // 1970 made the header unreadable, and one past March 2242 failed
        // every save of the task. The sidecar above carries the real value.
        mtime: Math.min(USTAR_MTIME_MAX, Math.max(0, Math.floor(st.mtimeMs / 1000))),
      }
    }),
  )
  // In the outputs' order, not as each stat settled: one tree, one artifact.
  const regular: Array<Exclude<(typeof files)[number], { link: string }>> = []
  for (const f of files) {
    if ('link' in f) (meta.links ??= {})[f.name] = f.link
    else {
      meta.files[f.name] = [f.mode, f.mtimeMs]
      regular.push(f)
    }
  }
  const stdout = new TextEncoder().encode(args.stdout)
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta))
  const inputs: TarInput[] = [
    { name: STDOUT_ENTRY, size: stdout.byteLength, body: stdout },
    ...regular.map((f) => ({
      name: f.name,
      size: f.size,
      mode: f.mode,
      mtime: f.mtime,
      body: Bun.file(f.abs) as Blob,
    })),
    { name: META_ENTRY, size: metaBytes.byteLength, body: metaBytes },
  ]
  return { inputs, size: tarSize([...inputs, sumInput('0'.repeat(SUM_SIZE))]) }
}

/** The tar as a stream: each output is read from disk as it is written. */
export function packArtifactStream(plan: ArtifactPlan): ReadableStream<Uint8Array> {
  return streamOf(tarPack(summed(plan.inputs)))
}

const sumInput = (hex: string): TarInput => ({ name: SUM_ENTRY, size: SUM_SIZE, body: hex })

/**
 * The inputs with each body hashed as `tarPack` reads it, then the sum
 * entry: `tarPack` drains one input before it asks for the next, so the
 * sum is whole when it is asked for.
 */
async function* summed(inputs: readonly TarInput[]): AsyncGenerator<TarInput> {
  const sum = new EntrySum()
  for (const i of inputs) {
    sum.entry(i.name)
    if (i.body instanceof Blob) {
      yield { ...i, body: sum.through(i.body.stream()) }
    } else if (typeof i.body === 'string' || i.body instanceof Uint8Array) {
      const bytes = typeof i.body === 'string' ? new TextEncoder().encode(i.body) : i.body
      sum.add(bytes)
      yield { ...i, body: bytes }
    } else {
      yield { ...i, body: sum.through(i.body) }
    }
  }
  yield sumInput(sum.hex())
}

/**
 * The tar in memory — the small-artifact path and the tests. Bodies are
 * read whole (one `bytes()` each, in flight together) rather than
 * streamed: a thousand one-file artifacts pay the stream setup
 * otherwise (measured 2026-09-03: 238 → 293 ms per 1 000 saves).
 */
export async function packArtifactBytes(plan: ArtifactPlan): Promise<Uint8Array> {
  // A small artifact is read and packed on this thread (`ON_THREAD_MAX`):
  // no promise or generator hop per file or block.
  if (plan.size <= ON_THREAD_MAX) return packSmall(plan)
  const inputs = await Promise.all(
    plan.inputs.map(async (i) =>
      i.body instanceof Blob ? { ...i, body: await i.body.bytes() } : i,
    ),
  )
  const out = new Uint8Array(plan.size)
  let off = 0
  for await (const chunk of tarPack(summed(inputs))) {
    out.set(chunk, off)
    off += chunk.byteLength
  }
  if (off !== plan.size) throw new TarFormatError(`packed ${off} bytes, planned ${plan.size}`)
  return out
}

/** `summed` + `tarPack` for a plan whose bodies fit in memory, synchronously. */
function packSmall(plan: ArtifactPlan): Uint8Array {
  const sum = new EntrySum()
  const inputs: (TarInput & { body: Uint8Array | string })[] = []
  for (const i of plan.inputs) {
    const body =
      i.body instanceof Blob
        ? readFileSync((i.body as Bun.BunFile).name!)
        : typeof i.body === 'string'
          ? new TextEncoder().encode(i.body)
          : (i.body as Uint8Array)
    sum.entry(i.name)
    sum.add(body)
    inputs.push({ ...i, body })
  }
  inputs.push({ name: SUM_ENTRY, size: SUM_SIZE, body: sum.hex() })
  const out = new Uint8Array(plan.size)
  const n = tarPackInto(inputs, out)
  if (n !== plan.size) throw new TarFormatError(`packed ${n} bytes, planned ${plan.size}`)
  return out
}

/** Plan and pack in one go, in memory. */
export async function packArtifact(args: PackArgs): Promise<Uint8Array> {
  return await packArtifactBytes(await planArtifact(args))
}

function streamOf(gen: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await gen.next()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel() {
      void gen.return(undefined)
    },
  })
}

/**
 * The tree form (`cache.store.decompress`, v47): an artifact's members
 * as plain files under one directory, `outputs/<rel>` and
 * `workspace-outputs/<rel>` as named in the tar, beside its sidecar.
 * stdout lives in the index. A restore copies (or clones) each file out,
 * so a hit decodes nothing; an upload packs the tree back into the
 * artifact a remote expects.
 *
 * Write `plan`'s outputs into the empty `dir` as the tree form, each copied
 * by the kernel (`copy_file_range`, or a clone where the filesystem has one)
 * and given its sidecar mtime, and return what a scan of the plan's tar
 * would: the save indexes from it without packing a tar.
 */
export async function writeTree(plan: ArtifactPlan, dir: string): Promise<ArtifactScan> {
  const fold = new ScanFold()
  const meta = plan.inputs.find((i) => i.name === META_ENTRY)!.body as Uint8Array
  const metaText = utf8.decode(meta)
  fold.sidecar(metaText)
  const times = (JSON.parse(metaText) as MetaFile).files
  for (const i of plan.inputs) {
    if (i.name === META_ENTRY) continue
    assertSafeName(i.name)
    if (i.name === STDOUT_ENTRY) fold.stdout = utf8.decode(i.body as Uint8Array)
    fold.entry(i.name, i.size, times[i.name]?.[1] ?? 0)
  }
  // A stdout-only entry writes no file to make the directory.
  await mkdir(dir, { recursive: true })
  await Promise.all(
    plan.inputs.map(async (i) => {
      if (!(i.body instanceof Blob)) return
      const to = path.join(dir, i.name)
      // The tar form's refusal (`tarPackInto`): an output that grew or shrank
      // since the plan's stat is not the file its row describes.
      const n = await Bun.write(to, i.body)
      if (n !== i.size) throw new TarFormatError(`${i.name}: ${n} bytes, ${i.size} declared`)
      const at = new Date(times[i.name]![1])
      await utimes(to, at, at)
    }),
  )
  await writeFile(path.join(dir, META_ENTRY), meta)
  return fold.result()
}

/**
 * Write a scanned artifact's sidecar into `dir`, whose outputs an extract
 * just wrote: an ingested remote hit kept as a tree.
 */
export async function sealTree(dir: string, scan: ArtifactScan): Promise<void> {
  // An artifact with no outputs extracts nothing, so nothing made `dir`.
  await mkdir(dir, { recursive: true })
  const meta: MetaFile = { version: 1, files: {} }
  if (scan.key !== undefined) meta.key = scan.key
  for (const e of scan.entries) {
    if (e.name !== STDOUT_ENTRY) meta.files[e.name] = [e.mode, e.mtimeMs]
  }
  if (scan.dirs.length > 0) meta.dirs = scan.dirs
  if (scan.links.length > 0) meta.links = Object.fromEntries(scan.links)
  if (scan.exec !== undefined) meta.exec = scan.exec
  await writeFile(path.join(dir, META_ENTRY), JSON.stringify(meta))
}

/** The plan that packs the tree in `dir` back into the artifact it holds. */
export function planOfTree(dir: string, stdout: string): ArtifactPlan {
  const metaBytes = readFileSync(path.join(dir, META_ENTRY))
  const meta = JSON.parse(utf8.decode(metaBytes)) as MetaFile
  const out = new TextEncoder().encode(stdout)
  const inputs: TarInput[] = [{ name: STDOUT_ENTRY, size: out.byteLength, body: out }]
  for (const [name, [mode, mtimeMs]] of Object.entries(meta.files)) {
    const file = Bun.file(path.join(dir, name))
    inputs.push({
      name,
      size: statSync(path.join(dir, name)).size,
      mode,
      mtime: Math.min(USTAR_MTIME_MAX, Math.max(0, Math.floor(mtimeMs / 1000))),
      body: file,
    })
  }
  inputs.push({ name: META_ENTRY, size: metaBytes.byteLength, body: new Uint8Array(metaBytes) })
  return { inputs, size: tarSize([...inputs, sumInput('0'.repeat(SUM_SIZE))]) }
}

/** What a scan of an artifact reads out of it. */
interface ArtifactScan {
  entries: ArchiveEntry[]
  /** The sidecar's empty directories, each name proven safe. */
  dirs: string[]
  /** The sidecar's symlinks, `[name, target]`, each name and target proven safe. */
  links: Array<[name: string, target: string]>
  stdout: string | null
  exec: ExecUsage | undefined
  key: string | undefined
}

/** A scan's result, built entry by entry in tar order: the one fold both scanners share. */
class ScanFold {
  private readonly seen: Array<{ name: string; size: number; mtimeMs: number }> = []
  private files: MetaFile['files'] = {}
  private dirs: string[] = []
  private links: Array<[string, string]> = []
  private exec: ExecUsage | undefined
  private key: string | undefined
  stdout: string | null = null

  sidecar(text: string): void {
    const parsed = JSON.parse(text) as MetaFile
    this.files = filesOf(parsed)
    this.dirs = dirsOf(parsed)
    this.links = linksOf(parsed)
    // The ingest side is the untrusted boundary: a foreign sidecar's
    // usage is taken only when it is a plain non-negative number.
    this.exec = usageOf(parsed.exec)
    if (typeof parsed.key === 'string') this.key = parsed.key
  }

  entry(name: string, size: number, mtimeMs: number): void {
    this.seen.push({ name, size, mtimeMs })
  }

  result(): ArtifactScan {
    return {
      entries: this.seen.map((s) => {
        const m = this.files[s.name]
        // A foreign artifact (or one whose sidecar lost an entry) restores
        // readable-but-not-executable rather than failing the hit: the
        // sidecar is metadata, never the authority on whether bytes exist.
        return { name: s.name, size: s.size, mode: m?.[0] ?? 0o644, mtimeMs: m?.[1] ?? s.mtimeMs }
      }),
      dirs: this.dirs,
      links: this.links,
      stdout: this.stdout,
      exec: this.exec,
      key: this.key,
    }
  }
}

/**
 * List an artifact's regular entries with their restore metadata, and
 * its stdout text (`null` when the entry is absent — not a vx artifact),
 * without materialising anything. Rejects the WHOLE archive when any
 * name is unsafe — a partial reading of a poisoned artifact is the
 * outcome the traversal defense exists to prevent.
 */
export async function scanArtifact(tar: ReadableStream<Uint8Array>): Promise<ArtifactScan> {
  const fold = new ScanFold()
  const check = new SumCheck()
  for await (const e of tarEntries(tar)) {
    if (e.type !== '0') continue
    const body = await check.body(e.name, e.body)
    if (body === null) continue
    if (e.name === META_ENTRY) {
      fold.sidecar(await textOf(body))
      continue
    }
    assertSafeName(e.name)
    if (e.name === STDOUT_ENTRY) fold.stdout = await textOf(body)
    else await drain(body)
    fold.entry(e.name, e.size, e.mtimeMs)
  }
  check.done()
  return fold.result()
}

/**
 * `scanArtifact` over a tar in memory, synchronously: a save scans the
 * tar it just packed. Same decoder, same checks in the same order, same
 * result. The async generators, per-chunk promises and drain were most
 * of a small save's scan: one 400 B output, 49 → 14 µs (X-191).
 */
export function scanTarBytes(tar: Uint8Array): ArtifactScan {
  const fold = new ScanFold()
  const check = new SumCheck()
  for (const e of tarEntriesSync(tar)) {
    if (e.type !== '0') continue
    if (check.enter(e.name)) {
      check.verify(utf8.decode(e.body()))
      continue
    }
    if (e.name === META_ENTRY) {
      const body = e.body()
      check.add(body)
      fold.sidecar(utf8.decode(body))
      continue
    }
    assertSafeName(e.name)
    const body = e.body()
    check.add(body)
    if (e.name === STDOUT_ENTRY) fold.stdout = utf8.decode(body)
    fold.entry(e.name, e.size, e.mtimeMs)
  }
  check.done()
  return fold.result()
}

/** The largest millisecond count a Date holds (ECMA-262 §21.4.1.1). */
const DATE_MAX_MS = 8.64e15

/**
 * The sidecar's stats, each an integer mode in 0..0o7777 and an integer
 * mtime a Date holds: one taken as is reached the index, and its restore
 * threw a TypeError out of `utimesSync` after renames had begun.
 */
function filesOf(meta: MetaFile): MetaFile['files'] {
  const raw: unknown = meta.files
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ArchiveSecurityError('archive sidecar files is not a map')
  }
  for (const [name, pair] of Object.entries(raw as Record<string, unknown>)) {
    if (
      !Array.isArray(pair) ||
      !Number.isInteger(pair[0]) ||
      pair[0] < 0 ||
      pair[0] > 0o7777 ||
      !Number.isInteger(pair[1]) ||
      Math.abs(pair[1]) > DATE_MAX_MS
    ) {
      throw new ArchiveSecurityError(
        `archive sidecar has a bad stat for ${name}: ${JSON.stringify(pair)}`,
      )
    }
  }
  return raw as MetaFile['files']
}

/**
 * The sidecar's directory names, each held to the rules a file entry's
 * name is (the sidecar is as attacker-reachable as the tar), and only
 * under an output namespace.
 */
function dirsOf(meta: MetaFile): string[] {
  const raw: unknown = meta.dirs
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new ArchiveSecurityError('archive sidecar dirs is not a list')
  return raw.map((name: unknown) => {
    if (
      typeof name !== 'string' ||
      !(name.startsWith('outputs/') || name.startsWith(WORKSPACE_PREFIX))
    ) {
      throw new ArchiveSecurityError(`archive directory is not an output: ${String(name)}`)
    }
    assertSafeName(name)
    return name
  })
}

/**
 * The sidecar's links, each name held to a file entry's rules and each
 * target to a relative path with no NUL: where it may point is decided at
 * the restore, which knows the workspace.
 */
function linksOf(meta: MetaFile): Array<[string, string]> {
  const raw: unknown = meta.links
  if (raw === undefined) return []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ArchiveSecurityError('archive sidecar links is not a map')
  }
  return Object.entries(raw as Record<string, unknown>).map(([name, to]) => {
    if (!(name.startsWith('outputs/') || name.startsWith(WORKSPACE_PREFIX))) {
      throw new ArchiveSecurityError(`archive link is not an output: ${name}`)
    }
    assertSafeName(name)
    if (typeof to !== 'string' || to.length === 0 || to.includes('\0') || path.isAbsolute(to)) {
      throw new ArchiveSecurityError(`archive link ${name} has an unsafe target: ${String(to)}`)
    }
    return [name, to]
  })
}

/** `p` is `root` or under it, lexically. */
/** A file this user cannot read is not the same bytes: the rename replaces it. */
function sameBytes(file: string, body: Uint8Array): boolean {
  try {
    return readFileSync(file).equals(body)
  } catch {
    return false
  }
}

/** The deepest directory holding both `a` and `b`. */
function commonDir(a: string, b: string): string {
  let dir = a
  while (!inside(b, dir) && path.dirname(dir) !== dir) dir = path.dirname(dir)
  return dir
}

const inside = (p: string, root: string): boolean => {
  const r = path.resolve(root)
  return p === r || p.startsWith(r + path.sep)
}

/** The usage worth carrying: each axis a finite non-negative number, or absent; nothing → undefined. */
function usageOf(raw: unknown): ExecUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { cpuMs, peakRssBytes } = raw as { cpuMs?: unknown; peakRssBytes?: unknown }
  const out: { cpuMs?: number; peakRssBytes?: number } = {}
  if (typeof cpuMs === 'number' && Number.isFinite(cpuMs) && cpuMs >= 0) out.cpuMs = cpuMs
  if (typeof peakRssBytes === 'number' && Number.isFinite(peakRssBytes) && peakRssBytes >= 0)
    out.peakRssBytes = peakRssBytes
  return out.cpuMs === undefined && out.peakRssBytes === undefined ? undefined : out
}

/**
 * Restore from `tar`, the DECOMPRESSED archive as a byte stream:
 * `outputs/<rel>` lands under `destDir/<rel>` and — when `workspaceDest`
 * is given — `workspace-outputs/<rel>` under `workspaceDest/<rel>`;
 * entries in neither namespace are ignored. Entries are validated and staged
 * as they arrive and renamed into place only after the archive has ended
 * cleanly and `verify` (the caller's look at which output names the
 * archive provided — the index's missing-output check) has passed. Any
 * failure — an unsafe name, an escape, a truncated stream, `verify` —
 * leaves nothing behind. Returns the provided output names.
 */
export async function extractArtifactStream(
  tar: ReadableStream<Uint8Array>,
  destDir: string,
  workspaceDest: string | undefined,
  verify?: (provided: ReadonlySet<string>) => void,
  accept?: (name: string) => boolean,
  /** The workspace root whose `.vx/tmp/` stages the entries; absent, each stages beside its target. */
  stageRoot?: string,
  /** Handed what `scanArtifact` would read of the same bytes, once their sum has checked. */
  onScan?: (scan: ArtifactScan) => void,
): Promise<Set<string>> {
  // No `mkdir -p` of the destination here: `stage` creates each entry's
  // directory chain, the destination included, and the cache restores
  // into a project directory that exists. The eager one cost every
  // restore a thread-pool round trip for an EEXIST and a stat (item 627).
  readUmask()
  const x = new Extractor(destDir, workspaceDest, stageRoot)
  const provided = new Set<string>()
  const headerMtime = new Map<string, number>()
  let meta: MetaFile['files'] = {}
  let dirs: string[] = []
  let links: Array<[string, string]> = []
  const fold = onScan === undefined ? undefined : new ScanFold()
  try {
    const check = new SumCheck()
    for await (const e of tarEntries(tar)) {
      if (e.type !== '0') continue
      const body = await check.body(e.name, e.body)
      if (body === null) continue
      if (e.name === META_ENTRY) {
        const text = await textOf(body)
        fold?.sidecar(text)
        const parsed = JSON.parse(text) as MetaFile
        meta = filesOf(parsed)
        dirs = dirsOf(parsed)
        links = linksOf(parsed)
        continue
      }
      assertSafeName(e.name)
      // Before anything is staged: an entry the task never declared is not
      // this task's save, and none of the archive lands.
      if (accept !== undefined && !accept(e.name)) {
        throw new ArchiveSecurityError(
          `archive entry is not one of the task's declared outputs: ${e.name}`,
        )
      }
      fold?.entry(e.name, e.size, e.mtimeMs)
      const dest = x.destFor(e.name)
      if (dest === null || dest.rel.length === 0) {
        if (fold !== undefined && e.name === STDOUT_ENTRY) fold.stdout = await textOf(body)
        else await drain(body)
        continue
      }
      const target = path.join(dest.base, dest.rel)
      await x.assertContained(dest.base, target, e.name)
      provided.add(e.name)
      headerMtime.set(e.name, e.mtimeMs)
      await x.stage(e.name, dest.base, target, e.size <= SMALL_ENTRY ? await bytesOf(body) : body)
    }
    check.done()
    if (fold !== undefined) onScan!(fold.result())
    for (const name of dirs) {
      if (accept !== undefined && !accept(name)) {
        throw new ArchiveSecurityError(
          `archive directory is not one of the task's declared outputs: ${name}`,
        )
      }
      const dest = x.destFor(name)
      if (dest === null || dest.rel.length === 0) continue
      const target = path.join(dest.base, dest.rel)
      await x.assertContained(dest.base, target, name)
      await x.makeDir(dest.base, target)
      // The index rows name a directory with a trailing slash.
      provided.add(`${name}/`)
    }
    // A link may point only inside the workspace (the project, without one).
    // Unpacked into a cache tree (no stage root), `outputs/` and
    // `workspace-outputs/` are siblings: bounded by the latter alone, a
    // `dist/link -> big.bin` pointed "out" and the ingest failed. The tree
    // bounds by their parent; its restore checks against the workspace.
    const bound =
      stageRoot ?? (workspaceDest === undefined ? destDir : commonDir(destDir, workspaceDest))
    for (const [name, to] of links) {
      if (accept !== undefined && !accept(name)) {
        throw new ArchiveSecurityError(
          `archive link is not one of the task's declared outputs: ${name}`,
        )
      }
      const dest = x.destFor(name)
      if (dest === null || dest.rel.length === 0) continue
      const target = path.join(dest.base, dest.rel)
      await x.assertContained(dest.base, target, name)
      const at = path.resolve(path.dirname(target), to)
      if (!inside(at, bound)) {
        throw new ArchiveSecurityError(`archive link ${name} points out of the workspace: ${to}`)
      }
      // Lexical: a write through a link is judged where it resolves, so an
      // alias chain into .git gets no further than this link would.
      if (!writableUnder(at, path.resolve(bound))) {
        throw new ArchiveSecurityError(`archive link ${name} points into .git: ${to}`)
      }
      await x.stageLink(name, dest.base, target, to)
      provided.add(name)
    }
    verify?.(provided)
    // The sidecar's stat is the truth, a mode of 000 and an mtime at or
    // before the epoch included (`SOURCE_DATE_EPOCH=0`). Without one, a
    // header mtime of 0 is a producer that wrote none: unknown.
    await x.commit((name) => {
      const m = meta[name]
      if (m !== undefined) return [m[0], m[1]]
      const header = headerMtime.get(name)
      return [0o644, header !== undefined && header > 0 ? header : undefined]
    })
  } catch (err) {
    await x.abort()
    throw err
  }
  return provided
}

/** BSD gives every new file its directory's group, setgid or not. */
const INHERITS_GROUP = process.platform === 'darwin'

/**
 * Entries up to this size are buffered and written without waiting, so a
 * thousand tiny outputs restore in parallel; larger ones stream chunk by
 * chunk to a file sink.
 */
const SMALL_ENTRY = 4 * 1024 * 1024

/** Buffered small writes in flight before the next one waits for them. */
const INFLIGHT_BYTES = 64 * 1024 * 1024

async function bytesOf(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let n = 0
  for await (const c of body) {
    parts.push(new Uint8Array(c))
    n += c.byteLength
  }
  if (parts.length === 1) return parts[0]!
  const out = new Uint8Array(n)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.byteLength
  }
  return out
}

const textOf = async (body: AsyncIterable<Uint8Array>): Promise<string> =>
  utf8.decode(await bytesOf(body))

/**
 * Bring a target that already held the entry's bytes to its mode and
 * mtime, through a descriptor opened without following a link: one
 * planted since the compare is refused, never written through.
 */
function keep(s: Staged, ino: number, mode: number, mtimeMs: number | undefined): void {
  const fd = openSync(s.target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    // An in-place write since the compare keeps the inode and bumps the ctime.
    if (st.ino !== ino || st.nlink !== 1 || st.ctimeMs !== s.sameCtimeMs) {
      throw new Error(`${s.target} changed while it was restored`)
    }
    if ((st.mode & 0o7777) !== restoredMode(mode)) fchmodSync(fd, restoredMode(mode))
    if (mtimeMs !== undefined && Math.floor(st.mtimeMs) !== mtimeMs) {
      const t = new Date(mtimeMs)
      futimesSync(fd, t, t)
    }
  } finally {
    closeSync(fd)
  }
}

/** One staged entry: written at `tmp`, renamed to `target` on commit. */
interface Staged {
  /** `tmp` is in the staging directory, not beside `target`. */
  staged: boolean
  name: string
  tmp: string
  target: string
  /** The topmost directory `mkdir -p` created for it, pruned on abort. */
  created: string | undefined
  /** Written by Bun's file writer, which creates with 0664 where `writeFile` uses 0666 (before the umask). */
  streamed: boolean
  /** The destination it is contained in. */
  base: string
  /** The target already holds the entry's bytes: nothing was written, and only its mode and mtime may change. */
  same?: number
  /** The kept target's ctime when its bytes were compared. */
  sameCtimeMs?: number
  /** `tmp` was copied beside `target`, which is on another filesystem than the staging (`crossOver`). */
  beside?: true
  /** A symlink to this target, made at `tmp`: no mode, no mtime. */
  link?: string
  /** `tmp` is inside the staged copy of this missing directory, which commit renames whole. */
  tree?: string
}

/** A directory missing in the tree, built in the staging directory and renamed in whole. */
interface Tree {
  at: string
  base: string
  /** The empty directories under it the entry holds. */
  dirs: string[]
}

/**
 * The staging core. Nothing reaches its final name until `commit`;
 * `abort` removes every temp and the empty directories this extraction
 * created.
 */
class Extractor {
  private readonly staged: Staged[] = []
  /** Empty output directories made, with the top of each chain created. */
  private readonly madeDirs: Array<{ dir: string; created: string }> = []
  private inflight: Promise<unknown>[] = []
  private inflightBytes = 0
  private readonly realBaseCache = new Map<string, string>()
  // Per-directory memos. An artifact holds a few files per directory
  // (payload's ui: 4,069 files in 535 directories), and the containment
  // walk and the `mkdir -p` are properties of the directory, not the
  // entry: doing both once per directory took the restore of that
  // artifact from 220–300 µs per file to the write itself. The window
  // this opens — a symlink planted at a validated directory between two
  // of its entries — is the same one that already lies between an
  // entry's own check and its write.
  private readonly containedDirs = new Set<string>()
  private readonly ensuredDirs = new Set<string>()
  private readonly trees = new Map<string, Tree>()
  // Directories the containment walk found missing, which `treeFor` would
  // otherwise probe again. A directory made since fails the tree's rename,
  // and the entries then go in one by one.
  private readonly seenAbsent = new Set<string>()

  constructor(
    private readonly destDir: string,
    private readonly workspaceDest: string | undefined,
    private readonly stageRoot: string | undefined,
  ) {}

  /** Each namespace anchors at its own destination dir. */
  destFor(name: string): { base: string; rel: string } | null {
    if (name.startsWith('outputs/')) {
      return { base: this.destDir, rel: name.slice('outputs/'.length) }
    }
    if (this.workspaceDest !== undefined && name.startsWith(WORKSPACE_PREFIX)) {
      return { base: this.workspaceDest, rel: name.slice(WORKSPACE_PREFIX.length) }
    }
    return null
  }

  // The REAL path of each base dir (symlinks resolved), memoized. Used to
  // catch a symlinked ANCESTOR under the output tree: the lexical check
  // below stops a `..` name, but if `<dest>/dist` is already an on-disk
  // symlink pointing outside (planted in the repo or by a dependency
  // postinstall), a lexically-contained entry `dist/x` would follow it and
  // escape. Both sides are realpath'd, so a legitimate symlinked ANCESTOR of
  // the base dir itself (e.g. macOS /tmp → /private/tmp) resolves
  // consistently and is not flagged.
  private async realBaseOf(base: string): Promise<string> {
    const key = path.resolve(base)
    let r = this.realBaseCache.get(key)
    if (r === undefined) {
      // The base often does NOT exist yet — the workspace-outputs anchor is
      // created lazily by the first entry. Falling back to the un-resolved
      // path there would compare a real ancestor (`/private/tmp/...`, once
      // mkdir has created it) against a symlinked base (`/tmp/...`) and
      // refuse EVERY entry with a bogus security error. So resolve the
      // deepest EXISTING ancestor and re-append the rest: the answer is the
      // same before and after the base is created, which is what makes the
      // memo safe.
      r = await realOf(key).catch(async () => {
        let probe = path.dirname(key)
        const tail: string[] = [path.basename(key)]
        while (probe !== path.dirname(probe)) {
          const real = await realOf(probe).then(
            (v) => v,
            () => null,
          )
          if (real !== null) return path.join(real, ...tail.reverse())
          tail.push(path.basename(probe))
          probe = path.dirname(probe)
        }
        return key
      })
      this.realBaseCache.set(key, r)
    }
    return r
  }

  // Two checks per entry: lexical (the joined path stays under the base)
  // and real (the deepest EXISTING ancestor still resolves inside the real
  // base). Walking up to the deepest existing ancestor is what makes it
  // sound BEFORE anything is created — checking only the immediate parent
  // would pass for `dist/a/b` when `dist` is the symlink and `dist/a` does
  // not exist yet.
  async assertContained(base: string, target: string, name: string): Promise<void> {
    const baseResolved = path.resolve(base)
    const targetResolved = path.resolve(target)
    if (targetResolved !== baseResolved && !targetResolved.startsWith(baseResolved + path.sep)) {
      throw new ArchiveSecurityError(`archive entry escapes destDir (unsafe): ${name}`)
    }
    const parentResolved = path.dirname(targetResolved)
    if (this.containedDirs.has(parentResolved)) return
    await this.assertParentContained(base, targetResolved)
    this.containedDirs.add(parentResolved)
  }

  private async assertParentContained(base: string, targetResolved: string): Promise<void> {
    const baseResolved = path.resolve(base)
    // Only ancestors strictly BELOW the base are candidates — those are the
    // ones a poisoned entry could follow out of the tree. The walk must never
    // climb past the base: when the base itself does not exist yet (the
    // workspace-outputs anchor is created lazily), its parent legitimately
    // resolves outside and comparing against it would reject every entry.
    // The base's own real path is resolved only once an ancestor EXISTS to
    // compare it with: after a clean pruned the output directories (the
    // common restore) nothing below the base is there, and the memoised
    // resolve was a round trip spent on a comparison never made (item 627).
    let probe = path.dirname(targetResolved)
    while (probe.startsWith(baseResolved + path.sep)) {
      // Nothing there resolves either: the lstat answers the common case
      // (a clean pruned the directory) without the failed realpath's round
      // trip and error (X-163). A dangling link is there and falls through,
      // as does an lstat that fails otherwise: the realpath decides.
      if (absent(probe)) {
        this.seenAbsent.add(probe)
        probe = path.dirname(probe)
        continue
      }
      const real = await realOf(probe).then(
        (r) => r,
        () => null,
      )
      if (real !== null) {
        const realBase = await this.realBaseOf(base)
        if (!writableUnder(real, realBase)) {
          throw await linkOutError(baseResolved, probe, realBase)
        }
        return
      }
      probe = path.dirname(probe)
    }
    // Nothing between the base and the target exists yet, so there is no
    // pre-existing symlink to follow — the chain will be created fresh.
  }

  /**
   * `mkdir -p` does not follow a DANGLING link: it fails EEXIST at the link,
   * ENOENT below it, ELOOP in a cycle — and the containment walk passed it,
   * finding nothing that resolves between it and the base. A live link that
   * stays inside the base is written through, so a dangling one is too: the
   * directory it names is created and the entry lands through the link,
   * which stays the user's (never replaced, nx#37061). One that leads out of
   * the base is the refusal a live link out gets. Only the failure pays for
   * the walk; a clean tree never reaches it.
   */
  private async mkdirThroughLink(
    base: string,
    dir: string,
    err: NodeJS.ErrnoException,
  ): Promise<string | undefined> {
    if (err.code !== 'EEXIST' && err.code !== 'ENOENT' && err.code !== 'ELOOP') throw err
    const real = await resolveThrough(dir)
    const realBase = await this.realBaseOf(base)
    if (!writableUnder(real, realBase)) {
      throw await linkOutError(path.resolve(base), dir, realBase)
    }
    // What stands there without a link on the way (a file named like the
    // directory) fails this mkdir as it failed the first: the caller names
    // it as a stray.
    return mkdir(real, { recursive: true })
  }

  /**
   * Where an entry in `dir` is written when a directory on the way to it is
   * missing: inside a copy of the topmost missing one, built in the staging
   * directory and renamed into place whole on commit. One rename per
   * missing directory, not one per file: every file of a restore into a
   * cleaned tree renamed across directories, all out of one staging
   * directory, and the kernel time of a 5,000-artifact restore doubled
   * (2026-10-17). A reader sees the directory complete or not at all.
   * Undefined where the group or filesystem would differ from a write in
   * place: the entry is then staged and renamed alone.
   */
  private async treeFor(base: string, dir: string): Promise<string | undefined> {
    if (this.stageRoot === undefined) return undefined
    const abs = path.resolve(dir)
    for (const [top, t] of this.trees) {
      if (abs === top || abs.startsWith(top + path.sep)) return t.at + abs.slice(top.length)
    }
    const baseResolved = path.resolve(base)
    let top: string | undefined
    let probe = abs
    while (
      probe.startsWith(baseResolved + path.sep) &&
      (this.seenAbsent.has(probe) || absent(probe))
    ) {
      top = probe
      probe = path.dirname(probe)
    }
    if (top === undefined) return undefined
    const staging = await stagingDir(this.stageRoot)
    const st = statSync(staging)
    const parent = statSync(probe, { throwIfNoEntry: false })
    if (
      parent === undefined ||
      !parent.isDirectory() ||
      parent.dev !== st.dev ||
      ((parent.mode | st.mode) & 0o2000) !== 0 ||
      (INHERITS_GROUP && parent.gid !== st.gid)
    ) {
      return undefined
    }
    const at = path.join(staging, (tmpSeq++).toString(36))
    this.trees.set(top, { at, base, dirs: [] })
    return at + abs.slice(top.length)
  }

  /** `dir` made, once per extraction. */
  private async ensure(dir: string): Promise<void> {
    if (this.ensuredDirs.has(dir)) return
    await mkdir(dir, { recursive: true })
    this.ensuredDirs.add(dir)
  }

  /** The tree `target` is staged in. */
  private treeOf(target: string): string | undefined {
    for (const top of this.trees.keys()) if (target.startsWith(top + path.sep)) return top
    return undefined
  }

  /** An empty output directory: made now, pruned by `abort` if it was not there. */
  async makeDir(base: string, dir: string): Promise<void> {
    const staged = await this.treeFor(base, dir)
    if (staged !== undefined) {
      await this.ensure(staged)
      this.trees.get(this.treeOf(dir + path.sep)!)!.dirs.push(dir)
      return
    }
    let created: string | undefined
    try {
      created = await mkdir(dir, { recursive: true })
    } catch (err) {
      created = await this.mkdirThroughLink(base, dir, err as NodeJS.ErrnoException)
    }
    this.ensuredDirs.add(dir)
    if (created !== undefined) this.madeDirs.push({ dir, created })
  }

  /**
   * Write the entry beside its target. A buffer is written without
   * waiting, bounded by `INFLIGHT_BYTES`; a chunk stream goes to a file
   * sink one piece at a time.
   */
  async stage(
    name: string,
    base: string,
    target: string,
    body: Uint8Array | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const dir = path.dirname(target)
    const inTree = await this.treeFor(base, dir)
    if (inTree !== undefined) {
      await this.ensure(inTree)
      const tmp = path.join(inTree, path.basename(target))
      const streamed = !(body instanceof Uint8Array)
      const tree = this.treeOf(target)!
      this.staged.push({
        staged: true,
        name,
        tmp,
        target,
        created: undefined,
        streamed,
        base,
        tree,
      })
      await this.write(tmp, body)
      return
    }
    let created: string | undefined
    if (!this.ensuredDirs.has(dir)) {
      try {
        created = await mkdir(dir, { recursive: true })
      } catch (err) {
        created = await this.mkdirThroughLink(base, dir, err as NodeJS.ErrnoException)
      }
      this.ensuredDirs.add(dir)
    }
    // A target that already holds these bytes stays: renaming over a live
    // file costs ~0.4 ms on ext4 (auto_da_alloc), and a hit that changed
    // one of 2,000 outputs paid it 2,000 times. Bytes, not a stat stamp: a
    // reproducible build gives every output one mtime (item 886).
    if (body instanceof Uint8Array && created === undefined) {
      const st = lstatSync(target, { throwIfNoEntry: false })
      if (
        st !== undefined &&
        st.isFile() &&
        st.nlink === 1 &&
        st.size === body.byteLength &&
        sameBytes(target, body)
      ) {
        this.staged.push({
          staged: false,
          name,
          tmp: '',
          target,
          created,
          streamed: false,
          base,
          same: st.ino,
          sameCtimeMs: st.ctimeMs,
        })
        return
      }
    }
    // Write apart from the target and RENAME into place. rename(2) replaces
    // the destination's directory ENTRY without following it, which is
    // what makes this both link-safe and concurrency-safe:
    //
    //   - a planted symlink or HARDLINK at the target is replaced, not
    //     written through, so `ln <victim> <dest>/out.txt` cannot get
    //     the artifact's bytes into <victim>;
    //   - the target is never momentarily ABSENT. The unlink-then-write
    //     version opened exactly that window, and a second extract of
    //     the same payload could delete the file between this one's
    //     write and its chmod — reproduced 3/400 locally, caught red on
    //     darwin CI where a loaded runner widened the race;
    //   - mode and mtime are applied BEFORE the file is visible, so no
    //     reader sees it with the wrong metadata.
    //
    // A directory at the target makes the rename fail — the same
    // fail-closed outcome the plain write had.
    // Staged under `.vx/tmp/`, so no output folder ever holds a temp: a
    // reader or a key taken meanwhile saw `.vx-tmp-*` files beside the
    // outputs, and a killed restore left them there (2026-10-16).
    const staged = this.stageRoot !== undefined
    const tmp = staged
      ? path.join(await stagingDir(this.stageRoot!), (tmpSeq++).toString(36))
      : siblingTemp(target)
    const streamed = !(body instanceof Uint8Array)
    this.staged.push({ staged, name, tmp, target, created, streamed, base })
    await this.write(tmp, body)
  }

  private async write(tmp: string, body: Uint8Array | AsyncIterable<Uint8Array>): Promise<void> {
    if (body instanceof Uint8Array) {
      this.inflightBytes += body.byteLength
      // `writeFile`, not `Bun.write`: for a buffer this size `Bun.write`
      // does the open, write and close on the calling thread and only
      // its promise is asynchronous, so ten restores in flight wrote
      // their 14,430 files one after another — a serial restore of
      // payload took the same 6–7 s as one at concurrency 10, and a CPU
      // profile put 6.7 of its 8.0 s inside `write` (2026-09-11). The
      // thread-pool write lets the restores overlap their I/O.
      const write = writeFile(tmp, body)
      // A write that fails before `commit` or `abort` awaits it must not
      // surface as an unhandled rejection; the awaiting `Promise.all` still
      // sees the error through the original promise.
      write.catch(() => undefined)
      this.inflight.push(write)
      if (this.inflightBytes > INFLIGHT_BYTES) await this.drain()
      return
    }
    const sink = Bun.file(tmp).writer()
    try {
      for await (const piece of body) await sink.write(piece)
    } finally {
      await sink.end()
    }
  }

  /** A symlink: made apart from the target like a file, renamed over it on commit. */
  async stageLink(name: string, base: string, target: string, to: string): Promise<void> {
    const dir = path.dirname(target)
    const inTree = await this.treeFor(base, dir)
    if (inTree !== undefined) {
      await this.ensure(inTree)
      const tmp = path.join(inTree, path.basename(target))
      const tree = this.treeOf(target)!
      this.staged.push({
        staged: true,
        name,
        tmp,
        target,
        created: undefined,
        streamed: false,
        base,
        link: to,
        tree,
      })
      await symlink(to, tmp)
      return
    }
    let created: string | undefined
    if (!this.ensuredDirs.has(dir)) {
      try {
        created = await mkdir(dir, { recursive: true })
      } catch (err) {
        created = await this.mkdirThroughLink(base, dir, err as NodeJS.ErrnoException)
      }
      this.ensuredDirs.add(dir)
    }
    if (created === undefined) {
      const st = lstatSync(target, { throwIfNoEntry: false })
      if (st?.isSymbolicLink() === true && readlinkSync(target) === to) return
    }
    const staged = this.stageRoot !== undefined
    const tmp = staged
      ? path.join(await stagingDir(this.stageRoot!), (tmpSeq++).toString(36))
      : siblingTemp(target)
    this.staged.push({ staged, name, tmp, target, created, streamed: false, base, link: to })
    await symlink(to, tmp)
  }

  private async drain(): Promise<void> {
    const pending = this.inflight
    this.inflight = []
    this.inflightBytes = 0
    await Promise.all(pending)
  }

  /**
   * Apply each entry's mode and mtime, then rename everything into place.
   * The metadata calls are synchronous: a few microseconds each on the
   * calling thread and ~40 µs each as thread-pool round trips, and a large
   * artifact has thousands of them (measured 2026-09-11 on payload's ui,
   * 4,069 files: 892 ms → see the archive bench). The renames go to the
   * pool, `RENAME_BATCH` at a time: each replaces a live file. The chmod is skipped when the mode is
   * the one the temp file was created with — the common case. The two
   * writers create with different modes (under umask 000: 0666 and 0664),
   * so each is stat'ed once.
   */
  async commit(
    metaFor: (name: string) => [mode: number, mtimeMs: number | undefined],
  ): Promise<void> {
    await this.drain()
    // One stat per directory, shared by the filesystem check and the group.
    const dirStats = new Map<string, Stats>()
    const statDir = (dir: string): Stats => {
      let st = dirStats.get(dir)
      if (st === undefined) {
        st = statSync(dir)
        dirStats.set(dir, st)
      }
      return st
    }
    await this.crossOver(statDir)
    const created = new Map<boolean, { mode: number; uid: number; gid: number }>()
    // The group a file written in place would take, by directory: a setgid
    // directory's on Linux, every directory's on BSD/macOS. A file staged
    // elsewhere took the staging directory's.
    const setgid = new Map<string, number | null>()
    let n = 0
    let renames: Promise<void>[] = []
    const checked = new Set<string>()
    try {
      for (const s of this.staged) {
        if (s.tree === undefined)
          await this.assertStillContained(s.base, path.dirname(s.target), checked)
        const [mode, mtimeMs] = metaFor(s.name)
        if (s.same !== undefined) {
          keep(s, s.same, mode, mtimeMs)
          continue
        }
        if (s.link !== undefined) {
          if (s.tree !== undefined) continue
          renames.push(handled(this.place(s, mode, undefined)))
          if (++n % RENAME_BATCH === 0) {
            await settle(renames)
            renames = []
          }
          continue
        }
        if (s.beside === true) {
          chmodSync(s.tmp, restoredMode(mode))
          if (mtimeMs !== undefined) utimesSync(s.tmp, new Date(mtimeMs), new Date(mtimeMs))
          renames.push(handled(this.place(s, mode, undefined)))
          if (++n % RENAME_BATCH === 0) {
            await settle(renames)
            renames = []
          }
          continue
        }
        let made = created.get(s.streamed)
        if (made === undefined) {
          const st = statSync(s.tmp)
          made = { mode: st.mode & 0o777, uid: st.uid, gid: st.gid }
          created.set(s.streamed, made)
        }
        if (restoredMode(mode) !== made.mode) chmodSync(s.tmp, restoredMode(mode))
        // A Date, not seconds: Bun reads a negative number of seconds as
        // "now", and a Date before 1970 as itself (Bun 1.4.2).
        const t = mtimeMs === undefined ? undefined : new Date(mtimeMs)
        if (t !== undefined) utimesSync(s.tmp, t, t)
        if (s.tree !== undefined) continue
        if (s.staged) {
          const dir = path.dirname(s.target)
          let gid = setgid.get(dir)
          if (gid === undefined) {
            const st = statDir(dir)
            gid = INHERITS_GROUP || (st.mode & 0o2000) !== 0 ? st.gid : null
            setgid.set(dir, gid)
          }
          if (gid !== null && gid !== made.gid) chownSync(s.tmp, made.uid, gid)
        }
        renames.push(handled(this.place(s, mode, t)))
        if (++n % RENAME_BATCH === 0) {
          await settle(renames)
          renames = []
        }
      }
    } catch (err) {
      // Every rename in flight lands or fails before `abort` cleans up
      // (a fuzz run on macOS, 2026-10-17).
      await Promise.allSettled(renames)
      throw err
    }
    await settle(renames)
    for (const [top, t] of this.trees) await this.placeTree(top, t, checked)
    await this.assertLandedInside()
    this.trees.clear()
    this.staged.length = 0
  }

  /**
   * Rename a staged tree to the directory it stands for. Something made
   * there since staging (another restore of the same outputs) takes the
   * tree's entries one by one instead, each renamed over its target.
   */
  private async placeTree(top: string, t: Tree, checked: Set<string>): Promise<void> {
    await this.assertStillContained(t.base, path.dirname(top), checked)
    try {
      await rename(t.at, top)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'ENOTDIR' && code !== 'EISDIR') {
        throw err
      }
    }
    for (const dir of t.dirs) await this.makeDirIn(t.base, dir)
    for (const s of this.staged) {
      if (s.tree !== top) continue
      const dir = path.dirname(s.target)
      await this.makeDirIn(t.base, dir)
      await this.assertStillContained(t.base, dir, checked)
      await rename(s.tmp, s.target)
    }
    await rm(t.at, { recursive: true, force: true })
  }

  private async makeDirIn(base: string, dir: string): Promise<void> {
    try {
      await mkdir(dir, { recursive: true })
    } catch (err) {
      await this.mkdirThroughLink(base, dir, err as NodeJS.ErrnoException)
    }
  }

  /**
   * Copy every staged entry whose target is on another filesystem than
   * `.vx/tmp/` to a temp beside its target, before any rename: a rename
   * there would fail EXDEV, and copying at the rename, one file at a time,
   * left the files renamed before a failed copy (ENOSPC) new and the rest
   * old (Growth's parity run, 2026-10-16). A failed copy throws with
   * nothing renamed, and `abort` removes the temps made so far.
   */
  private async crossOver(statDir: (dir: string) => Stats): Promise<void> {
    const dev = (dir: string): number => statDir(dir).dev
    const cross = this.staged.filter(
      (s) =>
        s.staged &&
        s.same === undefined &&
        s.tree === undefined &&
        dev(path.dirname(s.tmp)) !== dev(path.dirname(s.target)),
    )
    for (let i = 0; i < cross.length; i += RENAME_BATCH) {
      await settle(
        cross.slice(i, i + RENAME_BATCH).map(async (s) => {
          const side = siblingTemp(s.target)
          try {
            if (s.link !== undefined) await symlink(s.link, side)
            else await copyFile(s.tmp, side)
          } catch (err) {
            await unlink(side).catch(() => undefined)
            throw err
          }
          const staged = s.tmp
          s.tmp = side
          s.beside = true
          await unlink(staged).catch(() => undefined)
        }),
      )
    }
  }

  /**
   * Rename `s` over its target. A target on another filesystem than
   * `.vx/tmp/` (EXDEV) is reached through a temp beside it, for that file
   * only: the rename that replaces the live file stays atomic.
   */
  private async place(s: Staged, mode: number, t: Date | undefined): Promise<void> {
    try {
      await rename(s.tmp, s.target)
    } catch (err) {
      if (!s.staged || (err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
      const side = siblingTemp(s.target)
      try {
        if (s.link !== undefined) await symlink(s.link, side)
        else {
          await copyFile(s.tmp, side)
          chmodSync(side, restoredMode(mode))
          if (t !== undefined) utimesSync(side, t, t)
        }
        await rename(side, s.target)
      } catch (e) {
        await unlink(side).catch(() => undefined)
        throw e
      }
      await unlink(s.tmp).catch(() => undefined)
    }
  }

  /**
   * The staging check, again at the rename: a directory on the way swapped
   * for a link out of the base since then would carry the rename with it.
   * Bun has no `renameat` against a held directory fd, so this is by path,
   * once per directory per commit.
   */
  private async assertStillContained(
    base: string,
    dir: string,
    checked: Set<string>,
  ): Promise<void> {
    if (checked.has(dir)) return
    checked.add(dir)
    const realBase = await this.realBaseOf(base)
    const real = await realOf(dir, true)
    if (!writableUnder(real, realBase)) {
      throw await linkOutError(path.resolve(base), dir, realBase)
    }
  }

  /**
   * The check before each rename, once more after all landed: the rename
   * runs on the thread pool, and a directory swapped for a link out in that
   * gap carried the entry with it (restore-link-swap-rename.test.ts). An
   * entry that landed outside is removed from there and the restore fails.
   */
  private async assertLandedInside(): Promise<void> {
    const landed = new Map<string, { base: string; placed: string[] }>()
    const add = (base: string, dir: string, placed: string): void => {
      const at = landed.get(dir)
      if (at === undefined) landed.set(dir, { base, placed: [placed] })
      else at.placed.push(placed)
    }
    for (const s of this.staged) {
      if (s.same === undefined && s.tree === undefined)
        add(s.base, path.dirname(s.target), s.target)
    }
    for (const [top, t] of this.trees) add(t.base, path.dirname(top), top)
    for (const [dir, { base, placed }] of landed) {
      const realBase = await this.realBaseOf(base)
      const real = await realOf(dir, true).catch(() => null)
      if (real === null || writableUnder(real, realBase)) continue
      await Promise.allSettled(placed.map((p) => rm(p, { recursive: true, force: true })))
      throw await linkOutError(path.resolve(base), dir, realBase)
    }
  }

  /**
   * Never leave a temp behind: beside a target, the declared output globs
   * would sweep it into the next artifact. Directories this extraction created
   * are removed bottom-up while empty; one a concurrent writer has since
   * filled is left alone.
   */
  async abort(): Promise<void> {
    await Promise.allSettled(this.inflight)
    this.inflight = []
    await Promise.all(
      this.staged.map((s) =>
        s.same === undefined ? unlink(s.tmp).catch(() => undefined) : undefined,
      ),
    )
    for (const t of this.trees.values()) await rm(t.at, { recursive: true, force: true })
    this.trees.clear()
    // Newest first: a later entry's chain can sit inside an earlier one's
    // (`dist/` then `dist/sub/`), never the reverse.
    for (const s of this.staged.toReversed()) {
      if (s.created === undefined) continue
      let dir = path.dirname(s.target)
      const top = path.resolve(s.created)
      // Created at a dangling link's resolved target (`mkdirThroughLink`),
      // so the chain is pruned from where the link leads.
      if (!dir.startsWith(top)) dir = await realOf(dir).catch(() => dir)
      while (dir.startsWith(top)) {
        if (
          !(await rmdir(dir).then(
            () => true,
            () => false,
          ))
        )
          break
        if (dir === top) break
        dir = path.dirname(dir)
      }
    }
    for (const { dir: made, created } of this.madeDirs.toReversed()) {
      const top = path.resolve(created)
      let dir = made.startsWith(top) ? made : await realOf(made).catch(() => made)
      while (
        dir.startsWith(top) &&
        (await rmdir(dir).then(
          () => true,
          () => false,
        ))
      ) {
        if (dir === top) break
        dir = path.dirname(dir)
      }
    }
    this.madeDirs.length = 0
    this.staged.length = 0
  }
}

/**
 * Renames in flight at once. A rename over a live file is not the few
 * microseconds of one into an empty directory: on ext4 replacing a file
 * starts writeback of the new one's data (`auto_da_alloc`), ~250 µs each,
 * and synchronous ones stalled the main thread. 300 one-file restores
 * took 25% longer than delete-then-restore (2026-10-16); on the thread
 * pool they tie it, and 2,000 files in one restore are faster.
 */
const RENAME_BATCH = 64

/**
 * `p`, its failure marked handled at once: `settle` reads it later, and a
 * rename that fails while the commit awaits something else is not an
 * unhandled rejection that fails the process.
 */
function handled(p: Promise<void>): Promise<void> {
  p.catch(() => undefined)
  return p
}

/** Wait for every rename, then throw the first failure: none is left in flight for `abort`. */
async function settle(renames: readonly Promise<void>[]): Promise<void> {
  for (const r of await Promise.allSettled(renames)) if (r.status === 'rejected') throw r.reason
}

/** Per-process counter for extract temp names; uniqueness only. */
let tmpSeq = 0

/** `.vx/<STAGING>/`: where restores stage, each process in its own `<pid>-0` directory. */
const STAGING = 'tmp'

const stagingMade = new Set<string>()

/**
 * This process's staging directory under `root`'s `.vx/tmp/`, made on its
 * first restore and again only if something removed it: one per restore
 * cost 300 restores 12% (2026-10-16). Every restore's renames empty it;
 * the next run's `sweepStaging` removes it once this process is gone.
 */
async function stagingDir(root: string): Promise<string> {
  const top = path.join(root, '.vx', STAGING)
  const own = path.join(top, `${process.pid.toString(36)}-0`)
  if (stagingMade.has(own) && existsSync(own)) return own
  await mkdir(own, { recursive: true })
  // Ignored by git whatever `.vx/.gitignore` an older init committed.
  try {
    writeFileSync(path.join(top, '.gitignore'), '*\n', { flag: 'wx' })
  } catch {
    // there already, or the restore fails on its first write anyway
  }
  stagingMade.add(own)
  return own
}

/**
 * A temp beside `target`, with its own short name, never `<target>.suffix`:
 * a suffix pushed a legal name of 242–255 bytes past NAME_MAX, and the
 * restore of a valid artifact failed with ENAMETOOLONG (item 666).
 */
function siblingTemp(target: string): string {
  return path.join(
    path.dirname(target),
    `.vx-tmp-${process.pid.toString(36)}-${(tmpSeq++).toString(36)}`,
  )
}

const WORKSPACE_PREFIX = 'workspace-outputs/'

/**
 * The on-disk half of containment failed: `probe`, a directory under
 * `base`, resolves outside it, so a directory between them is a link out.
 * That is the tree, not the artifact — an output directory made a link
 * after the entry was saved (upstream survey, nx#37061) — so it is the
 * user's to fix, and the refusal names the link and where it leads. The
 * restore never writes through it and never replaces it: the link is the
 * user's, and replacing it is the bug nx#37061 reports.
 */
async function linkOutError(base: string, probe: string, realBase: string): Promise<UserError> {
  let dir = base
  let real = realBase
  for (const part of path.relative(base, probe).split(path.sep)) {
    dir = path.join(dir, part)
    real = await resolveThrough(dir)
    if (!writableUnder(real, realBase)) break
  }
  if (real.startsWith(realBase + path.sep)) {
    return new UserError(
      `${dir} is a symbolic link to ${real}, Git's metadata — a cache restore never writes ` +
        'into a .git directory. Remove the link and re-run, or stop declaring outputs under it.',
    )
  }
  return new UserError(
    `${dir} is a symbolic link to ${real}, outside ${base} — a cache restore never writes ` +
      'through a link that leaves its directory. Remove the link and re-run (the restore ' +
      'puts a real directory there), or stop declaring outputs under it.',
  )
}

/** Whether nothing at all is at `p` (a dangling link is something). */
function absent(p: string): boolean {
  try {
    return lstatSync(p, { throwIfNoEntry: false }) === undefined
  } catch {
    return false
  }
}

/**
 * `realpath`, for a path holding a backslash too: Bun's answers ENOENT for
 * any such path (1.4.2), so the containment walk took a link named
 * `dist\x` for absent and wrote through it, and a save called a linked
 * output under one dangling. Such a path's links are read one by one.
 */
async function realOf(p: string, sync = false): Promise<string> {
  try {
    return sync ? realpathSync(p) : await realpath(p)
  } catch (err) {
    if (!p.includes('\\')) throw err
    const real = await resolveThrough(p)
    await stat(real)
    return real
  }
}

/**
 * Where `p` leads, every link on the way followed, a dangling one included:
 * `realpath` for the part that exists, and past the first missing name the
 * rest as written — where `mkdir -p` would create it if it followed links.
 * A cycle is the user's tree, not the artifact, so it is refused by name.
 */
async function resolveThrough(p: string): Promise<string> {
  const abs = path.resolve(p)
  // The root is `/` or a drive (`C:\`): joining a drive onto `\` loses it.
  let at = path.parse(abs).root
  const pending = abs.slice(at.length).split(path.sep).filter(Boolean).reverse()
  let hops = 0
  while (pending.length > 0) {
    const next = path.join(at, pending.pop()!)
    const link = await readlink(next).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EINVAL') return null
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return undefined
      throw err
    })
    if (link === undefined) return path.join(next, ...pending.reverse())
    if (link === null) {
      at = next
      continue
    }
    // Linux's own bound on links followed in one lookup (MAXSYMLINKS).
    if (++hops > 40) {
      throw new UserError(
        `${p} goes through a cycle of symbolic links (at ${next}) — a cache restore cannot ` +
          'write through it. Remove the link and re-run.',
      )
    }
    let rest = link
    if (path.isAbsolute(link)) {
      at = path.parse(link).root
      rest = link.slice(at.length)
    }
    pending.push(...rest.split('/').filter(Boolean).reverse())
  }
  return at
}

/**
 * Path-traversal defense, applied to every entry name at read time.
 * Mirrors Turbo's `restore.rs:check_path` normalization: an artifact is
 * attacker-reachable, so a name that could resolve outside the anchor is
 * refused before anything decides where to write it.
 */
function assertSafeName(name: string): void {
  if (name.length === 0) {
    throw new ArchiveSecurityError('archive entry has an empty name')
  }
  if (name.startsWith('/')) {
    throw new ArchiveSecurityError(`archive entry name is absolute (unsafe): ${name}`)
  }
  if (hasParentSegment(name)) {
    throw new ArchiveSecurityError(`archive entry name escapes via '..' (unsafe): ${name}`)
  }
  if (name.includes('//')) {
    throw new ArchiveSecurityError(`archive entry name has empty path component (unsafe): ${name}`)
  }
  // vx never packs a `.` segment, and `outputs/.` names the anchor itself:
  // ingest kept it, and every hit then failed renaming a file over the
  // project directory, blamed on the user's tree.
  if (hasDotSegment(name)) {
    throw new ArchiveSecurityError(`archive entry name has a '.' segment (unsafe): ${name}`)
  }
  // No backslash refusal: vx runs on Linux and macOS (Windows through WSL),
  // where it is a name character, and the save scans its own artifact with
  // these checks, so refusing one made `dist/back\slash` uncacheable.
  if (/^[A-Za-z]:[\\/]/.test(name)) {
    throw new ArchiveSecurityError(`archive entry has windows drive prefix (unsafe): ${name}`)
  }
  if (name.includes('\0')) {
    throw new ArchiveSecurityError(`archive entry name contains a null byte (unsafe): ${name}`)
  }
  // Only a pax `path` record can carry a name this long. Left to the file
  // system it is a raw ENAMETOOLONG, which the restore reports as an
  // internal error rather than a refused artifact. A UTF-16 unit is at most
  // three UTF-8 bytes, so the common short name never pays for the count.
  if (name.length * 3 >= PATH_MAX && Buffer.byteLength(name) >= PATH_MAX) {
    throw new ArchiveSecurityError(
      `archive entry name is ${Buffer.byteLength(name)} bytes, past PATH_MAX (${PATH_MAX}) (unsafe): ${name.slice(0, 64)}…`,
    )
  }
  // The same raw ENAMETOOLONG for one component past NAME_MAX, the same on
  // Linux and macOS. Same cheap bound: a name under 86 units cannot hold one.
  if (name.length * 3 > NAME_MAX) {
    for (const part of name.split('/')) {
      if (part.length * 3 > NAME_MAX && Buffer.byteLength(part) > NAME_MAX) {
        throw new ArchiveSecurityError(
          `archive entry has a ${Buffer.byteLength(part)}-byte component, past NAME_MAX (${NAME_MAX}) (unsafe): ${part.slice(0, 64)}…`,
        )
      }
    }
  }
}

/** Bytes one path component may hold (limits.h), on Linux and macOS alike. */
const NAME_MAX = 255

/** Bytes a path may hold, its terminating NUL included (limits.h). */
const PATH_MAX = process.platform === 'darwin' ? 1024 : 4096

function hasDotSegment(p: string): boolean {
  return p === '.' || p.startsWith('./') || p.endsWith('/.') || p.includes('/./')
}

function hasParentSegment(p: string): boolean {
  if (p === '..' || p.startsWith('../') || p.endsWith('/..')) return true
  return p.includes('/../')
}
