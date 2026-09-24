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
// Per-project file snapshots (the Map), with what the resolver needs beside them.
export class GitFilesCache extends Map<string, readonly string[]> {
  setWorkspaceRoot(root: string): void
  setWorktreeDirty(dirty: boolean | null): void // what `git status` said, for the run context
  markOutputsChanged(projectDir: string, relPaths: readonly string[]): void // a save or restore wrote these
  markWorkspaceOutputsChanged(workspaceRoot: string, relPaths: readonly string[]): void
  invalidateWorkspacePartition(): void
  oidsFor(projectDir: string): ReadonlyMap<string, string> | undefined // trusted index OIDs by path
  setOids(projectDir: string, oids: Map<string, string>): void
  snapshotFor(projectDir: string, inputGlobs: readonly Bun.Glob[]): readonly string[] | undefined
  get undecodableNames(): ReadonlySet<string> // listed paths whose names are not UTF-8 (lossy spelling)
  markUndecodable(absPaths: readonly string[]): void
}

export interface GitEnumeration {
  all: string[] // every path git listed, root-relative
  trusted: Map<string, string> // path → index OID, for the tracked-clean ones
  dirty: boolean | null
  undecodable: readonly string[] // listed paths whose names are not UTF-8, root-relative
}
export function gitPathspecs(
  workspaceRoot: string,
  projectDirs: readonly string[],
  workspaceWide: boolean,
): string[]
export async function startGitEnumeration(
  workspaceRoot: string,
  pathspecs: readonly string[],
): Promise<GitEnumeration>
export function applyGitEnumeration(
  enumeration: GitEnumeration,
  workspaceRoot: string,
  projectDirs: readonly string[],
  cache: GitFilesCache,
  workspaceWide?: boolean,
): void
export async function populateGitFilesCache(
  workspaceRoot: string,
  projectDirs: readonly string[],
  cache: GitFilesCache,
  workspaceWide?: boolean,
): Promise<void> // start + apply in one call

export function runGitLsFiles(cwd: string): GitLsResult // the synchronous per-project fallback

// One `git rev-parse --show-prefix --git-common-dir --show-object-format` per
// directory per process; null (not remembered) when git fails.
export interface RepoFacts {
  prefix: string
  commonDir: string
  objectFormat: 'sha1' | 'sha256'
}
export function repoFacts(dir: string): RepoFacts | null
export function parseCheckAttrOutput(out: string): Set<string>
export function autocrlfConverts(coreConfig: string): boolean
```

`gitPathspecs` scopes the spawn to the projects in the run when there
are at most 64 of them and none is the root itself; otherwise (or
`workspaceWide`) it is `.`. A `git` that cannot be spawned at all — not
on `PATH` — is one `UserError` line (`gitSpawnRefusal`: "vx requires
git"), never a stack; a directory outside a work tree is the same
refusal with `git init` as the remedy.

`startGitEnumeration` is what `prepareRun` kicks off before the configs
load (the spawn overlaps evaluation). It spawns `ls-files`, `status` and
the `core.*` config read concurrently and asks `repoFacts` for the
prefix and the common dir while they run; the file hasher
(`file-hashes.ts`) asks the same memo for the object format at the same
directory (the workspace root, `new Cache(dir, policy, workspaceRoot)`),
so a cold run spawns ONE `rev-parse` whichever asks first — the
enumeration on an unscoped run, the config load on a scoped one
(`tests/git-spawns-once.test.ts` holds both as exact lists). The config
read stays a spawn of its own: `rev-parse` prints no config value.
`applyGitEnumeration` folds the result into the run's `GitFilesCache`, which `inputs.ts`'s `resolveFiles`
reads: a tracked-clean path carries a trusted OID and skips both the
existence probe and the hash; a dirty or untracked path falls back to a
content hash. The OID trust is pruned for merge-conflict stages,
gitlinks, paths a filter converts, and paths flagged skip-worktree /
assume-unchanged (`docs/caching.md` § Clean filters).

## A name that is not UTF-8

git prints a path's bytes as they are. A lossy decode turned `x\xffy`
into `x\ufffdy`, which names no file, so the path reached the input
set, failed the disk probe and dropped out of the key without a word:
every edit to it was a hit (turborepo#9345). An output holding no
U+FFFD after the lossy decode, which is every real repository's, is
done (0.07 ms more than before on a 15,000-record listing). One that
holds one is split at its NULs and each record decoded fatally, and the
records that fail are kept, spelled lossily so a glob still matches
them, in `GitEnumeration.undecodable` and
`GitFilesCache.undecodableNames`. `inputs.ts` refuses one a task's
globs select while it is on disk (`cache.inputs.files matched … the
name is not valid UTF-8`), rather than dropping it: nothing in vx can
open a path a string cannot spell. The same refusal covers outputs,
where `Bun.Glob` decodes a name the same lossy way.

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
renames), `tests/git-spawns-once.test.ts` (every git a cold run spawns,
scoped and unscoped), `tests/nested-repo-inputs.test.ts` (a project inside a
gitlink or an untracked embedded repository: its own git enumerates it,
and a source change is a miss), `tests/inputs.test.ts` and `tests/inputs-resolution.test.ts`
(through the resolver), `tests/restore-git-spawns.test.ts` (spawn
count), `tests/cache-hash-files.test.ts`, `tests/affected*.test.ts`
(the same enumeration behind `--affected`).

## Replacing this module

Another VCS implements the same shape — a per-project snapshot of
paths with a trusted content id and a dirty set — and the resolver does
not change.
