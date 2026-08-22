// In-process tar reader (POSIX ustar + GNU) for cache-hit restore.
//
// We replace `Bun.spawn(['tar', '-xf', ...])` on the cache-hit path
// to save a per-restore fork+exec (~5-10ms on Linux). At 200 cached
// tasks per run, that's 1-2s of pure overhead reclaimed.
//
// Tar layout we accept (produced by GNU/BSD `tar -cf - -C stage X Y Z`):
//   - 512-byte POSIX ustar headers
//   - name        : bytes 0..99    (null-padded)
//   - mode        : bytes 100..107 (octal ASCII, null-padded)
//   - mtime       : bytes 136..147 (octal ASCII seconds since epoch)
//   - size        : bytes 124..135 (octal ASCII)
//   - typeflag    : byte 156       ('0' or '\0' = file, '5' = dir,
//                                   '2' = symlink, 'L' = GNU longname,
//                                   'x' / 'g' / 'X' = PAX extended
//                                   header — metadata for the next
//                                   entry, not a file itself)
//   - magic       : bytes 257..264 ('ustar\0' + '00' = POSIX ustar;
//                                   'ustar  \0' = the older GNU format)
//   - prefix      : bytes 345..499 — POSIX-ustar ONLY. A name longer
//                                   than 100 bytes is split here, and
//                                   the entry's real name is
//                                   `prefix + '/' + name`. GNU-format
//                                   headers put atime/ctime at the same
//                                   offsets, so this field is read only
//                                   when the POSIX magic is present.
//   - data        : `size` bytes, padded up to next 512-byte block
//   - end         : two 512-byte zero blocks
//
// We tolerate the GNU longname extension (typeflag 'L') — that is how
// GNU-format archives (what `packArtifact` writes) carry a name longer
// than 100 bytes, and it is also the only way to express a single path
// COMPONENT over 100 bytes, which ustar cannot split at all.
//
// PAX extended-header records
// ('x' / 'g' / 'X') are SKIPPED — BSD tar (macOS default) emits one
// per entry for xattrs / mtime-nanos / SCHILY metadata. We don't
// need any of that; treating the headers as regular files would put
// `PaxHeaders/foo` junk entries into the restored tree.
//
// AppleDouble files (`._<name>`) are also SKIPPED — macOS Finder /
// `cp -p` leave these resource-fork siblings around (e.g. `._main.js`
// next to `main.js`). They're not real outputs; filtering at parse
// time prevents them from showing up in restored trees even when an
// older / contaminated cache entry includes them. The matching
// input-side filter lives in `src/cache/inputs.ts:ALWAYS_IGNORE`.
//
// We DO NOT support sparse files, character/block devices, or
// hardlinks — they don't appear in build outputs.

import { lstat, mkdir, chmod, realpath, unlink, utimes } from 'node:fs/promises'
import path from 'node:path'

export interface TarHeader {
  /** Full archive-relative name, e.g. "outputs/dist/index.js" or "manifest.json". */
  name: string
  size: number
  /** File permission bits, e.g. 0o644. */
  mode: number
  /** Modification time in ms since epoch (seconds-resolution from tar). */
  mtimeMs: number
  isDir: boolean
  /** Offset in `tarBytes` where the file's data starts. */
  dataOffset: number
}

/**
 * Walk a tar archive's headers and return them in source order.
 * Cheap: only reads 512-byte blocks; never decodes file bodies.
 */
export function parseTarHeaders(tarBytes: Uint8Array): TarHeader[] {
  const headers: TarHeader[] = []
  const dec = new TextDecoder('utf-8')
  let off = 0
  let pendingLongName: string | null = null

  while (off + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(off, off + 512)
    // End-of-archive marker: 512 zero bytes (tar pads two such blocks).
    let zero = true
    for (let i = 0; i < 512 && zero; i++) {
      if (header[i] !== 0) zero = false
    }
    if (zero) break

    let nameEnd = 0
    while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++
    const bareName = dec.decode(header.subarray(0, nameEnd))

    // POSIX ustar splits a name over 100 bytes into `prefix` + `name`.
    // Reading only `name` would silently drop the leading directories —
    // and with them the `outputs/` namespace, so the entry would be
    // invisible to both the restore and the output_files index. Gated on
    // the POSIX magic because GNU headers reuse bytes 345+ for atime.
    const posixUstar =
      header[257] === 0x75 /* u */ &&
      header[258] === 0x73 /* s */ &&
      header[259] === 0x74 /* t */ &&
      header[260] === 0x61 /* a */ &&
      header[261] === 0x72 /* r */ &&
      header[262] === 0
    let prefix = ''
    if (posixUstar) {
      let prefixEnd = 0
      while (prefixEnd < 155 && header[345 + prefixEnd] !== 0) prefixEnd++
      prefix = dec.decode(header.subarray(345, 345 + prefixEnd))
    }
    const rawName = (prefix.length > 0 ? `${prefix}/${bareName}` : bareName).replace(/^\.\//, '')

    const modeStr = dec.decode(header.subarray(100, 108)).trim().replace(/ +$/, '')
    const mode = parseInt(modeStr, 8) || 0o644

    const sizeStr = dec.decode(header.subarray(124, 136)).trim().replace(/ +$/, '')
    const size = parseInt(sizeStr, 8) || 0

    const mtimeStr = dec.decode(header.subarray(136, 148)).trim().replace(/ +$/, '')
    const mtimeMs = (parseInt(mtimeStr, 8) || 0) * 1000

    const typeFlag = header[156]
    const isDir = typeFlag === 0x35 /* '5' */ || rawName.endsWith('/')

    const dataStart = off + 512
    const padded = Math.ceil(size / 512) * 512

    // A declared size that runs past the end of the archive means the
    // bytes are not there. `subarray` CLAMPS, so reading anyway yields a
    // short, NUL-padded body — silently WRONG file content presented as a
    // cache hit. Refuse instead; the caller degrades to a miss and re-runs.
    // (Only the data must be present — trailing block padding may be cut.)
    if (dataStart + size > tarBytes.length) {
      throw new TarSecurityError(
        `tar entry declares ${size} bytes but the archive ends early (truncated): ${rawName}`,
      )
    }

    if (typeFlag === 0x4c /* 'L' — GNU longname */) {
      // The data block carries the next entry's full name (null-
      // terminated). Stash it; the actual file header follows.
      // Strip the null terminator(s) without writing a regex that lint
      // flags as a control-char match.
      const raw = dec.decode(tarBytes.subarray(dataStart, dataStart + size))
      let endIdx = raw.length
      while (endIdx > 0 && raw.charCodeAt(endIdx - 1) === 0) endIdx--
      pendingLongName = raw.slice(0, endIdx)
      off = dataStart + padded
      continue
    }

    // PAX extended headers: metadata about the next entry (long
    // names, large sizes, nanosecond mtime, BSD xattrs, etc). Their
    // own entry name is something like `PaxHeaders/<basename>` or
    // `./PaxHeader.NNNN/<basename>` — definitely not a file we want
    // to write to disk. Skip the whole record (header + padded data)
    // and let the next entry through unchanged.
    if (
      typeFlag === 0x78 /* 'x' — per-entry PAX */ ||
      typeFlag === 0x67 /* 'g' — global PAX */ ||
      typeFlag === 0x58 /* 'X' — Solaris extended */
    ) {
      off = dataStart + padded
      continue
    }

    // Reject typeflags we don't support: hardlink (1), symlink (2),
    // char device (3), block device (4), FIFO (6), contiguous (7).
    // Build outputs are regular files + directories; anything else
    // is either a producer bug or a smuggled non-file artifact (a
    // symlink to /etc/passwd, a /dev/null mapping, etc.). Reject
    // explicitly so future extractors can't be tricked into honoring
    // these by accident.
    if (typeFlag === 0x31 /* '1' */) {
      throw new TarSecurityError(`tar entry typeflag 'hardlink' is unsupported: ${rawName}`)
    }
    if (typeFlag === 0x32 /* '2' */) {
      throw new TarSecurityError(`tar entry typeflag 'symlink' is unsupported: ${rawName}`)
    }
    if (typeFlag === 0x33 /* '3' */) {
      throw new TarSecurityError(`tar entry typeflag 'chardev' is unsupported: ${rawName}`)
    }
    if (typeFlag === 0x34 /* '4' */) {
      throw new TarSecurityError(`tar entry typeflag 'blockdev' is unsupported: ${rawName}`)
    }
    if (typeFlag === 0x36 /* '6' */) {
      throw new TarSecurityError(`tar entry typeflag 'fifo' is unsupported: ${rawName}`)
    }
    if (typeFlag === 0x37 /* '7' */) {
      throw new TarSecurityError(`tar entry typeflag 'contiguous' is unsupported: ${rawName}`)
    }

    const name = pendingLongName ?? rawName
    pendingLongName = null

    if (name.length === 0) {
      off = dataStart + padded
      continue
    }

    // Path-traversal defense. We only ever want to extract entries
    // under `outputs/<rel>` where `<rel>` is project-relative and
    // contains no `..` segments and no absolute prefix. Reject at
    // parse time so a malicious cache artifact can't write outside
    // the destination (zip-slip class). Mirrors Turbo's
    // restore.rs:check_path normalization.
    if (name.startsWith('/')) {
      throw new TarSecurityError(`tar entry name is absolute (unsafe): ${name}`)
    }
    if (hasParentSegment(name)) {
      throw new TarSecurityError(`tar entry name escapes via '..' (unsafe): ${name}`)
    }
    if (name.includes('//')) {
      throw new TarSecurityError(`tar entry name has empty path component (unsafe): ${name}`)
    }
    // Windows-shaped paths are categorically unsafe to extract on
    // POSIX hosts (and vice versa): backslash separators, drive
    // letters, extended-length prefixes. Reject before we touch
    // anything.
    if (name.includes('\\')) {
      throw new TarSecurityError(`tar entry uses backslash separators (windows-unsafe): ${name}`)
    }
    if (/^[A-Za-z]:[\\/]/.test(name)) {
      throw new TarSecurityError(`tar entry has windows drive prefix (unsafe): ${name}`)
    }

    // AppleDouble resource-fork siblings — basename starting with
    // `._`. macOS Finder / `cp -p` leave these next to real files
    // (e.g. `._main.js` shadowing `main.js`). They carry xattrs we
    // don't care about; restoring them just pollutes the tree.
    const basename = name.slice(name.lastIndexOf('/') + 1)
    if (basename.startsWith('._')) {
      off = dataStart + padded
      continue
    }

    headers.push({ name, size, mode, mtimeMs, isDir, dataOffset: dataStart })
    off = dataStart + padded
  }
  return headers
}

/**
 * Thrown by `parseTarHeaders` when an entry's name would let it
 * escape the extraction destination (absolute path, `..` traversal,
 * doubled separators). Callers should treat this as a corrupt /
 * malicious artifact — log it, drop the cache entry, and re-run.
 */
export class TarSecurityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TarSecurityError'
  }
}

function hasParentSegment(p: string): boolean {
  if (p === '..' || p.startsWith('../') || p.endsWith('/..')) return true
  return p.includes('/../')
}

/**
 * Read a single tar entry's text body. Returns '' for missing entries.
 * Used to extract `stdout` / `stderr` inline.
 */
export function readTarText(tarBytes: Uint8Array, headers: TarHeader[], name: string): string {
  const h = headers.find((e) => e.name === name)
  if (!h) return ''
  return new TextDecoder('utf-8').decode(tarBytes.subarray(h.dataOffset, h.dataOffset + h.size))
}

/**
 * Extract a tar's `outputs/<rel>` entries into `destDir/<rel>` (strips
 * the `outputs/` prefix), and — when `workspaceDest` is given — its
 * `workspace-outputs/<rel>` entries into `workspaceDest/<rel>`.
 * Entries in neither namespace are ignored; workspace entries are
 * also ignored when no `workspaceDest` is supplied.
 */
export async function extractOutputs(
  tarBytes: Uint8Array,
  destDir: string,
  workspaceDest?: string,
): Promise<void> {
  const headers = parseTarHeaders(tarBytes)

  await mkdir(destDir, { recursive: true })

  // Each namespace anchors at its own destination dir.
  const destFor = (name: string): { base: string; rel: string } | null => {
    if (name.startsWith('outputs/')) {
      return { base: destDir, rel: name.slice('outputs/'.length) }
    }
    if (workspaceDest !== undefined && name.startsWith('workspace-outputs/')) {
      return { base: workspaceDest, rel: name.slice('workspace-outputs/'.length) }
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

  // Containment gate applied to EVERY entry — directories included, since
  // `mkdir(recursive)` follows a pre-existing symlink just as happily as a
  // file write does. Two checks: lexical (the joined path stays under the
  // base) and real (the deepest EXISTING ancestor still resolves inside the
  // real base). Walking up to the deepest existing ancestor is what makes it
  // sound BEFORE anything is created — checking only the immediate parent
  // would pass for `dist/a/b` when `dist` is the symlink and `dist/a` does
  // not exist yet.
  const assertContained = async (base: string, target: string, name: string): Promise<void> => {
    const baseResolved = path.resolve(base)
    const targetResolved = path.resolve(target)
    if (targetResolved !== baseResolved && !targetResolved.startsWith(baseResolved + path.sep)) {
      throw new TarSecurityError(`tar entry escapes destDir (unsafe): ${name}`)
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
          throw new TarSecurityError(`tar entry escapes destDir via a symlinked parent: ${name}`)
        }
        return
      }
      probe = path.dirname(probe)
    }
    // Nothing between the base and the target exists yet, so there is no
    // pre-existing symlink to follow — the chain will be created fresh.
  }

  // Two passes: directories first (depth-first via sort), then files.
  // Keeps file writes from racing with their parent dir creation.
  const dirEntries = headers
    .filter((h) => h.isDir)
    .map((h) => ({ name: h.name, dest: destFor(h.name) }))
    .filter(
      (d): d is { name: string; dest: { base: string; rel: string } } =>
        d.dest !== null && d.dest.rel.length > 0,
    )
    .sort((a, b) => (a.dest.rel < b.dest.rel ? -1 : 1))
  for (const d of dirEntries) {
    const target = path.join(d.dest.base, d.dest.rel)
    await assertContained(d.dest.base, target, d.name)
    await mkdir(target, { recursive: true })
  }

  const fileEntries = headers
    .map((h) => ({ h, dest: destFor(h.name) }))
    .filter(
      (e): e is { h: TarHeader; dest: { base: string; rel: string } } =>
        e.dest !== null && !e.h.isDir && e.dest.rel.length > 0,
    )

  await Promise.all(
    fileEntries.map(async ({ h, dest }) => {
      const target = path.join(dest.base, dest.rel)
      // Refuse BEFORE the parent chain is created, so a poisoned artifact
      // whose entry lands under a pre-existing symlinked directory never
      // gets so far as materializing a directory outside the tree.
      await assertContained(dest.base, target, h.name)

      // Ensure the parent dir exists. Cheap because mkdir(recursive)
      // is a no-op when the dir is already there.
      await mkdir(path.dirname(target), { recursive: true })

      // Symlink TOCTOU defense: if the target IS a symlink, unlink
      // it first so the upcoming write doesn't follow the link and
      // clobber whatever the link points to (e.g. an attacker placed
      // `<dest>/link -> /etc/passwd` to redirect our write). lstat
      // doesn't follow the symlink, so we can detect the link itself.
      try {
        const ls = await lstat(target)
        if (ls.isSymbolicLink()) await unlink(target)
      } catch {
        // Target doesn't exist — that's the common case; fall through.
      }

      const body = tarBytes.subarray(h.dataOffset, h.dataOffset + h.size)
      // Bun.write benchmarks ~2× faster than fs/promises.writeFile
      // for these per-entry restore writes (167µs vs 361µs per 1KB
      // on the dev box; ~1.6× in batched Promise.all over 50 files).
      // Native fast path; same correctness contract.
      await Bun.write(target, body)
      // Permission bits + mtime restoration — keeps a re-tar of the
      // restored tree byte-identical to the original artifact.
      if ((h.mode & 0o777) !== 0) await chmod(target, h.mode & 0o777)
      if (h.mtimeMs > 0) {
        const t = h.mtimeMs / 1000
        await utimes(target, t, t)
      }
    }),
  )
}

/**
 * The `--format` name for the GNU tar format, spelled the way the
 * LOCAL `tar` accepts it.
 *
 * GNU tar calls the format `gnu`; bsdtar — the macOS default — calls
 * the same format `gnutar` and REFUSES `gnu` outright ("Can't use
 * format gnu: No such format 'gnu'", exit 1). Both write the identical
 * on-disk bytes, including the `L` long-name record the reader above
 * already understands, so this is purely how the flag is spelled.
 * Measured against bsdtar 3.5.3: `gnutar` round-trips a 140-byte path
 * component and a >100-byte path through `extractOutputs` with modes
 * intact and no PAX junk; `ustar` silently DROPS the long-component
 * entry; `pax` produces headers this reader cannot parse at all.
 */
export function tarFormatFromVersion(version: string): 'gnu' | 'gnutar' {
  return /bsdtar|libarchive/i.test(version) ? 'gnutar' : 'gnu'
}

let tarFormatMemo: Promise<'gnu' | 'gnutar'> | undefined

/**
 * Probe `tar --version` ONCE per process, lazily. A run that never
 * packs — every warm all-hit run — pays nothing, and a host with GNU
 * tar installed as `tar` is DETECTED rather than assumed from
 * `process.platform`. An unreadable probe keeps the GNU spelling; the
 * pack that follows surfaces the real error itself rather than having
 * this guess at one.
 */
export function resolveTarFormat(): Promise<'gnu' | 'gnutar'> {
  tarFormatMemo ??= (async () => {
    try {
      const proc = Bun.spawn(['tar', '--version'], { stdout: 'pipe', stderr: 'pipe' })
      const [out] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited
      return tarFormatFromVersion(out)
    } catch {
      return 'gnu'
    }
  })()
  return tarFormatMemo
}
