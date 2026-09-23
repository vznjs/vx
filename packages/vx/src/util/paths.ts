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
  return prefixOf(normalizeGlob(rawGlob), GLOB_WILDCARDS)
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
    const m = /^([^*?{}!]+?)\/\*\*$/.exec(g)
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
  if (g === '.') g = ''
  // Where a bracket is literal, Turbo's escaped spelling `\[id\]` names the
  // same path as `[id]`; one spelling is what lets every literal fast path
  // (string compare, `settleLiterals`, `asTrees`) see it as a literal.
  if (wildcards === GLOB_WILDCARDS && g.includes('\\')) g = g.replace(/\\([[\]])/g, '$1')
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
 * The alphabet of a TASK glob (`cache.inputs.files`, `cache.outputs.files`,
 * `workspaceFiles`), behind {@link isLiteralPattern}, for the callers that
 * need the POSITION of the first wildcard rather than a verdict. Every site
 * that asks "must this declaration be matched?" reads this one regex: item
 * 495 found the fourth copy with a smaller set, and item 577 found the
 * class written out nine times — a spelling that drifts is how two guards
 * come to answer differently for one pattern.
 *
 * `[` and `]` are NOT in it: a bracket is a literal character in a task
 * glob, and there are no character classes (item 667). Route directories
 * are named `[id]` across Next.js, SvelteKit and Astro, and read as a class
 * `app/[id]/**` matched `app/i/…` and `app/d/…` and never the route: the
 * file never entered the key (a stale hit) and the output clean deleted an
 * unrelated `app/i/page.js`. {@link taskGlob} is how such a glob reaches
 * `Bun.Glob`, whose own alphabet still reads the class.
 */
export const GLOB_WILDCARDS = /[*?{}]/

/**
 * `Bun.Glob`'s own alphabet, the class included, for the globs vx does not
 * own: package-manager workspace members and `--filter` path globs follow
 * npm/pnpm semantics, and a sandbox grant's prefix must stop where the scan
 * that expands the grant (`Bun.Glob`, `MOUNT_WILDCARDS`) sees a wildcard.
 */
export const BUN_GLOB_WILDCARDS = /[*?[\]{}]/

/**
 * Compile a task glob for `Bun.Glob`, with every bare bracket escaped so it
 * matches itself (item 667). Every task glob is compiled here and nowhere
 * else: one site that forgot is a route directory that keys nothing.
 */
export function taskGlob(pattern: string): Bun.Glob {
  // A `]` with no `[` before it is already literal to `Bun.Glob`.
  if (!pattern.includes('[')) return new Bun.Glob(pattern)
  return new Bun.Glob(pattern.replace(/(?<!\\)[[\]]/g, '\\$&'))
}

function stripTrailingSlash(p: string): string {
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
 */
export function asTrees(patterns: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of patterns) {
    const p = normalizeGlob(raw)
    if (!isLiteralPattern(p)) {
      out.push(p)
      continue
    }
    const lit = stripTrailingSlash(p)
    if (lit.length === 0) continue
    out.push(lit, `${lit}/**`)
  }
  return out
}
