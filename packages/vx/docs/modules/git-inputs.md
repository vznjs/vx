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

## What it does NOT do

- Read a config, apply a project boundary, or expand a glob — the
  resolver's business.
- Spawn git more than the documented number of times per run
  (`tests/restore-git-spawns.test.ts` counts them).

## Tests

`tests/git-oid.test.ts` (ls-files parsing, OID trust, symlinks,
renames), `tests/inputs.test.ts` and `tests/inputs-resolution.test.ts`
(through the resolver), `tests/restore-git-spawns.test.ts` (spawn
count), `tests/cache-hash-files.test.ts`, `tests/affected*.test.ts`
(the same enumeration behind `--affected`).

## Replacing this module

Another VCS implements the same shape — a per-project snapshot of
paths with a trusted content id and a dirty set — and the resolver does
not change.
