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
// What this deliberately does NOT do is re-implement tar. Long names,
// PAX records, format dialects and truncation detection are libarchive's
// job now. What stays here is the part libarchive cannot decide for us:
// WHERE an entry may land on disk. Every name is validated and every
// destination is proven to stay inside its anchor before a byte is
// written, because a cache artifact is attacker-reachable (a poisoned
// remote, a tampered local entry) and "zip slip" is the class.
//
// Entries that are not regular files (symlinks, hardlinks, devices,
// FIFOs) are absent from `files()` and therefore can never be
// materialised — vx's outputs are regular files, and an artifact that
// claims otherwise silently loses the claim rather than acting on it.

import { lstat, mkdir, chmod, realpath, stat, unlink, utimes } from 'node:fs/promises'
import path from 'node:path'

/** Archive entry name carrying the per-output mode/mtime sidecar. */
export const META_ENTRY = '.vx-meta.json'

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

  // Each namespace anchors at its own destination dir.
  const destFor = (name: string): { base: string; rel: string } | null => {
    if (name.startsWith('outputs/')) {
      return { base: destDir, rel: name.slice('outputs/'.length) }
    }
    if (workspaceDest !== undefined && name.startsWith(WORKSPACE_PREFIX)) {
      return { base: workspaceDest, rel: name.slice(WORKSPACE_PREFIX.length) }
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
  const realBaseCache = new Map<string, string>()
  const realBaseOf = async (base: string): Promise<string> => {
    const key = path.resolve(base)
    let r = realBaseCache.get(key)
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
      realBaseCache.set(key, r)
    }
    return r
  }

  // Two checks per entry: lexical (the joined path stays under the base)
  // and real (the deepest EXISTING ancestor still resolves inside the real
  // base). Walking up to the deepest existing ancestor is what makes it
  // sound BEFORE anything is created — checking only the immediate parent
  // would pass for `dist/a/b` when `dist` is the symlink and `dist/a` does
  // not exist yet.
  const assertContained = async (base: string, target: string, name: string): Promise<void> => {
    const baseResolved = path.resolve(base)
    const targetResolved = path.resolve(target)
    if (targetResolved !== baseResolved && !targetResolved.startsWith(baseResolved + path.sep)) {
      throw new ArchiveSecurityError(`archive entry escapes destDir (unsafe): ${name}`)
    }
    const realBase = await realBaseOf(base)
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

  const targets = entries
    .map((e) => ({ e, dest: destFor(e.name) }))
    .filter(
      (t): t is { e: ArchiveEntry; dest: { base: string; rel: string } } =>
        t.dest !== null && t.dest.rel.length > 0,
    )

  // Containment is proven for EVERY entry before ANY of them is written:
  // a mixed artifact (benign entries plus one traversal) must leave
  // nothing behind, not a partial tree plus an error.
  await Promise.all(
    targets.map(({ e, dest }) =>
      assertContained(dest.base, path.join(dest.base, dest.rel), e.name),
    ),
  )

  await Promise.all(
    targets.map(async ({ e, dest }) => {
      const target = path.join(dest.base, dest.rel)
      await mkdir(path.dirname(target), { recursive: true })

      // Link TOCTOU defense: if anything already sits at the target,
      // unlink it before writing. A symlink would make the write follow
      // the link and clobber its destination; a HARDLINK is the same
      // attack without the link-shaped tell — `Bun.write` truncates the
      // shared inode in place, so an attacker-planted
      // `ln /etc/target <dest>/out.txt` gets the artifact bytes written
      // THROUGH it (probed 2026-08-24: the linked file's content was
      // replaced). Unlinking first breaks the link instead of following
      // it, for every link shape at once; a plain pre-existing file just
      // gets recreated. A directory at the target survives to fail the
      // write itself — fail-closed, same as before.
      try {
        const ls = await lstat(target)
        if (!ls.isDirectory()) await unlink(target)
      } catch {
        // Target doesn't exist — the common case; fall through.
      }

      await Bun.write(target, e.file)
      if (e.mode !== 0) await chmod(target, e.mode & 0o777)
      if (e.mtimeMs > 0) {
        const t = e.mtimeMs / 1000
        await utimes(target, t, t)
      }
    }),
  )
}

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
