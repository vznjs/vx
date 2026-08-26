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

/**
 * The leading, wildcard-free part of a glob, trimmed back to whole path
 * components (`dist/sub-**` → `dist`). `.` when the first component is
 * already a wildcard, i.e. the glob can reach anything in its anchor dir.
 *
 * Two callers with different needs share it deliberately: the sandbox
 * baseline joins it onto a dir to get a write prefix, and the deferral
 * eligibility gate compares two of them for overlap. A second copy is
 * how the two would disagree about what a prefix is.
 */
export function staticPrefix(glob: string): string {
  const wildcardIdx = glob.search(/[*?[\]]/)
  if (wildcardIdx === -1) return glob
  const head = glob.slice(0, wildcardIdx)
  const lastSep = head.lastIndexOf('/')
  if (lastSep === -1) return '.'
  return head.slice(0, lastSep) || '/'
}
