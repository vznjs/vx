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
  // A brace set is a wildcard too: `{dist,build}/**` reaches either dir,
  // and reading it as the literal directory `{dist,build}` gave the
  // sandbox baseline a prefix that exists nowhere (2026-09-10).
  const wildcardIdx = glob.search(/[*?[\]{}]/)
  if (wildcardIdx === -1) return glob
  const head = glob.slice(0, wildcardIdx)
  const lastSep = head.lastIndexOf('/')
  if (lastSep === -1) return '.'
  return head.slice(0, lastSep) || '/'
}

/**
 * The directories a task's declared outputs cover WHOLE — every glob is
 * `<dir>/**` with a plain, non-root, non-escaping `<dir>` — or `null` when
 * any glob is shaped otherwise. The directory-mtime short-circuit on a warm
 * hit (`Cache.outputDirsCurrent`) is sound only for whole subtrees: with
 * every directory under `<dir>` recorded, a file added or removed anywhere
 * the glob could see bumps a recorded directory's mtime (its parent, or a
 * new directory whose creation bumped a recorded ancestor). A root-anchored
 * `**\/*.js` has no such closed set, so it keeps the walk.
 */
export function wholeSubtreePrefixes(globs: readonly string[]): string[] | null {
  if (globs.length === 0) return null
  const out: string[] = []
  for (const g of globs.map(normalizeGlob)) {
    const m = /^([^*?[\]{}!]+?)\/\*\*$/.exec(g)
    if (m === null) return null
    const dir = m[1]!.replace(/\/+$/, '')
    if (dir === '' || dir === '.' || dir.startsWith('/') || dir.split('/').includes('..'))
      return null
    out.push(dir)
  }
  return [...new Set(out)]
}

/**
 * The spellings a reader, Turbo and `.gitignore` all accept but a matcher
 * fed the raw string turns into NOTHING — and a task keyed on nothing
 * replays old outputs as a green hit (2026-09-10, probed one by one):
 * a leading `./`, an inner `/./` segment, a doubled `//`, and a trailing
 * `/` on a pattern (`src/*\/` means the trees under `src`, so it becomes
 * `src/*\/**`; a trailing slash on a LITERAL is `asTrees`' job). Applied
 * after an optional `!`; a bare `.` is the empty entry the schema refuses.
 */
export function normalizeGlob(glob: string): string {
  const neg = glob.startsWith('!')
  let g = neg ? glob.slice(1) : glob
  g = g.replace(/\/{2,}/g, '/').replace(/(^|\/)(\.\/)+/g, '$1')
  if (g === '.') g = ''
  if (/[*?[\]{}]/.test(g) && g.endsWith('/')) g = `${g.replace(/\/+$/, '')}/**`
  return neg ? `!${g}` : g
}
