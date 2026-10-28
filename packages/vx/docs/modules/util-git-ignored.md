# `src/util/git-ignored.ts` — does git ignore everything an output writes

## Purpose

A key reads only what git lists, so an output git ignores whole never
reaches a reader's key: it is no input overlap for `vx lock` (X-54)
and no reach for the stability gate (2026-10-15). Git is asked, never
a `.gitignore` read: git alone knows every rule source (nested files,
`info/exclude`, `core.excludesFile`) and that a directory holding a
tracked file is not ignored.

## Public surface

```ts
export function ignoreProbes(glob: string): { paths: string[]; deep: boolean; dir: string } | null
export async function checkIgnore(
  cwd: string,
  paths: readonly string[],
): Promise<Set<string> | null>
export function checkIgnoreSync(cwd: string, paths: readonly string[]): Set<string> | null
export function listedSync(cwd: string, dirs: readonly string[]): string[] | null
export function wholeIgnored(
  globs: Iterable<string>,
  ignored: ReadonlySet<string> | null,
  listedMatch: (glob: string) => boolean,
): Set<string>
```

- `ignoreProbes`: the paths that stand for a root-relative glob: its
  literal directory (`dist/**` → `dist/`), a literal path as itself, and
  for `**/<name>…` the name at the prefix and under a fresh
  `__vx_probe__/` (a directory a task may create). `deep` marks the last:
  a file below them (a tracked one, or one a `!` rule takes back) must be
  looked for in git's listing. Null when no few paths stand (`*.js`).
- `checkIgnore` / `checkIgnoreSync`: one `git check-ignore --stdin -z`;
  null when git cannot answer (no work tree).
- `listedSync`: `git ls-files --cached --others --exclude-standard` under
  `dirs`, for `vx lock`; a run reads its own enumeration instead.
- `wholeIgnored`: the globs whose probes git ignores and, when deep, no
  listed file matches. Undecided is not ignored.

Callers: `graph/task-graph.ts` `refuseOverlaps` (at `vx lock`) and
`orchestrator/stable-keys.ts` `askIgnoredOutputs` (once per run).

## Tests

`tests/ignored-outputs.test.ts`: the rule passes and the key is taken up
front, the same before and after the build, with the rule in the root,
a parent, the project's own `.gitignore` and `.git/info/exclude`; with
the rule off the gate alone; controls: nothing ignored, a rule only one
nested directory holds, a tracked file at the output and deeper, and a
directory a `!` rule takes back are all still overlaps.
