// In-process tar reader (POSIX ustar) for cache-hit restore.
//
// We replace `Bun.spawn(['tar', '-xf', ...])` on the cache-hit path
// for two compounding wins:
//
//   1. Per-restore fork+exec saved (~5-10ms on Linux). At 200 cached
//      tasks per run, that's 1-2s of pure overhead reclaimed.
//   2. Per-file skip via a manifest embedded in the tar. After a
//      cache-hit restore, the on-disk tree already matches the
//      cached snapshot bit-for-bit. The next hit's restore reads the
//      manifest, stats each target, and skips identical files.
//      Turbo does the same in `restore_regular.rs:19-25`.
//
// Tar layout we accept (produced by GNU/BSD `tar -cf - -C stage X Y Z`):
//   - 512-byte POSIX ustar headers
//   - name        : bytes 0..99    (null-padded)
//   - mode        : bytes 100..107 (octal ASCII, null-padded)
//   - mtime       : bytes 136..147 (octal ASCII seconds since epoch)
//   - size        : bytes 124..135 (octal ASCII)
//   - typeflag    : byte 156       ('0' or '\0' = file, '5' = dir,
//                                   '2' = symlink, 'L' = GNU longname)
//   - data        : `size` bytes, padded up to next 512-byte block
//   - end         : two 512-byte zero blocks
//
// We tolerate the GNU longname extension (typeflag 'L') because some
// tar binaries emit it for paths > 100 chars even when ustar's
// prefix+name (256 chars) would suffice. We DO NOT support sparse
// files, character/block devices, or hardlinks — they don't appear
// in build outputs.

import { mkdir, stat, writeFile, chmod, utimes } from 'node:fs/promises'
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

/** Per-output-file metadata embedded in the tar as `manifest.json`. */
export interface ManifestEntry {
  size: number
  mode: number
  mtimeMs: number
}

/** Manifest keyed by tar entry name (e.g. "outputs/dist/index.js"). */
export type Manifest = Record<string, ManifestEntry>

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
    const rawName = dec.decode(header.subarray(0, nameEnd)).replace(/^\.\//, '')

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

    const name = pendingLongName ?? rawName
    pendingLongName = null

    if (name.length > 0) {
      headers.push({ name, size, mode, mtimeMs, isDir, dataOffset: dataStart })
    }
    off = dataStart + padded
  }
  return headers
}

/**
 * Read a single tar entry's text body. Returns '' for missing entries.
 * Used to extract `manifest.json` / `stdout` / `stderr` inline.
 */
export function readTarText(tarBytes: Uint8Array, headers: TarHeader[], name: string): string {
  const h = headers.find((e) => e.name === name)
  if (!h) return ''
  return new TextDecoder('utf-8').decode(tarBytes.subarray(h.dataOffset, h.dataOffset + h.size))
}

export interface ExtractResult {
  /** Files actually written to disk. */
  written: number
  /** Files skipped because (size, mode, mtimeMs) matched manifest. */
  skipped: number
}

/**
 * Extract a tar's `outputs/<rel>` entries into `destDir/<rel>` (strips
 * the `outputs/` prefix). Entries outside `outputs/` are ignored.
 *
 * When `manifest` is provided, each target is stat'd before writing;
 * if `(size, mode, mtime)` matches the manifest entry, the write is
 * skipped (Turbo's restore-skip pattern). Files not in the manifest
 * are always written.
 *
 * Returns counts for observability.
 */
export async function extractOutputs(
  tarBytes: Uint8Array,
  destDir: string,
  manifest?: Manifest,
): Promise<ExtractResult> {
  const headers = parseTarHeaders(tarBytes)
  const result: ExtractResult = { written: 0, skipped: 0 }

  await mkdir(destDir, { recursive: true })

  // Two passes: directories first (depth-first via sort), then files.
  // Keeps file writes from racing with their parent dir creation.
  const dirEntries = headers
    .filter((h) => h.name.startsWith('outputs/') && h.isDir)
    .map((h) => h.name.slice('outputs/'.length))
    .filter((rel) => rel.length > 0)
    .sort()
  for (const rel of dirEntries) {
    await mkdir(path.join(destDir, rel), { recursive: true })
  }

  const fileEntries = headers.filter(
    (h) => h.name.startsWith('outputs/') && !h.isDir && h.name !== 'outputs/',
  )
  await Promise.all(
    fileEntries.map(async (h) => {
      const rel = h.name.slice('outputs/'.length)
      const target = path.join(destDir, rel)

      // Skip-if-matches: stat the target and compare against the
      // manifest entry for this tar entry name.
      if (manifest && manifest[h.name]) {
        const m = manifest[h.name]!
        try {
          const s = await stat(target)
          if (
            s.size === m.size &&
            (s.mode & 0o777) === (m.mode & 0o777) &&
            Math.floor(s.mtimeMs / 1000) === Math.floor(m.mtimeMs / 1000)
          ) {
            result.skipped++
            return
          }
        } catch {
          // Target missing — fall through to write.
        }
      }

      // Ensure the parent dir exists. Cheap because mkdir(recursive)
      // is a no-op when the dir is already there.
      await mkdir(path.dirname(target), { recursive: true })

      const body = tarBytes.subarray(h.dataOffset, h.dataOffset + h.size)
      await writeFile(target, body)
      // Permission bits + mtime restoration — keeps a re-tar of the
      // restored tree byte-identical to the original artifact, and
      // primes the manifest-skip for the NEXT cache hit.
      if ((h.mode & 0o777) !== 0) await chmod(target, h.mode & 0o777)
      if (h.mtimeMs > 0) {
        const t = h.mtimeMs / 1000
        await utimes(target, t, t)
      }
      result.written++
    }),
  )

  return result
}

/**
 * Build a Manifest for the given absolute file paths. `relRoot` is
 * the directory the paths are relative to; entries are keyed by
 * `outputs/<rel>` (matching the tar entry naming).
 */
export async function buildManifest(files: readonly string[], relRoot: string): Promise<Manifest> {
  const m: Manifest = {}
  await Promise.all(
    files.map(async (f) => {
      const s = await stat(f)
      const rel = path.relative(relRoot, f).split(path.sep).join('/')
      m[`outputs/${rel}`] = {
        size: s.size,
        mode: s.mode & 0o777,
        mtimeMs: Math.floor(s.mtimeMs),
      }
    }),
  )
  return m
}
