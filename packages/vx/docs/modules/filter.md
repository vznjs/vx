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
  isPath: boolean // ./<dir> or {<dir>}
  matcher: string // glob (name) or absolute path
  gitSince?: string // [<git-ref>]
}

export function parseFilter(raw: string, workspaceRoot: string): ParsedFilter

export interface ApplyFiltersOptions {
  filters: ParsedFilter[]
  projects: ProjectMeta[]
  graph: PackageGraph
  /** Pre-resolved affected sets, one per [<since>] filter (caller-owned). */
  affectedByFilter?: Map<ParsedFilter, Set<string>>
}

export function applyFilters(opts: ApplyFiltersOptions): Set<string>
```

## Filter grammar

| Form                  | Meaning                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `<pattern>`           | Name match. `*` is a wildcard (no `/`).                          |
| `./<dir>` / `{<dir>}` | Packages whose dir is at or under `<dir>` (workspace-relative).  |
| `<pattern>...`        | Match + all transitive workspace dependencies.                   |
| `...<pattern>`        | Match + all transitive workspace dependents.                     |
| `<pattern>^...`       | Only the transitive deps of pattern (excluding the matched pkg). |
| `!<pattern>`          | Exclude.                                                         |
| `[<git-ref>]`         | Projects affected since `<git-ref>`. Resolved by caller via      |
|                       | `workspace/affected.ts:affectedProjects`.                        |

## Algorithm

1. **Parse** each filter string into a `ParsedFilter`.
2. **Base set**: if any include filter is present, start empty; else
   (all-exclude), start with every project name.
3. **Apply in argv order**:
   - Compute matched names (glob match on `name`, or path-prefix on
     `dir`, or pre-resolved git-affected set).
   - Expand per flags (add transitive deps / dependents; or restrict
     to deps-only).
   - Add to the selection (include) or remove from it (negate).

## Separation of concerns

`parseFilter` and `applyFilters` are **pure** — no FS, no spawn.
The git-relative `[<since>]` form is parsed into a `gitSince` field
but resolution happens upstream (`cli/run.ts:resolveFilters` calls
`workspace/affected.ts:affectedProjects` and passes the result via
`affectedByFilter`).

This makes the filter module fully testable against an in-memory
project list + package graph.

## What it does NOT do

- No `**/` in name patterns. Names are flat strings; `*` only.
- No regex.
- No tag-based selection (pnpm doesn't have it either).
- No mixing of `...` prefix and `^...` suffix on the same filter —
  the prefix wins; undocumented form.

## Tests

`tests/filter.test.ts` — parser forms + `applyFilters` matrix against
an in-memory project list + package graph fixture.

## Replacing this module

The CLI calls `parseFilter` then `applyFilters`. Swap both to provide
a different DSL while keeping `cli/run.ts` happy. Nothing else
depends on internals.
