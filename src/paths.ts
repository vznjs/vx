import path from 'node:path'

/** Convert a path to POSIX-style for cross-platform stable cache keys. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

export function relPosix(from: string, to: string): string {
  return toPosix(path.relative(from, to))
}
