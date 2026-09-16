# `src/workspace/nested-dirs.ts` — project-boundary set

## Purpose

For each project, compute the set of other projects' directories that
live underneath it. Passed to `cache/inputs.ts` glob resolution so a
parent project's `inputs.files` can never reach into a nested
project's tree.

## Public surface

```ts
export function computeNestedProjectDirs(
  entries: Array<Pick<ProjectEntry, 'name' | 'dir'>>,
): Map<string, string[]>
```

Returns `Map<projectName, absoluteDirs[]>`. Empty array for a project
with no nested children.

## Algorithm

Sort the entries by `dir` once, then for each project `p` scan
forward: every dir sharing `p.dir` as a string prefix is contiguous in
sorted order, and `p`'s descendants (`p.dir + sep + …`) are a run
inside that block. A sibling whose name extends `p.dir` by a character
that sorts below the separator (`foo-utils` beside `foo`; `-`, `.`, `+`
and a space all sort before `/`) lands between `p.dir` and
`p.dir + sep`, so the scan skips such interlopers and stops only on
leaving the block — a plain break on the first non-descendant missed
`foo/nested` behind `foo-utils` and silently broke the boundary. Near
O(P log P) on real trees.

## Why precompute

The result is consumed by every glob pass in every task during the
run. Precomputing once lets `cache/inputs.ts:resolveInputs` operate
in a hot loop without re-walking the project list.

## Tests

`tests/nested-dirs.test.ts` (the function, the interloper class
included) and `tests/inputs-resolution.test.ts` (the same class through
the resolver); end to end, the "project boundary" cases in
`tests/orchestrator.test.ts` create a parent + nested layout and verify
that the parent's `inputs.files: ['**/*']` doesn't pick up files from
the nested project.

## What this does NOT do

- Doesn't enforce the boundary itself — `cache/inputs.ts` does, using
  the result of this function.
- Doesn't resolve symlinks: the dirs are the discovered project
  directories as strings, and inputs come from git's listing, which
  reports a link as a link.
