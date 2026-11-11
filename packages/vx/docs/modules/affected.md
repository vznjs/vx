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
  projects: readonly ProjectMeta[] | Promise<readonly ProjectMeta[]> // awaited after the diff starts
  /** false skips the config-import scan: a branch scope's routing. */
  configImports?: false
  /** Assume-unchanged / skip-worktree paths from the run's enumeration; null or absent asks `git ls-files -v`. */
  flagged?: () => Promise<readonly string[] | null>
  /** Which projects declare a `workspaceFiles` glob matching these paths.
   *  Asked about every changed path, once something changed (item 954). */
  workspaceGlobOwners?: (
    changedPaths: readonly string[],
    nested: readonly string[],
    dirLinks: ReadonlySet<string>, // changed links to a directory: matched as one
    untracked: ReadonlySet<string>, // AffectedChanges.untracked: under a task's own outputs, no match
  ) => Promise<Iterable<string>>
  /** The fingerprint files a plugin claims and its answer for a change to
   *  one; resolved lazily, only when a diff touches a root file. */
  fingerprintClaims?: () => Promise<FingerprintClaims>
  /** The untracked files, from a walk shared with the run; null or absent
   *  spawns `git ls-files --others` here (I-26). */
  untracked?: () => Promise<readonly string[] | null>
  /** The tracked symlinks, from the run's enumeration; null or absent
   *  spawns `git ls-files -s` here. */
  links?: () => Promise<readonly string[] | null>
}

export function affectedProjects(args: AffectedArgs): Promise<Set<string>>

/** What `--affected` seeds its tasks from (2026-10-04). */
export interface AffectedChanges {
  projects: Set<string> // what affectedProjects returns
  changed: readonly string[] // workspace-relative changed paths
  paths: ReadonlyMap<string, readonly string[]> // project → its changed paths, project-relative
  whole: ReadonlySet<string> // reached whatever inputs say: lockfile claim, config import, nested repo
  wholeBy?: ReadonlyMap<string, string> // a whole project → the workspace-wide file that made it so
  wide?: boolean // wholeBy's file reached every project (the workspace config), not only those a claim named
  nested?: readonly string[] // changed nested repositories, workspace-relative: each stands for its files
  dirLinks?: ReadonlySet<string> // changed paths that are (or were) a link to a directory, workspace-relative
  dirLinksIn?: ReadonlyMap<string, ReadonlySet<string>> // project → its dirLinks, project-relative
  untrackedIn?: ReadonlyMap<string, ReadonlySet<string>> // project → its untracked changed paths, project-relative
  untracked?: ReadonlySet<string> // the changed paths git tracks neither now nor at the base, workspace-relative
}
export function affectedChanges(args: AffectedArgs, perTask?: boolean): Promise<AffectedChanges> // perTask false: affectedProjects' set only

/** Default base when `--affected` has no value: the base branch's ref; refused on that branch. */
export function defaultAffectedBase(
  workspaceRoot: string,
  baseBranch: string | undefined,
  instead?: string, // the verb's way to take every project instead (`vx show` has no --all)
): Promise<string>
/** The merge base of `ref` and HEAD, or undefined; a shallow clone fetches it
 *  (no blobs). The façade's, for a plugin reading the base branch's history. */
export function mergeBaseWith(workspaceRoot: string, ref: string): Promise<string | undefined>
/** Lockfiles a `fingerprint` plugin claims, so `--affected` can follow
 *  a per-project dependency closure instead of the whole fingerprint. */
export interface FingerprintClaims {
  readonly files: ReadonlySet<string>
  /** Project names a change to a claimed file affects; `undefined` = all. */
  affected(change: {
    file: string
    before: Uint8Array | null
    after: Uint8Array | null
    /** Changed files the claimant names (a patch, a `file:` directory), each side. */
    extras?: ReadonlyMap<string, { before: Uint8Array | null; after: Uint8Array | null }>
  }): Promise<ReadonlySet<string> | undefined>
  /** The files a claimed file names that its claimant keys too; absent = it reads none. */
  extraFiles?(file: string, bytes: Uint8Array): Promise<readonly string[] | undefined>
  /** The claimed file's per-project digests now and the hash of the bytes they came from; absent or `undefined` = the claimant keeps none. */
  digests?(
    file: string,
  ): Promise<{ hash: string; projects: Readonly<Record<string, string>> } | undefined>
  /** An extra file's hash now, from the run's hashes (`hashExtra`); absent = no check. */
  hashExtra?(rel: string): Promise<string>
}

/** The base `ref` names (`<base>...HEAD` reads as `<base>`) when it is the
 *  current HEAD, else undefined. A base that is already HEAD selects
 *  nothing, which is a clean exit rather than an empty run. */
export function headBase(workspaceRoot: string, ref: string): string | undefined
```

## Algorithm

0. The base is refused before any spawn when it is empty or starts
   with `-`: it reaches git as an argument (never a shell, so `$(…)` is
   opaque), but an option-like value is a real option — `--output=<path>`
   is an arbitrary file write from a CI-supplied string. Every git call
   in the module also ends its options (`--end-of-options`) before the
   ref, so a new caller cannot lose the guard by accident. A range
   (`A..B`, `A...B`) is refused there too, naming `A` as the base to
   pass alone: `rev-parse --verify` refuses a range, and its "did not
   resolve" blamed refs that exist. `..` is illegal in a ref name, so
   the check refuses no real ref.
1. `verifyRef(workspaceRoot, since)` — `git rev-parse --verify --quiet
--end-of-options <ref>`. Throws `UserError` if the ref doesn't resolve
   locally. A ref the default base's search already resolved to a
   commit (`resolvedRefs`, per workspace) is not asked again (#2288).
   On the merge-base path it runs only when `git merge-base` finds no
   base: a merge base proves the ref resolves, and the check was a
   synchronous spawn before every one.
2. `git diff --raw <merge-base(since, HEAD)>` (`<since>` itself
   when there is no merge base) — emits the union of committed, staged
   and unstaged changes. A path that is a gitlink (mode 160000) on either
   side, or an untracked `dir/`, is a nested repository: one path for every file
   in it, so it reaches the project holding it whole and every project
   under it (X-126). Matches Turbo's `[<since>]` semantics. A base
   that names HEAD's own ancestor (`HEAD~1`, `HEAD^2`) is its own merge
   base, so its resolved commit stands in and no `git merge-base`
   spawns (#2288). It runs with `diff.autoRefreshIndex=false`: a
   porcelain `diff` that meets a stat-dirty file rewrites the index under
   `index.lock`, ignoring `--no-optional-locks`, and a user's `git commit`
   beside the run failed on that lock. A file it then lists as modified
   whose content still hashes (`git hash-object`, a link's target in
   process) to the base's blob is dropped, so a stat-only change selects
   nothing, as the refresh did. A file a clean filter can rewrite
   (`core.autocrlf`, or a converting attribute per the key's own
   `git check-attr --all`, util `parseCheckAttrOutput`) stays: its
   filtered hash can match the base while the key, which hashes raw
   bytes, moved (a CRLF edit to an LF file). So does such a file git
   was told not to look at (`--assume-unchanged`). The diff also runs
   with `core.fileMode=true`, `core.trustctime=true` and
   `core.checkStat=default`, as the key does not trust the weaker view:
   under `core.fileMode=false` a `chmod +x` moved the key and selected
   nothing, and under `core.trustctime=false` or `core.checkStat=minimal`
   a same-size rewrite keeping its mtime (`cp -p`, `tar -x`) did the
   same. A file only the full stat calls dirty is hashed as above; on a
   normal repository these are git's defaults. A rewrite in place within
   the second the index recorded the file is still unseen: git compares
   a ctime by the second.
3. Untracked files (`git ls-files --others --exclude-standard`) are
   unioned in — a brand-new source file is a change. The `git config`
   that asks for a partial clone asks `core.ignorecase` too: set true on
   a disk that tells case apart (`ignoreCaseLies`), the listing runs with
   `-c core.ignorecase=false`, else a new `a.txt` beside the tracked
   `A.txt` selected nothing. `.vx/projects.lock.json` is
   no project's path: its entries are compared at the base and now (when
   both have a lock that parses), and a project whose entry changed is
   selected whole, so a lock rewritten over the same configs selects
   nothing. A changed path that is a link to a directory, or was a link (mode
   120000 on either side) and is no link to a file now, is a `dirLinks`
   entry: `declaresInput` matches it as a directory a glob may reach
   below, as the key does (`mayHoldMatch`), and a negation by the paths
   beneath it, never its name.
4. A changed ROOT file a `fingerprint` plugin claims (a lockfile under
   `@vzn/vx-lockfile`) is asked of its claimant, which names the
   projects whose dependency closure moved —
   [`lockfile-claim.md`](./lockfile-claim.md); one that appeared or went,
   or any "cannot tell", selects **every** project and the walk stops.
   Core keys no root file itself, so an unclaimed one (a lockfile with
   no plugin, `pnpm-workspace.yaml`) is an ordinary path, owned by the
   root project. A patch `bun.lock` names selects everything only while
   a plugin claims `bun.lock`.
   An extra file a claimed file's record names (a `file:` directory, a
   patch) whose hash now differs from the one the base's
   `.vx/dependencies.lock.json` records is a change to it too, though git
   lists none: a file git ignores inside it, or a directory outside the
   repository. With a claim plugin, every run with `--affected` checks
   them, through the hashes its key reads.
5. Otherwise each changed path reaches a project through **three
   channels**, and the union is returned:
   - **Containment.** Walk the path's ancestor dirs bottom-up until one
     is a project dir; the first hit is the DEEPEST containing project,
     so a **nested project wins over its parent**. A NEW nested project
     (its manifest absent or nameless at the base) also selects the
     project above it, whose inputs it took (D-1). (This replaced an
     earlier sort-by-directory-length-descending pass; the walk is
     O(files · depth) instead of O(files · projects).)
   - **Config imports.** A project whose `vx.config.*` transitively
     imports the changed file — see
     [`config-imports.md`](./config-imports.md). Resolved-config
     hashing folds those values into the key, so selection has to see
     them too. A changed file the workspace config imports selects
     every project; one it imports above the workspace root, which the
     `--relative` diff never lists, is asked of git by path
     (`outsideChanged`).
   - **Workspace globs.** For every changed path, `workspaceGlobOwners`
     (`cli/select.ts`) asks which projects declare
     a matching `inputs.workspaceFiles` glob — through the run
     path's staged load, so a glob a `project` plugin gave a
     config-less package counts. The match runs the entries through
     `asTrees`, the same rule `resolveWorkspaceFiles` applies, because
     this answers the question the KEY answers: with the entries raw,
     `./shared/**` and the literal `shared` folded a changed file into
     a project's key while selecting nothing, so `--affected` skipped a
     project its own key called stale (item 445). Every path, not only
     the ones no project owns: a glob may name a file inside another
     project (`schema.md` allows it), and asking only the unowned ones
     ran the owner alone (item 954). A path git tracks neither now nor
     at the base (`untracked`) under the task's own outputs
     (`outputs.workspaceFiles`, or its `outputs.files`) matches nothing,
     as the key folds only a tracked one there; one git stopped
     tracking is in the diff too, and the base key folded it, so it
     still matches. A task without `workspaceFiles` is skipped
     outright, and each distinct list is matched against the changed
     paths once, not once per task: tasks × paths took 14.5 s on 8000
     projects with 64k changed paths. The `--affected` sugar has staged
     every config for its graph walk already; a bare `[ref]` filter pays
     that one load when something changed.

   A changed manifest is no channel of its own: core reads no edge from
   it. A dependency added, removed or no longer satisfied moves the
   lockfile, and the lockfile plugin's claim (step 4) names the
   projects whose edges or closure moved; the dependents walk then
   follows today's edges.

Selection is never hashed, so widening it changes no cache key: every
channel here may over-select safely — but it may not UNDER-select, and
a channel that reads a declaration differently from the key does
exactly that. The config-import channel
[documents where it stops](./config-imports.md#where-this-stops).

`defaultAffectedBase` (2026-10-17):

- The base branch is the configured `baseBranch`, else the
  `origin/HEAD` symref's branch (one naming a branch the remote deleted
  is none), else `main`, else `master`; its ref is `origin/<name>`, else
  the local branch (a clone with no remote). Three spawns at once: the
  symref, one `for-each-ref`, HEAD's branch.
- On the base branch itself it refuses: there is no default (`HEAD~1`
  saw one commit of a multi-commit push); the last good commit is the
  caller's to name.
- With no base branch at all, a shallow clone fetches it from origin at
  depth 1 (the configured one, else origin's default from `ls-remote
--symref`); otherwise a `UserError` asks to set `baseBranch` or name
  the base (`--affected=origin/main`).
- `affectedChanges` diffs from the merge base of that ref and HEAD, or
  from the ref's tip when they share no history.

## Filter integration

`cli/select.ts:resolveFilters` invokes `affectedProjects` once per
`[<since>]` filter (`affectedChanges` for `--affected`'s), one after
another, starting before the workspace config and discovery with the
whole-tree walk beside them: those need only the root and the ref, and
`projects` is the discovery's promise. It stuffs the result in
`affectedByFilter: Map<ParsedFilter, Set<string>>`, then calls
`applyFilters({ filters, projects, graph, affectedByFilter })`.

This separation keeps `workspace/filter.ts` pure (no FS / no git
spawns) — easy to test against in-memory fixtures.

## What this does NOT do

- **Doesn't run `git fetch` in a whole clone.** If the local clone is
  stale, `affectedProjects` operates on stale refs. Only a shallow
  clone fetches, and only what its merge base needs
  (`reachMergeBase`): the base's tip at depth 1, then both tips
  deepened 1, 2, 4… commits (to 1,024) until git finds the merge base;
  a merge checkout whose parent is the base needs no deepening. Every
  fetch is `--filter=blob:none`: `--name-only` reads no blob. In a
  partial clone the diff is the base's tree against HEAD's plus HEAD's
  against the working tree, so no base blob is ever read (a stat-dirty
  file made `git diff <base>` fetch one per file; git 2.43 crashed).
  Probes set `GIT_NO_LAZY_FETCH`: a missing commit fetched its whole
  history. With no `remote.origin.url` nothing is fetched: a filtered
  fetch from no origin fails, yet first writes a promisor
  `[remote "origin"]` into the user's config.
- **Doesn't honor `.gitattributes` or `--diff-filter`.** A
  whitespace-only commit still marks projects as affected.
- **Doesn't intersect with `inputs.files`.** A project is
  affected if any file changed under its dir — even if no cached
  task lists that file as an input. (We default to "be permissive";
  Turbo behaves the same.)

## Tests

`tests/affected.test.ts`:

- single file change → owning project selected.
- file in nested project → nested project wins over parent.
- file outside any project → no project selected.
- bad git ref → UserError with the ref name.
- `defaultAffectedBase` returns `origin/<baseBranch>`, else the local
  branch; on that branch it refuses (no default, 2026-10-17).

Every git spawn goes through `spawnGitSync` / `spawnGit`: a git that is
not on PATH is util's `gitSpawnRefusal` (one line, the install named),
never the `ENOENT` stack `defaultAffectedBase` showed a minimal image
(item 241). `tests/no-git-on-path.test.ts`.
A base that fails outside a work tree, or in a repository with no commit
yet, says that (util's `notAWorkTree`, or "no commit yet") rather than
blaming the ref or a shallow clone; asked only after a base fails (X-52).
