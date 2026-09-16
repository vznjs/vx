# `src/cache/git-inputs.ts` — git-backed input enumeration

## Purpose

Talk to git once per run and turn the answer into what the resolver
trusts: `git ls-files -s` (paths with their index blob OIDs, stage 0,
regular files and symlinks), `git status --porcelain -z` (which of those
are dirty, plus the untracked), and `git check-attr` where a clean
filter (`text`, `eol`, `ident`, `core.autocrlf`) could make the blob
differ from the bytes on disk. Split from `inputs.ts` on 2026-09-10:
this file talks to git; `inputs.ts` decides which files a task declared
and where the project boundary is.

## Public surface

```ts
export class GitFilesCache extends Map<string, readonly string[]>   // per-project snapshots + OIDs
export async function startGitEnumeration(root, pathspecs): Promise<GitEnumeration>
export function applyGitEnumeration(cache: GitFilesCache, enumeration: GitEnumeration): void
export function gitPathspecs(...): string[]
export async function populateGitFilesCache(...): Promise<void>
export function runGitLsFiles(cwd): GitLsResult             // the synchronous fallback
export function parseCheckAttrOutput(out): Set<string>
export function autocrlfConverts(coreConfig: string): boolean
```

`startGitEnumeration` is what `prepareRun` kicks off before the configs
load (the spawn overlaps evaluation); `applyGitEnumeration` folds the
result into the run's `GitFilesCache`, which `inputs.ts`'s `resolveFiles`
reads: a tracked-clean path carries a trusted OID and skips both the
existence probe and the hash; a dirty or untracked path falls back to a
content hash. The OID trust is pruned for merge-conflict stages,
gitlinks, paths a filter converts, and paths flagged skip-worktree /
assume-unchanged (`docs/caching.md` § Clean filters).

## A project inside a nested repository

A submodule, or an embedded repository, is ONE entry of the workspace
repository's listing (a gitlink; `dir/` when untracked) and none of its
files — and under the pathspec naming the project, nothing at all. Its
slice of the workspace-wide enumeration is therefore EMPTY, which no
real project's is (a project has at least its `package.json`, tracked
or untracked), so the partition step stores no partition for it:
`resolveFiles` spawns `git ls-files` in the project's own directory,
which the nested repository answers, and the files hash by content — no
index OID is trusted from here. One spawn per such project per run; a
workspace without one pays nothing. (A directory ignored outright takes
the same path and still enumerates nothing, as before.) Before
2026-09-16 the empty slice was stored, `cache.inputs matched no files`,
and the key never moved: a stale hit under a green run. `--affected` follows the same
shape: git reports the nested repository as one changed path (the
gitlink, or the untracked `dir/`), and every project under it is
selected (`affected.ts`). What the workspace repository still cannot
see: `workspaceFiles` globs reaching into the nested repository.

## What it does NOT do

- Read a config, apply a project boundary, or expand a glob — the
  resolver's business.
- Spawn git more than the documented number of times per run
  (`tests/restore-git-spawns.test.ts` counts them).

## Tests

`tests/git-oid.test.ts` (ls-files parsing, OID trust, symlinks,
renames), `tests/nested-repo-inputs.test.ts` (a project inside a
gitlink or an untracked embedded repository: its own git enumerates it,
and a source change is a miss), `tests/inputs.test.ts` and `tests/inputs-resolution.test.ts`
(through the resolver), `tests/restore-git-spawns.test.ts` (spawn
count), `tests/cache-hash-files.test.ts`, `tests/affected*.test.ts`
(the same enumeration behind `--affected`).

## Replacing this module

Another VCS implements the same shape — a per-project snapshot of
paths with a trusted content id and a dirty set — and the resolver does
not change.
