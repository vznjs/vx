# `src/workspace/filter.ts` — `--filter` DSL

## Purpose

Implement the pnpm-style filter language used by `vx run --filter <pattern>`.
A filter expression selects a set of projects from the workspace; the
CLI passes that set to the orchestrator as the `projects` list.

## Public surface

```ts
export interface ParsedFilter {
  raw: string
  negate: boolean // !pattern
  withDeps: boolean // pattern...
  withDependents: boolean // ...pattern
  onlyDeps: boolean // pattern^...
  onlyDependents: boolean // ...^pattern (item 890)
  isPath: boolean // ./<dir> or {<dir>}
  matcher: string // glob (name) or absolute path
  gitSince?: string // [<git-ref>]
  pathGlob?: Bun.Glob // a path form carrying a glob (`./packages/*`), matched over the root-relative project dir
  pathRoot?: string // the workspace root `pathGlob` is relative to
}

export function parseFilter(raw: string, workspaceRoot: string): ParsedFilter

export interface ApplyFiltersOptions {
  filters: ParsedFilter[]
  projects: ProjectMeta[]
  graph: PackageGraph
  /** Pre-resolved affected sets, one per [<since>] filter (caller-owned). */
  affectedByFilter?: Map<ParsedFilter, Set<string>>
  /** Called once per filter that matched zero projects, before expansion — a typo among several filters otherwise under-selects silently. */
  onNoMatch?: (filter: ParsedFilter) => void
  onEmptyWalk?: (filter: ParsedFilter, matched: readonly string[]) => void
}

export function applyFilters(opts: ApplyFiltersOptions): Set<string>
```

## Filter grammar

| Form                  | Meaning                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<pattern>`           | Name match. `*` is the sole metacharacter and means any characters — pnpm's rule, so `*core*` crosses the `@scope/` boundary.                                                                                                                                                                                                                                                                  |
| `./<dir>` / `{<dir>}` | The package whose dir is `<dir>`, alone (`.` is the root project; a nested package is not included, as in Turbo and pnpm, D-43); a `<dir>` that is no package matches the packages under it (workspace-relative). A glob in the path (`./apps/*`, `{apps/**}`) is matched over each project's root-relative dir instead, unless the path selects a project dir literally (`./packages/[abc]`). |
| `<pattern>...`        | Match + all transitive workspace dependencies.                                                                                                                                                                                                                                                                                                                                                 |
| `...<pattern>`        | Match + all transitive workspace dependents.                                                                                                                                                                                                                                                                                                                                                   |
| `<pattern>^...`       | Only the transitive deps of pattern (excluding the matched pkg).                                                                                                                                                                                                                                                                                                                               |
| `...^<pattern>`       | Only the transitive dependents of pattern (excluding the matched pkg; item 890).                                                                                                                                                                                                                                                                                                               |
| `!<pattern>`          | Exclude.                                                                                                                                                                                                                                                                                                                                                                                       |
| `[<git-ref>]`         | Projects affected since `<git-ref>`. Resolved by caller via                                                                                                                                                                                                                                                                                                                                    |
|                       | `workspace/affected.ts:affectedProjects`.                                                                                                                                                                                                                                                                                                                                                      |

## Algorithm

1. **Parse** each filter string into a `ParsedFilter`.
2. **Base set**: if any include filter is present, start empty; else
   (all-exclude), start with every project name.
3. **Expand each filter in argv order** (so `onNoMatch` names them as
   typed):
   - Compute matched names (glob match on `name`, path-prefix or
     path-glob on `dir`, or the pre-resolved git-affected set); a
     filter that matched nothing is reported through `onNoMatch`, and one
     that matched but whose walk selected nothing through `onEmptyWalk`
     (item 1030).
   - Expand per flags (add transitive deps / dependents; or restrict
     to deps-only).
   - Add an include's set to the selection; hold a negation's.
4. **Remove every held exclude** — all includes land before any
   exclude, regardless of argv order, as pnpm does: `--filter '!b'
--filter 'a...'` no longer adds `b` back (item 979).

## Separation of concerns

`parseFilter` and `applyFilters` are **pure** — no FS, no spawn.
The git-relative `[<since>]` form is parsed into a `gitSince` field
but resolution happens upstream (`cli/select.ts` calls
`workspace/affected.ts:affectedProjects` once per distinct ref and
passes the result via `affectedByFilter`).

This makes the filter module fully testable against an in-memory
project list + package graph.

## What it does NOT do

- No `**/` in name patterns. Names are flat strings; `*` only.
- No regex.
- No tag-based selection (pnpm doesn't have it either).
- `...<pattern>^...` is accepted but undocumented: both flags apply —
  the matched package itself is left out, its dependencies and its
  dependents are taken.

## Tests

`tests/filter.test.ts` — parser forms + `applyFilters` matrix against
an in-memory project list + package graph fixture.

## Replacing this module

The CLI (`cli/select.ts`) calls `parseFilter` then `applyFilters`.
Swap both to provide a different DSL while keeping that caller happy.
Nothing else depends on internals.
