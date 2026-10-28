# `src/util/paths.ts` — POSIX-path normalisation

## Purpose

Normalize path separators to forward slashes so a path in a cache key
has one spelling. Every platform vx runs on (Linux, macOS, Windows
through WSL) already separates with `/`, so `toPosix` returns its input
there. Used wherever a path participates in a cache key (input file
paths, output file paths, etc.).

## Public surface

```ts
export function toPosix(p: string): string
export function relPosix(from: string, to: string): string
// `.vx/.gitignore`'s text: vx's machine-local state stays out of git
export const DOT_VX_GITIGNORE = '/cache\n/tmp\n'
// `.vx/.gitattributes`'s text: GitHub collapses the machine lock in a diff
export const DOT_VX_GITATTRIBUTES = 'projects.lock.json linguist-generated=true\n'
export function normalizeGlob(glob: string): string
export function normalizeBunGlob(glob: string): string
export function staticPrefix(glob: string): string
export function grantPrefix(glob: string): string
export function wholeSubtreePrefixes(globs: readonly string[]): string[] | null
export function outputDirPrefixes(globs: readonly string[]): string[] | null
export function asTrees(patterns: readonly string[]): string[]
// An output list's positive globs and what its `!` entries take back, and
// the matcher that honours both: a `!` glob compiled as-is is Bun.Glob's own
// negation, true of every other path (A-44).
export function splitNegations(globs: readonly string[]): { positive: string[]; negative: string[] }
export function outputMatcher(globs: readonly string[]): (rel: string) => boolean
// What no output glob selects in `scope`: the project root's `.git`, `.vx`
// and `vx.lock.json` (the workspace's: every project's `vx.lock.json`), and
// `node_modules` unless a glob names it
export function outputNever(globs: readonly string[], scope: 'project' | 'workspace'): string[]
// What a restore may write: a declared output, never under `outputNever`
// (the save side's set)
export function restorableOutput(
  globs: readonly string[],
  scope?: 'project' | 'workspace',
): (rel: string) => boolean
export function isLiteralPattern(glob: string): boolean
export function stripTrailingSlash(p: string): string
export function taskGlob(pattern: string): Bun.Glob
export function anyTaskGlob(patterns: readonly string[]): (rel: string) => boolean
// A path inside an install (`node_modules/` at any depth): untracked, it is
// never an input; tracked, it is a source like any other (X-4).
export function isInstalledPath(rel: string): boolean
// A brace whose alternatives hold `/` expanded (Bun.Glob's scan skips one):
// workspace discovery and the output scan (A-10).
export function slashBraceExpansions(pattern: string): string[]
// Every brace group of two or more alternatives, or a range, expanded: where a gitignored
// input a brace names can be (`ignoredReach`)
export function braceAlternatives(pattern: string): string[]
// A brace range's names as Bun.Glob (1.4.4) reads them (`1..3`, `01..03`, `a..c`, `1..10..3`), or null
export function braceRange(body: string): string[] | null
export const BRACE_RANGE_LIMIT: number // 1024 — the most names a range may name
export const GLOB_WILDCARDS: RegExp // /[*?{}]/ — a task glob's wildcards
export const BUN_GLOB_WILDCARDS: RegExp // /[*?[\]{}]/ — Bun.Glob's own
// An extglob group, which vx's matchers do not read: refused in member and task globs (A-62).
export const EXTGLOB: RegExp // /[!@+*?]\(/
// C0/C1 controls and DEL as `\xNN`, for a file name vx prints (L-31).
export function printable(s: string): string
// Whether `s` holds a char `printable` escapes: a project or task name may not.
export function hasControl(s: string): boolean
// Whether vx may write or delete at `real`, where a link landed: under `realBase`, in no `.git`.
export function writableUnder(real: string, realBase: string): boolean
```

**Two alphabets.** A TASK glob (`inputs.files`, `cache.outputs.files`,
`workspaceFiles`) is a standard glob (2026-10-18): `[ab]` is a class and
`app/\[id\]/**` the route directory. `GLOB_WILDCARDS` is `Bun.Glob`'s set
plus the backslash: an escaped pattern is matched, never compared as a
string, and `literalPath` reads one that names a single path
(`app/\[id\]` → `app/[id]`) for `asTrees`, `wholeSubtreePrefixes` and the
overlap refusal; `staticPrefix` unescapes its head. The globs vx does not
own keep `Bun.Glob`'s grammar: package-manager member globs
(`normalizeBunGlob`, `BUN_GLOB_WILDCARDS`), `--filter` path globs, and a
sandbox grant's prefix (`grantPrefix`), which must stop where the scan
that expands the grant sees a wildcard.

- `toPosix(p)` — replaces every `path.sep` with `/`.
- `relPosix(from, to)` — `path.relative(from, to)` then `toPosix`.
- `normalizeGlob(g)` — the spellings a reader accepts but a matcher turns
  into nothing: a leading `./`, an inner `/./`, a doubled `//`, a trailing
  `/` on a pattern (→ `/**`); after an optional `!`. The one rule behind
  the input/output resolver (`asTrees`), the watch loop's output
  containers, the subtree short-circuit and the schema's "names the
  directory itself" refusal (2026-09-10). An escape stays as written.
- `normalizeBunGlob(g)` — the same spellings for a glob in `Bun.Glob`'s
  own alphabet (the workspace member globs, a sandbox grant): `\[`
  stays escaped, since there it is what keeps a bracket from opening a
  class.
- `staticPrefix(g)` — the wildcard-free head of a glob, whole components
  only; a brace set counts as a wildcard, and a literal's trailing slash
  is dropped (the prefix is a directory either way). Normalizes the
  spelling FIRST — sharing the function was not enough to make its
  callers agree, because the sandbox joins the prefix onto a directory
  and `path.join` folds `./`, `//` and `/./` on the way while the
  deferral gate compares the strings raw (item 441). Shared by the
  deferral gate, the restore tier, the stable-key reach and the watch
  loop's output container.
- `grantPrefix(g)` — `staticPrefix` in `Bun.Glob`'s alphabet, for a
  sandbox write grant: the sandbox baseline's directory, and the
  directory the empty-grant warning names.
- `wholeSubtreePrefixes(globs)` — the `<dir>/**` directories a task's
  outputs cover whole, or `null`; normalizes first.
- `outputDirPrefixes(globs)` — the directories whose snapshot covers every
  path the globs can match: a whole subtree or literal as itself, any other
  glob as the tree under its static prefix, a root-anchored one
  (`**/dist/**`) as the whole project `''`; `null` when one leaves the
  project. Behind the warm hit's directory proof.
- `asTrees(patterns)` — a literal entry is the file OR its whole tree, so
  every literal compiles to itself plus `<path>/**`. It lives here, not
  beside the resolver, because it is not only the resolver's rule: it
  decides what a clean DELETES, so `graph`'s overlapping-output refusal
  has to read the same one, and `graph` may not import `cache` (item
  442). Re-exported by `cache/index.ts`, which is still its contract for
  the resolver.
- `isLiteralPattern(g)` — true when a task pattern carries no wildcard,
  so it names exactly one path and may be compared as a STRING; anything
  holding `*`, `?`, a class, a brace alternation or an escape must be
  MATCHED instead. The character set is the whole content, and it lives
  here for the reason `asTrees` does: four places asked this question and
  `graph/task-graph.ts` asked it without `{}`, so `dist/{a,b}.txt`
  counted as a literal and the overlapping-output refusal compared it to
  `dist/a.txt` as two unequal strings — the two tasks were accepted and
  then deleted each other's outputs, green, every run (item 495).
- `literalPath(g)` — the one path a task glob names, an escaped one
  included, or null for a pattern.
- `taskGlob(p)` — compile a task glob for `Bun.Glob`, memoised. Its
  `match` is a RegExp of the same verdict when the pattern has no brace,
  class, escape, leading `!`, empty
  or dot segment: a JS test, not a native call.
- `anyTaskGlob(ps)` — whether a path matches any of the task globs: one
  RegExp for the lot when each has one. An input file is tested once per
  side (positives, excludes), not once per glob.

## Why

A key folds paths, so a path must have one spelling: a walk that
yielded `src\index.ts` where another yielded `src/index.ts` would key
the same task twice. vx runs only where the separator is `/` (native
Windows is not supported; use WSL), so the conversion is a fast-path
no-op today, and costs nothing to keep.

## Tests

`tests/util-paths.test.ts` (each helper, incl. the spellings
`staticPrefix` folds), `tests/dot-slash-globs.test.ts`
(the spellings `normalizeGlob` folds, end to end), `tests/output-dirs.test.ts`
(`outputDirPrefixes` behind the directory proof) and
`tests/watch-rules.test.ts` (`staticPrefix` behind the output
container), `tests/task-glob-brackets.test.ts` (a class, and an escaped
route directory through inputs, outputs, `workspaceFiles`, `--affected`
and the additive hit); transitively through `tests/cache.test.ts` (cache-key
determinism) and `tests/inputs.test.ts` (glob result shapes).
