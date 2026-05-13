# `filter.ts` — package selection DSL

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
}

export function parseFilter(raw: string, workspaceRoot: string): ParsedFilter

export interface ApplyFiltersOptions {
  filters: ParsedFilter[]
  projects: ProjectMeta[]
  graph: PackageGraph
}

export function applyFilters(opts: ApplyFiltersOptions): Set<string>
```

## Filter grammar

| Form            | Meaning                                                          |
| --------------- | ---------------------------------------------------------------- |
| `<pattern>`     | Name match. `*` is a wildcard (no `/`).                          |
| `./<dir>`       | Packages whose dir is at or under `<dir>` (workspace-relative).  |
| `{<dir>}`       | Same as `./<dir>`.                                               |
| `<pattern>...`  | Match + all transitive workspace dependencies.                   |
| `...<pattern>`  | Match + all transitive workspace dependents.                     |
| `<pattern>^...` | Only the transitive dependencies, excluding the matched package. |
| `!<pattern>`    | Exclude packages matching pattern.                               |

## Algorithm

1. Parse each filter string into a `ParsedFilter` record.
2. If any include filter is present, the base set is empty. Otherwise
   (all-exclude), the base set is every project name.
3. For each filter in argv order:
   - Compute the matched names (glob on `name`, or path prefix on `dir`).
   - Expand per flags: optionally add transitive deps, dependents, or
     restrict to deps-only.
   - Add to the selection if include; remove from the selection if
     negate.

## What it does NOT do

- No `**/` glob in name patterns. Names are flat strings; `*` only.
- No regex.
- No mixing of `...` prefix and `^...` suffix on the same filter
  (`...pkg^...` is parsed but the prefix wins; not a documented form).
- No support for tag-based selection (pnpm has none either).

## Tests

`src/filter.test.ts` — parsing forms and `applyFilters` against a small
in-memory project graph.

## Replacing this module

The CLI's `resolveFilters` calls `parseFilter` then `applyFilters`. To
swap the DSL (e.g. for a richer query language), replace this file and
keep the same two exports. Nothing else depends on internal helpers.
