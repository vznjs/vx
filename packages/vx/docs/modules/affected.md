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
  /** Which projects declare a `workspaceFiles` glob matching these paths.
   *  Asked ONLY about paths that belong to no project. */
  workspaceGlobOwners?: (paths: readonly string[]) => Promise<Set<string>>
}

export function affectedProjects(args: AffectedArgs): Promise<Set<string>>

/** Default base when `--affected` has no value. */
export function defaultAffectedBase(workspaceRoot: string): Promise<string>

/** Lockfiles a `fingerprint` plugin claims, so `--affected` can follow
 *  a per-project dependency closure instead of the whole fingerprint. */
export interface FingerprintClaims {
  readonly files: ReadonlySet<string>
  /** Project names a change to a claimed file affects; `undefined` = all. */
  affected(change: {
    file: string
    before: Uint8Array | null
    after: Uint8Array | null
  }): Promise<ReadonlySet<string> | undefined>
}

/** Does any `workspaceFiles` glob match this root-relative path? */
export function workspaceGlobsMatch(globs: readonly string[], rel: string): boolean

/** Is `ref` the current HEAD? A base that is already HEAD selects nothing,
 *  which is a clean exit rather than an empty run. */
export function refIsHead(workspaceRoot: string, ref: string): boolean
```

## Algorithm

0. The base is refused before any spawn when it is empty or starts
   with `-`: it reaches git as an argument (never a shell, so `$(…)` is
   opaque), but an option-like value is a real option — `--output=<path>`
   is an arbitrary file write from a CI-supplied string. Every git call
   in the module also ends its options (`--end-of-options`) before the
   ref, so a new caller cannot lose the guard by accident.
1. `verifyRef(workspaceRoot, since)` — `git rev-parse --verify --quiet
--end-of-options <ref>`. Throws `UserError` if the ref doesn't resolve
   locally.
2. `git diff --name-only <since>` — emits the union of committed +
   staged + unstaged changes. Matches Turbo's `[<since>]` semantics.
3. Untracked files (`git ls-files --others --exclude-standard`) are
   unioned in — a brand-new source file is a change. `vx-lock.json` is
   filtered out, so re-running `vx lock` never selects everything.
4. If `pnpm-workspace.yaml` or a ROOT lockfile no plugin claims
   changed, **every** project is selected and the walk stops: those
   files are folded into the workspace fingerprint, so they re-key
   every task. A lockfile a `fingerprint` plugin claims
   (`@vzn/vx-lockfile`) selects the projects whose dependency closure
   moved instead — [`lockfile-claim.md`](./lockfile-claim.md); one that
   appeared or went still selects everything.
5. Otherwise each changed path reaches a project through **three
   channels**, and the union is returned:
   - **Containment.** Walk the path's ancestor dirs bottom-up until one
     is a project dir; the first hit is the DEEPEST containing project,
     so a **nested project wins over its parent**. (This replaced an
     earlier sort-by-directory-length-descending pass; the walk is
     O(files · depth) instead of O(files · projects).)
   - **Config imports.** A project whose `vx.config.*` transitively
     imports the changed file — see
     [`config-imports.md`](./config-imports.md). Resolved-config
     hashing folds those values into the key, so selection has to see
     them too.
   - **Workspace globs.** For paths that belong to no project,
     `workspaceGlobOwners` (`cli/run.ts`) asks which projects declare
     a matching `cache.inputs.workspaceFiles` glob — through the run
     path's staged load, so a glob a `project` plugin gave a
     config-less package counts.

Selection is never hashed, so widening it changes no cache key: every
channel here may over-select safely. It does NOT follow that selection
is complete — the config-import channel stops at project boundaries and
[documents what that misses](./config-imports.md#where-this-stops).

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

Every git spawn goes through `spawnGitSync` / `spawnGit`: a git that is
not on PATH is util's `gitSpawnRefusal` (one line, the install named),
never the `ENOENT` stack `defaultAffectedBase` showed a minimal image
(item 241). `tests/no-git-on-path.test.ts`.
