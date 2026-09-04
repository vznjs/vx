# `src/cache/inputs.ts` — input/output glob resolution + cleaning

## Purpose

Turn a task's declared `cache.inputs` into concrete data the cache key
can hash:

- a sorted list of absolute file paths whose contents will be hashed
- a sorted list of `[envName, hostValue]` pairs

Plus a small helper to resolve `cache.outputs.files` to actual produced
files for capture.

## Public surface

```ts
export interface ResolvedInputs {
  files: string[] // absolute paths, sorted
  envValues: Array<[name: string, value: string]> // sorted by name
}

export interface ResolveInputsArgs {
  projectDir: string
  workspaceRoot: string
  envSource: NodeJS.ProcessEnv
  inputs: CacheInputs | undefined
  ownOutputs: string[] // project-relative globs to exclude
  nestedProjectDirs: string[] // absolute dirs of nested projects
}

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
```

## File resolution rules (v14)

The candidate file set comes from `git ls-files --cached --others
--exclude-standard` when the project is inside a git repo, falling
back to a `Bun.Glob` walker when it isn't. The user's
`cache.inputs.files` globs are then applied as a filter on top.

1. **Candidate enumeration:**
   - **Git path** (default when a `.git` work-tree exists). `git
ls-files` yields tracked files PLUS untracked-but-not-ignored
     files. `.gitignore` cascades (workspace + every nested), plus
     `.git/info/exclude` + global excludes, are honored — git
     applies them for us. This matches what Turbo and Nx do
     internally.
   - **Fallback path** (no git available). `Bun.Glob.scan(projectDir)`
     walks the FS. The `ignore` library applies workspace-root +
     project-root `.gitignore` patterns, with the caveat that
     project-level anchored patterns are evaluated against
     workspace-relative paths (so `pkg/.gitignore: src/skip.ts`
     misbehaves — match git semantics by adopting a git workspace).
2. **Positive globs** — `cache.inputs.files` strings without `!`.
   The default when `cache.inputs.files` is undefined is `['**/*']`.
   Each is checked against the candidate set via `Bun.Glob.match`.
3. **Negative globs** — entries starting with `!`. The `!` is
   stripped; the rest becomes a `Bun.Glob` and any matched path is
   removed.
4. **Always-ignored** — hard-coded
   (`**/node_modules/**`, `**/.git/**`, `**/.vx/**`, `**/*.tsbuildinfo`)
   — applied as a defense-in-depth even if git happens to track
   something there.
5. **Boundary ignores** — every nested project's directory (relative
   to this project) → `<rel>/**`. Cross-project isolation contract.
6. **Own outputs** — declared `cache.outputs.files` are excluded.
   Prevents self-invalidation.
7. **Existence check** — `git ls-files --cached` can surface a
   deleted-but-tracked path; we drop entries that don't exist on
   disk so the hasher doesn't throw ENOENT. Paths carrying a trusted
   index OID skip the probe (a clean tracked file necessarily exists),
   which is why `skip-worktree` / `assume-unchanged` entries have
   their OID dropped up front — git is not watching those, so their
   OID says nothing about whether the file is on disk.

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

- Globs run against the project dir.
- Always-ignored paths excluded (`node_modules`, etc.).
- Nested-project subtrees excluded (boundary isolation).
- **No gitignore filter** — outputs like `dist/` are usually
  gitignored on purpose, and we still want to capture them.

Returns sorted absolute paths.

## What this does NOT do

- Doesn't hash file content (that's `cache.ts:hashFiles`).
- Doesn't apply `inputs.tasks` filtering (that's
  `orchestrator.filterUpstreamHashes`).
- Doesn't support workspace-relative globs in `inputs.files` —
  intentionally scoped per-project. For workspace-root-anchored files use
  `cache.inputs.workspaceFiles` (root-relative globs); see
  [`../schema.md`](../schema.md). A workspace-level `globalInputs` field is
  an owner-rejected non-goal.
- Doesn't follow symlinks specially.

## Tests

Two test files cover this module:

**`tests/inputs.test.ts`** — direct unit tests against `resolveInputs`,
`resolveOutputs`, `cleanOutputs`. Split into FS-walker tests (no git
init in fixture) and **git-path tests** (init a real git repo in the
fixture). The git-path block verifies:

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
  reads confined to what it declared asks for that with `sandbox`.
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
