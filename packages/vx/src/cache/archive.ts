// Cache artifact container: a zstd-compressed tar written and read by vx's own
// streaming tar code (`tar-stream.ts`). It holds `stdout` (the vx-artifact
// marker), `outputs/<rel>`, `workspace-outputs/<rel>` and `.vx-meta.json`.
//
// Tar headers carry second mtimes and lose nothing else vx needs only by luck,
// so the pack side stats each output once and writes its mode and millisecond
// mtime into the sidecar. A restore applies the mode; it dates a file it writes
// now, and leaves the mtime of one whose bytes already stood.
//
// Both directions stream, never holding more than a chunk. Every regular entry
// is staged under `.vx/tmp/<pid>-0/` and renamed over its target only once the
// WHOLE archive has been read and every name proven safe, so a poisoned entry
// anywhere leaves nothing behind, and a killed restore leaves temps the next
// run sweeps.
//
// What stays here is what no tar reader decides: WHERE an entry may land. An
// artifact is attacker-reachable (a poisoned remote, a tampered local entry),
// so every name and destination is proven inside its anchor before a byte is
// written ("zip slip"). Non-regular tar entries are never materialised; an
// output symlink rides the sidecar (`links`), its target held to the workspace
// on both sides.

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
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  utimesSync,
  type Stats,
} from 'node:fs'
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
import {
  decodeRaw,
  ignoreDir,
  rawEncode,
  UserError,
  writableUnder,
  readUmask,
  restoredMode,
} from '../util/index.js'
import { type OutputFileRow, WORKSPACE_OUTPUT_PREFIX, LINK_MODE } from '../memo/index.js'
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

/** Archive entry name carrying the per-output mode/mtime sidecar. */
const META_ENTRY = '.vx-meta.json'

/** The project outputs' prefix no artifact may use: the tree form keeps workspace outputs there. */
const RESERVED_OUTPUT = `outputs/${WORKSPACE_OUTPUT_PREFIX}`

/** Archive entry name of the always-present stdout record. */
const STDOUT_ENTRY = 'stdout'

// One decoder for both scanners. `ignoreBOM`: a leading U+FEFF in a task's
// stdout is the task's.
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true })

/**
 * The last entry: a CRC-32 over every entry before it (name, NUL, body), as 8
 * hex digits. Nothing else checks a BODY: tar sums headers only and zstd writes
 * no frame checksum, so a byte flipped in a raw block decoded clean and
 * replayed wrong bytes under a green hit. It catches transit and storage
 * damage, not a store that forges artifacts.
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
 * The reader's half: each regular entry is hashed as consumed and `check` gets
 * the sum entry's body. A sum absent, wrong or followed by another entry is
 * refused before anything is committed.
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
   * The next regular entry: true when it is the sum entry, whose text goes to
   * `verify`; otherwise its bytes go to `add`.
   */
  enter(name: string): boolean {
    if (this.seen) throw new TarFormatError(`entry ${name} follows the artifact's checksum`)
    if (name === SUM_ENTRY) return true
    // vx never packs a name twice; staged twice, which body landed would be a
    // race.
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
 * Sidecar shape. `files` maps an entry name to a `[mode, mtimeMs]` pair, not an
 * object: per-file key names would be paid once per output in otherwise
 * compressible bytes.
 */
interface MetaFile {
  /**
   * Bumped only if the sidecar's own shape changes; the container is versioned
   * by CACHE_VERSION.
   */
  version: 1
  /**
   * The key the artifact was packed under. Ingest refuses bytes under another
   * key: nothing else ties an artifact to its key, so a remote answering one
   * key with another's bytes would replay the other task's outputs.
   */
  key?: string
  files: Record<string, [mode: number, mtimeMs: number]>
  /**
   * The empty directories under the outputs, as entry names: a tar of regular
   * files cannot hold them.
   */
  dirs?: string[]
  /**
   * The symlinks under the outputs, entry name → target as written (relative,
   * inside the workspace): a hit makes the link, as Turbo and Nx do.
   */
  links?: Record<string, string>
  /**
   * Output directories whose mode withholds a permission 0755 grants (`chmod
   * 700 dist/keys`), entry name → permission bits; otherwise a hit made them
   * with mkdir's default, readable by every user.
   */
  dirModes?: Record<string, number>
  /**
   * What the producing execution used (optional). Rides the artifact so a
   * machine that never ran the task still learns it.
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
 * Thrown when an entry's name could escape the extraction anchor (absolute,
 * `..`, doubled separator, Windows shapes). A corrupt or malicious artifact:
 * dropped, and the task re-runs.
 */
export class ArchiveSecurityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveSecurityError'
  }
}

/** What `packArtifactStream` packs: stdout plus archive name → absolute source path. */
interface PackArgs {
  /** The cache key, recorded in the sidecar; ingest refuses an artifact without it. */
  key?: string
  stdout: string
  outputs: ReadonlyMap<string, string>
  /** Entry names of the empty directories under the outputs. */
  dirs?: readonly string[] | undefined
  /** The producing execution's usage, when the runner reported it. */
  exec?: ExecUsage | undefined
  /** The workspace root an output symlink's target must stay inside; absent, every link is refused. */
  root?: string
  /** Where `outputs/` names lie, for the directory modes (`dirModes`); absent, none is recorded. */
  projectDir?: string
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
 * Stat every output once (size, mode, millisecond mtime) and lay out the tar
 * (stdout, outputs, sidecar) with its exact size, so the caller picks the
 * one-call pack or the streamed one before a byte is read. A symlinked output
 * is stored as its link.
 */
export async function planArtifact(args: PackArgs): Promise<ArtifactPlan> {
  const meta: MetaFile = { version: 1, files: {} }
  // A few outputs are stat'ed on this thread: a pool round trip per stat cost
  // more than the stat.
  const few = args.outputs.size <= ON_THREAD_STATS
  const lstatOf = few ? async (p: string) => lstatSync(p) : lstat
  const readlinkOf = few ? async (p: string) => readlinkSync(p) : readlink
  if (args.key !== undefined) meta.key = args.key
  if (args.dirs !== undefined && args.dirs.length > 0) meta.dirs = [...args.dirs]
  const exec = usageOf(args.exec)
  if (exec !== undefined) meta.exec = exec
  const files = await Promise.all(
    [...args.outputs].map(async ([name, abs]) => {
      // The path as the config spells it: a root-anchored output's entry name
      // is `workspace-outputs/…`.
      const shown = name.startsWith('outputs/')
        ? `output ${name.slice('outputs/'.length)}`
        : name.startsWith(WORKSPACE_OUTPUT_PREFIX)
          ? `workspaceFiles output ${name.slice(WORKSPACE_OUTPUT_PREFIX.length)}`
          : `output ${name}`
      // The index reads a row under `workspace-outputs/` as a workspace output,
      // so a project output by that name would miss on every hit. The loader
      // refuses such a glob; one that reaches it anyway (`**/*.js`) is refused
      // here, where names are known.
      if (name.startsWith(`outputs/${WORKSPACE_OUTPUT_PREFIX}`)) {
        throw new UserError(
          `${shown} is under workspace-outputs/, a name vx's artifacts reserve for outputs.workspaceFiles — write the task's files to another directory, or take them back with a '!' entry`,
        )
      }
      const st = await lstatOf(abs)
      if (st.isSymbolicLink()) {
        // Kept as the link, never read through: no byte of its target enters
        // the artifact.
        const to = await readlinkOf(abs)
        // A venv's `bin/python -> /usr/local/bin/python3` names no checkout, so
        // "make it relative" is no fix to suggest.
        if (path.isAbsolute(to) && args.root !== undefined && !inside(to, args.root)) {
          throw new UserError(
            `${shown} is a symlink to ${to}, an absolute path outside the workspace: vx restores a link as written, and a project's outputs stay in its workspace — emit a file there (a copy, e.g. \`python -m venv --copies\`), or take it back with a '!' entry`,
          )
        }
        if (path.isAbsolute(to)) {
          throw new UserError(
            `${shown} is a symlink to an absolute path (${to}): vx restores a link as written, and an absolute one names this machine's checkout — make it relative, or take it back with a '!' entry`,
          )
        }
        const refused =
          args.root === undefined ? 'out' : linkRefused(path.dirname(abs), to, args.root)
        if (refused === 'out') {
          throw new UserError(
            `${shown} is a symlink to ${to}, outside the workspace: vx restores a link as written, and a project's outputs stay in its workspace — emit a file there, or take it back with a '!' entry`,
          )
        }
        if (refused === '.git') {
          throw new UserError(
            `${shown} is a symlink to ${to}, inside .git: vx never restores into Git's metadata — emit a file there, or take it back with a '!' entry`,
          )
        }
        return { name, link: to, abs, shown }
      }
      if (!st.isFile()) {
        throw new UserError(
          `${shown} is not a regular file: vx stores regular files and symlinks only — emit a file there, or narrow outputs.files to the files the task produces, or take it back with a '!' entry`,
        )
      }
      const mode = st.mode & 0o777
      return {
        name,
        abs,
        size: st.size,
        mode,
        mtimeMs: Math.floor(st.mtimeMs),
        // ustar's octal field holds no sign and 11 digits: an mtime before 1970
        // or past 2242 breaks the header. The sidecar carries the real value.
        mtime: Math.min(USTAR_MTIME_MAX, Math.max(0, Math.floor(st.mtimeMs / 1000))),
      }
    }),
  )
  const shownOf = new Map<string, string>()
  const linked = new Map<string, string>()
  const symlinks = files.filter(
    (f): f is Extract<(typeof files)[number], { link: string }> => 'link' in f,
  )
  for (const f of symlinks) {
    shownOf.set(f.abs, f.shown)
    linked.set(f.abs, f.link)
  }
  for (const f of symlinks) {
    const via = throughLink(path.dirname(f.abs), f.link, linked)
    if (via?.why === 'through') {
      throw new UserError(
        `${f.shown} is a symlink to ${f.link} through ${shownOf.get(via.at)}, another link: vx restores each link as written and checks where it points alone — point it at the target directly, or take it back with a '!' entry`,
      )
    }
    if (via?.why === 'loop') {
      throw new UserError(
        `${f.shown} is a symlink to ${f.link}, a chain of links that loops or runs past ${LINK_CHAIN_MAX} hops at ${shownOf.get(via.at)} — point it at the target directly, or take it back with a '!' entry`,
      )
    }
  }
  if (symlinks.length > 0 && args.root !== undefined) {
    const realRoot = await realOf(args.root)
    const realDirs = new Map<string, Promise<string>>()
    for (const f of symlinks) {
      const refused = await linkLandsRefused(path.dirname(f.abs), f.link, realRoot, realDirs)
      if (refused === 'out') {
        throw new UserError(
          `${f.shown} is a symlink to ${f.link}, outside the workspace: vx restores a link as written, and a project's outputs stay in its workspace — emit a file there, or take it back with a '!' entry`,
        )
      }
      if (refused === '.git') {
        throw new UserError(
          `${f.shown} is a symlink to ${f.link}, inside .git: vx never restores into Git's metadata — emit a file there, or take it back with a '!' entry`,
        )
      }
    }
  }
  // In the outputs' order, not as each stat settled: one tree, one artifact.
  const regular: Array<Exclude<(typeof files)[number], { link: string }>> = []
  for (const f of files) {
    if ('link' in f) (meta.links ??= {})[f.name] = f.link
    else {
      meta.files[f.name] = [f.mode, f.mtimeMs]
      regular.push(f)
    }
  }
  if (args.projectDir !== undefined) {
    const modes = narrowDirModes(
      [...args.outputs.keys(), ...(args.dirs ?? [])],
      args.dirs ?? [],
      (name) =>
        name.startsWith('outputs/')
          ? path.join(args.projectDir!, name.slice('outputs/'.length))
          : path.join(args.root ?? args.projectDir!, name.slice(WORKSPACE_PREFIX.length)),
    )
    if (modes !== undefined) meta.dirModes = modes
  }
  const stdout = rawEncode(args.stdout)
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

/**
 * The modes `MetaFile.dirModes` keeps: of each directory on the way to an
 * output name, and of each empty output directory, only those withholding a
 * permission 0755 grants. Wider modes are left to the umask, so most artifacts
 * carry none.
 */
function narrowDirModes(
  names: readonly string[],
  emptyDirs: readonly string[],
  abs: (name: string) => string,
): Record<string, number> | undefined {
  const seen = new Set<string>()
  let out: Record<string, number> | undefined
  const visit = (dir: string): void => {
    if (seen.has(dir)) return
    seen.add(dir)
    const st = statSync(abs(dir), { throwIfNoEntry: false })
    if (st?.isDirectory() !== true || (st.mode & 0o755) === 0o755) return
    ;(out ??= {})[dir] = st.mode & 0o777
  }
  for (const d of emptyDirs) visit(d)
  for (const name of names) {
    const top = name.startsWith('outputs/') ? 'outputs/'.length : WORKSPACE_PREFIX.length
    for (let i = name.lastIndexOf('/'); i > top; i = name.lastIndexOf('/', i - 1)) {
      visit(name.slice(0, i))
    }
  }
  return out
}

/** The tar as a stream: each output is read from disk as it is written. */
export function packArtifactStream(plan: ArtifactPlan): ReadableStream<Uint8Array> {
  return streamOf(tarPack(summed(plan.inputs)))
}

const sumInput = (hex: string): TarInput => ({ name: SUM_ENTRY, size: SUM_SIZE, body: hex })

/**
 * The inputs with each body hashed as `tarPack` reads it, then the sum entry:
 * `tarPack` drains one input before asking for the next, so the sum is whole
 * when asked for.
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
 * The tar in memory, for small artifacts and tests. Bodies are read whole, in
 * flight together: stream setup per tiny file costs more.
 */
export async function packArtifactBytes(plan: ArtifactPlan): Promise<Uint8Array> {
  // A small artifact is packed on this thread (`ON_THREAD_MAX`): no promise or
  // generator hop per file or block.
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
 * The tree form (`cache.store.decompress`): an artifact's members as plain
 * files under one directory at their index rows' paths, with stdout and every
 * sidecar fact in the index rows. A restore copies (or clones) each file out,
 * decoding nothing; an upload packs the tree back into the artifact a remote
 * expects (`planOfTree`).
 *
 * Write `plan`'s outputs into the empty `dir` as the tree form, each copied by
 * the kernel and given its sidecar mtime, and return what a scan of the plan's
 * tar would.
 */
export async function writeTree(plan: ArtifactPlan, dir: string): Promise<ArtifactScan> {
  const fold = new ScanFold()
  const meta = plan.inputs.find((i) => i.name === META_ENTRY)!.body as Uint8Array
  const metaText = utf8.decode(meta)
  fold.sidecar(metaText)
  const parsed = JSON.parse(metaText) as MetaFile
  const times = parsed.files
  for (const i of plan.inputs) {
    if (i.name === META_ENTRY) continue
    assertSafeName(i.name)
    if (i.name === STDOUT_ENTRY) fold.stdout = decodeRaw(i.body as Uint8Array)
    fold.entry(i.name, i.size, times[i.name]?.[1] ?? 0)
  }
  // A stdout-only entry writes no file to make the directory.
  await mkdir(dir, { recursive: true })
  // Every write settles before a failure is thrown: the caller removes `dir`,
  // and a write in flight would make its parents again.
  const settled = await Promise.allSettled([
    ...plan.inputs.map(async (i) => {
      if (!(i.body instanceof Blob)) return
      const to = path.join(dir, treeRel(i.name))
      // The tar form's refusal: an output that changed size since the plan's
      // stat is not the file its row describes.
      const n = await Bun.write(to, i.body)
      if (n !== i.size) throw new TarFormatError(`${i.name}: ${n} bytes, ${i.size} declared`)
      const at = new Date(times[i.name]![1])
      await utimes(to, at, at)
    }),
    // Its row holds only the target's length and CRC: the link is the target's record.
    ...Object.entries(parsed.links ?? {}).map(async ([name, to]) => {
      const at = path.join(dir, treeRel(name))
      await mkdir(path.dirname(at), { recursive: true })
      await symlink(to, at)
    }),
  ])
  const failed = settled.find((s) => s.status === 'rejected')
  if (failed !== undefined) throw failed.reason
  return fold.result()
}

/** Where an artifact entry lives in a tree: its index row's path. */
function treeRel(name: string): string {
  return name.startsWith('outputs/') ? name.slice('outputs/'.length) : name
}

/**
 * The plan that packs the tree in `dir` back into its artifact, the sidecar
 * rebuilt from the entry's rows. A link is held to its row's length and CRC.
 */
export function planOfTree(
  dir: string,
  stdout: string,
  rows: readonly OutputFileRow[],
  key: string,
  exec: ExecUsage | undefined,
): ArtifactPlan {
  const meta: MetaFile = { version: 1, key, files: {} }
  if (exec !== undefined) meta.exec = exec
  const out = rawEncode(stdout)
  const inputs: TarInput[] = [{ name: STDOUT_ENTRY, size: out.byteLength, body: out }]
  const nameOf = (rel: string): string =>
    rel.startsWith(WORKSPACE_OUTPUT_PREFIX) ? rel : `outputs/${rel}`
  const dirs: string[] = []
  const dirModes: Record<string, number> = {}
  for (const r of rows) {
    if (r.path.endsWith('/')) {
      const name = nameOf(r.path.slice(0, -1))
      // A moded directory with nothing under it is an empty one too.
      if (r.mode === 0 || !rows.some((o) => o !== r && o.path.startsWith(r.path))) dirs.push(name)
      if (r.mode !== 0) dirModes[name] = r.mode & 0o7777
      continue
    }
    const name = nameOf(r.path)
    const at = path.join(dir, r.path)
    if (r.mode === LINK_MODE) {
      const to = readlinkSync(at, 'buffer')
      if (to.byteLength !== r.size || Bun.hash.crc32(to) !== r.mtimeMs)
        throw new ArchiveSecurityError(`kept tree link ${name} is not the link its row records`)
      ;(meta.links ??= {})[name] = utf8.decode(to)
      continue
    }
    // Bun.file reads through a link: only a regular file is packed as one.
    const st = lstatSync(at)
    if (!st.isFile())
      throw new ArchiveSecurityError(`kept tree entry ${name} is not a regular file`)
    meta.files[name] = [r.mode, r.mtimeMs]
    inputs.push({
      name,
      size: st.size,
      mode: r.mode,
      mtime: Math.min(USTAR_MTIME_MAX, Math.max(0, Math.floor(r.mtimeMs / 1000))),
      body: Bun.file(at),
    })
  }
  if (dirs.length > 0) meta.dirs = dirs
  if (Object.keys(dirModes).length > 0) meta.dirModes = dirModes
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta))
  inputs.push({ name: META_ENTRY, size: metaBytes.byteLength, body: metaBytes })
  return { inputs, size: tarSize([...inputs, sumInput('0'.repeat(SUM_SIZE))]) }
}

/** What a scan of an artifact reads out of it. */
interface ArtifactScan {
  entries: ArchiveEntry[]
  /** The sidecar's empty directories, each name proven safe. */
  dirs: string[]
  /** The sidecar's symlinks, `[name, target]`, each name and target proven safe. */
  links: Array<[name: string, target: string]>
  /** The sidecar's directory modes, each a directory the artifact holds something in or is. */
  dirModes: Array<[name: string, mode: number]>
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
  private dirModes: Array<[string, number]> = []
  private exec: ExecUsage | undefined
  private key: string | undefined
  stdout: string | null = null

  sidecar(text: string): void {
    const parsed = JSON.parse(text) as MetaFile
    this.files = filesOf(parsed)
    this.dirs = dirsOf(parsed)
    this.links = linksOf(parsed)
    this.dirModes = dirModesOf(parsed)
    // Ingest is the untrusted boundary: a foreign sidecar's usage is taken only
    // as a plain non-negative number.
    this.exec = usageOf(parsed.exec)
    if (typeof parsed.key === 'string') this.key = parsed.key
  }

  entry(name: string, size: number, mtimeMs: number): void {
    this.seen.push({ name, size, mtimeMs })
  }

  result(): ArtifactScan {
    // A mode names a directory the artifact holds, never one a restore would
    // otherwise not make.
    if (this.dirModes.length > 0) {
      const held = new Set(this.dirs)
      const hold = (name: string): void => {
        for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1))
          held.add(name.slice(0, i))
      }
      for (const s of this.seen) hold(s.name)
      for (const d of this.dirs) hold(d)
      for (const [name] of this.links) hold(name)
      for (const [name] of this.dirModes) {
        if (!held.has(name)) {
          throw new ArchiveSecurityError(
            `archive directory mode names no output directory: ${name}`,
          )
        }
      }
    }
    return {
      entries: this.seen.map((s) => {
        const m = this.files[s.name]
        // A foreign artifact, or a sidecar missing an entry, restores
        // readable-but-not-executable rather than failing the hit: the sidecar
        // is metadata, not the authority on what exists.
        return { name: s.name, size: s.size, mode: m?.[0] ?? 0o644, mtimeMs: m?.[1] ?? s.mtimeMs }
      }),
      dirs: this.dirs,
      links: this.links,
      dirModes: this.dirModes,
      stdout: this.stdout,
      exec: this.exec,
      key: this.key,
    }
  }
}

/**
 * List an artifact's regular entries with their restore metadata, and its
 * stdout (`null`: not a vx artifact), materialising nothing. One unsafe name
 * rejects the WHOLE archive: a partial reading of a poisoned artifact is what
 * the traversal defense prevents.
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
    if (e.name === STDOUT_ENTRY) fold.stdout = decodeRaw(await bytesOf(body))
    else await drain(body)
    fold.entry(e.name, e.size, e.mtimeMs)
  }
  check.done()
  return fold.result()
}

/**
 * `scanArtifact` over a tar in memory, synchronously, for the tar a save just
 * packed. Same checks, same result, without the per-chunk promises that were
 * most of a small save's scan.
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
    if (e.name === STDOUT_ENTRY) fold.stdout = decodeRaw(body)
    fold.entry(e.name, e.size, e.mtimeMs)
  }
  check.done()
  return fold.result()
}

/** The largest millisecond count a Date holds (ECMA-262 §21.4.1.1). */
const DATE_MAX_MS = 8.64e15

/**
 * Each sidecar mode an integer in 0..0o7777 and each mtime one a Date holds:
 * anything else would throw out of `utimesSync` after renames had begun.
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
 * The sidecar's directory names, held to a file entry's rules (the sidecar is
 * as attacker-reachable as the tar), and only under an output namespace.
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
 * The sidecar's links: each name held to a file entry's rules, each target to a
 * relative path with no NUL. Where it may point is decided at the restore,
 * which knows the workspace.
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

/** Links one link may lead through as its last hop: `libx.so -> libx.so.1 -> libx.so.1.0` is 2. */
const LINK_CHAIN_MAX = 8

/**
 * The first of `links` that `to` passes through, walked from `dir` a segment at
 * a time. Each target is checked as text, but the kernel follows one link while
 * resolving the next: `up -> ..` and `esc -> up/../../x` each read inside while
 * `esc` lands outside. A link that is the LAST hop is checked on its own, so a
 * soname chain (`libx.so -> libx.so.1`) is kept, walked to its end and refused
 * only when it loops or passes `LINK_CHAIN_MAX`.
 */
function throughLink(
  dir: string,
  to: string,
  links: ReadonlyMap<string, string>,
): { at: string; why: 'through' | 'loop' } | undefined {
  const seen = new Set<string>()
  for (;;) {
    const segs = to.split('/').filter((seg) => seg !== '' && seg !== '.')
    let at = dir
    for (const [i, seg] of segs.entries()) {
      at = seg === '..' ? path.dirname(at) : path.join(at, seg)
      if (links.has(at) && (i < segs.length - 1 || seg === '..')) return { at, why: 'through' }
    }
    const next = links.get(at)
    if (next === undefined) return undefined
    if (seen.has(at) || seen.size >= LINK_CHAIN_MAX) return { at, why: 'loop' }
    seen.add(at)
    dir = path.dirname(at)
    to = next
  }
}

/**
 * The sidecar's directory modes: each name held to a file entry's rules, each
 * mode to permission bits.
 */
function dirModesOf(meta: MetaFile): Array<[string, number]> {
  const raw: unknown = meta.dirModes
  if (raw === undefined) return []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ArchiveSecurityError('archive sidecar dirModes is not a map')
  }
  return Object.entries(raw as Record<string, unknown>).map(([name, mode]) => {
    if (!(name.startsWith('outputs/') || name.startsWith(WORKSPACE_PREFIX))) {
      throw new ArchiveSecurityError(`archive directory is not an output: ${name}`)
    }
    assertSafeName(name)
    if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o777) {
      throw new ArchiveSecurityError(
        `archive directory ${name} has an unsafe mode: ${String(mode)}`,
      )
    }
    return [name, mode]
  })
}

/**
 * A file this user cannot read, or one gone since its stat, is not the same
 * bytes: the rename replaces it. Any other failure is the restore's.
 */
function sameBytes(file: string, body: Uint8Array): boolean {
  try {
    return readFileSync(file).equals(body)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') return false
    throw err
  }
}

/** `p` is `root` or under it, lexically. */
const inside = (p: string, root: string): boolean => {
  const r = path.resolve(root)
  return p === r || p.startsWith(r + path.sep)
}

/**
 * Where a link in `dir` reading `to` lands against `bound`, if a restore may
 * not write it: out of it, or into its `.git`. Out is any step above `bound`,
 * even one that comes back: `../../../ws/app/x` resolves inside only a root
 * named `ws`. The save asks it too, or it would store a link no restore lays.
 */
function linkRefused(dir: string, to: string, bound: string): 'out' | '.git' | undefined {
  const root = path.resolve(bound)
  const from = path.resolve(dir)
  if (!inside(from, root)) return 'out'
  let depth = from === root ? 0 : path.relative(root, from).split(path.sep).length
  for (const seg of to.split(path.sep === '/' ? '/' : /[\\/]/)) {
    if (seg === '..') depth--
    else if (seg !== '' && seg !== '.') depth++
    if (depth < 0) return 'out'
  }
  return writableUnder(path.resolve(from, to), root) ? undefined : '.git'
}

/**
 * `linkRefused` on disk: the kernel resolves a `..` from where the links before
 * it lead, so with a committed `app/up -> ..` the text `../up/../x` reads
 * inside and lands beside the workspace. Walked from `dir`'s real path, every
 * step held to `realBound`. A target with no `..` touches no disk.
 */
async function linkLandsRefused(
  dir: string,
  to: string,
  realBound: string,
  realDirs: Map<string, Promise<string>>,
): Promise<'out' | '.git' | undefined> {
  const segs = to.split(path.sep === '/' ? '/' : /[\\/]/)
  const lastUp = segs.lastIndexOf('..')
  if (lastUp < 0) return undefined
  let realDir = realDirs.get(dir)
  if (realDir === undefined) {
    // At a restore the link's directory may not exist yet.
    realDir = realOf(dir).catch(() => resolveThrough(dir))
    realDirs.set(dir, realDir)
  }
  let at = await realDir
  let onDisk = true
  for (let i = 0; i <= lastUp; i++) {
    const seg = segs[i]!
    if (seg === '' || seg === '.') continue
    if (seg === '..') at = path.dirname(at)
    else {
      at = path.join(at, seg)
      if (onDisk) {
        const st = statOrAbsent(at)
        if (st === undefined) onDisk = false
        else if (st.isSymbolicLink()) at = await resolveThrough(at)
      }
    }
    if (!inside(at, realBound)) return 'out'
  }
  return writableUnder(path.join(at, ...segs.slice(lastUp + 1)), realBound) ? undefined : '.git'
}

/** `lstat`, or undefined for a name that is not there (under a file too). */
function statOrAbsent(p: string): Stats | undefined {
  try {
    return lstatSync(p, { throwIfNoEntry: false })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined
    throw err
  }
}

/** Each directory `p` (an entry name; a directory's ends in `/`) lies under, into `into`. */
function addAncestors(into: Set<string>, p: string): void {
  for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) into.add(p.slice(0, i))
}

/** What a restore holds its links to: `dir`, named `where`, and its real path, asked once. */
interface LinkBound {
  dir: string
  where: string
  real: () => Promise<string>
}

function boundOf(dir: string, where: string): LinkBound {
  let real: Promise<string> | undefined
  return { dir, where, real: () => (real ??= realOf(dir)) }
}

/**
 * Why a restore refuses the link `name` at `target` reading `to`, or undefined.
 * `linked` and `nameOf` hold every link the restore lays. With no `bound` (an
 * unpack into a cache tree) only the links among themselves are judged.
 */
async function linkRefusal(
  name: string,
  target: string,
  to: string,
  bound: LinkBound | undefined,
  linked: ReadonlyMap<string, string>,
  nameOf: ReadonlyMap<string, string>,
  realDirs: Map<string, Promise<string>>,
): Promise<string | undefined> {
  let refused = bound === undefined ? undefined : linkRefused(path.dirname(target), to, bound.dir)
  if (refused === 'out') return `archive link ${name} points out of the ${bound!.where}: ${to}`
  const via = throughLink(path.dirname(target), to, linked)
  if (via?.why === 'through')
    return `archive link ${name} points through ${nameOf.get(via.at)}, another link it restores: ${to}`
  if (via?.why === 'loop')
    return `archive link ${name} starts a chain of links that loops or runs past ${LINK_CHAIN_MAX} hops at ${nameOf.get(via.at)}: ${to}`
  if (refused === undefined && bound !== undefined)
    refused = await linkLandsRefused(path.dirname(target), to, await bound.real(), realDirs)
  if (refused === 'out') return `archive link ${name} points out of the ${bound!.where}: ${to}`
  if (refused === '.git') return `archive link ${name} points into .git: ${to}`
  return undefined
}

/**
 * Whether the extractor would lay every one of `links` with no refusal: only
 * then does the copy-out lay links itself, leaving a refusal to the extractor,
 * which names it. Same rules: a safe target, no row at or under the link,
 * inside the workspace as text and on disk, never into `.git`, never through
 * another link.
 */
export async function linksRestorable(
  links: ReadonlyArray<readonly [string, string]>,
  rows: readonly OutputFileRow[],
  projectDir: string,
  workspaceRoot: string | undefined,
): Promise<boolean> {
  const under = new Set<string>()
  for (const r of rows) addAncestors(under, r.path)
  const linked = new Map<string, string>()
  const nameOf = new Map<string, string>()
  for (const [rel, to] of links) {
    if (to.length === 0 || to.includes('\0') || path.isAbsolute(to) || under.has(rel)) return false
    linked.set(path.join(projectDir, rel), to)
    nameOf.set(path.join(projectDir, rel), `outputs/${rel}`)
  }
  const bound = boundOf(
    workspaceRoot ?? projectDir,
    workspaceRoot === undefined ? 'project' : 'workspace',
  )
  const realDirs = new Map<string, Promise<string>>()
  for (const [rel, to] of links) {
    const target = path.join(projectDir, rel)
    const name = `outputs/${rel}`
    if ((await linkRefusal(name, target, to, bound, linked, nameOf, realDirs)) !== undefined)
      return false
  }
  return true
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
 * Restore from `tar`, the DECOMPRESSED archive as a stream: `outputs/<rel>`
 * under `destDir`, `workspace-outputs/<rel>` under `workspaceDest` when given;
 * other entries are ignored. Entries are validated and staged as they arrive
 * and renamed into place only after the archive ended cleanly and `verify` (the
 * index's missing-output check) passed. Any failure leaves nothing behind.
 * Returns the provided output names.
 */
export async function extractArtifactStream(
  tar: ReadableStream<Uint8Array>,
  destDir: string,
  workspaceDest: string | undefined,
  verify?: (provided: ReadonlySet<string>) => void,
  accept?: (name: string, dir?: boolean) => boolean,
  /** The workspace root whose `.vx/tmp/` stages the entries; absent, each stages beside its target. */
  stageRoot?: string,
  /** Handed what `scanArtifact` would read of the same bytes, once their sum has checked. */
  onScan?: (scan: ArtifactScan) => void,
  /**
   * Given, a restore into a workspace: a file written is dated now, one whose
   * bytes already stood keeps its mtime. Absent, an unpack into the tree form:
   * saved mtimes apply.
   */
  dated?: Map<string, number>,
  /** Given, filled with the directories the extract found missing (and so made). */
  absentDirs?: Set<string>,
): Promise<Set<string>> {
  // No `mkdir -p` of the destination: `stage` makes each entry's chain, the
  // destination included.
  readUmask()
  const x = new Extractor(destDir, workspaceDest, stageRoot, absentDirs)
  const provided = new Set<string>()
  const headerMtime = new Map<string, number>()
  let meta: MetaFile['files'] = {}
  let dirs: string[] = []
  let links: Array<[string, string]> = []
  let dirModes: Array<[string, number]> = []
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
        dirModes = dirModesOf(parsed)
        continue
      }
      assertSafeName(e.name)
      // Before anything is staged: an entry the task never declared is not this
      // task's save, and none of the archive lands.
      if (accept !== undefined && !accept(e.name)) {
        throw new ArchiveSecurityError(
          `archive entry is not one of the task's declared outputs: ${e.name}`,
        )
      }
      fold?.entry(e.name, e.size, e.mtimeMs)
      const dest = x.destFor(e.name)
      if (dest === null || dest.rel.length === 0) {
        if (fold !== undefined && e.name === STDOUT_ENTRY)
          fold.stdout = decodeRaw(await bytesOf(body))
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
      if (accept !== undefined && !accept(name, true)) {
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
    // Unpacked into a cache tree, the workspace is unknown, and bounding by the
    // tree refused good links like `dist/l -> ../../other/f.txt`. The tree
    // stores a link as text; its restore bounds it by the workspace.
    const tree = stageRoot === undefined && workspaceDest !== undefined
    const bound = stageRoot ?? destDir
    const where = stageRoot === undefined ? 'project' : 'workspace'
    const nameOf = new Map<string, string>()
    const linked = new Map<string, string>()
    for (const [name, to] of links) {
      const dest = x.destFor(name)
      if (dest === null || dest.rel.length === 0) continue
      nameOf.set(path.join(dest.base, dest.rel), name)
      linked.set(path.join(dest.base, dest.rel), to)
    }
    const held = tree ? undefined : boundOf(bound, where)
    const realDirs = new Map<string, Promise<string>>()
    // Once, not a scan of every entry per link: 700 links in 32k entries took
    // 1.7 s.
    const under = new Set<string>()
    for (const p of provided) addAncestors(under, p)
    for (const [name, to] of links) {
      // Renamed over an entry just written, the link would stand where the
      // sidecar says a file is.
      if (provided.has(name) || under.has(name)) {
        throw new ArchiveSecurityError(`archive link ${name} is also a file or directory entry`)
      }
      if (accept !== undefined && !accept(name)) {
        throw new ArchiveSecurityError(
          `archive link is not one of the task's declared outputs: ${name}`,
        )
      }
      const dest = x.destFor(name)
      if (dest === null || dest.rel.length === 0) continue
      const target = path.join(dest.base, dest.rel)
      await x.assertContained(dest.base, target, name)
      const refused = await linkRefusal(name, target, to, held, linked, nameOf, realDirs)
      if (refused !== undefined) throw new ArchiveSecurityError(refused)
      await x.stageLink(name, dest.base, target, to)
      provided.add(name)
      addAncestors(under, name)
    }
    // A moded directory is one the entries above make; its row names it with a
    // trailing slash. `Cache.restoreOutputs` applies the mode.
    for (const [name] of dirModes) {
      if (x.destFor(name) !== null) provided.add(`${name}/`)
    }
    verify?.(provided)
    // The sidecar's stat is the truth, a 000 mode and an epoch mtime included
    // (`SOURCE_DATE_EPOCH=0`). Without one, a header mtime of 0 means unknown.
    await x.commit((name) => {
      const m = meta[name]
      if (m !== undefined) return [m[0], m[1]]
      const header = headerMtime.get(name)
      return [0o644, header !== undefined && header > 0 ? header : undefined]
    }, dated)
  } catch (err) {
    await x.abort()
    throw err
  }
  return provided
}

/** BSD gives every new file its directory's group, setgid or not. */
const INHERITS_GROUP = process.platform === 'darwin'

/**
 * Entries up to this size are buffered and written without waiting, so tiny
 * outputs restore in parallel; larger ones stream to a file sink.
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
 * Bring a target that already held the entry's bytes to its mode and `mtimeMs`,
 * through a descriptor opened without following a link: one planted since the
 * compare is refused. Answers the mtime it leaves, in whole ms.
 */
function keep(s: Staged, ino: number, mode: number, mtimeMs: number | undefined): number {
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
      return mtimeMs
    }
    return Math.floor(st.mtimeMs)
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
 * The staging core. Nothing reaches its final name until `commit`; `abort`
 * removes every temp and the empty directories this extraction made.
 */
class Extractor {
  private readonly staged: Staged[] = []
  /** Directories given owner write for a rename into them, with the mode to put back. */
  private readonly reopened = new Map<string, number>()
  /** Empty output directories made, with the top of each chain created. */
  private readonly madeDirs: Array<{ dir: string; created: string }> = []
  private inflight: Promise<unknown>[] = []
  private inflightBytes = 0
  private readonly realBaseCache = new Map<string, string>()
  // Per-directory memos: the containment walk and `mkdir -p` belong to the
  // directory, not the entry (4,069 files in 535 directories went from 220–300
  // µs per file to the write itself). The window this opens, a symlink planted
  // at a checked directory between two of its entries, already lies between any
  // entry's check and its write.
  private readonly containedDirs = new Set<string>()
  private readonly ensuredDirs = new Set<string>()
  private readonly trees = new Map<string, Tree>()
  // Directories the containment walk found missing. One made since fails the
  // tree's rename, and the entries go in one by one.
  private readonly seenAbsent: Set<string>

  constructor(
    private readonly destDir: string,
    private readonly workspaceDest: string | undefined,
    private readonly stageRoot: string | undefined,
    seenAbsent: Set<string> = new Set(),
  ) {
    this.seenAbsent = seenAbsent
  }

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

  // The REAL path of each base dir, memoized, to catch a symlinked ANCESTOR
  // under the output tree: an on-disk `<dest>/dist` link pointing out would
  // carry a lexically contained `dist/x` with it. Both sides are realpath'd, so
  // a symlinked ancestor of the base itself (macOS /tmp) resolves consistently.
  private async realBaseOf(base: string): Promise<string> {
    const key = path.resolve(base)
    let r = this.realBaseCache.get(key)
    if (r === undefined) {
      // The base often does not exist yet (the workspace-outputs anchor is made
      // by the first entry). Resolve the deepest EXISTING ancestor and
      // re-append the rest, so the answer is the same before and after the base
      // is made, which keeps the memo safe.
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

  // Two checks per entry: lexical (the joined path stays under the base) and
  // real (the deepest existing ancestor resolves inside the real base).
  // Checking only the parent would pass `dist/a/b` when `dist` is the link and
  // `dist/a` does not exist.
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
    // Only ancestors strictly BELOW the base are candidates: a missing base's
    // parent resolves outside legitimately. The base's real path is resolved
    // only once an ancestor exists to compare with, which after a clean (the
    // common restore) it does not.
    let probe = path.dirname(targetResolved)
    while (probe.startsWith(baseResolved + path.sep)) {
      // The lstat answers the common case (a clean pruned the directory)
      // without a failed realpath. A dangling link, or an lstat failing
      // otherwise, falls through to the realpath.
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
    // Nothing between the base and the target exists: no symlink to follow.
  }

  /**
   * `mkdir -p` does not follow a DANGLING link (EEXIST, ENOENT or ELOOP), and
   * the containment walk passed it. A live link inside the base is written
   * through, so a dangling one is too: the directory it names is made and the
   * link stays the user's (never replaced, nx#37061). One leading out of the
   * base is refused. Only a failure pays for this walk.
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
    // directory) fails again: the caller names it as a stray.
    return mkdir(real, { recursive: true })
  }

  /**
   * Where an entry is written when a directory on its way is missing: inside a
   * copy of the topmost missing one, built in staging and renamed into place
   * whole on commit. One rename per directory, not per file (per-file renames
   * doubled a 5,000-artifact restore's kernel time), and a reader sees the
   * directory complete or not at all. Undefined where the group or filesystem
   * would differ from a write in place.
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
    const staging = stagingDir(this.stageRoot)
    if (!stagesInto(statSync(staging), statSync(probe, { throwIfNoEntry: false }))) return undefined
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
   * Write the entry beside its target: a buffer without waiting, bounded by
   * `INFLIGHT_BYTES`; a stream to a file sink.
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
    // A target already holding these bytes stays: renaming over a live file
    // costs ~0.4 ms on ext4 (auto_da_alloc). Bytes, not a stamp: a reproducible
    // build gives every output one mtime. Never an empty file, which reads as
    // an untouched write-grant placeholder and is swept after a remote task.
    const st = created === undefined ? lstatSync(target, { throwIfNoEntry: false }) : undefined
    // A directory there would fail its rename at commit, after others landed:
    // refused now, nothing replaced.
    if (st?.isDirectory() === true)
      throw Object.assign(
        new Error(`EISDIR: illegal operation on a directory, rename '${target}'`),
        { code: 'EISDIR', path: target },
      )
    if (body instanceof Uint8Array && body.byteLength > 0 && created === undefined) {
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
    // Write apart from the target and RENAME into place. rename(2) replaces the
    // directory ENTRY without following it, so:
    //
    // - a planted symlink or hardlink at the target is replaced, never written
    //   through;
    // - the target is never absent, so a second extract of the same payload
    //   cannot delete it mid-restore;
    // - mode and mtime are set before the file is visible.
    //
    // A directory at the target fails the rename, closed. Staged under
    // `.vx/tmp/`, so no output folder ever holds a temp.
    const staged = this.stageRoot !== undefined
    const tmp = staged
      ? path.join(stagingDir(this.stageRoot!), (tmpSeq++).toString(36))
      : siblingTemp(target)
    const streamed = !(body instanceof Uint8Array)
    this.staged.push({ staged, name, tmp, target, created, streamed, base })
    await this.write(tmp, body)
  }

  private async write(tmp: string, body: Uint8Array | AsyncIterable<Uint8Array>): Promise<void> {
    if (body instanceof Uint8Array) {
      this.inflightBytes += body.byteLength
      // `writeFile`, not `Bun.write`: for a buffer `Bun.write` writes on the
      // calling thread, so concurrent restores ran one after another. The
      // thread-pool write overlaps their I/O.
      const write = writeFile(tmp, body)
      // A write that fails before `commit` or `abort` awaits it is no unhandled
      // rejection; `Promise.all` still sees the error.
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
      ? path.join(stagingDir(this.stageRoot!), (tmpSeq++).toString(36))
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
   * Metadata calls are synchronous: microseconds here, ~40 µs as pool round
   * trips, thousands per large artifact. Renames go to the pool, `RENAME_BATCH`
   * at a time. The chmod is skipped when the temp already has the mode; the two
   * writers create with different modes, so each is stat'ed once.
   */
  async commit(
    metaFor: (name: string) => [mode: number, mtimeMs: number | undefined],
    dated?: Map<string, number>,
  ): Promise<void> {
    try {
      await this.commitAll(metaFor, dated)
    } finally {
      this.closeReopened()
    }
  }

  private async commitAll(
    metaFor: (name: string) => [mode: number, mtimeMs: number | undefined],
    dated: Map<string, number> | undefined,
  ): Promise<void> {
    await this.drain()
    // A restore dates each file it writes now, as the task's write would, and
    // moves no mtime back: a make-style dependant would take a changed upstream
    // as older than its own output. One clock for the restore.
    const now = dated === undefined ? undefined : Date.now()
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
    // The group a file written in place would take: a setgid directory's on
    // Linux, every directory's on BSD/macOS.
    const setgid = new Map<string, number | null>()
    let n = 0
    let renames: Promise<void>[] = []
    const checked = new Set<string>()
    try {
      for (const s of this.staged) {
        if (s.tree === undefined)
          await this.assertStillContained(s.base, path.dirname(s.target), checked)
        const [mode, savedMtimeMs] = metaFor(s.name)
        if (s.same !== undefined) {
          const own = keep(s, s.same, mode, now === undefined ? savedMtimeMs : undefined)
          dated?.set(s.name, own)
          continue
        }
        const mtimeMs = now ?? savedMtimeMs
        if (now !== undefined && s.link === undefined) dated!.set(s.name, now)
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
        // A Date, not seconds: Bun reads negative seconds as "now" (Bun 1.4.2).
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
      // Every rename in flight lands or fails before `abort` cleans up.
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
   * Rename a staged tree to the directory it stands for. Something made there
   * since staging takes the entries one by one instead.
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
      await this.renameInto(s.tmp, s.target)
    }
    await rm(t.at, { recursive: true, force: true })
  }

  /**
   * Into a directory of this user's that withholds its own write (`chmod 555
   * dist/ro`, which a hit restores): it gets owner write and search for the
   * commit and its mode back after, or every later hit changing a file there
   * fails EACCES.
   */
  private async renameInto(from: string, to: string): Promise<void> {
    try {
      await rename(from, to)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EACCES' || !this.reopen(path.dirname(to)))
        throw err
      await rename(from, to)
    }
  }

  private reopen(dir: string): boolean {
    if (this.reopened.has(dir)) return false
    const st = lstatSync(dir, { throwIfNoEntry: false })
    if (st?.isDirectory() !== true || st.uid !== process.getuid?.()) return false
    if ((st.mode & 0o300) === 0o300) return false
    this.reopened.set(dir, st.mode & 0o7777)
    chmodSync(dir, (st.mode & 0o7777) | 0o300)
    return true
  }

  private closeReopened(): void {
    for (const [dir, mode] of this.reopened) {
      try {
        chmodSync(dir, mode)
      } catch {
        // gone with an abort's cleanup
      }
    }
    this.reopened.clear()
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
   * `.vx/tmp/` to a temp beside its target, before any rename: a rename would
   * fail EXDEV, and copying at the rename left a mix of new and old files when
   * one copy failed. A failed copy throws with nothing renamed.
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
   * Rename `s` over its target, through a temp beside it when on another
   * filesystem (EXDEV): the final rename stays atomic.
   */
  private async place(s: Staged, mode: number, t: Date | undefined): Promise<void> {
    try {
      await this.renameInto(s.tmp, s.target)
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
        await this.renameInto(side, s.target)
      } catch (e) {
        await unlink(side).catch(() => undefined)
        throw e
      }
      await unlink(s.tmp).catch(() => undefined)
    }
  }

  /**
   * The staging check again at the rename: a directory swapped for a link out
   * since then would carry the rename. Bun has no `renameat`, so by path, once
   * per directory per commit.
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
   * The check once more after all landed: renames run on the pool, and a
   * directory swapped in that gap carried an entry out
   * (restore-link-swap-rename.test.ts). An entry that landed outside is removed
   * and the restore fails.
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
   * Never leave a temp behind: beside a target, the output globs would sweep it
   * into the next artifact. Directories this extraction made are removed
   * bottom-up while empty.
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
    // Newest first: a later chain can sit inside an earlier one, never the
    // reverse.
    for (const s of this.staged.toReversed()) {
      if (s.created === undefined) continue
      let dir = path.dirname(s.target)
      const top = path.resolve(s.created)
      // Made at a dangling link's target (`mkdirThroughLink`), so pruned from
      // where the link leads.
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
 * Renames in flight at once. Replacing a live file starts writeback on ext4
 * (~250 µs each), and synchronous ones stalled the main thread.
 */
const RENAME_BATCH = 64

/**
 * Marked handled at once: `settle` reads it later, and a rename failing
 * meanwhile must not fail the process.
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
 * This process's staging directory under `.vx/tmp/`, made on its first restore
 * and again only if removed (one per restore cost 12%). The next run's
 * `sweepStaging` removes it once this process is gone. Made synchronously: one
 * `mkdir` of microseconds, where awaited ones queued behind each other.
 */
function stagingDir(root: string): string {
  const top = stagingRoot(root)
  const own = ownStaging(root)
  if (stagingMade.has(own) && existsSync(own)) return own
  mkdirSync(own, { recursive: true })
  // Ignored by git whatever `.vx/.gitignore` an older init committed.
  try {
    ignoreDir(top)
  } catch {
    // there already, or the restore fails on its first write anyway
  }
  stagingMade.add(own)
  return own
}

function ownStaging(root: string): string {
  return path.join(stagingRoot(root), `${process.pid.toString(36)}-0`)
}

/** `root`'s `.vx/tmp/`, which holds every process's staging directory. */
export function stagingRoot(root: string): string {
  return path.join(root, '.vx', STAGING)
}

/**
 * Where a tree restore's copy-out stages: this process's directory under
 * `.vx/tmp/`, its stats, and a fresh name per `temp`. With no root each temp
 * sits beside its target.
 */
export function copyStaging(root: string | undefined): {
  stats: Stats | undefined
  temp: (target: string) => string
} {
  if (root === undefined) return { stats: undefined, temp: siblingTemp }
  // Made already: its stat checks it still stands.
  let dir = ownStaging(root)
  let stats = stagingMade.has(dir) ? statSync(dir, { throwIfNoEntry: false }) : undefined
  if (stats === undefined) {
    dir = stagingDir(root)
    stats = statSync(dir)
  }
  return { stats, temp: () => path.join(dir, (tmpSeq++).toString(36)) }
}

/**
 * Whether a file made in `staging` and renamed into `dir` keeps what a write in
 * place gives it: the same filesystem and group.
 */
export function stagesInto(staging: Stats, dir: Stats | undefined): boolean {
  return (
    dir !== undefined &&
    dir.isDirectory() &&
    dir.dev === staging.dev &&
    ((dir.mode | staging.mode) & 0o2000) === 0 &&
    (!INHERITS_GROUP || dir.gid === staging.gid)
  )
}

/**
 * A temp beside `target` with its own short name, never `<target>.suffix`,
 * which pushes a legal 242–255 byte name past NAME_MAX.
 */
function siblingTemp(target: string): string {
  return path.join(
    path.dirname(target),
    `.vx-tmp-${process.pid.toString(36)}-${(tmpSeq++).toString(36)}`,
  )
}

const WORKSPACE_PREFIX = 'workspace-outputs/'

/**
 * Containment failed on disk: a directory between `base` and `probe` is a link
 * out. That is the user's tree, not the artifact (nx#37061), so the refusal
 * names the link and where it leads; the restore never writes through it or
 * replaces it.
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
 * `realpath` for a path holding a backslash too: Bun's answers ENOENT for any
 * such path (1.4.2), so such a path's links are read one by one.
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
 * Where `p` leads, every link followed, a dangling one included: `realpath` for
 * the part that exists, the rest as written. A cycle is the user's tree,
 * refused by name.
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
 * Path-traversal defense on every entry name at read time, mirroring Turbo's
 * `check_path`: a name that could resolve outside the anchor is refused before
 * anything decides where to write it.
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
  // vx never packs a `.` segment, and `outputs/.` names the anchor itself.
  if (hasDotSegment(name)) {
    throw new ArchiveSecurityError(`archive entry name has a '.' segment (unsafe): ${name}`)
  }
  // No backslash refusal: on Linux and macOS it is a name character, and
  // refusing it made `dist/back\slash` uncacheable.
  if (/^[A-Za-z]:[\\/]/.test(name)) {
    throw new ArchiveSecurityError(`archive entry has windows drive prefix (unsafe): ${name}`)
  }
  if (name.includes('\0')) {
    throw new ArchiveSecurityError(`archive entry name contains a null byte (unsafe): ${name}`)
  }
  // A tree keeps project outputs beside `workspace-outputs/`: one by that name
  // would come back a workspace output.
  if (name.startsWith(RESERVED_OUTPUT) || name === RESERVED_OUTPUT.slice(0, -1)) {
    throw new ArchiveSecurityError(
      `archive entry ${name} is a project output under ${WORKSPACE_OUTPUT_PREFIX}, the name outputs.workspaceFiles reserve`,
    )
  }
  // Only a pax `path` record carries a name this long; the file system's
  // ENAMETOOLONG would read as an internal error. A UTF-16 unit is at most
  // three UTF-8 bytes, so a short name skips the count.
  if (name.length * 3 >= PATH_MAX && Buffer.byteLength(name) >= PATH_MAX) {
    throw new ArchiveSecurityError(
      `archive entry name is ${Buffer.byteLength(name)} bytes, past PATH_MAX (${PATH_MAX}) (unsafe): ${name.slice(0, 64)}…`,
    )
  }
  // The same for one component past NAME_MAX. A name under 86 units cannot hold
  // one.
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
