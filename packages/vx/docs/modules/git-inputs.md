# `src/cache/git-inputs.ts` — git-backed input enumeration

## Purpose

Talk to git once per run and turn the answer into what the resolver
trusts: `git ls-files -s` (paths with their index blob OIDs, stage 0,
regular files and symlinks), `git status --porcelain -z` (which of those
are dirty, plus the untracked; `--no-renames`, so a rename's source,
the original of a `git add -N` copy (item 976) or a deletion paired with
an unmerged path (A-59), is a deletion of its own), and `git check-attr` where a clean
filter (`text`, `eol`, `ident`, a `filter` driver, `working-tree-encoding`,
`core.autocrlf`) could make the blob
differ from the bytes on disk. The gate looks for a `.gitattributes`
among every listed path, untracked and modified ones too: git applies
those, and a scan of the trusted paths alone never saw them (item 977),
and an ignored one, which the status walk names with `--ignored=matching`
(A-19). `ls-files --debug` adds the worktree size the index recorded
for each entry, and a trusted OID whose blob is another size is dropped:
a filter since removed left a stat-clean entry git never re-reads (A-60).
The blob sizes come from the cache's `blob_sizes` memo, the unknown ones
from one `git cat-file --batch-check`; `applyGitEnumeration` runs the
check, so every caller of it gets it. Split from `inputs.ts` on 2026-09-10:
this file talks to git; `inputs.ts` decides which files a task declared
and where the project boundary is.

Every enumeration spawn runs `git --no-optional-locks`. A plain `status`
refreshes the index under `index.lock` when files are stat-dirty, and the
user's own `git add` or `commit` failed on that lock while a vx run held
it: 12 of 1,165 across 80 runs, 0 of 1,121 with the flag (item 880). A
clean tree costs the same. The flag does not reach `--affected`'s
`git diff <base>`, which git 2.43 refreshes regardless; the plumbing
`diff-index` would report every stat-dirty file as changed.

## Public surface

```ts
// Per-project file snapshots (the Map), with what the resolver needs beside them.
export class GitFilesCache extends Map<string, readonly string[]> {
  setWorkspaceRoot(root: string): void
  setWorktreeDirty(dirty: boolean | null): void // what `git status` said, for the run context
  get worktreeDirty(): boolean | null
  markOutputsChanged(projectDir: string, relPaths: readonly string[]): void // a save or restore wrote these
  noteClean(by: string, dir: string, rels: readonly string[]): void // which of a clean's paths git tracks (A-48)
  trackedCleansMissing(except: string): Array<{ path: string; by: string }> // another task's clean removed it; still gone
  markWorkspaceOutputsChanged(workspaceRoot: string, relPaths: readonly string[]): void
  invalidateWorkspacePartition(): void
  clear(): void // every partition AND its OIDs and pending marks (a write that reached the workspace)
  oidsFor(projectDir: string): ReadonlyMap<string, string> | undefined // trusted index OIDs by path
  setOids(projectDir: string, oids: Map<string, string>): void
  snapshotFor(projectDir: string, inputGlobs: readonly Bun.Glob[]): readonly string[] | undefined
  get undecodableNames(): ReadonlySet<string> // listed paths whose names are not UTF-8 (lossy spelling)
  markUndecodable(absPaths: readonly string[]): void
  enumeratedAtMs: number | undefined // the enumeration's start: what `oidsFor` says is true as of then
}

export interface GitEnumeration {
  all: string[] // every path git listed, root-relative
  trusted: Map<string, string> // path → index OID, for the tracked-clean ones
  dirty: boolean | null
  changed: readonly string[] | null // what `status` listed (dirty, both sides of a rename, untracked)
  untracked: readonly string[] | null // status's untracked set, before nested repos expand (ls-files --others)
  undecodable: readonly string[] // listed paths whose names are not UTF-8, root-relative
  startedAtMs: number // Date.now() before the spawns
  indexed: ReadonlyMap<string, { oid: string; size: number }> // regular stage-0 entry → OID, recorded size
  catFile(stdin: string): Promise<{ exitCode: number; stdout: string } | null> // blob sizes (A-60)
}
export interface BlobSizeMemo {
  knownBlobSizes(oids: readonly string[]): Map<string, number>
  rememberBlobSizes(sizes: ReadonlyMap<string, number>): void
}
export interface LazyGitEnumeration {
  start(): Promise<GitEnumeration> // the whole-tree enumeration, started once
  readonly started: Promise<GitEnumeration> | undefined
}
export function lazyGitEnumeration(workspaceRoot: string): LazyGitEnumeration
export const MAX_SCOPED_PATHSPECS: number // 64: above it the walk is the whole tree
export function gitPathspecs(
  workspaceRoot: string,
  projectDirs: readonly string[],
  workspaceWide: boolean,
): string[]
export async function startGitEnumeration(
  workspaceRoot: string,
  pathspecs: readonly string[],
): Promise<GitEnumeration>
export async function applyGitEnumeration(
  enumeration: GitEnumeration,
  workspaceRoot: string,
  projectDirs: readonly string[],
  cache: GitFilesCache,
  workspaceWide?: boolean,
  memo?: BlobSizeMemo, // the blob-size check's memo (`Cache`); absent, every size is asked
): Promise<void>
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
export function repoRootOf(workspaceRoot: string, gitPrefix: string): string // the repo root, from `--show-prefix`
// The identity the key folds: the blob OID, prefixed `<mode>:` unless mode is 100644 (item 887)
export function fileIdentity(mode: string, oid: string): string
export function parseCheckAttrOutput(out: string): Set<string>
export function autocrlfConverts(gitVars: string): boolean // over `git var -l`
// `core.trustctime` off or `core.checkStat=minimal`: `git status` cannot see a
// same-size, time-keeping rewrite, so the enumeration trusts no OID (A-6).
export function gitStatWeakened(gitVars: string): boolean
// The attributes files git reads outside the tree: from 2.42 git names them
// (`GIT_ATTR_GLOBAL`, `GIT_ATTR_SYSTEM`); before, the lookup is mirrored.
export function attributeFilesOutsideTree(
  gitVars: string,
  env: Readonly<Record<string, string | undefined>>,
): string[]
```

`gitPathspecs` scopes the spawn to the projects in the run when there
are at most `MAX_SCOPED_PATHSPECS` (64) of them and none is the root
itself; otherwise (or `workspaceWide`) it is `.`. A run that names more
projects than that starts the whole-tree walk early, as an unscoped run
does, since its configs cannot narrow it. A `git` that cannot be spawned at all — not
on `PATH` — is one `UserError` line (`gitSpawnRefusal`: "vx requires
git"), never a stack; a directory outside a work tree is the same
refusal with `git init` as the remedy.

`startGitEnumeration` is what `prepareRun` kicks off before the configs
load (the spawn overlaps evaluation). It spawns `ls-files`, `status` and
`var -l` (git's merged config and, from 2.42, the attributes files it
reads outside the tree) concurrently and asks `repoFacts` for the
prefix and the common dir while they run; the file hasher
(`file-hashes.ts`) asks the same memo for the object format at the same
directory (the workspace root, `new Cache(dir, policy, workspaceRoot)`),
so a cold run spawns ONE `rev-parse` whichever asks first — the
enumeration on an unscoped run, the config load on a scoped one
(`tests/git-spawns-once.test.ts` holds both as exact lists). The config
read stays a spawn of its own: `rev-parse` prints no config value.
`lazyGitEnumeration` holds a run's whole-tree enumeration: an unscoped
run starts it at once; a `discover` hook's `worktreeChanges()` starts it
on a scoped one (and in the CLI's `--filter` pass, whose discovery the
run takes over: `gitOfDiscovery` finds its enumeration), and the run then reuses it rather than
spawn a scoped walk too (G-75).
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

## Nested repositories

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
selected (`affected.ts`).

The other direction, a nested repository INSIDE a project or under a
`workspaceFiles` glob (a vendored submodule under `**`): every listing —
the workspace-wide enumeration and the per-project `runGitLsFiles` —
replaces the one entry (a mode-160000 gitlink, or an untracked `dir/`)
with the files `git ls-files` lists inside it, prefixed by its path,
recursively (`expandNestedRepos`). They carry no index OID, so they hash
by content. One spawn per nested repository per listing; a listing with
none pays nothing. A gitlink with no `.git` behind it (a submodule never
initialised, or one whose `.git` was removed to vendor its files) has no
repository to ask, so a walk lists what is there (`walkFiles`, A-61);
an empty one folds nothing. Until 2026-09-27 (A-1) the
entry was dropped as a directory, the files never reached the key, and
an edit inside the nested repository was a hit on the old output while
`git status` named the path.

## What it does NOT do

- Read a config, apply a project boundary, or expand a glob — the
  resolver's business.
- Spawn git more than the documented number of times per run
  (`tests/restore-git-spawns.test.ts` counts them).

## Tests

`tests/git-oid.test.ts` (ls-files parsing, OID trust, symlinks,
renames), `tests/git-trust.test.ts` (end to end: working-tree shapes the
trust rule once misread into a stale hit), `tests/git-spawns-once.test.ts` (every git a cold run spawns,
scoped and unscoped), `tests/nested-repo-inputs.test.ts` (a project inside a
gitlink or an untracked embedded repository, and one inside a project:
its own git enumerates it, and a source change is a miss), `tests/inputs.test.ts` and `tests/inputs-resolution.test.ts`
(through the resolver), `tests/restore-git-spawns.test.ts` (spawn
count), `tests/cache-hash-files.test.ts`, `tests/affected*.test.ts`
(the same enumeration behind `--affected`).

## Replacing this module

Another VCS implements the same shape — a per-project snapshot of
paths with a trusted content id and a dirty set — and the resolver does
not change.
