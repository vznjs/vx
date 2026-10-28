// Whether git ignores everything an output glob can write (2026-10-15):
// a key reads only what git lists, so such an output never reaches a
// reader's key. Asked of git, never read from a `.gitignore`: git alone
// knows every rule source (nested files, `info/exclude`, `core.excludesFile`)
// and that a directory holding a tracked file is not ignored.

import { gitEnv } from './hide-env.js'
import { isLiteralPattern, normalizeGlob } from './paths.js'
import { executablePath } from './which.js'

/** A directory name no ignore rule names, standing for one a task may create. */
const FRESH = '__vx_probe__'

/**
 * The paths git is asked about for a root-relative output glob: when git
 * ignores each, it ignores every untracked path the glob can match. `deep`:
 * the glob reaches below them (a `dist` at any depth is asked as `dist/` and
 * a fresh `__vx_probe__/dist/`), so a listed file it matches must be looked
 * for too (a tracked one, or one a `!` rule takes back). Null when no few paths
 * stand for the glob (`*.js`): undecided, the output overlaps as before.
 * `dir`: the glob's literal directory, where a listed file it matches lies.
 */
export function ignoreProbes(glob: string): { paths: string[]; deep: boolean; dir: string } | null {
  const segs = normalizeGlob(glob).split('/')
  let i = 0
  while (i < segs.length && isLiteralPattern(segs[i]!)) i++
  const lit = segs.slice(0, i).join('/')
  if (i === segs.length) return { paths: [lit], deep: false, dir: lit }
  const at = lit === '' ? '' : `${lit}/`
  const name = segs[i + 1]
  if (segs[i] === '**' && name !== undefined && isLiteralPattern(name)) {
    const leaf = i + 2 < segs.length ? `${name}/` : name
    return { paths: [at + leaf, `${at}${FRESH}/${leaf}`], deep: true, dir: lit }
  }
  return lit === '' ? null : { paths: [`${lit}/`], deep: false, dir: lit }
}

const CHECK_IGNORE = ['check-ignore', '--stdin', '-z']

function ignoredOf(exitCode: number, stdout: Uint8Array): Set<string> | null {
  // 0: some ignored; 1: none; anything else (no work tree): undecided.
  if (exitCode === 1) return new Set()
  if (exitCode !== 0) return null
  return new Set(
    new TextDecoder()
      .decode(stdout)
      .split('\0')
      .filter((p) => p !== ''),
  )
}

/** The `paths` (relative to `cwd`) git ignores; null when git cannot say. */
export async function checkIgnore(
  cwd: string,
  paths: readonly string[],
): Promise<Set<string> | null> {
  if (paths.length === 0) return new Set()
  try {
    const proc = Bun.spawn({
      cmd: [executablePath('git'), ...CHECK_IGNORE],
      env: gitEnv(),
      cwd,
      stdin: Buffer.from(paths.map((p) => `${p}\0`).join('')),
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const stdout = await new Response(proc.stdout).bytes()
    return ignoredOf(await proc.exited, stdout)
  } catch {
    return null
  }
}

/** {@link checkIgnore} for `vx lock`, which builds its graph synchronously. */
export function checkIgnoreSync(cwd: string, paths: readonly string[]): Set<string> | null {
  if (paths.length === 0) return new Set()
  try {
    const r = Bun.spawnSync({
      cmd: [executablePath('git'), ...CHECK_IGNORE],
      env: gitEnv(),
      cwd,
      stdin: Buffer.from(paths.map((p) => `${p}\0`).join('')),
      stdout: 'pipe',
      stderr: 'ignore',
    })
    return ignoredOf(r.exitCode, r.stdout)
  } catch {
    return null
  }
}

/**
 * What git lists under `dirs` (relative to `cwd`): tracked files and the
 * untracked ones it does not ignore, the set a key filters. Null when git
 * cannot say. A run has it from its enumeration; this is `vx lock`'s.
 */
export function listedSync(cwd: string, dirs: readonly string[]): string[] | null {
  try {
    const r = Bun.spawnSync({
      cmd: [
        executablePath('git'),
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        ...dirs.map((d) => (d === '' ? '.' : `:(literal)${d}`)),
      ],
      env: gitEnv(),
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (r.exitCode !== 0) return null
    return new TextDecoder()
      .decode(r.stdout)
      .split('\0')
      .filter((p) => p !== '')
  } catch {
    return null
  }
}

/**
 * Of `globs` (root-relative), those git ignores whole: each probe ignored
 * and, for a deep glob, no listed file it matches (`listedMatch`).
 */
export function wholeIgnored(
  globs: Iterable<string>,
  ignored: ReadonlySet<string> | null,
  listedMatch: (glob: string) => boolean,
): Set<string> {
  const out = new Set<string>()
  if (ignored === null) return out
  for (const g of globs) {
    const ask = ignoreProbes(g)
    if (ask === null || !ask.paths.every((p) => ignored.has(p))) continue
    if (ask.deep && listedMatch(g)) continue
    out.add(g)
  }
  return out
}
