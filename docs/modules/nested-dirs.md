# `src/workspace/nested-dirs.ts` — project-boundary set

## Purpose

For each project, compute the set of other projects' directories that
live underneath it. Passed to `cache/inputs.ts` glob resolution so a
parent project's `inputs.files` can never reach into a nested
project's tree.

## Public surface

```ts
export function computeNestedProjectDirs(entries: ProjectEntry[]): Map<string, string[]>
```

Returns `Map<projectName, absoluteDirs[]>`. Empty array for a project
with no nested children.

## Algorithm

For each project `p`, walk every other project `o`:

- Skip if `o.dir === p.dir`.
- Include if `o.dir` starts with `p.dir + path.sep`.

O(n²) in the project count. Realistic monorepo sizes (≤ hundreds of
projects) make this trivial.

## Why precompute

The result is consumed by every glob pass in every task during the
run. Precomputing once lets `cache/inputs.ts:resolveInputs` operate
in a hot loop without re-walking the project list.

## Tests

Indirect via `tests/orchestrator.test.ts` — the "project boundary"
test cases create a parent + nested layout and verify that the
parent's `inputs.files: ['**/*']` doesn't pick up files from the
nested project.

## What this does NOT do

- Doesn't enforce the boundary itself — `cache/inputs.ts` does, using
  the result of this function.
- Doesn't normalize for symlinks. Bun globs the real tree; symlinks
  to outside the project resolve to their target paths (not the
  symlink path).
