# `src/workspace/affected.ts` — git-relative project selection

## Purpose

Power `--affected[=<base>]` and the `[<since>]` filter form. Resolves
the set of project names whose files changed between `<since>` and
the current working tree.

## Public surface

```ts
export interface AffectedArgs {
  workspaceRoot: string
  since: string // required: ref / commit / branch
  projects: readonly ProjectMeta[]
}

export function affectedProjects(args: AffectedArgs): Promise<Set<string>>

/** Default base when `--affected` has no value. */
export function defaultAffectedBase(workspaceRoot: string): Promise<string>
```

## Algorithm

1. `verifyRef(workspaceRoot, since)` — `git rev-parse --verify --quiet
<ref>`. Throws `UserError` if the ref doesn't resolve locally.
2. `git diff --name-only <since>` — emits the union of committed +
   staged + unstaged changes. Matches Turbo's `[<since>]` semantics.
3. Each changed path is mapped to its owning project. Projects are
   sorted by directory length descending so a **nested project wins
   over its parent** when a file is a descendant of both (consistent
   with the project-boundary rule).
4. Returns the deduped set of project names.

`defaultAffectedBase`:

- Try `git symbolic-ref --short -q refs/remotes/origin/HEAD` (e.g.
  `origin/main`).
- Fall back to `HEAD~1` if the symbolic-ref isn't set (common in CI
  shallow clones).

## Filter integration

`cli/run.ts:resolveFilters` invokes `affectedProjects` once per
`[<since>]` filter, stuffs the result in
`affectedByFilter: Map<ParsedFilter, Set<string>>`, then calls
`applyFilters({ filters, projects, graph, affectedByFilter })`.

This separation keeps `workspace/filter.ts` pure (no FS / no git
spawns) — easy to test against in-memory fixtures.

## What this does NOT do

- **Doesn't run `git fetch`.** If the local clone is stale,
  `affectedProjects` operates on stale refs. CI scripts should
  fetch first.
- **Doesn't honor `.gitattributes` or `--diff-filter`.** A
  whitespace-only commit still marks projects as affected.
- **Doesn't intersect with `cache.inputs.files`.** A project is
  affected if any file changed under its dir — even if no cached
  task lists that file as an input. (We default to "be permissive";
  Turbo behaves the same.)

## Tests

`tests/affected.test.ts`:

- single file change → owning project selected.
- file in nested project → nested project wins over parent.
- file outside any project → no project selected.
- bad git ref → UserError with the ref name.
- `defaultAffectedBase` returns `origin/HEAD` symref then `HEAD~1`.
