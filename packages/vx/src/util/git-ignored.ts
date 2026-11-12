// Whether git ignores everything an output glob can write (2026-10-15):
// a key reads only what git lists, so such an output never reaches a
// reader's key. Asked of git, never read from a `.gitignore`: git alone
// knows every rule source (nested files, `info/exclude`, `core.excludesFile`)
// and that a directory holding a tracked file is not ignored.

import { existsSync } from 'node:fs'
import path from 'node:path'
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
 * for too (a tracked one, or one a `!` rule takes back). A glob with no
 * literal directory whose one wildcard part is a name of `*` and `?` (`*.tgz`,
 * at the root or at any depth) is asked as a fresh name it matches, and holds only when
 * the rule git names for each probe is one of `rules`: the name pattern
 * itself matches every name the glob does, where `pkg-*.tgz` or `?.tgz`
 * would ignore the probe and not `a.tgz`. Null when no few paths stand for
 * the glob (`*.{js,ts}`): undecided, the output overlaps as before.
 * `dir`: the glob's literal directory, where a listed file it matches lies.
 */
export function ignoreProbes(
  glob: string,
): { paths: string[]; deep: boolean; dir: string; rules?: string[] } | null {
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
  if (lit !== '') return { paths: [`${lit}/`], deep: false, dir: lit }
  const base = segs.length === 1 ? segs[0]! : segs.length === 2 && segs[0] === '**' ? segs[1]! : ''
  if (!/^[^[\]{}\\!][^[\]{}\\]*$/.test(base) || base.includes('**')) return null
  const probe = base.replaceAll('*', FRESH).replaceAll('?', '_')
  // `/*.tgz` anchors at the probe's directory: every root name, never a deeper one.
  return segs.length === 1
    ? { paths: [probe], deep: true, dir: '', rules: [base, `/${base}`, `**/${base}`] }
    : { paths: [probe, `${FRESH}/${probe}`], deep: true, dir: '', rules: [base, `**/${base}`] }
}

/** The rule `check-ignore -v` named for each path git ignores, per answer it gave. */
const rulesOf = new WeakMap<ReadonlySet<string>, ReadonlyMap<string, string>>()

// `-v`: the rule beside each path, for a probe that stands for a name pattern.
const CHECK_IGNORE = ['check-ignore', '--stdin', '-z', '-v']

/**
 * Per directory git runs in, whether its `core.ignorecase=true` is false on
 * disk: a `.git` copied from macOS to Linux keeps the setting, and git then
 * takes a new `a.txt` beside the tracked `A.txt` for the tracked file and
 * lists it nowhere. Asked only where git's config was read anyway.
 */
const caseLies = new Map<string, boolean>()

/**
 * Whether `core.ignorecase=true`, which git in `dir` reported, is false on
 * disk: one stat of `probe` (an existing path) with its name's case
 * swapped, once per `dir`. A name with no cased letter cannot tell, so git
 * is trusted.
 */
export function ignoreCaseLies(dir: string, probe: string): boolean {
  const at = path.resolve(dir)
  let lies = caseLies.get(at)
  if (lies === undefined) {
    const name = path.basename(probe)
    const lower = name.toLowerCase()
    const twin = lower === name ? name.toUpperCase() : lower
    lies = twin !== name && !existsSync(path.join(path.dirname(probe), twin))
    caseLies.set(at, lies)
  }
  return lies
}

/**
 * What a git spawn in `cwd` prepends so a wrong `core.ignorecase` hides no
 * file: `-c core.ignorecase=false` at or under a directory `ignoreCaseLies`
 * found lying (the disk there tells case apart, so the override is git's
 * own answer for any repository on it), else nothing.
 */
export function gitCaseArgs(cwd: string): readonly string[] {
  if (caseLies.size === 0) return []
  const at = path.resolve(cwd)
  for (const [dir, lies] of caseLies)
    if (lies && (at === dir || at.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)))
      return CASE_SENSITIVE
  return []
}

const CASE_SENSITIVE = ['-c', 'core.ignorecase=false']

// git reads each line as a pathspec, so `:top/dist/` was asked as
// `top/dist/`. `./` keeps it the path it is (this command refuses
// `:(literal)`), and git echoes each path back as given.
const stdinOf = (paths: readonly string[]): Buffer =>
  Buffer.from(paths.map((p) => `./${p}\0`).join(''))

function ignoredOf(exitCode: number, stdout: Uint8Array): Set<string> | null {
  // 0: some matched a rule; 1: none; anything else (no work tree): undecided.
  if (exitCode === 1) return new Set()
  if (exitCode !== 0) return null
  // -v: source, line, rule, path per record. A path a `!` rule matched last
  // is listed too, and is not ignored.
  const fields = new TextDecoder().decode(stdout).split('\0')
  const rules = new Map<string, string>()
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const rule = fields[i + 2]!
    if (!rule.startsWith('!')) rules.set(fields[i + 3]!.slice(2), rule)
  }
  const out = new Set(rules.keys())
  rulesOf.set(out, rules)
  return out
}

/** The `paths` (relative to `cwd`) git ignores; null when git cannot say. */
export async function checkIgnore(
  cwd: string,
  paths: readonly string[],
): Promise<Set<string> | null> {
  if (paths.length === 0) return new Set()
  try {
    const proc = Bun.spawn({
      cmd: [executablePath('git'), ...gitCaseArgs(cwd), ...CHECK_IGNORE],
      env: gitEnv(),
      cwd,
      stdin: stdinOf(paths),
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
      cmd: [executablePath('git'), ...gitCaseArgs(cwd), ...CHECK_IGNORE],
      env: gitEnv(),
      cwd,
      stdin: stdinOf(paths),
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
        ...gitCaseArgs(cwd),
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
 * `rel` (relative to `cwd`) as the repository names it when the index
 * flags it skip-worktree (a sparse checkout left it out), else null.
 */
export function skipWorktreeSync(cwd: string, rel: string): string | null {
  try {
    const r = Bun.spawnSync({
      cmd: [
        executablePath('git'),
        ...gitCaseArgs(cwd),
        'ls-files',
        '-t',
        '-z',
        '--full-name',
        '--',
        `:(literal)${rel}`,
      ],
      env: gitEnv(),
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (r.exitCode !== 0) return null
    const record = new TextDecoder().decode(r.stdout).split('\0')[0] ?? ''
    return record.startsWith('S ') ? record.slice(2) : null
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
    const rules = ask.rules
    if (
      rules !== undefined &&
      !ask.paths.every((p) => rules.includes(rulesOf.get(ignored)?.get(p) ?? ''))
    )
      continue
    if (ask.deep && listedMatch(g)) continue
    out.add(g)
  }
  return out
}
