# `src/cache/inputs.ts` — input/output glob resolution + cleaning

## Purpose

Turn a task's declared `cache.inputs` into concrete data the cache key
can hash:

- a sorted list of absolute file paths whose contents will be hashed
- a sorted list of `[envName, hostValue]` pairs
- sorted `[command, output]` pairs for `cache.inputs.runtime` and
  `workspaceRuntime` (each command run once per run through a memo)

Plus the helpers that resolve and clean `cache.outputs.files` and
`outputs.workspaceFiles`.

## Public surface

The git side is `git-inputs.ts` (see git-inputs.md); this module
re-exports it for readers that reach it here: `GitFilesCache`,
`populateGitFilesCache`, `runGitLsFiles`, `startGitEnumeration`,
`applyGitEnumeration`, `gitPathspecs`, `parseCheckAttrOutput`,
`autocrlfConverts` and the `GitEnumeration` type.

```ts
export interface ResolvedInputs {
  files: string[] // absolute paths, sorted
  envValues: Array<[name: string, value: string]> // sorted by name
  runtimeValues: Array<[command: string, output: string]> // sorted by command
  workspaceRuntimeValues: Array<[command: string, output: string]>
}

export interface ResolveInputsArgs {
  projectDir: string
  workspaceRoot: string
  envSource: NodeJS.ProcessEnv
  inputs: CacheInputs | undefined
  ownOutputs: string[] // project-relative globs to exclude
  ownWorkspaceOutputs?: string[] // root-relative `outputs.workspaceFiles` to exclude from `inputs.workspaceFiles`
  nestedProjectDirs: string[] // absolute dirs of nested projects
  gitFilesCache?: GitFilesCache // per-run memo of `git ls-files` per project
  runtimeCache?: Map<string, Promise<string>> // per-run memo of `inputs.runtime`, keyed projectDir + '\0' + command
  workspaceRuntimeCache?: Map<string, Promise<string>> // per-run memo of `workspaceRuntime`, keyed by command
  workspaceFilesCache?: WorkspaceFilesCache // per-run memo of `inputs.workspaceFiles` per declaration
  projectFilesCache?: ProjectFilesCache // per-run memo of `inputs.files` per project + declaration
}

export type WorkspaceFilesCache = Map<
  string,
  { snapshot: readonly string[]; result: Promise<string[]> }
>

export type ProjectFilesCache = Map<
  string,
  { snapshot: readonly string[]; result: readonly string[] }
>

export async function resolveInputs(args: ResolveInputsArgs): Promise<ResolvedInputs>

export async function resolveOutputs(args: {
  projectDir: string
  outputs: string[]
  nestedProjectDirs: string[]
}): Promise<string[]>

/**
 * Remove every file currently matching the declared output globs.
 * Called before every cache-miss exec AND before every cache-hit
 * restore so the project dir lands on a clean slate.
 */
export async function cleanOutputs(args: {
  projectDir: string
  outputs: string[]
  nestedProjectDirs: string[]
}): Promise<void>

// The same pair for `outputs.workspaceFiles`, anchored at the root with
// no project-dir exclusion; the clean returns the root-relative paths
// it removed, for `GitFilesCache.markWorkspaceOutputsChanged`.
export async function resolveWorkspaceOutputs(args: {
  workspaceRoot: string
  outputs: string[]
}): Promise<string[]>
export async function cleanWorkspaceOutputs(args: {
  workspaceRoot: string
  outputs: string[]
}): Promise<string[]>

/** A literal entry compiles to itself plus its subtree: `src/` → `src`, `src/**`. */
export function asTrees(patterns: readonly string[]): string[]

// An ADDITIVE task (its outputs overlap an upstream's, with the edge that
// orders them; item 588) owns what its run added or changed, not what
// its glob selects: the stamp before, the diff after, and a clean by
// recorded rows rather than by glob.
export interface OutputStamp {
  size: number
  mtimeMs: number
}
export async function stampOutputs(args: {
  projectDir: string
  outputs: string[]
  nestedProjectDirs: string[]
}): Promise<Map<string, OutputStamp>>
export async function ownOutputsSince(
  args: { projectDir: string; outputs: string[]; nestedProjectDirs: string[] },
  before: ReadonlyMap<string, OutputStamp>,
): Promise<string[]>
export async function cleanOutputPaths(args: {
  projectDir: string
  rels: readonly string[]
}): Promise<void>
```

## File resolution rules

The candidate file set comes from git — `git ls-files --cached
--others --exclude-standard` in the project directory — and the user's
`cache.inputs.files` globs are applied as a filter on top. There is no
other walker: a project outside a git work tree is a `UserError`
("vx requires git").

1. **Candidate enumeration.** `git ls-files` yields tracked files PLUS
   untracked-but-not-ignored files. `.gitignore` cascades (workspace +
   every nested), plus `.git/info/exclude` + global excludes, are
   honored — git applies them for us. This matches what Turbo and Nx
   do internally. The listing is memoized per run in `GitFilesCache`
   (one spawn per project, or one workspace-wide spawn through
   `populateGitFilesCache`); a project inside a nested repository — a
   submodule, an embedded repository, which the workspace's git holds
   as one gitlink — is enumerated by its own git.
2. **Positive globs** — `cache.inputs.files` strings without `!`.
   The default when `cache.inputs.files` is undefined is `['**/*']`.
   Each is normalized (a leading `./`, inner `./` segments, doubled
   slashes and a trailing slash) and checked against the candidate
   set via `Bun.Glob.match`. A literal entry — no glob character —
   means the file or its whole tree: `src/`, `src` and `dist` all
   compile to the path plus `<path>/**` (`asTrees`, defined in
   `util/paths.ts` and re-exported here — the graph's
   overlapping-output refusal reads the same rule), as in Turbo and
   every `.gitignore`. A literal that exists on disk but git does not
   list (gitignored) is refused as a `UserError`: it would contribute
   nothing to the key, and the task would report up-to-date after
   that file changed. A literal that does not exist stays silent — an
   optional file is an ordinary declaration.
3. **Negative globs** — entries starting with `!`. The `!` is
   stripped; the rest becomes a `Bun.Glob` (a literal is a tree here
   too) and any matched path is removed.
4. **Always-ignored** — hard-coded
   (`**/node_modules/**`, `**/.git/**`, `**/.vx/**`, `**/*.tsbuildinfo`,
   `**/vx-lock.json`, `**/*.bun-build`)
   — applied as a defense-in-depth even if git happens to track
   something there. The lock file is vx's own frozen-config metadata,
   never a task input; the `.bun-build` intermediate is a transient a
   concurrent compile is mid-write.
5. **Boundary ignores** — every nested project's directory (relative
   to this project) → `<rel>/**`. Cross-project isolation contract.
6. **Own outputs** — declared `cache.outputs.files` are excluded.
   Prevents self-invalidation.
7. **Existence check** — `git ls-files --cached` can surface a
   deleted-but-tracked path; we drop entries that are not on disk so
   the hasher doesn't throw ENOENT. "On disk" is an `lstat`: a regular
   file or a symlink (to anything, or to nothing — its target string
   is what folds, as in git); a directory is not an input (git lists a
   gitlink at its path and `**/*` matches it). Paths carrying a
   trusted index OID skip the probe (a clean tracked file necessarily
   exists), which is why `skip-worktree` / `assume-unchanged` entries
   have their OID dropped up front — git is not watching those, so
   their OID says nothing about whether the file is on disk.

The matched absolute paths are sorted alphabetically and returned.

## Env resolution rules

Listed `cache.inputs.env` names are looked up in `envSource` (the
host's `process.env`):

- Set names → `[name, value]` pair.
- Unset names → `[name, '']` (distinguishable from "name was never
  listed").
- Sorted by name for deterministic key ordering.

## Output resolution rules

`resolveOutputs` is a simpler glob pass:

- Globs run against the project dir (a literal is a tree here too).
- `.git` and `.vx` excluded whatever the glob (`OUTPUT_NEVER`: no task
  produces them and their loss is unrecoverable). Nothing else is —
  `ALWAYS_IGNORE` does not apply here, since `node_modules/**` is an
  install task's legitimate output.
- Nested-project subtrees excluded (boundary isolation).
- **No gitignore filter** — outputs like `dist/` are usually
  gitignored on purpose, and we still want to capture them.
- **Only paths really inside the project**, after resolving each
  output's directory: Bun 1.4.0's `Glob.scan` descends into a
  symlinked directory, so `dist -> ../victim` yielded paths that are
  lexically inside the project while the files are not — and the
  caller deletes what this returns. A directory that will not resolve
  is refused (a broken link, or a race with the producing task).

Returns sorted absolute paths. `resolveWorkspaceOutputs` is the same
pass for `outputs.workspaceFiles`, anchored at the workspace root and
deliberately without the project-dir exclusion.

`cleanOutputs` removes every match, then the directories it emptied,
bottom-up and never the root itself (a directory left standing where
the cached entry holds a file of the same name blocks the restore). A
declared output the process cannot remove — another user's `dist/`, a
read-only checkout — is a `UserError` naming the path, not an internal
error.

## What this does NOT do

- Doesn't hash file content (that's `file-hashes.ts`'s `FileHashStore`
  under `orchestrator/task-hash.ts`).
- Doesn't apply `inputs.tasks` filtering (that's
  `orchestrator/upstream.ts`'s `filterUpstreamHashes`).
- Doesn't support workspace-relative globs in `inputs.files` —
  intentionally scoped per-project. For workspace-root-anchored files use
  `cache.inputs.workspaceFiles` (root-relative globs); see
  [`../schema.md`](../schema.md). A workspace-level `globalInputs` field is
  an owner-rejected non-goal.
- Doesn't follow symlinks. Inputs come from git, which reports a link as
  a link; the OUTPUT scan yields symlinks as outputs (captured as the
  target's bytes, unlinked on clean) and never descends through one.

## Tests

Two test files cover this module:

**`tests/inputs.test.ts`** — direct unit tests against `resolveInputs`,
`resolveOutputs`, `cleanOutputs`, each on a real git repository in the
fixture, plus the `gitFilesCache` memo, the single workspace-wide
spawn, the symlink edge cases and the runtime values. The git-path
block verifies:

- Nested `.gitignore` patterns are correctly anchored (the v13 bug).
- Untracked-but-not-ignored files participate immediately.
- Workspace-root `.gitignore` excludes via git.
- `.git/info/exclude` honored.
- Deleted-but-tracked files skipped (no ENOENT).
- Declared outputs still excluded under the git path.
- Nested-project boundary still excludes under the git path.
- Negation in `inputs.files` still strips under the git path.
- `node_modules` always-ignored even when force-added to git.

**`tests/orchestrator.test.ts`** — e2e behaviour:

- default = all files (gitignore-aware)
- narrow globs limit cache busting
- negation excludes
- self-invalidation guard (declared outputs excluded)
- boundary isolation (nested project files don't leak)
- gitignored files excluded; negated gitignore re-included
- empty `files: []` produces stable hash
- env input value changes bust cache; unset vs empty differ

## Replacing this module

Possible directions:

- **Auto-tracking inputs is NOT one** (vite-task style syscall spying,
  the observed set becoming the next run's inputs): owner-rejected
  (CLAUDE.md § Rejected). Inputs stay declared. A task that wants its
  reads confined to what it declared asks for that with `exec.sandbox`.
- **Cross-project inputs** exist as `cache.inputs.workspaceFiles`
  (root-relative globs, which may reach into another project's
  directory) and, for outputs of an upstream task, through `dependsOn`
  folding the upstream INPUT key. A per-project `{ project, files }`
  form is not planned: the two cover the cases, and project boundaries
  stay hard for plain `files` globs.
- **Enumeration from something other than git's index** (a VFS, a
  watchman daemon, a different VCS) — replace the one worktree walk in
  `resolveFiles`; the identity contract (a blob id for a tracked-clean
  file, a content hash otherwise) stays, since the cache key folds it.
