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
  sinceViaDeps?: true // <name>...[<git-ref>]: changed, or depends on a changed package
  pathGlob?: Bun.Glob // a path form carrying a glob (`./packages/*`), matched over the root-relative project dir
  pathGlobBase?: Bun.Glob // `./a/**`'s `a`: a trailing `**` matches zero dirs (D-84)
  pathRoot?: string // the workspace root `pathGlob` is relative to
  exactDir?: true // `//`: the project at `matcher` itself, never the ones under it
  tag?: true // tag:<pattern>: `matcher` is a glob over the projects' tags
}

export function parseFilter(raw: string, workspaceRoot: string): ParsedFilter

export interface ApplyFiltersOptions {
  filters: ParsedFilter[]
  projects: ProjectMeta[]
  graph: PackageGraph
  /** Each project's config `tags`, read by `tag:` selectors (caller-owned: the staged load). */
  tags?: ReadonlyMap<string, readonly string[]>
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
| `//`                  | The root project alone (Turbo's name for the root package); nothing when the root is no project, never every project under it (D-46).                                                                                                                                                                                                                                                          |
| `tag:<pattern>`       | The projects whose config `tags` hold a match (`*` as in a name; Nx's `tag:`). Every operator a name takes applies.                                                                                                                                                                                                                                                                            |
| `<pattern>...`        | Match + all transitive workspace dependencies.                                                                                                                                                                                                                                                                                                                                                 |
| `...<pattern>`        | Match + all transitive workspace dependents.                                                                                                                                                                                                                                                                                                                                                   |
| `<pattern>^...`       | Only the transitive deps of pattern (excluding the matched pkg).                                                                                                                                                                                                                                                                                                                               |
| `...^<pattern>`       | Only the transitive dependents of pattern (excluding the matched pkg; item 890).                                                                                                                                                                                                                                                                                                               |
| `!<pattern>`          | Exclude.                                                                                                                                                                                                                                                                                                                                                                                       |
| `[<git-ref>]`         | Projects affected since `<git-ref>` (`<ref>...HEAD` reads as `<ref>`, D-117). Resolved by caller via                                                                                                                                                                                                                                                                                           |
|                       | `workspace/affected.ts:affectedProjects`.                                                                                                                                                                                                                                                                                                                                                      |

## Algorithm

1. **Parse** each filter string into a `ParsedFilter`.
2. **Base set**: if any include filter is present, start empty; else
   (all-exclude), start with every project name.
3. **Expand each filter in argv order** (so `onNoMatch` names them as
   typed):
   - Compute matched names (glob match on `name` or on a tag,
     path-prefix or path-glob on `dir`, or the pre-resolved
     git-affected set); a
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
The git-relative `[<since>]` form is parsed into a `gitSince` field,
alone or after a name or `{dir}` selector it narrows (`@scope/*[main]`,
`{./apps/*}[HEAD~1]`: the selected packages that changed, D-44; an
unbraced `./` path keeps its brackets as a glob class; `<name>...[ref]`
also takes the dependants of what changed, as Turbo reads it, over a graph
that holds the configs' cross-project `dependsOn` edges), but resolution
happens upstream (`cli/select.ts` calls
`workspace/affected.ts:affectedProjects` once per distinct ref and
passes the result via `affectedByFilter`). A tag lives in the config,
so `cli/select.ts` hands the staged load's tags in through `tags`, and
loads configs for that only when a `tag:` filter is present.

This makes the filter module fully testable against an in-memory
project list + package graph.

## What it does NOT do

- No `**/` in name patterns. Names are flat strings; `*` only.
- No regex.
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
