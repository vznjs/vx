import path from 'node:path'

const IS_POSIX = path.sep === '/'

/** Convert a path to POSIX-style for cross-platform stable cache keys. */
export function toPosix(p: string): string {
  // Fast path: on Linux/macOS the separator is already '/'. This
  // function is called for every input file on every cache-key
  // derivation; skipping the split+join is free perf on the dominant
  // dev platform.
  return IS_POSIX ? p : p.split(path.sep).join('/')
}

export function relPosix(from: string, to: string): string {
  return toPosix(path.relative(from, to))
}
