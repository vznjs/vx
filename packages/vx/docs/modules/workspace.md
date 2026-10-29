# `src/workspace/workspace.ts` — workspace discovery

## Purpose

Find the workspace root, find its projects, name them, and resolve the
cache directory. **A project is a directory holding a `vx.config.*`**, in
any language (2026-10-14): core reads no `package.json` and no
package-manager member list. `vx lock` finds the directories
(`findProjectConfigs`) and records each by directory; a run takes its
projects from the lock (`lockedProjects`), then the plugin `discover`
stage, which may add directories (`discoveredProject`), name them and give
edges (`linkDiscoveredEdges`). `checkProjectNames` ends the stage. Core reads
no package manager's members; `@vzn/vx-migrate` does, for an adoption.
Design:
`docs/design/language-agnostic-core-2026-10.md`.

## Public surface

```ts
export interface ProjectMeta {
  name: string // config `name`, else a `discover` plugin's, else its root-relative path (`//` for the root)
  dir: string // absolute project directory
  configPath: string | null // absolute vx.config.{ts,mts,js,mjs,cts,cjs}; null for a project a plugin added
  deps?: readonly string[] // project names a `discover` plugin orders this one after ([] when an entry carried none)
  reach?: readonly string[] // project names a `discover` plugin reaches it through, no order
}

// A loaded project: its name, directory and evaluated config.
// `ProjectMeta` is what discovery finds; this is what a run reads.
export interface ProjectEntry {
  name: string
  dir: string
  config: ProjectConfig
}

// A directory holding a vx config, and the file precedence picked there.
export interface ConfigDir {
  readonly dir: string
  readonly configPath: string
}

// `vx lock`'s review copy of a project's resolved config: 'vx.lock.json'.
export const REVIEW_FILE: string
// The configs, and the review copies in a directory with no config.
export interface ProjectConfigs {
  readonly configs: ConfigDir[]
  readonly strayReviews: string[]
  readonly shadowed: { file: string; read: string }[]
}

// A project's config file names, in the order discovery prefers them.
export const PROJECT_CONFIG_FILENAMES: string[]
// The root project's name when nothing names it (Turbo's spelling).
export const ROOT_NAME: '//'

// the directory of the nearest .vx/workspace.* up to the git top-level
// (handoff.ts workspaceFile); VX_E_NO_WORKSPACE without one
export function findWorkspaceRoot(start: string, uid?: number): Promise<string>
// A project's name when nothing names it: its root-relative POSIX path, `//` for the root
export function pathName(root: string, dir: string): string
// Every directory holding a vx config, for `vx lock`; sorted by directory
export function findProjectConfigs(root: string): Promise<ProjectConfigs>
// The projects a lock records, named by the config's `name`, else by path
export function lockedProjects(
  root: string,
  locked: Readonly<Record<string, { readonly file: string; readonly config: ProjectConfig }>>,
): ProjectMeta[]
// `dir` at the directory it leads to, under `root` as given; `dir` when
// that lies outside the root, null when absent
export function canonicalDir(root: string, dir: string): string | null
// The project a `discover` entry names: new (`added`) or the one already
// at its real dir, renamed when its path named it. `deps` / `reach` are
// checked to be string arrays here and resolved by linkDiscoveredEdges
export function discoveredProject(
  root: string,
  known: ReadonlyMap<string, ProjectMeta>, // by dir
  entry: { dir: string; name?: string; deps?: readonly string[]; reach?: readonly string[] },
  by: string,
): Promise<{ meta: ProjectMeta; added: boolean }>
// After the stage: each edge dir to the project there, as ProjectMeta
// `deps` / `reach` (sorted names; `deps: []` for an entry that carried an
// empty list, so the graph sees an edge source); a target outside the root
// or no project is refused naming the plugin
export function linkDiscoveredEdges(
  root: string,
  projects: readonly ProjectMeta[],
  edges: readonly {
    by: string
    meta: ProjectMeta
    deps: readonly string[] | undefined
    reach: readonly string[]
  }[],
): void
// Sorts by name; refuses two projects of one name and a name no spec can address
export function checkProjectNames(root: string, metas: ProjectMeta[]): ProjectMeta[]
export function resolveCacheDir(root: string, config: WorkspaceConfig | null): string
export function resolveStoreRoot(
  root: string,
  config: WorkspaceConfig | null,
): Promise<string | null>
```

From `src/workspace/load-reads.ts`, what one load has read of the root:

```ts
// Absolute path → the bytes, or null when no file is there.
export type LoadReads = Map<string, Promise<Uint8Array | null>>
// `file`'s bytes through `reads`: probed and read at most once per map.
export function readOnce(reads: LoadReads | undefined, file: string): Promise<Uint8Array | null>
```

A load reads each root file once: the workspace fingerprint and `vx init`'s
package workspace share one `LoadReads`. The map is the load's and dies
with it: a `vx watch` cycle is a new run and reads afresh
(`tests/load-reads.test.ts`). The probe stays ahead of the read — most
names asked about are absent, and a failed read costs 90–200 µs building
its error where `exists()` answers in 15–40 µs.

## Discovery rules

### `findWorkspaceRoot(start)`

The root is the directory holding the nearest `.vx/workspace.*` from
`start` up to the git top-level, inclusive (a worktree's `.git` file is a
top-level, a submodule's too; a submodule goes on to its superproject, and so does an
embedded repository the outer git does not ignore, whose configs
`findProjectConfigs` lists as the outer workspace's), or up to `/` outside
git. Nothing else decides it: not a `package.json`, `pnpm-workspace.yaml`
or a lockfile (2026-10-13: "Workspace file is the ultimate",
"never go out of git root"). A file above the checkout is never read.
Outside git, a file another user owns above `start` is refused (root
aside): it is code that would run as you. Without one the error is
`VX_E_NO_WORKSPACE`, naming `vx init`
(`tests/workspace-root-file.test.ts`). The lookup is `workspaceFile` in
`handoff.ts`, shared with the hand-off and the config loader, once per run.

### `findProjectConfigs(root)`

`vx lock`'s walk; a run never walks. In git: `git ls-files` over the
config names, tracked and untracked, git's ignore rules applied, so a
config git ignores is no project. A nested repository is one entry to the
outer git (a submodule's gitlink, an embedded repository's untracked
`dir/`): its own git lists its configs, or a walk when it has no `.git`,
as the input enumeration expands one. Outside git: a walk that skips
`node_modules`, `.git` and `.vx`, and enters every other dot-directory,
as git lists `.github/actions/x`. A config at or under a nested
`.vx/workspace.*` is that workspace's and is left out. Where a directory
holds several, `PROJECT_CONFIG_FILENAMES` order picks the first that is a
file (a directory may carry a config's name; git lists a tracked config
deleted from the worktree). Every other file there is `shadowed`, with
the one read, and so is a root `.vx/workspace.*` behind another: `vx lock`
names each, since an edit to it changes nothing. The same listing names each `vx.lock.json`
(`REVIEW_FILE`): one in a directory with no config is `strayReviews`,
which `vx lock --check` names. Left where a project's config was
deleted, it is a source of the project around it, and a `**` reader
there was keyed on a copy no `vx lock` rewrites (2026-10-23).

### A directory reached through a symlink

A project is its real directory. A `discover` entry, an edge or a
`./path` filter naming a link (pnpm's `widgets/**` with
`widgets/a -> ../submodules/a`) is the project at the directory it
leads to, spelled under the root as given (`canonicalDir`); git lists
the config there, not at the link. Joined by spelling, one directory
was two projects: the configured one, which nothing depended on, and a
config-less twin at the link taking every `^task` edge
(vercel/turborepo#12489). A link leading out of the root stays a
project at the link. Only a directory no project holds is resolved, so
locked projects cost no syscall (`tests/discover-stage.test.ts`).

### Names

A project's name is, in order: its config's `name`; the name a `discover`
plugin gives (`@vzn/vx-lockfile` gives `package.json#name`); its
root-relative POSIX path (`apps/web`), `//` for the root. A plugin renames
only a project its path names: a config's `name` wins silently, and a
different name from a second plugin is refused naming the first. Two
projects of one name are refused naming both directories; a path that
holds `#`, or `//` away from the root, is refused asking for `name`
(`tests/discovery-refusals.test.ts`, `tests/project-dirs.test.ts`).

### `resolveCacheDir(root, config)`

Resolves the cache directory:

- `config?.cacheDir` (set via `.vx/workspace.ts`) is honored, else
  `VX_CACHE_DIR`. Relative paths resolve against `root`, `~` and `~/`
  against the home directory; absolute paths pass through.
- The home directory itself is refused: the cache writes a `*`
  `.gitignore` beside its index (D-153).
- Default: `<root>/.vx/cache`.

### `resolveStoreRoot(root, config)`

Where the repository's shared store lives: `~/.vx/<id>/cache` on every
platform (`$HOME` before the passwd entry), the id `repoIdOf(root)`
(`repo-id.ts`, Nx 23's `~/.nx/<id>` rule, read from the `.git` files;
git is spawned only when the config file cannot settle it: `remote -v`
when it names a remote none of whose urls parse, holds an `include` or
`url` rewrite, or sets `extensions.worktreeConfig` (as Nx; a remote-less
config spawns none of it), then `rev-list` for a root commit,
asynchronously, so `prepareRun` asks it
before discovery and awaits it when the cache opens; shallow is read from
the common dir's `shallow` file; the root is realpathed first, as git
resolves it, so a symlinked path to the workspace is the same id). Null
when the workspace names its cache dir (`cache.dir`, `VX_CACHE_DIR`),
which then holds everything, with no repository id, or with no home. A run given `--cache-dir` passes null itself.

Used by `prepareRun` (so `run` and `planRun`), the doctor, and the
verbs that open the store through `cli/workspace-config.ts` (`vx cache
clean`, a plugin verb's cache), over the config with the plugin `config`
stage applied. There it is asked on first use: a verb that never opens
the store (`vx help`, `show`, `last`, `why`, `completions`) spawns no git
for it (`tests/reading-verbs-git.test.ts`).

## What this does NOT do

- **Doesn't load configs.** `loadProjectConfig` does (see
  [`project-loader.md`](./project-loader.md)), for `vx lock`; a run reads
  the lock.
- **Doesn't read package manifests.** A `discover` plugin does
  (`@vzn/vx-lockfile`); `@vzn/vx-migrate` reads them for an adoption.
- **Doesn't compute the package graph.** That's
  [`package-graph.md`](./package-graph.md).
- **Doesn't filter projects.** `--filter` / `--affected` happen in
  `cli/select.ts` (`resolveFilters`).
- **Doesn't enforce project boundaries.** `inputs.ts` does, using
  the nested-dirs precomputation.

## Tests

- `tests/project-dirs.test.ts`: a config alone makes a project, named by
  its path; `//` for the root; `name` over a plugin's over the path;
  duplicates refused; an ignored config and a nested workspace's are no
  project; a config added after `vx lock` waits for it; a version 2 lock
  is refused; a package-manager member with no config is no project;
  `--affected` without a plugin.
- `tests/discovery-refusals.test.ts`: each refusal whole.
- `tests/discover-stage.test.ts`: the stage over the locked projects.
- `tests/contract-discovery.test.ts`: the walk and the root, as recorded.
- `tests/workspace-root-file.test.ts`: `findWorkspaceRoot`.
