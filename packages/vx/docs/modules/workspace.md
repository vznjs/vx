# `src/workspace/workspace.ts` — workspace discovery

## Purpose

Package globs come from the package manager's manifest and take its
full grammar: a negated entry (`!packages/fixtures`, `!**/test/**`)
subtracts from what the positive globs found — a literal one excludes
its tree, and a wildcard one is matched against the member's manifest
(`<pattern>/package.json`) as pnpm matches it, so `!**/test/**` excludes
`packages/test` itself (item 986) — in both discovery and the root-claim walk.
A negation applies whatever its position, as pnpm reads its own file: a
later positive glob does not re-include what it excluded. npm and bun
read `package.json` `workspaces` in order and disagree with each other
(npm drops a negation a later pattern matches as text; bun lets the last
pattern matching a path decide), so a list that re-includes after a
negation names a member vx leaves out (probed npm 10 and bun 1.4, D-147).
A read that finds nothing (a missing directory, a dangling link, no
config) is absent; a read the process could not make, out of file
descriptors (`EMFILE`, `ENFILE`), fails discovery with the `ulimit -n`
hint, where it had read the workspace as empty (D-60).
A symlinked member is found by any glob without `**` (`packages/*`,
`packages/{a,b}`, `pack*/*`); only `packages/*` found one until item 987.
Under `**` links are not followed, so the scan never walks a pnpm
`node_modules` link farm. Handed to the
glob engine raw, a leading `!` negated the whole pattern and made every
manifest in the tree a member (2026-09-10). Every entry goes through
`normalizeBunGlob` first: `!./packages/legacy` and `!packages//legacy`
excluded nothing until they did (same day). A trailing slash is dropped
before that, as npm and pnpm drop it: `normalizeBunGlob` gives a task
glob's trailing slash the meaning `/**`, and `packages/*/` found every
example and fixture package at any depth (item 985). A member glob keeps the
package manager's grammar, so a bracket there is a class and `\[` a
literal bracket — unlike a task glob, where a bracket is literal (item
667). The one form it refuses is extglob (`!(…)`, `@(…)`, `+(…)`,
`*(…)`, `?(…)`): npm and yarn read `packages/!(x)` as an exclusion,
`Bun.Glob` has no extglob and its scan widened the segment to a
wildcard (x became a project, turborepo#3766), so `assertGlobList`
refuses the entry by name, with the exact `!` rewrite when the group is
a whole segment of plain names. A brace whose alternatives hold a
slash (`packages/{a,nested/b}`) is scanned as its expansions:
`Bun.Glob`'s scan found nothing for one, though its match reads it, so
both packages vanished while the root still claimed them (D-2).

Find the workspace root, enumerate its projects, and resolve the
cache directory. Supports pnpm / npm / yarn / Bun workspaces, plus a
single-project mode (bare `package.json` with no `workspaces` field).

## Public surface

```ts
export interface PackageJson {
  name: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  workspaces?: string[] | { packages?: string[] }
}

export interface Workspace {
  root: string
  packageGlobs: string[] // patterns relative to root
}

export interface ProjectMeta {
  name: string // canonical from package.json
  dir: string // absolute project directory
  packageJson: PackageJson
  configPath: string | null // absolute path to vx.config.{ts,mts,js,mjs,cts,cjs}
}

export function findWorkspaceRoot(start: string, reads?: LoadReads): Promise<string>
export function loadWorkspace(root: string, reads?: LoadReads): Promise<Workspace>
export function listProjects(workspace: Workspace): Promise<ProjectMeta[]>
// listProjects, collecting each nameless member's dir into `nameless` (vx init)
export function discoverProjects(workspace: Workspace, nameless?: string[]): Promise<ProjectMeta[]>
// A `discover` hook's `{ dir, name }` as a meta; null when already found
export function namedProject(
  workspace: Workspace,
  known: readonly ProjectMeta[],
  named: { readonly dir: string; readonly name: string },
  by: string,
): Promise<ProjectMeta | null>
export function resolveCacheDir(root: string, config: WorkspaceConfig | null): string
export function resolveStoreRoot(
  root: string,
  config: WorkspaceConfig | null,
): Promise<string | null>

// A loaded project: its canonical name, directory and evaluated config.
// `ProjectMeta` is what discovery finds; this is what a run reads.
export interface ProjectEntry {
  name: string
  dir: string
  config: ProjectConfig
}

// Workspace members whose package globs match no directory — `vx run`
// warns with `unreachedHint`, which names them and what to check.
export function unreachedPackages(workspace: Workspace): Promise<string[]>
export function unreachedHint(unreached: readonly string[]): string

// Whether a member glob reaches any package.json but the root's,
// addressable or not; `vx init` names globs that reach none (M-46).
export function reachesManifest(workspace: Workspace): Promise<boolean>

// The directories a recursive watch must cover to see every member.
export function memberBaseDirs(workspace: Workspace): string[]

// A project's config file names, in the order discovery prefers them.
export const PROJECT_CONFIG_FILENAMES: string[]
```

From `src/workspace/load-reads.ts`, what one load has read of the root:

```ts
// Absolute path → the bytes, or null when no file is there.
export type LoadReads = Map<string, Promise<Uint8Array | null>>
// `file`'s bytes through `reads`: probed and read at most once per map.
export function readOnce(reads: LoadReads | undefined, file: string): Promise<Uint8Array | null>
```

A run reads the root manifest once. `findWorkspaceRoot`, `loadWorkspace`
and `computeWorkspaceFingerprints` each read `pnpm-workspace.yaml` for
themselves until 2026-09-24 — three probes and three reads per run;
`prepareRun` now hands all three one `LoadReads`, and so do the verbs
that pair the first two (`show`, `lock`, `init`, `watch`, the
selection pass, the doctor). The map is the load's and dies with it:
a `vx watch` cycle is a new run and reads the file afresh
(`tests/load-reads.test.ts` holds both). The probe stays ahead of the
read — most names asked about are absent, and a failed read costs
90–200 µs building its error where `exists()` answers in 15–40 µs.

## Discovery rules

### `findWorkspaceRoot(start)`

Walks up from `start` to the filesystem root. A directory is a root
CANDIDATE if it contains either:

- `pnpm-workspace.yaml`, OR
- `package.json` (with or without a `workspaces` field).

**The nearest candidate that CLAIMS `start` wins** — one of the
directories between it and `start` matches one of its package globs.
Every member has its own `package.json`, so first-match-wins would make
a run from inside a package treat that package as the whole workspace:
`^task` edges vanish, upstream hashes drop out of the cache key (stale
hits), and a second cache dir appears under the member. Claiming reads
the same globs `loadWorkspace` applies, and only a directory holding a
manifest can be the claimed member, as only such a directory is listed,
so "the root that claims me" and "the root that lists me as a project"
cannot diverge. They did until item 989: `packages/*` matched a
manifest-less `packages/tools`, and the standalone package below it ran
in a workspace that does not list it. A `pnpm-workspace.yaml` is a hard
root, as pnpm has it: the walk stops at the nearest one, listed by an
outer workspace or not. From `apps/inner` the walk went past its own file
to the outer workspace while `apps/inner/pkgs/x` stopped there, two roots
and two caches for one tree, until item 990.
A `package.json` with `workspaces` of its own is a root the same way
unless the outer root lists that directory itself, as npm reads it: a
nested workspace inside a member (`apps/tool/ws` under `apps/*`) was
claimed through `apps/tool`, and its members ran in a workspace that does
not list them (D-137). The converse holds too: an outer root that lists
both the nested root and the claimed member (`packages/**` over
`packages/inner` and `packages/inner/sub`) owns the member, since the
walk from `packages/inner` itself reaches it; `sub` resolved to `inner`
with its `^` edges into the outer workspace dropped until X-3.

When nothing claims `start` — a standalone package, or a subdirectory
of a single-project repo — the nearest candidate wins. A bare
`package.json` without `workspaces` means single-project mode: the root
itself IS the project. Throws a `UserError` if no candidate is found.
`unreachedPackages(workspace)` is the failure-path check for that mode:
one shallow scan (two levels, `node_modules` and dot directories
skipped) for the `package.json` files the missing globs never reach, and
`unreachedHint` is the line `vx init` and `vx run` print for them —
the cause, the packages, the `workspaces` entry to add.

### `loadWorkspace(root, reads?)`

Reads the package-glob list (through `reads`, so the manifest
`findWorkspaceRoot` just read is not read again):

| Manager                | Source                                                           |
| ---------------------- | ---------------------------------------------------------------- |
| pnpm                   | `pnpm-workspace.yaml`'s `packages:` field (via `Bun.YAML.parse`) |
| npm / yarn / bun (new) | `package.json` `workspaces: string[]`                            |
| yarn (legacy)          | `package.json` `workspaces: { packages: string[] }`              |
| single project         | `package.json` without `workspaces` → returns `['.']`            |

### `listProjects(workspace)`

Globs every `package.json` matching the patterns (`Bun.Glob`,
`onlyFiles: true`, `dot: false`). For each:

- Skip if no `name` field (`discoverProjects` collects the directory for
  `vx init`, which names one that has scripts, D-106).
- A member dir (`<dir>/*` shape) with a vx config but no `package.json` is
  skipped with a stderr line naming it (D-128): `--all` said only that no
  package matched, and a run from inside it "not inside a project".
- A file this user may not read is refused as a read (D-132):
  `<file>: not readable by this user (EACCES)`, for a member's manifest, a
  project config, the root's manifest and `vx.workspace.ts`. A manifest
  at mode 000 had dropped its project from `--all` under a green run. A
  member directory it may not search hides whether a manifest is there,
  so it is named on stderr and skipped (a service's data directory under
  `packages/*`). Any other glob shape is scanned, and the scan stops at
  such a directory and cannot skip it, so the load is refused naming the
  directory and the glob.
- A name several manifests share: pnpm accepts it (vite's playground,
  sveltejs/kit's test apps); vx cannot, since a project is addressed by
  its name. With no vx config among them they are left out, named on one
  stderr line, and the rest runs; with one, a `UserError` names every
  root-relative path and the way on (rename one, or a `!` glob).
- One package reached by two paths, a member and a link to it
  (`apps/docs` linking to `../packages/docs`), is one project, kept at the
  path that reaches it through no link (D-135); real paths are resolved
  only for a name several manifests share.
- Find the first existing `vx.config.{ts,mts,js,mjs,cts,cjs}` sibling; that
  becomes `configPath`. Projects without a config keep
  `configPath: null` — they're still in the workspace graph (so
  cross-package deps work) but contribute no tasks.
- `node_modules` paths are explicitly skipped even when a
  pathological `**` glob would match them.
- The root package is a project too when it holds a
  `vx.config.{ts,mts,js,mjs,cts,cjs}` and no glob lists `.` (D-39): a
  workspace-root task (Turbo's `//#task`, an Nx root project) without
  changing the package manager's member list. Its globs stop at every
  member, as any parent project's do. Design:
  `docs/design/root-project-2026-09-28.md`.

Returns the project list sorted by `name`.

### `resolveCacheDir(root, config)`

Resolves the cache directory:

- `config?.cacheDir` (set via `vx.workspace.ts`) is honored, else
  `VX_CACHE_DIR`. Relative paths resolve against `root`; absolute
  paths pass through.
- Default: `<root>/.vx/cache`.

### `resolveStoreRoot(root, config)`

Where the repository's shared store lives: `~/.vx/<id>/cache` on every
platform (`$HOME` before the passwd entry), the id `repoIdOf(root)`
(`repo-id.ts`, Nx 23's `~/.nx/<id>` rule, read from the `.git` files;
git is spawned only for a repository with no parseable remote: one
`rev-list` for its root commit, asynchronously, so `prepareRun` asks it
before discovery and awaits it when the cache opens; shallow is read from
the common dir's `shallow` file; the root is realpathed first, as git
resolves it, so a symlinked path to the workspace is the same id). Null
when the workspace names its cache dir (`cacheDir`, `VX_CACHE_DIR`),
which then holds everything, with no repository id, or with no home. A run given `--cache-dir` passes null itself.

Used by `prepareRun` (so `run` and `planRun`), the doctor, and every
reading verb through `cli/workspace-config.ts` — `vx cache prune`
included (`cliCacheDir`: `--cache-dir`, else this over the config with
the plugin `config` stage applied).

## What this does NOT do

- **Doesn't load configs.** `loadProjectConfig` does (see
  [`project-loader.md`](./project-loader.md)). Discovery is purely
  about "what packages exist and where?"
- **Doesn't compute the package graph.** That's
  [`package-graph.md`](./package-graph.md).
- **Doesn't filter projects.** `--filter` / `--affected` happen in
  `cli/select.ts` (`resolveFilters`).
- **Doesn't enforce project boundaries.** `inputs.ts` does, using
  the nested-dirs precomputation.

## Tests

`tests/workspace.test.ts`:

- pnpm-workspace.yaml discovery.
- npm/yarn/bun `workspaces` array form.
- yarn legacy `workspaces.packages` form.
- bare-`package.json` single-project mode (`['.']`).
- duplicate-name detection.
- `findWorkspaceRoot` ascending behavior + missing-root error.
- glob behavior (one project, multiple projects, nested
  `node_modules` skipped).

## Replacing this module

- **Lerna / Rush layouts** — replace `loadWorkspace` to parse the
  appropriate config file. Keep `Workspace` shape.
- **Custom workspace yaml** — add another source to `loadWorkspace`.
- **Project discovery beyond `package.json`** — e.g., reading
  `pyproject.toml` for non-JS deps. Would require generalizing
  `ProjectMeta.packageJson` into a more abstract `manifest` field.
