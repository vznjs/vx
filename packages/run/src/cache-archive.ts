// tar.gz pack/unpack for remote-cache artifacts.
//
// The wire body for a `/v8/artifacts/<hash>` PUT/GET is opaque to cache
// servers, so we pick the interior. Per docs/design/remote-cache.md, our
// tar layout is:
//
//   meta.json
//   outputs/
//     <project-relative paths>
//
// Pure helpers: build a tar.gz from a stage dir; extract a tar.gz into a
// dest dir. The caller (LayeredCache, separate PR) handles staging from
// the v10 local layout and back.
//
// Implementation: shells out to system `tar`. tar ships with every
// platform we care about (GNU on Linux, BSD on macOS, MS bundled on
// Windows 10+) and handles gzip via `-z`, streaming via stdin/stdout.

import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

/**
 * Tar+gzip the entire `stageDir` contents, writing to a stdout-piped
 * `tar` subprocess. Returns the gzipped tarball as a buffer.
 *
 * The tar layout mirrors `stageDir`'s top-level entries — pass a stage
 * that already has `meta.json` and `outputs/` at its root.
 */
export async function packArchive(stageDir: string): Promise<Uint8Array> {
  const proc = Bun.spawn(['tar', '-cz', '-C', stageDir, '.'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode !== 0) {
    throw new Error(`packArchive: tar exited ${proc.exitCode}: ${stderr.trim()}`)
  }
  return new Uint8Array(stdout)
}

/**
 * Extract a gzipped tarball into `destDir`. Creates `destDir` if missing.
 * Streams the input via stdin so the caller doesn't need a temp file.
 */
export async function unpackArchive(
  tarball: Uint8Array | ArrayBuffer,
  destDir: string,
): Promise<void> {
  await mkdir(destDir, { recursive: true })
  const proc = Bun.spawn(['tar', '-xz', '-C', destDir], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const bytes = tarball instanceof Uint8Array ? tarball : new Uint8Array(tarball)
  // proc.stdin is a FileSink in Bun; write + end is the streaming pattern.
  // write() can return a number (bytes written) or a Promise in some Bun
  // versions — await covers both.
  await proc.stdin.write(bytes)
  await proc.stdin.end()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited
  if (proc.exitCode !== 0) {
    throw new Error(`unpackArchive: tar exited ${proc.exitCode}: ${stderr.trim()}`)
  }
}

/**
 * Convenience: pack a stage dir, then remove it. Useful when the stage
 * was created just to feed `packArchive`.
 */
export async function packAndDiscard(stageDir: string): Promise<Uint8Array> {
  try {
    return await packArchive(stageDir)
  } finally {
    await rm(stageDir, { recursive: true, force: true })
  }
}

/** Build a tar-safe POSIX path (forward slashes). */
export function tarPath(...segments: string[]): string {
  return segments.join('/').replace(/\\/g, '/').replace(/\/+/g, '/')
}

/** Tiny helper: stage dir name with PID + timestamp to avoid races. */
export function uniqueStageDir(parent: string, prefix: string): string {
  return path.join(parent, `${prefix}.${process.pid}.${Date.now()}`)
}
