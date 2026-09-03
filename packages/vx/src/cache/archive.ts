// Cache artifact container — built on `Bun.Archive` (libarchive, Bun ≥ 1.4).
//
// An artifact is a tar of:
//   stdout                       always present; the vx-artifact marker
//   outputs/<rel>                project-relative outputs
//   workspace-outputs/<rel>      workspace-root-relative outputs
//   .vx-meta.json                per-output mode + millisecond mtime
//
// `Bun.Archive` carries no per-entry metadata in either direction: the
// writer takes `{ name: bytes }` and the reader hands back a
// `Map<string, File>` (regular files only — no mode, no directory or
// symlink records). vx needs BOTH, and needs them exactly:
//
//   - mode, because an output that lost its executable bit builds cold
//     and breaks warm — the worst failure profile there is;
//   - millisecond mtime, because `isOutputsCurrent` skips a restore when
//     size+mode+mtime match, and tar headers only carry SECONDS.
//
// So the pack side stats each output once and writes both into
// `.vx-meta.json`, and the restore side applies them. That also makes a
// REMOTE-ingested entry's index rows millisecond-accurate — with tar
// headers as the only source they were second-precision, and the save
// path needed a second stat pass to refine them.
//
// Two readers share one extractor. `readArtifact` + `extractOutputs` take
// the whole tar in memory (libarchive via `Bun.Archive`): the ingest path,
// which already holds the remote bytes, and the small-artifact restore.
// `extractArtifactStream` reads the tar as it streams out of the zstd
// decoder (`tar-stream.ts`) and never holds more than a chunk of it:
// restoring a 150 MiB artifact through `Bun.Archive` peaked at 3.2× its
// size (measured 2026-09-03), which is the wrong shape for a task whose
// output IS the big thing. Both feed the same staging core: every entry
// is written beside its target under a `.vx-tmp-*` name and renamed into
// place only once the WHOLE archive has been read and every name proven
// safe, so a poisoned entry anywhere — even the last one — leaves nothing
// behind but the empty directories it needed, which are pruned too.
//
// What stays here is the part no tar reader can decide for us: WHERE an
// entry may land on disk. Every name is validated and every destination
// is proven to stay inside its anchor before a byte is written, because a
// cache artifact is attacker-reachable (a poisoned remote, a tampered
// local entry) and "zip slip" is the class.
//
// Entries that are not regular files (symlinks, hardlinks, devices,
// FIFOs) are never materialised — `Bun.Archive.files()` omits them and
// the streaming reader reports them only to be skipped — vx's outputs are
// regular files, and an artifact that claims otherwise silently loses the
// claim rather than acting on it.

import { mkdir, chmod, realpath, rename, rmdir, stat, unlink, utimes } from 'node:fs/promises'
import path from 'node:path'
import { tarEntries } from './tar-stream.js'

/** Archive entry name carrying the per-output mode/mtime sidecar. */
const META_ENTRY = '.vx-meta.json'

/** Archive entry name of the always-present stdout record. */
export const STDOUT_ENTRY = 'stdout'

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
  files: Record<string, [mode: number, mtimeMs: number]>
}

/** One regular file in an artifact, with its restore metadata resolved. */
export interface ArchiveEntry {
  /** Full archive-relative name, e.g. `outputs/dist/index.js`. */
  name: string
  size: number
  /** Permission bits (0o777 mask) from the sidecar. */
  mode: number
  /** Modification time in ms since epoch from the sidecar. */
  mtimeMs: number
  /** The entry's bytes, as handed back by `Bun.Archive`. */
  file: File
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

/**
 * Build the uncompressed artifact bytes from files still on disk.
 *
 * There is no staging directory: the previous implementation COPIED
 * every output into a temp tree just so an external `tar` could see it
 * under the right name, then spawned `tar` and read the whole archive
 * back through a pipe. Naming entries directly removes that copy, the
 * fork+exec, and the `--format=gnu` / `--format=gnutar` spelling probe
 * that existed only because the two tar implementations disagree.
 */
export async function packArtifact(args: {
  stdout: string
  /** Archive name → absolute source path, for every output file. */
  outputs: ReadonlyMap<string, string>
}): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array | string> = { [STDOUT_ENTRY]: args.stdout }
  const meta: MetaFile = { version: 1, files: {} }

  await Promise.all(
    [...args.outputs].map(async ([name, abs]) => {
      // Read and stat the same file once each. `Bun.file(abs).bytes()`
      // follows a symlinked output exactly as the staging copy did, so
      // a link is stored as its target's content — unchanged behaviour.
      const [bytes, st] = await Promise.all([Bun.file(abs).bytes(), stat(abs)])
      entries[name] = bytes
      meta.files[name] = [st.mode & 0o777, Math.floor(st.mtimeMs)]
    }),
  )

  entries[META_ENTRY] = JSON.stringify(meta)
  return await new Bun.Archive(entries).bytes()
}

/**
 * Parse artifact bytes into validated entries. Rejects the WHOLE
 * archive when any name is unsafe — a partial extract of a poisoned
 * artifact is the outcome the traversal defense exists to prevent.
 */
export async function readArtifact(bytes: Uint8Array): Promise<ArchiveEntry[]> {
  const files = await new Bun.Archive(bytes).files()

  let meta: MetaFile['files'] = {}
  const metaFile = files.get(META_ENTRY)
  if (metaFile !== undefined) {
    const parsed = JSON.parse(await metaFile.text()) as MetaFile
    meta = parsed.files ?? {}
  }

  const out: ArchiveEntry[] = []
  for (const [name, file] of files) {
    if (name === META_ENTRY) continue
    assertSafeName(name)
    const m = meta[name]
    out.push({
      name,
      size: file.size,
      // A foreign artifact (or one whose sidecar lost an entry) restores
      // readable-but-not-executable rather than failing the hit: the
      // sidecar is metadata, never the authority on whether bytes exist.
      mode: m?.[0] ?? 0o644,
      mtimeMs: m?.[1] ?? file.lastModified,
      file,
    })
  }
  return out
}

/** Read one entry's text body; `''` when the entry is absent. */
export async function readEntryText(
  entries: readonly ArchiveEntry[],
  name: string,
): Promise<string> {
  const e = entries.find((x) => x.name === name)
  return e === undefined ? '' : await e.file.text()
}

/**
 * Materialise `outputs/<rel>` under `destDir/<rel>` and — when
 * `workspaceDest` is given — `workspace-outputs/<rel>` under
 * `workspaceDest/<rel>`. Entries in neither namespace are ignored.
 *
 * Mode and mtime come from the sidecar, so a restored tree compares
 * equal to the recorded index rows at millisecond precision and
 * `isOutputsCurrent` can skip the next restore.
 */
export async function extractOutputs(
  entries: readonly ArchiveEntry[],
  destDir: string,
  workspaceDest?: string,
): Promise<void> {
  await mkdir(destDir, { recursive: true })
  const x = new Extractor(destDir, workspaceDest)
  const targets = entries
    .map((e) => ({ e, dest: x.destFor(e.name) }))
    .filter(
      (t): t is { e: ArchiveEntry; dest: { base: string; rel: string } } =>
        t.dest !== null && t.dest.rel.length > 0,
    )

  // Containment is proven for EVERY entry before ANY of them is written:
  // a mixed artifact (benign entries plus one traversal) must leave
  // nothing behind, not a partial tree plus an error.
  await Promise.all(
    targets.map(({ e, dest }) =>
      x.assertContained(dest.base, path.join(dest.base, dest.rel), e.name),
    ),
  )
  try {
    await Promise.all(
      targets.map(({ e, dest }) => x.stage(e.name, path.join(dest.base, dest.rel), e.file)),
    )
    await x.commit((name) => {
      const e = entries.find((c) => c.name === name)!
      return [e.mode, e.mtimeMs]
    })
  } catch (err) {
    await x.abort()
    throw err
  }
}

/**
 * The streaming twin of `readArtifact` + `extractOutputs`: `tar` is the
 * DECOMPRESSED archive as a byte stream. Entries are validated and staged
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
): Promise<Set<string>> {
  await mkdir(destDir, { recursive: true })
  const x = new Extractor(destDir, workspaceDest)
  const provided = new Set<string>()
  const headerMtime = new Map<string, number>()
  let meta: MetaFile['files'] = {}
  try {
    for await (const e of tarEntries(tar)) {
      if (e.type !== '0') continue
      if (e.name === META_ENTRY) {
        meta = (JSON.parse(await textOf(e.body)) as MetaFile).files ?? {}
        continue
      }
      assertSafeName(e.name)
      const dest = x.destFor(e.name)
      if (dest === null || dest.rel.length === 0) continue
      const target = path.join(dest.base, dest.rel)
      await x.assertContained(dest.base, target, e.name)
      provided.add(e.name)
      headerMtime.set(e.name, e.mtimeMs)
      await x.stage(e.name, target, e.size <= SMALL_ENTRY ? await bytesOf(e.body) : e.body)
    }
    verify?.(provided)
    await x.commit((name) => {
      const m = meta[name]
      return [m?.[0] ?? 0o644, m?.[1] ?? headerMtime.get(name) ?? 0]
    })
  } catch (err) {
    await x.abort()
    throw err
  }
  return provided
}

/**
 * Entries up to this size are buffered and written without waiting, so a
 * thousand tiny outputs restore with the same parallelism as the in-memory
 * path; larger ones stream chunk by chunk to a file sink.
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
  new TextDecoder().decode(await bytesOf(body))

/** One staged entry: written at `tmp`, renamed to `target` on commit. */
interface Staged {
  name: string
  tmp: string
  target: string
  /** The topmost directory `mkdir -p` created for it, pruned on abort. */
  created: string | undefined
}

/**
 * The staging core both readers share. Nothing reaches its final name
 * until `commit`; `abort` removes every temp and the empty directories
 * this extraction created.
 */
class Extractor {
  private readonly staged: Staged[] = []
  private inflight: Promise<unknown>[] = []
  private inflightBytes = 0
  private readonly realBaseCache = new Map<string, string>()

  constructor(
    private readonly destDir: string,
    private readonly workspaceDest: string | undefined,
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
      r = await realpath(key).catch(async () => {
        let probe = path.dirname(key)
        const tail: string[] = [path.basename(key)]
        while (probe !== path.dirname(probe)) {
          const real = await realpath(probe).then(
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
    const realBase = await this.realBaseOf(base)
    // Only ancestors strictly BELOW the base are candidates — those are the
    // ones a poisoned entry could follow out of the tree. The walk must never
    // climb past the base: when the base itself does not exist yet (the
    // workspace-outputs anchor is created lazily), its parent legitimately
    // resolves outside and comparing against it would reject every entry.
    let probe = path.dirname(targetResolved)
    while (probe.startsWith(baseResolved + path.sep)) {
      const real = await realpath(probe).then(
        (r) => r,
        () => null,
      )
      if (real !== null) {
        if (real !== realBase && !real.startsWith(realBase + path.sep)) {
          throw new ArchiveSecurityError(
            `archive entry escapes destDir via a symlinked parent: ${name}`,
          )
        }
        return
      }
      probe = path.dirname(probe)
    }
    // Nothing between the base and the target exists yet, so there is no
    // pre-existing symlink to follow — the chain will be created fresh.
  }

  /**
   * Write the entry beside its target. Buffers (a Blob or bytes) are
   * written without waiting, bounded by `INFLIGHT_BYTES`; a chunk stream
   * goes to a file sink one piece at a time.
   */
  async stage(
    name: string,
    target: string,
    body: Blob | Uint8Array | AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const created = await mkdir(path.dirname(target), { recursive: true })
    // Write beside the target and RENAME into place. rename(2) replaces
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
    const tmp = `${target}.vx-tmp-${process.pid.toString(36)}-${(tmpSeq++).toString(36)}`
    this.staged.push({ name, tmp, target, created })
    if (body instanceof Blob || body instanceof Uint8Array) {
      this.inflightBytes += body instanceof Blob ? body.size : body.byteLength
      this.inflight.push(Bun.write(tmp, body))
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

  private async drain(): Promise<void> {
    const pending = this.inflight
    this.inflight = []
    this.inflightBytes = 0
    await Promise.all(pending)
  }

  /** Apply each entry's mode and mtime, then rename everything into place. */
  async commit(metaFor: (name: string) => [mode: number, mtimeMs: number]): Promise<void> {
    await this.drain()
    await Promise.all(
      this.staged.map(async (s) => {
        const [mode, mtimeMs] = metaFor(s.name)
        if (mode !== 0) await chmod(s.tmp, mode & 0o777)
        if (mtimeMs > 0) {
          const t = mtimeMs / 1000
          await utimes(s.tmp, t, t)
        }
        await rename(s.tmp, s.target)
      }),
    )
    this.staged.length = 0
  }

  /**
   * Never leave a stray `.vx-tmp-*` behind: the declared output globs would
   * sweep it into the next artifact. Directories this extraction created
   * are removed bottom-up while empty; one a concurrent writer has since
   * filled is left alone.
   */
  async abort(): Promise<void> {
    await Promise.allSettled(this.inflight)
    this.inflight = []
    await Promise.all(this.staged.map((s) => unlink(s.tmp).catch(() => undefined)))
    for (const s of this.staged) {
      if (s.created === undefined) continue
      let dir = path.dirname(s.target)
      const top = path.resolve(s.created)
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
    this.staged.length = 0
  }
}

/** Per-process counter for extract temp names; uniqueness only. */
let tmpSeq = 0

const WORKSPACE_PREFIX = 'workspace-outputs/'

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
  // Windows-shaped paths are categorically unsafe to extract on POSIX
  // hosts (and vice versa): backslash separators, drive letters,
  // extended-length prefixes.
  if (name.includes('\\')) {
    throw new ArchiveSecurityError(
      `archive entry uses backslash separators (windows-unsafe): ${name}`,
    )
  }
  if (/^[A-Za-z]:[\\/]/.test(name)) {
    throw new ArchiveSecurityError(`archive entry has windows drive prefix (unsafe): ${name}`)
  }
  if (name.includes('\0')) {
    throw new ArchiveSecurityError(`archive entry name contains a null byte (unsafe): ${name}`)
  }
}

function hasParentSegment(p: string): boolean {
  if (p === '..' || p.startsWith('../') || p.endsWith('/..')) return true
  return p.includes('/../')
}
