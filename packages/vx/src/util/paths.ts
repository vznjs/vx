import path from 'node:path'

const IS_POSIX = path.sep === '/'

/** Convert a path to POSIX-style for cross-platform stable cache keys. */
export function toPosix(p: string): string {
  // Fast path: on Linux/macOS the separator is already '/', and this runs for
  // every input file of every key.
  return IS_POSIX ? p : p.split(path.sep).join('/')
}

/**
 * `.vx/.gitignore`: git ignores `.vx/cache` and `.vx/tmp` and nothing else, so
 * the workspace config and lock are committed. `vx init` and the cache write it
 * when missing.
 */
export const DOT_VX_GITIGNORE = '/cache\n/tmp\n'

/** `.vx/.gitattributes`' text: GitHub collapses the machine lock in a diff. */
export const DOT_VX_GITATTRIBUTES = 'projects.lock.json linguist-generated=true\n'

export function relPosix(from: string, to: string): string {
  return toPosix(path.relative(from, to))
}

/**
 * The leading wildcard-free part of a glob, cut to whole components
 * (`dist/sub-**` → `dist`); `.` when the first component is a wildcard.
 *
 * Shared by the sandbox (a write prefix) and the deferral gate (overlap of two
 * prefixes), so they agree on what a prefix is. The spelling is normalized here
 * first: the sandbox's `path.join` folds `./` and `//` while the gate compared
 * raw strings, so `./out/**` and `out/**` were one tree to the sandbox and two
 * prefixes to the gate, which deferred a producer a reader's key could see.
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
 * {@link staticPrefix} in `Bun.Glob`'s alphabet, for a sandbox grant: the scan
 * expanding it reads `[ab]` as a class, so the prefix stops there, or `write:
 * ['g/[ab].txt']` created a directory of that name.
 */
export function grantPrefix(rawGlob: string): string {
  return prefixOf(normalizeBunGlob(rawGlob), BUN_GLOB_WILDCARDS)
}

function prefixOf(glob: string, wildcards: RegExp): string {
  // A brace set is a wildcard too: `{dist,build}` as a literal dir is a prefix
  // that exists nowhere.
  const wildcardIdx = glob.search(wildcards)
  // A literal keeps its trailing slash through `normalizeGlob` (`asTrees` needs
  // it), but `out/` against `out/sub` found no overlap where `out` does. `/` is
  // the root.
  if (wildcardIdx === -1) return glob === '/' ? '/' : glob.replace(/\/+$/, '')
  const head = glob.slice(0, wildcardIdx)
  const lastSep = head.lastIndexOf('/')
  if (lastSep === -1) return '.'
  return head.slice(0, lastSep) || '/'
}

/**
 * The directories a task's outputs cover whole (every glob `<dir>/**` or a bare
 * literal, with a plain, non-root, non-escaping dir), or null. The warm hit's
 * directory-mtime short-circuit (`Cache.outputDirsCurrent`) is sound only for
 * whole subtrees: any add or remove under them bumps a recorded mtime. A
 * root-anchored `**\/*.js` keeps the walk. A literal naming a file is refused
 * by the snapshot (`recordOutputDirs`) and keeps the walk too; one naming a
 * directory gets the same stats as `<dir>/**`.
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
 * The directories whose snapshot covers every path the positive `globs` can
 * match, or null when one leaves the project: a whole subtree or literal is its
 * own tree, other globs the tree under their static prefix, a root-anchored one
 * the whole project (`''`). The snapshot's file list is held to the entry's
 * rows through the globs, so a source file beside outputs is no stray.
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
 * Spellings readers, Turbo and `.gitignore` accept but a raw matcher turns into
 * nothing (a task keyed on nothing replays old outputs green): leading `./`,
 * inner `/./`, doubled `//`, a trailing `/` on a pattern (`src/*\/` becomes
 * `src/*\/**`; a literal's is `asTrees`'), and trailing `/.`. After an optional
 * `!`; a bare `.` is refused by the schema.
 */
export function normalizeGlob(glob: string): string {
  return normalizeWith(glob, GLOB_WILDCARDS)
}

/**
 * {@link normalizeGlob} in `Bun.Glob`'s alphabet (member globs, grants): `\[`
 * stays escaped, since there it keeps a bracket from opening a class.
 */
export function normalizeBunGlob(glob: string): string {
  return normalizeWith(glob, BUN_GLOB_WILDCARDS)
}

function normalizeWith(glob: string, wildcards: RegExp): string {
  const neg = glob.startsWith('!')
  let g = neg ? glob.slice(1) : glob
  g = g.replace(/\/{2,}/g, '/').replace(/(^|\/)(\.\/)+/g, '$1')
  // A trailing `/.` is the directory, as a trailing `/` is: `*/.` matched no
  // file and `!gen/.` took nothing back.
  if (g.endsWith('/.')) g = g.slice(0, -1)
  if (g === '.') g = ''
  if (wildcards.test(g) && g.endsWith('/')) g = `${g.replace(/\/+$/, '')}/**`
  return neg ? `!${g}` : g
}

/**
 * True when a pattern has no wildcard and names one path. One copy for every
 * caller: graph/task-graph.ts once omitted `{}`, so `dist/{a,b}.txt` compared
 * unequal to `dist/a.txt` and two tasks deleted each other's outputs, green.
 */
export function isLiteralPattern(glob: string): boolean {
  return !GLOB_WILDCARDS.test(glob)
}

/**
 * A task glob's alphabet (`inputs.files`, `outputs.files`, `workspaceFiles`)
 * for callers needing the first wildcard's position: one regex, so guards
 * cannot disagree. `[...]` is a class and `\[id\]` names `[id]`; an escape
 * counts as a wildcard (matched by `Bun.Glob`, never compared as a string),
 * though `asTrees` reads an escaped-only pattern as one path.
 */
export const GLOB_WILDCARDS = /[*?{}[\]\\]/

/**
 * A path as a task glob naming it alone, in a spelling the config check
 * accepts. `*` and `?` become classes (`\*` reads as a Windows separator); a
 * leading `!` is escaped, or it is a negation; a space at either end becomes a
 * class, which the whitespace check spares.
 */
export function taskGlobOf(rel: string): string {
  return rel
    .replace(new RegExp(GLOB_WILDCARDS.source, 'g'), (c) =>
      c === '*' || c === '?' ? `[${c}]` : `\\${c}`,
    )
    .replace(/^!/, '\\!')
    .replace(/^\s+|\s+$/g, (ws) => ws.replace(/\s/g, '[$&]'))
}

/**
 * `Bun.Glob`'s alphabet, for globs vx does not own: workspace members and
 * `--filter` paths follow npm/pnpm, and a grant's prefix stops where
 * `Bun.Glob`'s scan sees a wildcard.
 */
export const BUN_GLOB_WILDCARDS = /[*?[\]{}]/

/**
 * An extglob group (`!(…)`, `@(…)`, `+(…)`, `*(…)`, `?(…)`): npm, yarn, Nx and
 * Turbo read it, but vx's matchers read it as text or a plain wildcard, so
 * `src/@(x|y).ts` keyed nothing and `packages/!(x)` took in x (turborepo#3766).
 * Refused in every config glob vx hands `Bun.Glob`.
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
 * Compiled once per pattern: a Turbo-mapped config repeats one 400-entry list
 * across thousands of tasks, and per-pair compiles were 3.3 s of an astro plan.
 * Bounded by what configs say. Kept per `Bun.Glob` in force, since a test swaps
 * it.
 */
const taskGlobs = new WeakMap<object, Map<string, Bun.Glob>>()
const anyTaskGlobs = new WeakMap<object, Map<string, (rel: string) => boolean>>()

function memoFor<T>(memos: WeakMap<object, Map<string, T>>): Map<string, T> {
  let memo = memos.get(Bun.Glob)
  if (memo === undefined) memos.set(Bun.Glob, (memo = new Map()))
  return memo
}

function compileTaskGlob(pattern: string): Bun.Glob {
  const glob = new Bun.Glob(scannable(pattern))
  const alternatives = braceAlternatives(pattern)
  if (alternatives.length > 1) {
    const any = anyTaskGlob(alternatives)
    glob.match = (rel: string): boolean => any(rel)
    return glob
  }
  const re = regExpSource(pattern)
  if (re === null) {
    const own = new Bun.Glob(rewriteGlob(pattern, false))
    glob.match = (rel: string): boolean => own.match(rel)
    return glob
  }
  const compiled = new RegExp(`^${re}$`, 'u')
  const native = Object.getPrototypeOf(glob) as Bun.Glob
  // A path ending in a slash names no file vx lists; `Bun.Glob` has its own
  // rules for it. Set on the instance, so the glob comes from whatever
  // `Bun.Glob` is at the call.
  glob.match = (rel: string): boolean =>
    rel.endsWith('/') ? native.match.call(glob, rel) : compiled.test(rel)
  return glob
}

/**
 * `pattern` as `Bun.Glob`'s scan must read it. Each `\]`, `\}` and `\\` outside
 * a class becomes a one-character class: in a wildcard-free segment the scan
 * read them as backslash plus character, so `dist/\]b` saved nothing and a hit
 * deleted `dist/]b`. Each `!` outside a class is escaped: the scan reads a
 * name-leading one as negation. Never an entry's own `!`.
 */
export function scannable(pattern: string): string {
  if (!/\\[\]}\\]|!/.test(pattern)) return pattern
  return rewriteGlob(pattern, true)
}

/**
 * `pattern` in the spelling `Bun.Glob`'s readings share with task globs: `!`
 * outside a class is literal (a leading brace alternative `{x,!a}` matched
 * every path), and a negated class never takes `/` (`gen[!.]*` took
 * `gen/notes.txt` and a clean deleted it). Plus {@link scannable}'s class
 * spellings.
 */
function rewriteGlob(pattern: string, scan: boolean): string {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '\\' && i + 1 < pattern.length) {
      const next = pattern[++i]!
      out += scan && ']}\\'.includes(next) ? `[${next === '\\' ? '\\\\' : next}]` : c + next
    } else if (c === '!') out += '\\!'
    else if (c === '[') {
      // As `Bun.Glob` reads a class: `!` or `^` negates, a `]` first is a
      // member, and a `[` with no close is the character.
      let body = i + 1
      const negated = pattern[body] === '!' || pattern[body] === '^'
      if (negated) body++
      let end = pattern[body] === ']' ? body + 1 : body
      while (end < pattern.length && pattern[end] !== ']') end += pattern[end] === '\\' ? 2 : 1
      if (end >= pattern.length) {
        out += c
        continue
      }
      let members = pattern.slice(body, end)
      if (negated && !scan) {
        // Appended last; a `-` before it would make a range ending at `/`.
        const dash = /(?:^|[^\\])(?:\\\\)*-$/.test(members)
        members = `${dash ? `${members.slice(0, -1)}\\-` : members}/`
      }
      out += pattern.slice(i, body) + members + ']'
      i = end
    } else out += c
  }
  return out
}

/**
 * Whether a path matches any task glob: one compiled RegExp for all when each
 * has one, else a glob each (a native call per glob per file was slow).
 *
 * Braces are expanded first, never matched by `Bun.Glob`, which read a `**`
 * ending an alternative as one name: `{src/**,lib/**}` missed `src/deep/a.ts`,
 * a stale hit.
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
  if (!sources.every((r) => r !== null)) return (rel) => globs.some((g) => g.match(rel))
  // `**/` alternatives each opened with their own prefix, retried at every
  // slash: 1,000 globs over 200,000 paths took 24 s; one shared prefix, 50 ms.
  const deep: string[] = []
  const rest: string[] = []
  for (const s of sources as string[]) {
    if (s.startsWith(LEADING_GLOBSTAR)) deep.push(s.slice(LEADING_GLOBSTAR.length))
    else rest.push(s)
  }
  const res = alternations(rest)
  for (let i = 0; i < deep.length; i += ALTERNATIVES_PER_REGEXP) {
    const part = deep.slice(i, i + ALTERNATIVES_PER_REGEXP)
    res.push(new RegExp(`^${LEADING_GLOBSTAR}(?:${part.join('|')})$`, 'u'))
  }
  if (res.length === 1) {
    const re = res[0]!
    return (rel) => (rel.endsWith('/') ? globs.some((g) => g.match(rel)) : re.test(rel))
  }
  return (rel) =>
    rel.endsWith('/') ? globs.some((g) => g.match(rel)) : res.some((re) => re.test(rel))
}

/**
 * Alternatives per RegExp: Bun's engine falls off a cliff past a few thousand
 * (8,000 literal alternatives: 15 s over 200k paths). Below it, splitting costs
 * nothing.
 */
const ALTERNATIVES_PER_REGEXP = 1000

function alternations(sources: readonly string[]): RegExp[] {
  const out: RegExp[] = []
  for (let i = 0; i < sources.length; i += ALTERNATIVES_PER_REGEXP) {
    const part = sources.slice(i, i + ALTERNATIVES_PER_REGEXP)
    out.push(new RegExp(`^(?:${part.join('|')})$`, 'u'))
  }
  return out
}

/** What {@link regExpSource} writes for a leading `**` segment. */
const LEADING_GLOBSTAR = '(?:[^]*/)?'

const REGEXP_SYNTAX = /[\\^$.*+?()[\]{}|]/g

/**
 * The RegExp source of a task glob, matching what `Bun.Glob` matches
 * (`tests/util-paths.test.ts` holds them equal): `*` within a name, `?` one
 * character, a `**` segment any depth, `!` literal. Null for syntax left to
 * `Bun.Glob`: braces, classes, escapes, empty/`.`/`..` segments, `**` inside a
 * name, consecutive `**`.
 */
function regExpSource(pattern: string): string | null {
  if (/[\\{}[\]]/.test(pattern)) return null
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
      else out += i === 0 ? LEADING_GLOBSTAR : `/${LEADING_GLOBSTAR}`
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
 * A literal names a file or a tree: `src/` and `src` both mean everything under
 * `src`, as in Turbo and `.gitignore`. A raw matcher folded zero files for
 * `['src/']` and captured nothing for `"outputs": ["dist"]`. So each literal
 * compiles to itself plus its subtree (`x/**` matches nothing under a file).
 *
 * In `util` because it also decides what a clean deletes, so the graph's
 * overlap refusal reads the same rule: `dist` and `dist/app.js` compared
 * unequal and the run wiping `dist/app.js` passed.
 *
 * Braces expand first, each alternative read alone, or `{src,lib}` never became
 * two trees.
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
 * An output list's positive globs and its `!` take-backs. Where outputs might
 * land needs `positive`; whether a path is an output needs both
 * (`outputMatcher`).
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
 * Whether a path is a declared output: a positive glob selects it and no `!`
 * takes it back. A raw `!` in a matcher is `Bun.Glob`'s negation, true of every
 * other path.
 */
export function outputMatcher(globs: readonly string[]): (rel: string) => boolean {
  const { positive, negative } = splitNegations(globs)
  if (positive.length === 0) return () => false
  const pos = anyTaskGlob(asTrees(positive))
  const neg = anyTaskGlob(asTrees(negative))
  return (rel) => pos(rel) && !neg(rel)
}

/**
 * What no output glob reaches: the project root's `.git` and `.vx`, and the
 * `vx.lock.json` beside its config. A root project declaring `**` would wipe
 * its repository and cache, a clean deleted an uncommitted workspace config,
 * and a hit restored a lock over the current one. Only where vx writes them: at
 * any depth, a hit dropped a build's own `dist/.git/**`.
 */
const OUTPUT_NEVER = ['.git/**', '.vx/**', 'vx.lock.json']

/**
 * Whether vx may write or delete at `real` (a path a link resolved): under
 * `realBase` and not in its `.git`, case-insensitively. `OUTPUT_NEVER` holds
 * names lexically; this holds where a link lands (vercel/turborepo#14808). Only
 * the base's own: a deeper `.git` may be a declared output.
 */
export function writableUnder(real: string, realBase: string): boolean {
  if (real === realBase) return true
  if (!real.startsWith(realBase + path.sep)) return false
  const top = real.slice(realBase.length + 1).split(path.sep, 1)[0]!
  return top.toLowerCase() !== '.git'
}

/**
 * `OUTPUT_NEVER` from the workspace root, for `outputs.workspaceFiles`, which
 * cross projects.
 */
const WORKSPACE_OUTPUT_NEVER = [...OUTPUT_NEVER, '**/vx.lock.json']

/**
 * Whether `globs` may not reach `rel`: its never-list, and a `node_modules` no
 * glob owns. A glob naming one owns every one (an install task); a project glob
 * owns those under its literal dir (`.output/server/node_modules/**`). One
 * reaching them by wildcard alone (`**\/*.js`) never does: its clean deleted
 * every installed `.js`. Save, restore and clean all ask this.
 */
export function outputExcluded(
  globs: readonly string[],
  scope: 'project' | 'workspace',
): (rel: string) => boolean {
  const never = anyTaskGlob(scope === 'project' ? OUTPUT_NEVER : WORKSPACE_OUTPUT_NEVER)
  if (namesNodeModules(globs)) return never
  const installed = anyTaskGlob(['**/node_modules/**'])
  const owners =
    scope === 'workspace'
      ? []
      : asTrees(splitNegations(globs).positive).flatMap((g) => {
          const base = staticPrefix(g)
          if (base === '.' || base === '/') return []
          const match = anyTaskGlob([g])
          return [(rel: string) => rel.startsWith(`${base}/`) && match(rel)]
        })
  return (rel) => never(rel) || (installed(rel) && !owners.some((own) => own(rel)))
}

/** Whether a positive glob in `globs` names a `node_modules` directory. */
function namesNodeModules(globs: readonly string[]): boolean {
  return globs.some(
    (g) => !g.startsWith('!') && normalizeGlob(g).split('/').includes('node_modules'),
  )
}

/**
 * Whether a restore may write `rel`: a declared output not `outputExcluded`,
 * what the save could have packed. Anything else in an artifact is not
 * restored.
 */
export function restorableOutput(
  globs: readonly string[],
  scope: 'project' | 'workspace' = 'project',
): (rel: string) => boolean {
  const isOutput = outputMatcher(globs)
  const excluded = outputExcluded(globs, scope)
  return (rel) => isOutput(rel) && !excluded(rel)
}

/**
 * The root dir of a `<dir>/**` glob, else undefined. The glob does not match
 * its root, yet a task leaving `public/uploads/` empty made it: a save keeps
 * that root, so a hit makes it too.
 */
export function treeRoot(pattern: string): string | undefined {
  if (!pattern.endsWith('/**')) return undefined
  const root = pattern.slice(0, -3)
  return root.length > 0 && staticPrefix(pattern) === root ? root : undefined
}

/**
 * Whether a restore may make the empty directory `rel`: one
 * `restorableOutput` takes, or the root of a `<dir>/**` glob (`treeRoot`).
 */
export function restorableOutputDir(
  globs: readonly string[],
  scope: 'project' | 'workspace' = 'project',
): (rel: string) => boolean {
  const take = restorableOutput(globs, scope)
  const { positive, negative } = splitNegations(globs)
  const roots = new Set(asTrees(positive).flatMap((g) => treeRoot(g) ?? []))
  if (roots.size === 0) return take
  const excluded = outputExcluded(globs, scope)
  const back = anyTaskGlob(asTrees(negative))
  return (rel) => take(rel) || (roots.has(rel) && !excluded(rel) && !back(rel))
}

/**
 * `pattern` with its first brace group expanded, recursively, while the group
 * holds a `/`; `Bun.Glob` expands slash-free braces itself. Unbalanced or
 * escaped braces are left alone.
 */
export function slashBraceExpansions(pattern: string): string[] {
  return expandBraces(pattern, true)
}

/** `pattern` with every brace group of two or more alternatives, or a range, expanded. */
export function braceAlternatives(pattern: string): string[] {
  return expandBraces(pattern, false)
}

/**
 * Where a `[`…`]` class opening at `i` ends, as `bracket-literal.ts` reads one;
 * `i` for a `[` with no `]`. `,` `{` `}` inside a class are members: split
 * there, `src/{a[,]b,x}.ts` broke apart (turborepo#13763).
 */
function classEnd(pattern: string, i: number): number {
  const end = pattern.indexOf(']', i + 2)
  return end === -1 ? i : end
}

// A `\x` is one character to both scans and stays in its alternative. Expansion
// stopped at any escape, so `{src,app/\[id\]}` named neither tree.
function expandBraces(pattern: string, slashOnly: boolean): string[] {
  for (let open = 0; open < pattern.length; open++) {
    if (pattern[open] === '\\') {
      open++
      continue
    }
    if (pattern[open] === '[') {
      open = classEnd(pattern, open)
      continue
    }
    if (pattern[open] !== '{') continue
    let depth = 0
    const cuts: number[] = []
    let close = -1
    for (let i = open; i < pattern.length && close === -1; i++) {
      const c = pattern[i]
      if (c === '\\') i++
      else if (c === '[') i = classEnd(pattern, i)
      else if (c === '{') depth++
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

/**
 * How many alternatives a pattern expands to, counted without expanding, capped
 * at `cap + 1`: twenty `{a,b}` groups are a million. Duplicates count: an upper
 * bound.
 */
export function braceExpansionCount(pattern: string, cap: number): number {
  for (let open = 0; open < pattern.length; open++) {
    if (pattern[open] === '\\') {
      open++
      continue
    }
    if (pattern[open] === '[') {
      open = classEnd(pattern, open)
      continue
    }
    if (pattern[open] !== '{') continue
    let depth = 0
    const cuts: number[] = []
    let close = -1
    for (let i = open; i < pattern.length && close === -1; i++) {
      const c = pattern[i]
      if (c === '\\') i++
      else if (c === '[') i = classEnd(pattern, i)
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) close = i
      else if (c === ',' && depth === 1) cuts.push(i)
    }
    if (close === -1) return 1
    const range = cuts.length === 0 ? braceRange(pattern.slice(open + 1, close)) : null
    if (cuts.length === 0 && range === null) continue
    const bounds = [open, ...cuts, close]
    let alts = range?.length ?? 0
    for (let k = 1; range === null && k < bounds.length && alts <= cap; k++)
      alts += braceExpansionCount(pattern.slice(bounds[k - 1]! + 1, bounds[k]), cap)
    return Math.min(cap + 1, alts * braceExpansionCount(pattern.slice(close + 1), cap))
  }
  return 1
}

const NUMERIC_RANGE = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/
const LETTER_RANGE = /^(?:([a-z])\.\.([a-z])|([A-Z])\.\.([A-Z]))(?:\.\.(-?\d+))?$/
/** The most names a brace range may name: each is a glob vx compiles. */
export const BRACE_RANGE_LIMIT = 1024

/**
 * A brace range's names as `Bun.Glob` reads them since 1.4.4 (bash's rule:
 * `1..3`, `01..03`, `a..c`, `1..10..3`); null for anything else, mixed case
 * (`A..c` spans punctuation) or past `BRACE_RANGE_LIMIT`. Expanded like a comma
 * brace so every matcher agrees with `Bun.Glob`.
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
 * Whether an untracked path is an installed dependency (under `node_modules`):
 * never an input. A tracked file there (a fixture) is a source: dropped by
 * path, its edit was a stale hit.
 */
export function isInstalledPath(rel: string): boolean {
  return rel.startsWith('node_modules/') || rel.includes('/node_modules/')
}

// oxlint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g

/**
 * `s` with every C0/C1 control and DEL as `\xNN`: a file name is anyone's
 * bytes, and `ESC ]` or `\r` printed raw retitled the terminal or overwrote a
 * line.
 */
export function printable(s: string): string {
  return s.replace(CONTROL, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

/** Whether `s` holds a C0/C1 control or DEL, which `printable` would escape. */
export function hasControl(s: string): boolean {
  // oxlint-disable-next-line no-control-regex
  return /[\x00-\x1f\x7f-\x9f]/.test(s)
}
