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

/**
 * `.vx/.gitignore`: git ignores the machine-local `.vx/cache`, `.vx/tmp`
 * (where restores stage) and nothing else in `.vx`, so the workspace
 * config and the lock beside it are committed. `vx init` and the cache
 * write it when missing.
 */
export const DOT_VX_GITIGNORE = '/cache\n/tmp\n'

/** `.vx/.gitattributes`' text: GitHub collapses the machine lock in a diff. */
export const DOT_VX_GITATTRIBUTES = 'projects.lock.json linguist-generated=true\n'

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
 *
 * The spelling is normalized FIRST, here rather than at each call site,
 * because sharing the function was not enough to make the two callers
 * agree: the sandbox joins the prefix onto a directory and `path.join`
 * folds `./`, `//` and `/./` on the way, while the deferral gate compares
 * the raw strings and does not. So `./out/**` and `out/**` named the same
 * tree to the resolver, the sandbox and the watcher, and two DIFFERENT
 * prefixes to the gate — which then deferred a producer a same-project
 * reader's key could see, moving that key with a transfer flag (item 441,
 * measured through a real run: `./out/**` keyed the consumer two ways).
 * Every glob reaching here is user-written, so every one takes the rule.
 */
export function staticPrefix(rawGlob: string): string {
  // An escaped character is part of the prefix and names itself:
  // `app/\[id\]/**` is rooted at the directory `app/[id]`.
  const g = normalizeGlob(rawGlob)
  if (!g.includes('\\')) return prefixOf(g, GLOB_WILDCARDS)
  const masked = g.replace(/\\./g, '\0\0')
  const prefix = prefixOf(masked, GLOB_WILDCARDS)
  return prefix === '.' || prefix === '/'
    ? prefix
    : g.slice(0, prefix.length).replace(/\\(.)/g, '$1')
}

/**
 * {@link staticPrefix} under `Bun.Glob`'s own alphabet, for a sandbox GRANT:
 * the grant is expanded by a `Bun.Glob` scan that reads `[ab]` as a class, so
 * its prefix must stop there too, or `write: ['g/[ab].txt']` would create a
 * DIRECTORY named `g/[ab].txt`.
 */
export function grantPrefix(rawGlob: string): string {
  return prefixOf(normalizeBunGlob(rawGlob), BUN_GLOB_WILDCARDS)
}

function prefixOf(glob: string, wildcards: RegExp): string {
  // A brace set is a wildcard too: `{dist,build}/**` reaches either dir,
  // and reading it as the literal directory `{dist,build}` gave the
  // sandbox baseline a prefix that exists nowhere (2026-09-10).
  const wildcardIdx = glob.search(wildcards)
  // A LITERAL keeps its trailing slash through `normalizeGlob` on purpose
  // (`asTrees` is what turns `out/` into the tree `out` + `out/**`), but a
  // prefix with a slash on the end compares as a different string: `out/`
  // against `out/sub` found no overlap where `out` does. The prefix is a
  // directory either way. `/` is the root, not a trailing slash.
  if (wildcardIdx === -1) return glob === '/' ? '/' : glob.replace(/\/+$/, '')
  const head = glob.slice(0, wildcardIdx)
  const lastSep = head.lastIndexOf('/')
  if (lastSep === -1) return '.'
  return head.slice(0, lastSep) || '/'
}

/**
 * The directories a task's declared outputs cover WHOLE — every glob is
 * `<dir>/**` or a bare literal (which `asTrees` reads as the path or the
 * tree under it), with a plain, non-root, non-escaping `<dir>` — or `null`
 * when any glob is shaped otherwise. The directory-mtime short-circuit on a
 * warm hit (`Cache.outputDirsCurrent`) is sound only for whole subtrees:
 * with every directory under `<dir>` recorded, a file added or removed
 * anywhere the glob could see bumps a recorded directory's mtime (its
 * parent, or a new directory whose creation bumped a recorded ancestor). A
 * root-anchored `**\/*.js` has no such closed set, so it keeps the walk.
 * A literal that names a FILE is no directory: the snapshot refuses it
 * whole (`recordOutputDirs`) and that task keeps the walk too, so the
 * literal costs nothing it did not cost before; one that names a directory
 * gets the same stats a `<dir>/**` does (Next 27: an nx() output file
 * had to be `<dir>/**` to keep the short-circuit, and saved nothing).
 */
export function wholeSubtreePrefixes(globs: readonly string[]): string[] | null {
  if (globs.length === 0) return null
  const out: string[] = []
  for (const g of globs.map(normalizeGlob)) {
    const named = /^(.+?)\/\*\*$/.exec(g)?.[1] ?? g
    if (g.startsWith('!') || !namesOnePath(named)) return null
    // An escaped bracket names itself: `app/\[id\]/**` is the tree `app/[id]`.
    const dir = named.replace(/\\(.)/g, '$1').replace(/\/+$/, '')
    if (dir === '' || dir === '.' || dir.startsWith('/') || dir.split('/').includes('..'))
      return null
    out.push(dir)
  }
  return [...new Set(out)]
}

/**
 * The directories whose snapshot covers every path the positive `globs`
 * can match, or `null` when one reaches outside the project. A
 * whole-subtree glob or a literal is its own tree
 * ({@link wholeSubtreePrefixes}); any other glob is the tree under its
 * static prefix, and a root-anchored one (`**\/dist/**`, Turbo's shape) is
 * the whole project, `''`. Sound for the same reason: a file added or
 * removed anywhere under a recorded directory bumps a recorded mtime. The
 * snapshot's file list is then held to the entry's rows through the globs
 * themselves, so a source file beside the outputs is no stray.
 */
export function outputDirPrefixes(globs: readonly string[]): string[] | null {
  if (globs.length === 0) return null
  const dirs: string[] = []
  for (const g of globs) {
    const whole = wholeSubtreePrefixes([g])?.[0]
    if (whole !== undefined) {
      dirs.push(whole)
      continue
    }
    const prefix = staticPrefix(g)
    if (prefix === '.') return ['']
    if (prefix.startsWith('/') || prefix.startsWith('!') || prefix.split('/').includes('..'))
      return null
    dirs.push(prefix)
  }
  const sorted = [...new Set(dirs)].sort()
  return sorted.filter((d, i) => !sorted.slice(0, i).some((a) => d.startsWith(`${a}/`)))
}

/**
 * The spellings a reader, Turbo and `.gitignore` all accept but a matcher
 * fed the raw string turns into NOTHING — and a task keyed on nothing
 * replays old outputs as a green hit (2026-09-10, probed one by one):
 * a leading `./`, an inner `/./` segment, a doubled `//`, and a trailing
 * `/` on a pattern (`src/*\/` means the trees under `src`, so it becomes
 * `src/*\/**`; a trailing slash on a LITERAL is `asTrees`' job), and a
 * trailing `/.`, read as a trailing `/`. Applied
 * after an optional `!`; a bare `.` is the empty entry the schema refuses.
 */
export function normalizeGlob(glob: string): string {
  return normalizeWith(glob, GLOB_WILDCARDS)
}

/**
 * {@link normalizeGlob} for a glob in `Bun.Glob`'s own alphabet (a workspace
 * member glob, a sandbox grant): the same spellings, but `\[` stays escaped,
 * since there it is what keeps a bracket from opening a class.
 */
export function normalizeBunGlob(glob: string): string {
  return normalizeWith(glob, BUN_GLOB_WILDCARDS)
}

function normalizeWith(glob: string, wildcards: RegExp): string {
  const neg = glob.startsWith('!')
  let g = neg ? glob.slice(1) : glob
  g = g.replace(/\/{2,}/g, '/').replace(/(^|\/)(\.\/)+/g, '$1')
  // A trailing `/.` is the directory, as a trailing `/` is: `*/.` matched
  // no file and `!gen/.` took nothing back (2026-10-28).
  if (g.endsWith('/.')) g = g.slice(0, -1)
  if (g === '.') g = ''
  if (wildcards.test(g) && g.endsWith('/')) g = `${g.replace(/\/+$/, '')}/**`
  return neg ? `!${g}` : g
}

/**
 * True when a pattern carries no wildcard — it names exactly one path.
 *
 * The character SET is the whole content: in a task glob `*`, `?` and a
 * brace alternation are wildcards, so a pattern holding any of them must
 * be MATCHED, never compared as a string. It lives here, exported, because
 * four places asked the same question and one of them asked it with a
 * smaller set: `graph/task-graph.ts` omitted `{}`, so `dist/{a,b}.txt`
 * counted as a literal and the overlapping-output refusal compared it to
 * `dist/a.txt` as two unequal strings — the two tasks were accepted and
 * then deleted each other's outputs, green, every run (item 495). That is
 * the same divergence `asTrees` was moved here to end in item 442, and the
 * same one that removed `@vzn/vx-migrate`'s copy of `outputsOverlap` in
 * item 445.
 */
export function isLiteralPattern(glob: string): boolean {
  return !GLOB_WILDCARDS.test(glob)
}

/**
 * The alphabet of a TASK glob (`inputs.files`, `cache.outputs.files`,
 * `workspaceFiles`), behind {@link isLiteralPattern}, for the callers that
 * need the POSITION of the first wildcard rather than a verdict. Every site
 * that asks "must this declaration be matched?" reads this one regex: item
 * 495 found the fourth copy with a smaller set, and item 577 found the
 * class written out nine times — a spelling that drifts is how two guards
 * come to answer differently for one pattern.
 *
 * A task glob is a standard glob (2026-10-18): `[...]` is a character
 * class and `\[id\]` names the route directory `[id]`. An escape counts as
 * a wildcard too: such a pattern is matched by `Bun.Glob`, which reads the
 * escape, never compared as a string; `asTrees` still reads an escaped-only
 * pattern as one path.
 */
export const GLOB_WILDCARDS = /[*?{}[\]\\]/

/**
 * `Bun.Glob`'s own alphabet, for the globs vx does not own: package-manager
 * workspace members and `--filter` path globs follow npm/pnpm semantics,
 * and a sandbox grant's prefix must stop where the scan that expands the
 * grant (`Bun.Glob`, `MOUNT_WILDCARDS`) sees a wildcard.
 */
export const BUN_GLOB_WILDCARDS = /[*?[\]{}]/

/**
 * An extglob group: `!(…)`, `@(…)`, `+(…)`, `*(…)`, `?(…)`. npm, yarn,
 * Nx and Turbo read it; `Bun.Glob` had none before 1.4.4, and vx's own
 * matchers still read the group as literal text or as a plain wildcard.
 * A task input `src/@(x|y).ts` keyed
 * no file, so an edit to `src/x.ts` replayed a stale hit, and a member
 * glob `packages/!(x)` took in x (turborepo#3766). Every glob vx hands
 * `Bun.Glob` from a config refuses it.
 */
export const EXTGLOB = /[!@+*?]\(/

/** Compile a task glob for `Bun.Glob`. Every task glob is compiled here and nowhere else. */
export function taskGlob(pattern: string): Bun.Glob {
  const memo = memoFor(taskGlobs)
  let glob = memo.get(pattern)
  if (glob === undefined) memo.set(pattern, (glob = compileTaskGlob(pattern)))
  return glob
}

/**
 * Compiled once per pattern: a Turbo-mapped config repeats one 400-entry
 * list across two thousand tasks, and the graph's overlap checks compiled
 * each entry per task pair, 3.3 s of an astro plan (2026-10-09). A pattern
 * comes from a config, so the set is bounded by what the configs say. Kept
 * per `Bun.Glob` in force: a test swaps it, and a glob built by one is not
 * the other's.
 */
const taskGlobs = new WeakMap<object, Map<string, Bun.Glob>>()
const anyTaskGlobs = new WeakMap<object, Map<string, (rel: string) => boolean>>()

function memoFor<T>(memos: WeakMap<object, Map<string, T>>): Map<string, T> {
  let memo = memos.get(Bun.Glob)
  if (memo === undefined) memos.set(Bun.Glob, (memo = new Map()))
  return memo
}

function compileTaskGlob(pattern: string): Bun.Glob {
  const glob = new Bun.Glob(pattern)
  const alternatives = braceAlternatives(pattern)
  if (alternatives.length > 1) {
    const any = anyTaskGlob(alternatives)
    glob.match = (rel: string): boolean => any(rel)
    return glob
  }
  const re = regExpSource(pattern)
  if (re === null) return glob
  const compiled = new RegExp(`^${re}$`, 'u')
  const native = Object.getPrototypeOf(glob) as Bun.Glob
  // A path with a slash on the end names no file vx lists; `Bun.Glob` reads
  // it by rules of its own (`src/**` takes `src/`, never `src`). `scan`
  // stays `Bun.Glob`'s. Set on the instance, not by a subclass, so the glob
  // is built by whatever `Bun.Glob` is at the call.
  glob.match = (rel: string): boolean =>
    rel.endsWith('/') ? native.match.call(glob, rel) : compiled.test(rel)
  return glob
}

/**
 * Whether a path matches any of `patterns`, each a task glob: one compiled
 * RegExp for the lot when every pattern has one, else a glob each. An input
 * file was matched against a dozen globs (its positives, the always-ignored
 * list, its negatives) one native call at a time.
 *
 * A brace is expanded first, never matched by `Bun.Glob`: its match reads a
 * `**` that ends an alternative as one name, so `{src/**,lib/**}` took
 * `src/a.ts` and never `src/deep/a.ts`, and an edit there was a stale hit.
 */
export function anyTaskGlob(rawPatterns: readonly string[]): (rel: string) => boolean {
  const memo = memoFor(anyTaskGlobs)
  const key = rawPatterns.join('\0')
  let any = memo.get(key)
  if (any === undefined) memo.set(key, (any = compileAnyTaskGlob(rawPatterns)))
  return any
}

function compileAnyTaskGlob(rawPatterns: readonly string[]): (rel: string) => boolean {
  const patterns = rawPatterns.flatMap(braceAlternatives)
  if (patterns.length === 0) return () => false
  const sources = patterns.map(regExpSource)
  const globs = patterns.map(taskGlob)
  if (sources.every((r) => r !== null)) {
    const re = new RegExp(`^(?:${sources.join('|')})$`, 'u')
    return (rel) => (rel.endsWith('/') ? globs.some((g) => g.match(rel)) : re.test(rel))
  }
  return (rel) => globs.some((g) => g.match(rel))
}

const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|]/g

/**
 * The RegExp source of a task glob, matching what `Bun.Glob` matches
 * (`tests/util-paths.test.ts` holds the two to the same verdict on every
 * shape): `*` any run within a name, `?` one character, a `**` segment any
 * number of directories. Null for the syntax left to `Bun.Glob`: a brace,
 * a character class, an escape, a leading `!`, an empty, `.` or `..`
 * segment, a `**` inside a name, or two `**` segments in a row.
 */
function regExpSource(pattern: string): string | null {
  if (/[\\{}[\]]/.test(pattern) || pattern.startsWith('!')) return null
  const segments = pattern.split('/')
  let out = ''
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    const last = i === segments.length - 1
    if (seg === '**') {
      if (segments[i - 1] === '**') return null
      // A globstar is zero or more whole directories; at the end, one or
      // more names (`src/**` does not match `src`).
      if (segments.length === 1) out += '[^]*'
      else if (last) out += '/[^]+'
      else out += i === 0 ? '(?:[^]*/)?' : '/(?:[^]*/)?'
      continue
    }
    if (seg === '' || seg === '.' || seg === '..' || seg.includes('**')) return null
    if (i > 0 && segments[i - 1] !== '**') out += '/'
    out += seg.replace(REGEXP_SYNTAX, (c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : `\\${c}`))
  }
  return out
}

export function stripTrailingSlash(p: string): string {
  return p.replace(/\/+$/, '')
}

/**
 * A literal entry names a file OR a directory tree: `src/` and `src` both
 * mean everything under `src`, as they do in Turbo and every `.gitignore`.
 * A glob matcher sees only the literal path, so `['src/']` folded ZERO
 * files — a key that never moves with its source, and the most common
 * turbo.json shape (`"outputs": ["dist"]`) captured nothing. Every
 * literal therefore compiles to itself plus its subtree; a literal that
 * names a file still matches exactly that file, since `x/**` matches
 * nothing under a file.
 *
 * It lives in `util` rather than beside the resolver because it is not
 * only the resolver's rule. It decides what a clean DELETES, so the
 * graph's overlapping-output refusal has to read the same one: while it
 * did not, `dist` and `dist/app.js` compared as two unequal literals and
 * the run that wiped `dist/app.js` reported success (item 442). `graph`
 * may not import `cache`, and a second copy is how the two would
 * disagree — which is exactly what item 441 measured about
 * `staticPrefix`.
 *
 * A brace is expanded first and each alternative read alone: as one
 * pattern, `{src,lib}` never became the two trees and `{./src,lib}/**`
 * kept a `./` no git path holds, so an edit under either was a stale hit
 * and the same output glob saved an empty artifact.
 */
export function asTrees(patterns: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of patterns) {
    const alternatives = raw.includes('{') ? braceAlternatives(raw) : [raw]
    for (const alt of alternatives) {
      const p = normalizeGlob(alt)
      if (!namesOnePath(p)) {
        out.push(p)
        continue
      }
      const lit = stripTrailingSlash(p)
      if (lit.length === 0) continue
      out.push(lit, `${lit}/**`)
    }
  }
  // Two alternatives can fold to one entry (`{./src,src}`).
  return [...new Set(out)]
}

/**
 * The one path a task glob names, an escaped one included (`app/\[id\]`
 * names `app/[id]`), or null for a pattern.
 */
export function literalPath(glob: string): string | null {
  if (isLiteralPattern(glob)) return glob
  return isLiteralPattern(glob.replace(/\\./g, '_')) ? glob.replace(/\\(.)/g, '$1') : null
}

function namesOnePath(glob: string): boolean {
  return literalPath(glob) !== null
}

/**
 * An output list's positive globs, and what its `!` entries take back
 * (A-44). A reader that only needs where outputs MIGHT land (an overlap
 * refusal, a preliminary key) takes `positive` alone; one that decides
 * whether a path IS an output takes both, through `outputMatcher`.
 */
export function splitNegations(globs: readonly string[]): {
  positive: string[]
  negative: string[]
} {
  const positive: string[] = []
  const negative: string[] = []
  for (const g of globs) {
    if (g.startsWith('!')) negative.push(g.slice(1))
    else positive.push(g)
  }
  return { positive, negative }
}

/**
 * Whether a relative path is one of the outputs `globs` declare: a positive
 * glob selects it and no `!` entry takes it back. A `!` entry fed to a
 * matcher as-is would be `Bun.Glob`'s own negation, true of every OTHER
 * path (A-44).
 */
export function outputMatcher(globs: readonly string[]): (rel: string) => boolean {
  const { positive, negative } = splitNegations(globs)
  if (positive.length === 0) return () => false
  const pos = anyTaskGlob(asTrees(positive))
  const neg = anyTaskGlob(asTrees(negative))
  return (rel) => pos(rel) && !neg(rel)
}

/**
 * What no output glob reaches, relative to the project: its root's `.git`
 * and `.vx`, and the `vx.lock.json` beside its config. An output is
 * otherwise taken as written — `node_modules/**` IS an install task's
 * output — but a root project declaring `**` would otherwise wipe its
 * repository and the cache it is restoring from (2026-09-16), the clean
 * deleted an uncommitted workspace config, and a hit restored a lock or
 * ignore file the key does not see over the current one. Only where vx
 * writes them: reserved at any depth, a hit dropped a build's own
 * `dist/.git/**` and `dist/sub/vx.lock.json` (2026-10-17).
 */
const OUTPUT_NEVER = ['.git/**', '.vx/**', 'vx.lock.json']

/**
 * Whether vx may write or delete at `real`, a path a link on the way
 * resolved: under `realBase` and not in its `.git`, in any case (a
 * case-insensitive disk reads `.GIT` as `.git`). Names are held to
 * `OUTPUT_NEVER` lexically; this holds where a link lands
 * (vercel/turborepo#14808). Only the base's own: a deeper `.git` (a
 * submodule under `gen/**`, a build's `dist/.git`) is an output an entry
 * may name, and refused only once it existed on disk, a restore failed by
 * what the last run left.
 */
export function writableUnder(real: string, realBase: string): boolean {
  if (real === realBase) return true
  if (!real.startsWith(realBase + path.sep)) return false
  const top = real.slice(realBase.length + 1).split(path.sep, 1)[0]!
  return top.toLowerCase() !== '.git'
}

/**
 * `OUTPUT_NEVER` relative to the workspace root, for `outputs.workspaceFiles`:
 * those globs cross into other projects, and every project's `vx.lock.json`
 * is vx's.
 */
const WORKSPACE_OUTPUT_NEVER = [...OUTPUT_NEVER, '**/vx.lock.json']

/**
 * What `globs` may not reach in `scope`: its never-list, and every
 * `node_modules` unless a glob names one.
 */
export function outputNever(globs: readonly string[], scope: 'project' | 'workspace'): string[] {
  const never = scope === 'project' ? OUTPUT_NEVER : WORKSPACE_OUTPUT_NEVER
  return namesNodeModules(globs) ? never : [...never, '**/node_modules/**']
}

/** Whether a positive glob in `globs` names a `node_modules` directory. */
function namesNodeModules(globs: readonly string[]): boolean {
  return globs.some(
    (g) => !g.startsWith('!') && normalizeGlob(g).split('/').includes('node_modules'),
  )
}

/**
 * Whether a restore may write `rel`: one of the outputs `globs` declare,
 * never under `OUTPUT_NEVER`, and under `node_modules` only where a glob
 * names it — what the save side could have packed (`resolveOutputs`). An
 * artifact naming anything else was not written by this task's save, and
 * none of it is restored (2026-10-16).
 */
export function restorableOutput(
  globs: readonly string[],
  scope: 'project' | 'workspace' = 'project',
): (rel: string) => boolean {
  const isOutput = outputMatcher(globs)
  const never = anyTaskGlob(outputNever(globs, scope))
  return (rel) => isOutput(rel) && !never(rel)
}

/**
 * `pattern` with its first brace group expanded, recursively, while that
 * group holds a `/`; any other pattern as itself, since `Bun.Glob`
 * expands a slash-free brace on its own. An unbalanced or escaped brace
 * is left to the glob.
 */
export function slashBraceExpansions(pattern: string): string[] {
  return expandBraces(pattern, true)
}

/** `pattern` with every brace group of two or more alternatives, or a range, expanded. */
export function braceAlternatives(pattern: string): string[] {
  return expandBraces(pattern, false)
}

function expandBraces(pattern: string, slashOnly: boolean): string[] {
  if (pattern.includes('\\')) return [pattern]
  for (let open = pattern.indexOf('{'); open !== -1; open = pattern.indexOf('{', open + 1)) {
    let depth = 0
    const cuts: number[] = []
    let close = -1
    for (let i = open; i < pattern.length && close === -1; i++) {
      const c = pattern[i]
      if (c === '{') depth++
      else if (c === '}' && --depth === 0) close = i
      else if (c === ',' && depth === 1) cuts.push(i)
    }
    if (close === -1) return [pattern]
    const body = pattern.slice(open + 1, close)
    if (slashOnly && !body.includes('/')) continue
    const range = cuts.length === 0 ? braceRange(body) : null
    if (cuts.length === 0 && range === null) continue
    const head = pattern.slice(0, open)
    const tail = pattern.slice(close + 1)
    const bounds = [open, ...cuts, close]
    const alts = range ?? bounds.slice(1).map((end, k) => pattern.slice(bounds[k]! + 1, end))
    const out: string[] = []
    for (const alt of alts) out.push(...expandBraces(head + alt + tail, slashOnly))
    return [...new Set(out)]
  }
  return [pattern]
}

const NUMERIC_RANGE = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/
const LETTER_RANGE = /^(?:([a-z])\.\.([a-z])|([A-Z])\.\.([A-Z]))(?:\.\.(-?\d+))?$/
/** The most names a brace range may name: each is a glob vx compiles. */
export const BRACE_RANGE_LIMIT = 1024

/**
 * A brace range's names, as `Bun.Glob` reads them since 1.4.4 (bash's
 * rule): `1..3`, `3..1`, `01..03` padded, `a..c`, `1..10..3` stepped; null
 * for any other body, a mixed-case one (`A..c` spans `[`, `\` and `]`) and
 * one past `BRACE_RANGE_LIMIT`. vx expands it like a comma brace, so every matcher
 * names the files `Bun.Glob` does.
 */
export function braceRange(body: string): string[] | null {
  const num = NUMERIC_RANGE.exec(body)
  const letter = num === null ? LETTER_RANGE.exec(body) : null
  const m =
    num ?? (letter && [letter[0], letter[1] ?? letter[3], letter[2] ?? letter[4], letter[5]])
  if (m === null) return null
  const from = num ? Number(m[1]) : m[1]!.charCodeAt(0)
  const to = num ? Number(m[2]) : m[2]!.charCodeAt(0)
  const step = Math.abs(Number(m[3] ?? 1)) || 1
  if (Math.abs(to - from) / step >= BRACE_RANGE_LIMIT) return null
  const padded = num !== null && [m[1]!, m[2]!].some((n) => /^-?0\d/.test(n))
  const width = padded ? Math.max(m[1]!.length, m[2]!.length) : 0
  const out: string[] = []
  for (let i = from; from <= to ? i <= to : i >= to; i += from <= to ? step : -step) {
    if (!num) out.push(String.fromCharCode(i))
    else if (i < 0) out.push(`-${String(-i).padStart(width - 1, '0')}`)
    else out.push(String(i).padStart(width, '0'))
  }
  return out
}

/**
 * Whether a path git lists as UNTRACKED is an installed dependency: it sits
 * under a `node_modules` directory. Such a file is never an input, and the
 * enumeration drops it. A TRACKED file there (a committed test fixture) is
 * a source like any other: dropped by path, an edit to it was a stale hit.
 */
export function isInstalledPath(rel: string): boolean {
  return rel.startsWith('node_modules/') || rel.includes('/node_modules/')
}

// oxlint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g

/**
 * `s` with every C0/C1 control and DEL written as `\xNN`: a file name is
 * anyone's bytes, and one holding `ESC ]` or `\r` printed raw retitled
 * the terminal or overwrote the line vx printed before it (L-31).
 */
export function printable(s: string): string {
  return s.replace(CONTROL, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

/** Whether `s` holds a C0/C1 control or DEL, which `printable` would escape. */
export function hasControl(s: string): boolean {
  // oxlint-disable-next-line no-control-regex
  return /[\x00-\x1f\x7f-\x9f]/.test(s)
}
