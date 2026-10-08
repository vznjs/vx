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
export function normalizeGlob(glob: string): string
export function normalizeBunGlob(glob: string): string
export function staticPrefix(glob: string): string
export function grantPrefix(glob: string): string
export function wholeSubtreePrefixes(globs: readonly string[]): string[] | null
export function asTrees(patterns: readonly string[]): string[]
// An output list's positive globs and what its `!` entries take back, and
// the matcher that honours both: a `!` glob compiled as-is is Bun.Glob's own
// negation, true of every other path (A-44).
export function splitNegations(globs: readonly string[]): { positive: string[]; negative: string[] }
export function outputMatcher(globs: readonly string[]): (rel: string) => boolean
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
export const GLOB_WILDCARDS: RegExp // /[*?{}]/ — a task glob's wildcards
export const BUN_GLOB_WILDCARDS: RegExp // /[*?[\]{}]/ — Bun.Glob's own
// An extglob group, which Bun.Glob cannot read: refused in member and task globs (A-62).
export const EXTGLOB: RegExp // /[!@+*?]\(/
// C0/C1 controls and DEL as `\xNN`, for a file name vx prints (L-31).
export function printable(s: string): string
```

**Two alphabets (item 667).** In a TASK glob (`cache.inputs.files`,
`cache.outputs.files`, `workspaceFiles`) a bracket is a literal
character and there are no character classes: `app/[id]/**` is the
route directory, not the class that matches `app/i`. `GLOB_WILDCARDS`,
`normalizeGlob`, `staticPrefix`, `isLiteralPattern` and `taskGlob` read
that alphabet, and every task glob reaches `Bun.Glob` through
`taskGlob`, which escapes the brackets. The globs vx does not own keep
`Bun.Glob`'s grammar, class included: package-manager member globs
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
  directory itself" refusal (2026-09-10). A task glob's escaped bracket
  `\[` becomes the bare one, so both spellings are one literal.
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
- `asTrees(patterns)` — a literal entry is the file OR its whole tree, so
  every literal compiles to itself plus `<path>/**`. It lives here, not
  beside the resolver, because it is not only the resolver's rule: it
  decides what a clean DELETES, so `graph`'s overlapping-output refusal
  has to read the same one, and `graph` may not import `cache` (item
  442). Re-exported by `cache/index.ts`, which is still its contract for
  the resolver.
- `isLiteralPattern(g)` — true when a task pattern carries no wildcard,
  so it names exactly one path and may be compared as a STRING; anything
  holding `*`, `?` or a brace alternation must be MATCHED instead (a
  bracket is literal). The character set is the whole content, and it lives
  here for the reason `asTrees` does: four places asked this question and
  `graph/task-graph.ts` asked it without `{}`, so `dist/{a,b}.txt`
  counted as a literal and the overlapping-output refusal compared it to
  `dist/a.txt` as two unequal strings — the two tasks were accepted and
  then deleted each other's outputs, green, every run (item 495).
- `taskGlob(p)` — compile a task glob for `Bun.Glob` with every bare
  bracket escaped. The one door: a site that compiled a task glob itself
  is a route directory that keys nothing. Its `match` is a RegExp of the
  same verdict when the pattern has no brace, escape, leading `!`, empty
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
(`wholeSubtreePrefixes` behind the directory proof) and
`tests/watch-rules.test.ts` (`staticPrefix` behind the output
container), `tests/task-glob-brackets.test.ts` (a bracket route directory
through inputs, outputs, `workspaceFiles`, `--affected` and the additive
hit, both spellings); transitively through `tests/cache.test.ts` (cache-key
determinism) and `tests/inputs.test.ts` (glob result shapes).
