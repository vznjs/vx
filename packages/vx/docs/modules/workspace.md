# `src/workspace/` — discovery, config and selection

## `src/workspace/workspace.ts` — workspace discovery

### Purpose

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

### Public surface

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
  // the outermost nested workspace roots, absolute: `vx lock` records them
  readonly nestedWorkspaces: string[]
  // listed configs a sparse checkout left out: `vx lock` refuses them
  readonly sparse: { file: string; add: string }[]
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
// Why `dependsOn` or `--filter` would read a project name as something else, or null
export function projectNameProblem(name: string): string | null
export function resolveCacheDir(root: string, config: WorkspaceConfig | null): string
export function resolveStoreRoot(
  root: string,
  config: WorkspaceConfig | null,
): Promise<string | null>
```

From `src/workspace/repo-id.ts`:

```ts
// Every id `repoIdOf` gives `root` now or gave it before a remote was added
// (the remote's, the root commit's): the stores `vx cache clean` may delete
// when its index names them.
export function repoIdsOf(root: string): Promise<string[]>
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

### Discovery rules

#### `findWorkspaceRoot(start)`

The root is the directory holding the nearest `.vx/workspace.*` from
`start` up to the git top-level, inclusive (a worktree's `.git` file is a
top-level, a submodule's too; a submodule goes on to its superproject, and so does an
embedded repository the outer git does not ignore, whose configs
`findProjectConfigs` lists as the outer workspace's), or up to `/` outside
git. Nothing else decides it: not a `package.json`, `pnpm-workspace.yaml`
or a lockfile (2026-10-13: "Workspace file is the ultimate",
"never go out of git root"). A file above the checkout is never read.
Outside git, a file another user owns above `start` is refused (root
aside): it is code that would run as you. An entry by a workspace name
that is no file (a broken link, a directory), with no file beside it,
marks the root all the same and is refused by name, `VX_E_CONFIG`. Without one the error is
`VX_E_NO_WORKSPACE`, naming `vx init`, or `git sparse-checkout add .vx`
when the git top-level's workspace file is in the index but a sparse
checkout left it out (git asked only then)
(`tests/workspace-root-file.test.ts`). The lookup is `workspaceFile` in
`handoff.ts`, shared with the hand-off and the config loader, once per run.

#### `findProjectConfigs(root)`

`vx lock`'s walk; a run never walks. In git: `git ls-files` over the
config names, tracked and untracked, git's ignore rules applied, so a
config git ignores is no project, and none under a `.vx` directory, at
any depth, as the walk skips it (`.vx/workspace.*` still marks a nested
workspace). A nested repository is one entry to the
outer git (a submodule's gitlink, an embedded repository's untracked
`dir/`): its own git lists its configs, or a walk when it has no `.git`,
as the input enumeration expands one. A linked worktree of the same
repository made inside it (`git worktree add .worktrees/x`) is this tree
checked out again and is skipped, not a nested workspace: recorded as
one, the lock failed `--check` on every other checkout. Outside git: a walk that skips
`node_modules`, `.git` and `.vx`, and enters every other dot-directory,
as git lists `.github/actions/x`. A config at or under a nested
`.vx/workspace.*` is that workspace's and is left out: any entry, a
broken link or a directory too, as the root walk stops at one, but not a
tracked one deleted from the worktree. Where a directory
holds several, `PROJECT_CONFIG_FILENAMES` order picks the first that is a
file (git lists a tracked config deleted from the worktree, skipped;
one a sparse checkout left out, skip-worktree in the index, is
`sparse`, which `vx lock` refuses, naming them all in one `git sparse-checkout add`:
skipped, its project left the committed lock).
With no file, an entry by a config's name (a broken link, a directory)
is refused by name, as the root walk refuses one: skipped, its project
was in no lock and nothing said so. Every other file there is `shadowed`, with
the one read, and so is a root `.vx/workspace.*` behind another: `vx lock`
names each, since an edit to it changes nothing. The same listing names each `vx.lock.json`
(`REVIEW_FILE`): one in a directory with no config is `strayReviews`,
which `vx lock --check` names. Left where a project's config was
deleted, it is a source of the project around it, and a `**` reader
there was keyed on a copy no `vx lock` rewrites (2026-10-23).

#### A directory reached through a symlink

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

Discovery follows no link. Outside git the walk does not enter one; in
git, a config the index lists behind a symlinked directory (a project
moved and linked back, `b -> real/b`) is skipped, as git calls it
deleted: locked, `b` and `real/b` were two projects over one directory,
their tasks writing the same `dist` (`tests/discovery-links.test.ts`).

#### Names

A project's name is, in order: its config's `name`; the name a `discover`
plugin gives (`@vzn/vx-lockfile` gives `package.json#name`); its
root-relative POSIX path (`apps/web`), `//` for the root. A plugin renames
only a project its path names: a config's `name` wins silently, and a
different name from a second plugin is refused naming the first. Two
projects of one name are refused naming both directories; a path that
holds `#`, one `dependsOn` or `--filter` would read as something else
(`projectNameProblem`: `*`, a leading `^` or `!`, `tag:`, `...`, `[<ref>]`,
`./`), or `//` away from the root, is refused asking for `name`
(`tests/discovery-refusals.test.ts`, `tests/project-dirs.test.ts`).

#### `resolveCacheDir(root, config)`

Resolves the cache directory:

- `config?.cacheDir` (set via `.vx/workspace.ts`) is honored, else
  `VX_CACHE_DIR`. Relative paths resolve against `root`, `~` and `~/`
  against the home directory; absolute paths pass through.
- The home directory itself is refused: the cache writes a `*`
  `.gitignore` beside its index (D-153).
- Default: `<root>/.vx/cache`.

#### `resolveStoreRoot(root, config)`

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

### What this does NOT do

- **Doesn't load configs.** `loadProjectConfig` does (see
  [`workspace.md`](#srcworkspaceproject-loaderts--config-file-evaluation)), for `vx lock`; a run reads
  the lock.
- **Doesn't read package manifests.** A `discover` plugin does
  (`@vzn/vx-lockfile`); `@vzn/vx-migrate` reads them for an adoption.
- **Doesn't compute the package graph.** That's
  [`workspace.md`](#srcworkspacepackage-graphts--project-dep-graph).
- **Doesn't filter projects.** `--filter` / `--affected` happen in
  `cli/select.ts` (`resolveFilters`).
- **Doesn't enforce project boundaries.** `inputs.ts` does, using
  the nested-dirs precomputation.

### Tests

- `tests/project-dirs.test.ts`: a config alone makes a project, named by
  its path; `//` for the root; `name` over a plugin's over the path;
  duplicates refused; an ignored config and a nested workspace's are no
  project, and one in a directory a plugin discovers is refused, naming
  the plugin, by `vx lock`, `--check` and a run; a config added after `vx lock` waits for it; a version 2 lock
  is refused; a package-manager member with no config is no project;
  `--affected` without a plugin.
- `tests/discovery-refusals.test.ts`: each refusal whole.
- `tests/discover-stage.test.ts`: the stage over the locked projects.
- `tests/contract-discovery.test.ts`: the walk and the root, as recorded.
- `tests/workspace-root-file.test.ts`: `findWorkspaceRoot`.

## `src/workspace/project-loader.ts` — config file evaluation

### Purpose

Evaluate a `vx.config.{ts,mts,js,mjs,cts,cjs}` file and return the resolved
`ProjectConfig` object. Bun runs TypeScript natively, so the loader is
a thin wrapper around `await import()`.

Two paths, chosen by whether this process has loaded that path before:

- **First load** — in-process `await import()` with a content-hash
  query-string bust. The single `vx run` hot path only ever takes this
  one, so it costs exactly what it always did.
- **Repeat load** — re-evaluated in a Worker (`config-eval.ts`),
  because the bust cannot reach the config's import closure.

### Public surface

```ts
export async function loadProjectConfig(configPath: string): Promise<ProjectConfig>
export async function loadWorkspaceConfig(workspaceRoot: string): Promise<WorkspaceConfig | null>

// The batch form: one staged evaluation round for many configs. Every
// config is evaluated; nothing is cached (runs read the lock). With `root`,
// each evaluates with it as process.cwd(); without, the cwd is left as is.
export async function loadProjectConfigs(
  configPaths: readonly string[],
  root?: string,
): Promise<ProjectConfig[]>

// Thrown by the batch when more than one config refuses: the first's
// message, and `all` of them, so `vx lock` names each.
export class ConfigsRefused extends UserError {
  readonly all: readonly UserError[]
}

// The names a workspace config may take, in resolution order.
export const WORKSPACE_CONFIG_FILENAMES = [
  '.vx/workspace.ts',
  '.vx/workspace.mts',
  '.vx/workspace.js',
  '.vx/workspace.mjs',
  '.vx/workspace.cts',
  '.vx/workspace.cjs',
]

// A Bun `ResolveMessage` / `BuildMessage`, or the stackless `SyntaxError` of a
// malformed JSON import, as a one-line UserError naming the config (and the
// file, for a syntax error in an import); null for anything else.
export function configLoadError(err: unknown, configPath: string, kind: string): UserError | null
```

What the evaluated object may contain is `config-schema.ts`'s
business (`validateProjectConfig`, `validateWorkspace`); the loader
calls both after evaluation and re-exports `validateProjectConfig` for
readers that reach it here.

### Loading rules

- Supported extensions: `.ts`, `.mts`, `.js`, `.mjs`. Each is handed
  to a native `await import()`. Bun resolves TypeScript natively —
  no transpile step, no separate loader, no `jiti`.
- On a first load the import specifier is
  `<absolutePath>?vx-bust=<xxh3-of-bytes>`; a project config evaluated
  from the bytes the loader read (below) is imported under its plain
  path, `?vx-held=` only when Bun's registry already held that path.
  Content changes produce a different query string → different ESM
  module identity → fresh evaluation. Same content → cached module (the
  no-op fast path).
- Bun's resolver reads `\` as a separator, even in a `file:` URL, and
  cuts a path at its first `?` as a query, so a config whose path holds
  either (a project under `a\b` or `a?b`) is imported under
  `?vx-literal=`: an `onResolve` keeps the path as written and the held
  bytes are served, the workspace config's too. Such a config must be
  UTF-8 ESM (else refused), and its relative imports still fail in Bun.
  The worker serves it the same way, read from disk.
- On a repeat load the path is evaluated in a Worker instead, and the
  resolved object comes back as JSON.
- Configs load 128 at a time (`LOAD_WIDTH`), not one after another:
  1,000 cold configs' `load configs` went from 226 to 164 ms at 64
  (D-68), and from 432 to 411 ms at 128 (stream I). Results keep the
  order they were asked in, a failure stops none of the others, and the
  error thrown is the first in that order.
- The default export must be a non-null object. Anything else throws
  `"Project config at <path> did not export a default object"` (a function default export adds `: it exports a function, …`, D-110)
  (`Workspace config at …` for a workspace file) — from
  the same check on both paths.
- Both paths read the same environment: each Worker request carries the
  parent's `process.env` as it is at that moment, and the Worker syncs to
  it before the import. A Worker otherwise starts with the process's
  startup environment, so a config reading a variable the process set
  since saw it on the first load and not on later ones, and an
  embedder's second `run()` derived a different key (D-61).
- What a config prints in the Worker goes to stderr, by every route
  (`console`, `process.stdout.write`, `Bun.write(Bun.stdout)`,
  `Bun.stdout.writer()`): the parent's stdout may be a verb's
  JSON, whose own redirect covers only the parent thread, and a repeat
  load's config output landed in it (D-64). The first load, in process, sends them to stderr too while
  the round evaluates: a verb's stdout is its output, and a config's
  `console.log` came out ahead of `vx show --format json`'s JSON.
  Below those routes, fd 1 itself is stderr's while a round of project
  configs evaluates (`dup2` through `bun:ffi`; libc bound once, ~0.7 ms):
  `import { writeSync } from 'node:fs'` is a copy Bun took when vx first
  imported it, `writeFileSync('/dev/stdout')` opens the descriptor anew,
  and a child the config spawns inherits it, so all three printed ahead of
  `vx lock --check --format json`'s JSON. The worker shares the
  descriptor, so a repeat load is covered by the same swap. Only the lock verb
  evaluates project configs, so a run never binds libc for this. The
  workspace config, loaded on every run, gets the JS routes alone.
- A config that throws something other than an Error (`throw 'no'`, a
  plain object) fails as a user error naming the config, on both paths:
  "Project config <path> threw "no", which is not an Error". It
  printed `vx: no`, naming no file, and a null-prototype object crashed
  vx's error printer.
- A config that calls `process.exit` while it evaluates fails the load,
  at the config's line, on both paths: "process.exit(0) in a config: a
  config exports its object; it cannot end the run". In process
  it ended vx mid-load (`exit(0)` was a green run that ran nothing); in
  the Worker it ended the Worker unheard, and the load waited out its
  deadline (D-65). The guard is counted, so concurrent loads leave the
  real `process.exit` in place only once the last has left. An exit a
  config schedules for later (a timer) is not covered.
- A first load may not change the built-ins vx runs on:
  `Object.prototype`, `Array.prototype`, `String`, `Map`, `Set`,
  `Promise`, `RegExp`, `Function`, `Number` and `Date` prototypes,
  `Object`, `Array`, `Reflect`, `Date`, `Bun`, `Bun.hash`, `JSON` and
  `Math`. The check reads through primitives taken before any config runs,
  in indexed loops: a config that set `Reflect.ownKeys = () => []` (or
  `Array.prototype.forEach`) blinded it before, and its
  `Object.prototype.exec` ran in another project's task (D-124; +2 ms on a
  cold 300-config load, none warm). Every
  config is read through them and cache keys are made with them
  (`Bun.hash.xxHash3 = () => 7n` keyed every task 00000000, D-75), and
  the key folds each config's own JSON, so `Object.prototype.exec` set in one config ran in another
  project's task and a cache hit replayed the old command after it
  changed (D-74). Each first load is compared with a snapshot taken
  before its round evaluates anything, before anything reads through
  them (a replaced `Array.prototype.includes` broke the JSON-data walk
  itself); what changed is put back, a failed load's too, and the load
  is refused naming the property. Loads overlap (`LOAD_WIDTH` at a time),
  so the load that sees a change may not be the one that made it: when
  more than one evaluation was in flight, the round evaluates each of its
  configs alone in a throwaway worker that reports what it changed, and
  names the first that changes something (it named an innocent config
  before, D-119); none found, it says "a project config". While loads
  overlap, each one is checked against only the built-ins the loader
  itself reads through between loads (`Object.prototype`, `JSON`, the
  `Promise`, `Map` and `Set` prototypes, `Bun.hash`), and the rest once,
  at the round's end: all of them after every load was ~73 µs a config,
  a quarter of a cold load of 1,000. A change found at the end may have
  broken another config's load, so it is refused first. A lone load
  checks them all.
- A first load may not move the process either: a config's
  `process.chdir()` left every relative path vx resolved after it reading
  from the config's choice; the working directory is put back and the load
  refused, naming `process.cwd (a chdir)` (D-120).
- The lock verb evaluates every project config with the workspace root as
  `process.cwd()`, wherever it was run, and puts the invoking directory
  back after the round. It saw the invoking directory before, so a config
  reading the cwd made the lock depend on where it ran, and
  `vx lock --check` from a subdirectory failed a lock written at the root.
  Not the project's own directory: the cwd is the process's (the worker's
  too) and loads overlap, so a cwd per config would serialize them.
  `import.meta.dir` is the config's own directory.
- `.vx/workspace.ts` gets the same guard: it runs in this process too, and
  its `Object.prototype.exec` ran in a project's group task. Built-ins,
  `process.env`, the cwd and the umask are snapshotted around its load, put
  back, and the load refused naming the file, a failed load's change
  included (D-126): the workspace config's bytes are in no key, so a
  removed `Object.prototype.exec` replayed the old command. Globals are
  left out: it loads first in every run, filtered or not. Of `Bun` it reads
  the descriptors of the members vx reads (`BUN_MEMBERS_VX_READS`, held to
  every `Bun.<name>` in `src/`) and keeps the rest's keys and order: some
  members are built on their first read (`Bun.postgres` loads `bun:sql`),
  and the full read was 4.4–5 ms of every warm run. A replaced member vx
  does not read is not caught here.
- Nor change the umask: a config's `process.umask(0o777)` left every file
  vx and its tasks wrote after it `000`, a cache artifact a user other than
  root could not read back. A worker shares the process's umask (a
  `chdir` there stays the worker's), so a repeat load is checked too, and
  the load is refused naming `process.umask` (D-125). Bun reads the umask
  by setting 0 and putting it back, so two threads reading it at once see
  each other's 0 and can leave the process there: the main thread alone
  reads it, around a load that is alone in its round or before and after
  a round of several, and the worker only when blaming a config, the one
  evaluation in flight, putting it back before it answers; the round puts it
  back after each blame too, as a worker ended at its budget restores
  nothing (`config-umask-concurrent.test.ts`).
- A first load may not add or replace a global either: one config's
  `globalThis.x = …` reached every config loaded after it in the process,
  so `vx run --all` read it and a `--filter` of the reader alone did not
  (D-122). `globalThis` is watched with the built-ins above: put back,
  refused naming `globalThis.<key>`; a constant configs share goes in a
  module each one imports. Cost: +3 ms on a cold 300-config load, none warm.
- Nor change a module another config imports: first loads share the
  module registry, so a config's `reg.push('a')` on a shared module reached
  every config evaluated after it, and the lock recorded b's `echo a,b` beside
  a and `echo b` without it, or when a loaded later. Isolating each config
  would take a worker per config, which D-68 measured out. Instead, before
  any config evaluates, a round of several first loads imports each local
  module that two or more of them reach by static import, in the order the
  configs reach them, and notes what its exports hold: every value reached
  through own properties and `Map` / `Set` entries, compared by identity,
  getters not called (`module-state.ts`). Once every config has loaded, a
  change is refused, naming the export and the module; a throwaway worker
  evaluates each importer alone to name the config that made it, as
  D-119 does. Importing first evaluates nothing a config would not, and
  what could make a shared module evaluate differently by order is a
  global or another shared module, both refused when changed. Shared
  modules that change one another as they evaluate do so in every round
  alike and are not refused. Not reached: state a module keeps unexported
  behind a function, a module reached only by dynamic `import()`, and a
  repeat load in the worker. Cost: none measured on a cold load of 1,000
  configs sharing one preset (min of 20: 150.7 → 144.0 ms).
- A first load may not change `process.env` either: a config that set
  a variable gave it to every project's `passThrough` and to vx's own
  `VX_*` reads, and a repeat load, in a worker, gave it to neither
  (D-76). The same snapshot, compare, put back and refuse; a task gets
  a value through `exec.env.define` or the host's `passThrough`. While
  loads overlap it is compared once, at the round's end, as most
  built-ins are: reading every variable after every load was 15–25 µs a
  config.
- A first load has the Worker's deadline too (`VX_CONFIG_WORKER_TIMEOUT`,
  30 s): a top-level await that never settles fails the load, naming
  the config and the budget, where it hung `vx run` silently (D-66).
  A Promise default export is awaited under the budget too, its own
  after the import's: one that never settled hung every verb.
  At 5 s, on both paths, vx says once which config is still evaluating,
  so the wait to the budget is not silent; a load that ends clears it.
  The evaluation itself cannot be cancelled; a timer it left running
  still holds the process open after the run reports. A synchronous
  loop (`while (true) {}`) holds the thread the deadline fires on, so it
  hangs until killed; a repeat load, in its Worker, still fails at the
  budget. Bounding it would take the worker per config D-68 measured out.
- A Promise default export is awaited on both paths, so an async
  config resolves to its object on the first load and in the Worker
  alike (D-5). The awaited value is checked again, a workspace
  config's too (D-6).
- Validation runs on the JSON copy both paths produce, so a malformed
  config reports the identical `UserError` either way. On the live
  object, a getter in an array or a Proxy answered the check with one
  value and the copy, which the lock stores, with another
  (`outputs.files: ['../victim/**']` reached the lock unchecked).
- A value JSON cannot carry (a function, `NaN`, a `Map`, …) is refused
  by both paths with one message (item 701, config-schema.md): the first
  load runs `nonJsonPaths` on the live object before its copy, and the Worker
  runs the same `nonJsonPaths`, embedded in its inline source by
  `toString()`, BEFORE its `JSON.stringify` would drop the evidence. It
  replies with the paths instead of the JSON, and `evaluateConfigFresh`
  throws the `UserError`. The compiled binary's Worker is held to it by
  `scripts/check-binary.ts` (`check.binary`).

### Evaluated from the bytes it read

The loader reads a project config's bytes to refuse an unprovided
import; `import()` then opened and read the file again. A first load of
a project config is now served those bytes by the `vx-config-bytes`
onLoad (`Bun.plugin`), under its plain path: one read of the config, and
the evaluation runs exactly the bytes the gate saw. Under a query it was
a second module beside the one an import cycle reaches (`Cannot access
'task' before initialization`), and its `import.meta.url` differed from
the worker's. An `onLoad` that did not serve the load (Bun's registry
held the path, from a config that imported it) is followed by the
`?vx-held=` import, a fresh evaluation; a `vx.config.*` imported while no
load holds it is served from disk, or re-exported from Bun's own load
when CommonJS. It is also the cheaper import — 1,000 configs took 80–100
ms served against 180 ms read by Bun, and the cold `load configs` stage
of a 1,000-package `vx run --dry` dropped from 256 to 181 ms (min of 7,
interleaved, 2026-09-24; 100 packages: 51 to 33).

What `onLoad` source cannot be, it is not handed:

- **Only ESM.** Source from `onLoad` is always evaluated as a module;
  a file Bun would run as CommonJS (no `export`, and `module.exports`,
  `exports`, `require`, `this` or `__dirname` at the top) would lose its
  exports. `hasEsmExport` (config-imports.ts) asks Bun's own parser for
  an ESM `export`; without one, the config takes Bun's path, `?vx-bust=`.
  Source that spells none of those names, no TypeScript `export =`
  (CommonJS to Bun, with no ESM `export`) and no backslash (an
  escaped `\u006dodule` is CommonJS to Bun too) is a module on either
  path and skips the parse: 18–20 ms off 1,000 cold configs (median of
  30, interleaved, 2026-10-03). A syntax error then reaches the served
  path, and its position's query is stripped like a `ResolveMessage`'s.
- **Only UTF-8.** Bun's loader reads invalid UTF-8 as Latin-1 and a
  decoder would repair it to U+FFFD, a different string; a strict decode
  that fails sends the config down Bun's path. And the source goes over
  as a string: `onLoad` reads a byte array as Latin-1 (a `ü` came back
  `Ã¼`, caught by config-eval's JSON-data row).
- **The query never reaches the user.** A served module's stack frames
  name its specifier, rewritten to the path; a `ResolveMessage` has
  either query stripped.
- **Not the workspace config.** Proving it ESM is the parser's first
  use in a warm run (~0.27 ms) and `loadWorkspaceConfig` measured 0.3 ms
  slower served, so Bun reads it a second time.

A repeat load (the Worker, below) reads the file in the Worker's own
registry; nothing is served there. What stays read twice in a cold run,
and why — the project's `package.json` and directory, which Bun's
resolver visits for the importer whatever vx hands it — is pinned with
strace in `tests/read-once.unsafe.test.ts`.

### The workspace config's bytecode bundle

`config-bytecode.ts`. Bun parses and compiles `.vx/workspace.ts` and
every plugin package it imports on each run, while core runs from the
binary's bytecode: ~4 ms of a ~60 ms warm no-op on a solid-sized
workspace (2026-10-22). So after a first load from source, the graph is
bundled with `Bun.build` (CommonJS, `bytecode: true`, `@vzn/vx`
external) into `.vx/cache/compiled/workspace-<hash>.{js,js.jsc,json}`,
the name keyed by the config's bytes, its path and `Bun.revision`. The
next first load requires the bundle instead, while its manifest still
holds: a config reached through a link still links to the file it was
built from, every input file hashes as it did and every import, bare or
relative, resolves to the same real path (`./preset` finds a new
`preset.ts` before the bundled `preset.js`). Anything else, a bundle
that throws on require included, loads the source and builds again. Any plugin gets this; none is named.

The bundle is built from the bytes the manifest records, transpiled
with `import.meta`, `__dirname` and `__filename` replaced by the
source file's own location, and `process.env.NODE_ENV` left to read at
run time (Bun inlines it by default, and the name folds no env). A graph the bundle could run differently
gets a `skip` manifest and loads from source while its inputs stay the
same: an `import.meta` field other than `dir dirname path filename file
url main`, a computed `require`/`import()` or `require.resolve`, a
`.cjs`/`.cts` file or a CommonJS config, top-level await (no bytecode
is produced), an input no loader hook saw (JSON), a file this process had already evaluated (a bundled copy would be a second state: run from source, core's own `src/index.ts` imported by path). The require needs
the core alias (`cli/core-alias.ts`, synchronous for that reason);
without it `@vzn/vx` resolves only for `import` and the source loads.

Every workspace load asks for it, so a repeat load in one process (the
run after the CLI's selection pass) gets the same required module and
plugin instances. The build is off the run's path (`beforeExit`,
util-before-exit.md): it starts beside the run when `.vx/cache` exists,
and otherwise once the verb has answered, if the run made `.vx/cache`.
Awaited inside the load, it was ~30 ms of `workspace config` on the run
after a cold one, which had no `.vx/cache` while it loaded and built
nothing (solid, 2026-11-11). It is built only once `.vx/cache` exists,
so a reading verb on a fresh workspace writes nothing (item 900), and
never where `.vx/cache` resolves
to home, `/` or the workspace (`refuseForeignCacheDir` refuses the run
first, util-foreign-cache-dir.md). `compiled/` holds a `*` `.gitignore`
(written when missing), so git skips it when `VX_CACHE_DIR` points
elsewhere and no `.vx/.gitignore` names `/cache`. A cache clear removes
`compiled/`.
`.vx/cache` is trusted as the rest of the cache is. Pinned by
`tests/config-bytecode.test.ts`.

### Why a Worker on a repeat load

The content-hash bust only changes the **entry's** specifier. Bun caches
an evaluated module by its **resolved** specifier, so an
`import './preset.js'` inside a config resolves to the same key no
matter what query the entry carries — a busted entry re-evaluates
against a **stale preset**.

Shared presets are the documented composition mechanism (`@vzn/vx-migrate`
generates a `vx-preset.ts`), so through a whole `vx watch` session a
preset edit was invisible; and because the resolved config feeds the
cache key, vx answered `up-to-date` for a command that had changed on
disk — a stale cache hit.

A Worker gets its own module registry, so everything it imports is read
from disk now. It is the only mechanism for this that the runtime
exposes as public API: `globalThis.Loader.registry` — the obvious place
to evict from — exists on Bun 1.3.11 and is **gone** on 1.3.14, where an
eviction-based fix degrades to no fix at all while still reporting
success.

Every path hands out a tree of its own: the lock and the Worker parse
JSON, and a first in-process load, which yields the module object,
returns a JSON round-trip of it. The module object shares what the source shares — one
preset task imported by two configs, one `exec` in two tasks — so a
`project` hook that edits in place (the way the API invites) edited all
of them at once: a cold run ran `echo P +plug +plug` where the warm run
and a lock run ran `echo P +plug`, under another key (item 967). The copy
costs about 1.7 ms per 1,000 configs, and only on the evaluating path.

Two properties make the swap safe:

- **Key stability.** The config crosses back as JSON, which is already
  this project's contract for a config object: `hashTaskConfig` derives
  the cache key from `JSON.stringify(config)` and `vx lock` stores the
  same round-trip. Since `JSON.stringify(JSON.parse(s)) === s`, a config
  re-read through a Worker derives the **same** cache key as the
  in-process first load — which is why this needed no `CACHE_VERSION`
  bump.
- **Round sharing.** A round is one `loadProjectConfigs` call, the path
  `loadProjects` takes for a run and for every watch cycle. It evaluates
  its repeat loads inside `beginEvalRound()`, which
  holds the Worker open until the round ends, so a round costs one
  Worker, not one per project, and the next round still starts from an
  empty registry. Loads in flight at the same moment from separate calls
  also share one. Before item 694 nothing held the round: the in-flight
  count reached zero between configs, so 5 repeat configs made 5 Workers,
  and a 50-config repeat round took 148 ms against 10.5 ms now. Sharing within
  a round is also the more faithful semantics: two configs importing the
  same preset evaluate it once, exactly as in a fresh `vx run` process.

The Worker source is an inline `data:` URL rather than a sibling file
because `bun build --compile` does **not** embed a Worker entry point —
it resolves the URL from disk at runtime, so a sibling file would make
the shipped standalone binary fail with `ModuleNotFound`.

### What this does NOT do

- Validates each `TaskConfig` shape at load time and surfaces
  `UserError` on malformed input. Rules enforced:
  - `exec` must be an object with a non-empty `command` string.
  - `exec.persistent` rejects malformed shapes; non-string
    `readyWhen` is rejected.
  - `cache` + `persistent` together is a hard error (no exit to
    cache).
  - A task with no `exec` MUST declare `dependsOn` or `inputs` (group
    task) — a no-op task is rejected.
  - `cache` requires `exec`, the task's `inputs.files` and
    `outputs.files`; a group (a keyed group is `inputs` with no
    `exec`) takes no `cache`.
  - `dependsOn` must be a `string[]`.
  - `description` must be a string.
- Doesn't sandbox the evaluated config — config code runs with the
  caller's full Bun permissions. The user wrote it, the user trusts it.
- Doesn't transform imports — relative imports inside the config
  resolve normally via Bun's loader. Including from `node_modules`.
  This is what enables presets.

### Caveats consumers should know

- **Side effects in config files run every load.** Authors writing
  `process.env.SET_AT_LOAD_TIME = 'oops'` will see that env mutation.
- **`Date.now()` in config = always-different configHash.** Resolved
  values get baked into the object, including non-deterministic ones.
  This is a footgun documented in `architecture.md`.
- **Imports from `node_modules` are cached by Bun on a first load.**
  Within one Bun process an `import from 'pkg'` resolves once; a repeat
  load re-resolves it in a fresh Worker registry.
- **`loadWorkspaceConfig` has no Worker path.** `.vx/workspace.ts`
  declares `plugins`, which are objects holding **functions** — they
  cannot cross a Worker boundary at all. A repeat load busts the
  config's own URL, so an edit to `.vx/workspace.ts` itself is read, but
  Bun answers what it imports from the registry: a long-lived verb served an
  edited local plugin's first version on every call (item 1046). So a
  repeat load walks the config's relative imports and refuses, naming
  the file, when one changed since the first successful load in this
  process; the fix is a restart, as `vx watch` says when it sees the
  edit. A process that loads once (every CLI verb but these two) pays
  nothing for it.

### Tests

`tests/project-loader.test.ts` covers:

- Loads a default-exported object from `.mjs`.
- Throws on no-default export.
- Throws on non-object default export.
- Group-task validation (accepts task with only `dependsOn`; rejects
  task with neither `exec` nor `dependsOn`; rejects `cache` on a
  group task).
- `loadWorkspaceConfig` returns null when no `.vx/workspace.*` file
  exists, validates `concurrency` and `cache.dir`.
- The served first load (`a project config is evaluated from the bytes
vx read`): a CommonJS config keeps its exports, non-UTF-8 bytes
  evaluate as Bun reads them, and neither a runtime throw's stack nor
  an unresolvable import names the query.

### Replacing this module

Drop in any function that takes an absolute config path and returns
`ProjectConfig`. Alternatives:

- **esbuild / oxc-based loader** — fastest TS evaluation but ships an
  extra dep and gives up Bun's native TS support.
- **Subprocess isolation** — a fresh process per repeat load also gets
  a clean registry, but measured ~30-50 ms against the Worker's
  ~8-15 ms, and a compiled binary cannot spawn `bun` (it would need an
  internal subcommand on `process.execPath`).

Before either evaluation path (the first in-process import, the repeat
load's worker), a bare import nothing above the config provides is refused
with the install named (`refuseUnprovided`, item 239): left to Bun, a
workspace with no `node_modules` would auto-install it from the registry
first, and a config must never download. Each script the config reaches
by relative import (`configImports`) is held to the same rule, naming the
file that holds the import: a preset's import was installed and run where
the config's own was refused (`--no-install` holds only the shebang). A
config with no relative specifier skips the walk; a fresh bytecode bundle
skips it too, every import it holds already resolved.

## `src/workspace/config-schema.ts` — what a config may say

### Purpose

The schema validators for `vx.config.*` and `.vx/workspace.*`: every
object level, every field's shape, every rule a value must satisfy, and
the message that names the level, the accepted list and the nearest
spelling when a key is unknown. Split from `project-loader.ts` on
2026-09-10 so the two concerns read separately: this module decides
what a config may SAY, the loader decides HOW a file is evaluated.

### Public surface

```ts
// `ownConfig`: the config file outputs may not cover (null: none); defaults to `configPath`
export function validateProjectConfig(
  config: ProjectConfig,
  configPath: string,
  ownConfig?: string | null,
  jsonCopy?: boolean, // the caller refused non-JSON values and passes a JSON copy: the walk is skipped
): void
export function validateWorkspace(config: WorkspaceConfig, configPath: string): void
// A cache scope's rule, for `VX_CACHE_SCOPE` and a plugin's `setBranch`, and that variable's refusal
export function isCacheScope(v: unknown): v is string
export function branchCacheScope(repo: string, branch: string): string // `<owner>/<repo>:<branch>`, sanitized to a valid scope
export function cacheScopeEnvError(got: string): UserError
// The same refusal as text, naming its source
export function cacheScopeError(source?: string): string
// `baseBranch`: `VX_BASE_BRANCH`, else the workspace's; a bad variable throws
export function configuredBaseBranch(workspace: WorkspaceConfig | null): string | undefined
// `VX_INPUTS_STABILITY_STRATEGY` / `VX_INPUTS_STABILITY_SEVERITY`, read once per run in run.ts; a bad value throws
export function inputStabilityEnv(): InputStability
// Why `name` cannot be a task name (empty, padded, holds `#`, …), or null; `vx init` skips such a script
export function taskNameProblem(name: string): string | null

// json-data.ts: the JSON-data rule (item 701)
export interface NonJsonValue {
  path: string // as the validator writes it: tasks.build.description, dependsOn[1]
  is: string // a function, NaN, an instance of Map, …
}
export function nonJsonPaths(value: unknown): NonJsonValue[]
export function nonJsonMessage(configPath: string, found: NonJsonValue): string

// bracket-literal.ts: `vx lock` refuses a glob whose `[…]` class, read literally, names an existing path
export function checkBracketLiterals(root: string, projects: Iterable<ProjectEntry>): void
```

`validateProjectConfig` is the one boundary three readers cross with the
same object shape: the loader after evaluation, `lockfile.ts` on a frozen
entry read back from `.vx/projects.lock.json` (a hand-editable file — the same
boundary), and `orchestrator/projects.ts` after each plugin's `project`
edit (a broken edit is refused naming the plugin; there `configPath` is
that label and `ownConfig` the project's config file, or null with none). `validateWorkspace`
runs once per `.vx/workspace.*` load: fields, plugin shapes, and the verb
rules (a plugin may not shadow a core verb; a verb has one owner, a package).

### Rules

- **A project config is JSON data** (item 701). The key folds
  `JSON.stringify` of each task's config, `vx lock` stores that JSON,
  and a repeat load crosses back from the config worker as JSON, so a
  value JSON cannot carry was refused by one path and dropped by the
  other (`description: () => 'x'` failed `vx run` and passed `vx watch`),
  or sat outside the key on both (a `Map` as `exec.sandbox`, a hole in
  `dependsOn`). `nonJsonPaths` names every such value — a function,
  symbol or bigint, `NaN` / `±Infinity`, `undefined` inside an array (a
  hole too), a cycle, a getter or setter (never called), a symbol key, a
  non-enumerable property, an object whose prototype is neither
  `Object.prototype` nor `null` and is not an array — and
  `validateProjectConfig` refuses the first one before the schema,
  after the file's path: "tasks.build.description is a function — a
  config must be JSON data, because the cache key is built from its JSON". An `undefined`
  PROPERTY is allowed (JSON drops it, the schema reads it as absent, conditional
  spreads write it). The config worker (config-eval.ts) runs the same
  function, embedded by its source text
  (`nonJsonPaths.toString()`), before its `JSON.stringify`, and reports
  with `nonJsonMessage`, so there is one copy of the rule and one
  message. It changes no key: a config that passes is the object it was.
  `validateWorkspace` does not apply it: plugins are objects of
  functions, the file never crosses the worker, and no key folds it.
- **Unknown keys are refused at every object level** — `tasks`, the
  task, `exec`, `exec.env`, `exec.persistent`,
  `exec.sandbox` and its `allow` / `deny` / `ignore`, `cache`,
  `inputs`, `outputs`, and the workspace top level. The
  message is `<level> has unknown field "<key>" (allowed: …)` plus
  ` — did you mean <x>?` when a candidate is within two edits
  (`util/edit-distance.ts`), never a guess beyond that; another
  runner's spelling (`FOREIGN_FIELDS`: Turbo's `outputs`, Nx's
  `targetDefaults`) ends ` — vx spells it <x>` instead (D-37, D-38).
- `cache` needs both `inputs` and `outputs`; a persistent task may not
  carry `cache`; `dependsOn` entries are validated as specs.
- Globs may not carry a `..` path segment, a negation alone, or a
  double negation; workspace-anchored globs have their own checks.
- Timeouts are bounded by `MAX_TIMEOUT_MS` (a larger delay would fire
  at 1 ms); `sandbox` grants are typed per field (paths, names,
  booleans, `network`, `unixSockets`).

### What it does NOT do

- Evaluate or read any file; it sees an object.
- Fold anything into a cache key — `task-hash.ts` does, from the
  validated object.
- Apply defaults. A validated config is the user's object, untouched.

### Tests

`tests/schema-unknown-keys.test.ts` (the walk over every level, its
level list pinned); `tests/config-eval.test.ts` § item 701 (each
non-JSON kind refused by the first load and by the worker with one
message, the controls, the key's JSON unchanged); `tests/schema-doc-drift.test.ts` (every rule and
message against `docs/schema.md`); `tests/project-loader.test.ts`,
`tests/timeout-bounds.test.ts`, `tests/workspace-files.test.ts`,
`tests/inputs-resolution.test.ts` (individual rules);
`tests/sandbox-hint.test.ts` (a runtime message's field names validate
here).

### Replacing this module

A stricter or looser schema is a change here and in `docs/schema.md`
together — the drift test holds the two to each other.

## `src/workspace/package-graph.ts` — project dep graph

### Purpose

Build the project dependency graph from the edges plugins supply: a
`discover` entry's `deps` and `reach` (`ProjectMeta.deps` / `.reach`,
set by `linkDiscoveredEdges`), plus, for selection, `vx watch` and the
dependency rules, the cross-project `pkg#task` edges of the task
configs. The graph `'^name'` resolves against has no task edges: a run
builds it before configs load. Core reads no edge from a manifest; the lockfile
plugins (`@vzn/vx-lockfile`'s `bun()`, `pnpm()`, `npm()`, `yarn()`)
supply what the package manager installed. Used by `buildTaskGraph` to
resolve `'^name'` edges (`directDeps`), by `workspace/filter.ts` for the
`pkg...` / `...pkg` traversals and `--affected`'s dependents
(`transitiveDeps` / `transitiveDependents`), and by `vx watch` to widen
its scope to each watched project's transitive deps.

### Public surface

```ts
export interface PackageGraph {
  readonly edgeSource: boolean // some `discover` entry carried `deps`
  directDeps: (name: string) => string[] // immediate deps (sorted)
  transitiveDeps: (name: string) => string[] // all transitive deps
  transitiveDependents: (name: string) => string[] // all transitive dependents
}

export function buildPackageGraph(
  projects: ProjectMeta[],
  taskEdges?: ReadonlyMap<string, readonly string[]>, // project → projects its tasks name in a cross-project dependsOn
): PackageGraph

// dependency-rules.ts: throws VX_E_DEPENDENCY_RULE naming every broken edge
export function checkDependencyRules(
  rules: readonly DependencyRule[],
  projects: readonly string[],
  tags: ReadonlyMap<string, readonly string[]>, // each project's config tags
  graph: PackageGraph, // built with the task edges
): void
```

`checkDependencyRules` is `vx lock`'s check of `run.rules.dependencies`
(lock-only, 2026-10-13): for each project a rule's `from` selects,
each `directDeps` entry must match an `allow` selector when `allow` is
given, and no `deny` one. A selector is `tag:<glob>` or a name glob
(`compileNameGlob`, `--filter`'s matcher).

`directDeps` is the adjacency `buildTaskGraph` walks for `'^name'`
frontier expansion; `transitiveDeps` / `transitiveDependents` serve
`workspace/filter.ts`'s `pkg...` / `...pkg` traversals.

### Algorithm

Two adjacencies, each skipping self-references and names that are no
project:

- **order** (`directDeps`, what `'^name'` walks): a plugin's `deps` and
  the task edges.
- **reach** (`transitiveDeps` / `transitiveDependents`, what
  `--filter pkg...` and `--affected` read): order plus a plugin's
  `reach`, which never orders a build (the lockfile plugins put a
  workspace peer, or a workspace package the root installs, there when
  it would close an order cycle).

**The edge source.** `edgeSource` is true when any project carries
`deps`, even an empty list: a `discover` entry with `deps` makes the
workspace one (rule 4 of
`design/language-agnostic-core-2026-10.md`). Without one,
`buildTaskGraph` refuses a `^task` (`VX_E_DEPENDS_ON`, "`<id>: ^<task>`
needs project edges; add pnpm()/bun()/npm()/yarn() and install so its
lockfile exists, or a plugin that returns `deps`", led on the default
build by "`<project>` declares no build, so it is the default build,
whose"; a lockfile plugin
whose lockfile is absent gives no edges), the default `build`'s `^build` included: every `^`
would resolve to nothing, and its upstream would fold into no key, a
stale hit replayed green. With one, a project with no deps is a leaf
and its `^task` resolves to nothing, as a shared template needs. Reach
and task edges supply no `^` edge, so neither makes an edge source.

`directDeps` reads an adjacency built with the graph. The two
transitive closures are built on the FIRST query, not with the graph:
an unscoped run seeds every project and never asks for one, and
neither does a `^task` walk, and building both eagerly was 12 ms of a
240 ms warm run at 1000 projects × 30 deps (profiled 2026-09-09) for
answers nobody read. A scoped run asks one or two seeds' deps, so
`transitiveDeps` answers its first 8 asks by a search from the seed
over the REACH lists it visits, each list built on demand (the same
set in the same order; `--filter pkg-500` at 1,000 projects, load
configs 18.4 → 11.3 ms median, #2323). Past those, and for every
`transitiveDependents` ask, a closure is a bitset per project, swept once in
Kahn topological order (O(E·P/32), where a set-union DFS was O(P²)
entries on a dense layered graph — 68 ms at 1090 projects), with
projects indexed in sorted-name order so materialising one answer is a
single ascending bit-scan, already sorted; each answer is memoised by
name. Project graphs may legally contain cycles and the sweep needs a
DAG: when the Kahn pass does not drain, every query in that direction
falls back to a self-contained per-query reachability search (a node
inside a cycle includes itself). Per query on purpose: in a cycle the
back edge contributes nothing, so a memoised recursion over
sub-results computes truncated closures for the nodes below it, and
caching those made every later answer depend on which node was asked
for first.

Output lists are sorted alphabetically for deterministic cache keys
and graph traversal.

### What this does NOT do

- **Doesn't read a manifest or a lockfile.** Edges are what plugins
  return; which manifest entries a manager links is the lockfile
  plugin's question, answered from what it installed.
- **Doesn't include external (non-project) deps.** Those reach a key
  through the lockfile plugin's claim.
- **Doesn't report project-level cycles.** A cycle in the plugin edges
  is legal; the Kahn pass notices one only to choose the per-query
  fallback, so traversal terminates; whether the task graph cycles is
  detected at task-graph build time.

### Tests

`tests/package-graph.test.ts`:

- a project that names ITSELF is not its own dependency
- an edge to a name not in the graph is no edge
- builds an empty graph from no projects
- a project carrying deps, even none, makes the graph an edge source
- directDeps returns only immediate deps, sorted
- walks transitive deps and dedupes them
- does not loop forever on a dep cycle
- a cycle does not poison the closure memo (results are query-order independent)
- a node outside the cycle still gets its full closure after a cycle query
- transitiveDependents walks the reverse direction
- transitiveDependents terminates on a 2-node cycle and includes the other node
- reach from a plugin is in both closures and orders nothing
- with no plugin supplying edges, `^build` fails naming the fix
- a run whose lock was written with an edge source keeps its edges once the plugin is gone
- with an edge source, a leaf resolves `^build` to nothing and a dependent waits on its dep
- a workspace that writes no `^` runs with no edge source

The list is the suite's `it` names, pinned in order by
`tests/module-shape-drift.test.ts`.

### Replacing this module

The graph is consumed by name-lookup methods. Replacements should
preserve `PackageGraph` shape. A reasonable extension: **edge
metadata** — the plugin that supplied each edge, so `vx why` and
dependency rules can name it.

## `src/workspace/filter.ts` — `--filter` DSL

### Purpose

Implement the pnpm-style filter language used by `vx run --filter <pattern>`.
A filter expression selects a set of projects from the workspace; the
CLI passes that set to the orchestrator as the `projects` list.

### Public surface

```ts
export interface ParsedFilter {
  raw: string
  negate: boolean // !pattern
  withDeps: boolean // pattern...
  withDependents: boolean // ...pattern
  onlyDeps: boolean // pattern^...
  onlyDependents: boolean // ...^pattern (item 890)
  isPath: boolean // ./<dir> or {<dir>}
  matcher: string // glob (name) or absolute path
  gitSince?: string // [<git-ref>]
  sinceViaDeps?: true // <name>...[<git-ref>]: changed, or depends on a changed package
  pathGlob?: Bun.Glob // a path form carrying a glob (`./packages/*`), matched over the root-relative project dir
  pathGlobBase?: Bun.Glob // `./a/**`'s `a`: a trailing `**` matches zero dirs (D-84)
  pathGlobRoot?: true // `./**`: the one path glob that reaches the root project
  pathRoot?: string // the workspace root `pathGlob` is relative to
  exactDir?: true // `//`: the project at `matcher` itself, never the ones under it
  tag?: true // tag:<pattern>: `matcher` is a glob over the projects' tags
  dirFallback?: ParsedFilter // `apps/*` naming no project: read as ./apps/*
  within?: ParsedFilter // `<pattern>{<dir>}`: name matches narrowed to that path form
}

// throws a UserError for a path that climbs out of workspaceRoot (`../`, `{..}`), naming `typed`
export function parseFilter(raw: string, workspaceRoot: string, typed?: string): ParsedFilter

export interface ApplyFiltersOptions {
  filters: ParsedFilter[]
  projects: ProjectMeta[]
  graph: PackageGraph
  /** Each project's config `tags`, read by `tag:` selectors (caller-owned: the staged load). */
  tags?: ReadonlyMap<string, readonly string[]>
  /** Pre-resolved affected sets, one per [<since>] filter (caller-owned). */
  affectedByFilter?: Map<ParsedFilter, Set<string>>
  /** Called once per filter that matched zero projects, before expansion — a typo among several filters otherwise under-selects silently. */
  onNoMatch?: (filter: ParsedFilter) => void
  onEmptyWalk?: (filter: ParsedFilter, matched: readonly string[]) => void
}

export function applyFilters(opts: ApplyFiltersOptions): Set<string>
```

### Filter grammar

| Form                  | Meaning                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<pattern>`           | Name match. `*` is the sole metacharacter and means any characters — pnpm's rule, so `*core*` crosses the `@scope/` boundary. A pattern holding a `/` outside a scope that names no project is read as `./<pattern>` (Nx's `--projects 'apps/*'`).                                                                                                                                             |
| `./<dir>` / `{<dir>}` | The package whose dir is `<dir>`, alone (`.` is the root project; a nested package is not included, as in Turbo and pnpm, D-43); a `<dir>` that is no package matches the packages under it (workspace-relative). A glob in the path (`./apps/*`, `{apps/**}`) is matched over each project's root-relative dir instead, unless the path selects a project dir literally (`./packages/[abc]`). |
| `//`                  | The root project alone (Turbo's name for the root package); nothing when the root is no project, never every project under it (D-46).                                                                                                                                                                                                                                                          |
| `tag:<pattern>`       | The projects whose config `tags` hold a match (`*` as in a name; Nx's `tag:`). Every operator a name takes applies.                                                                                                                                                                                                                                                                            |
| `<pattern>...`        | Match + all transitive workspace dependencies.                                                                                                                                                                                                                                                                                                                                                 |
| `...<pattern>`        | Match + all transitive workspace dependents.                                                                                                                                                                                                                                                                                                                                                   |
| `<pattern>^...`       | Only the transitive deps of pattern (excluding the matched pkg).                                                                                                                                                                                                                                                                                                                               |
| `...^<pattern>`       | Only the transitive dependents of pattern (excluding the matched pkg; item 890).                                                                                                                                                                                                                                                                                                               |
| `!<pattern>`          | Exclude.                                                                                                                                                                                                                                                                                                                                                                                       |
| `[<git-ref>]`         | Projects affected since `<git-ref>` (`<ref>...HEAD` reads as `<ref>`, D-117). Resolved by caller via                                                                                                                                                                                                                                                                                           |
|                       | `workspace/affected.ts:affectedProjects`.                                                                                                                                                                                                                                                                                                                                                      |

### Algorithm

1. **Parse** each filter string into a `ParsedFilter`.
2. **Base set**: if any include filter is present, start empty; else
   (all-exclude), start with every project name.
3. **Expand each filter in argv order** (so `onNoMatch` names them as
   typed):
   - Compute matched names (glob match on `name` or on a tag,
     path-prefix or path-glob on `dir`, or the pre-resolved
     git-affected set); a
     filter that matched nothing is reported through `onNoMatch`, and one
     that matched but whose walk selected nothing through `onEmptyWalk`
     (item 1030).
   - Expand per flags (add transitive deps / dependents; or restrict
     to deps-only).
   - Add an include's set to the selection; hold a negation's.
4. **Remove every held exclude** — all includes land before any
   exclude, regardless of argv order, as pnpm does: `--filter '!b'
--filter 'a...'` no longer adds `b` back (item 979).

### Separation of concerns

`parseFilter` and `applyFilters` are **pure** — no FS, no spawn.
The git-relative `[<since>]` form is parsed into a `gitSince` field,
alone or after a name or `{dir}` selector it narrows (`@scope/*[main]`,
`{./apps/*}[HEAD~1]`: the selected packages that changed, D-44; an
unbraced `./` path keeps its brackets as a glob class; `<name>...[ref]`
also takes the dependants of what changed, as Turbo reads it, over a graph
that holds the configs' cross-project `dependsOn` edges), but resolution
happens upstream (`cli/select.ts` calls
`workspace/affected.ts:affectedProjects` once per distinct ref and
passes the result via `affectedByFilter`). A tag lives in the config,
so `cli/select.ts` hands the staged load's tags in through `tags`, and
loads configs for that only when a `tag:` filter is present.

This makes the filter module fully testable against an in-memory
project list + package graph.

### What it does NOT do

- No `**/` in name patterns. Names are flat strings; `*` only.
- No regex.
- `...<pattern>^...` is accepted but undocumented: both flags apply —
  the matched package itself is left out, its dependencies and its
  dependents are taken.

### Tests

`tests/filter.test.ts` — parser forms + `applyFilters` matrix against
an in-memory project list + package graph fixture.

### Replacing this module

The CLI (`cli/select.ts`) calls `parseFilter` then `applyFilters`.
Swap both to provide a different DSL while keeping that caller happy.
Nothing else depends on internals.

## `src/workspace/affected.ts` — git-relative project selection

### Purpose

Power `--affected[=<base>]` and the `[<since>]` filter form. Resolves
the set of project names whose files changed between `<since>` and
the current working tree.

### Public surface

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
 *  current HEAD and HEAD is that branch (or detached), else undefined. A
 *  base that is already HEAD selects nothing, which is a clean exit rather
 *  than an empty run; another branch on that commit (a fresh feature
 *  branch) has only not moved past it, and gets no hint. */
export function headBase(workspaceRoot: string, ref: string): string | undefined
```

### Algorithm

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
   both have a lock that parses): an entry is a project's config, its
   `project`-stage config and its `discoverStage` record (name, `deps`,
   `reach`). A project whose entry changed is selected whole, the lock
   named as the reason unless a deleted config names a closer one, so
   an edge or name a `discover` plugin changed selects it, and a lock
   rewritten over the same entries selects nothing. A changed path that is a link to a directory, or was a link (mode
   120000 on either side) and is no link to a file now, is a `dirLinks`
   entry: `declaresInput` matches it as a directory a glob may reach
   below, as the key does (`mayHoldMatch`), and a negation by the paths
   beneath it, never its name.
4. A changed ROOT file a `fingerprint` plugin claims (a lockfile under
   `@vzn/vx-lockfile`) is asked of its claimant, which names the
   projects whose dependency closure moved —
   [`orchestrator.md`](./orchestrator.md#srcorchestratorlockfile-claimts--the-claimants-shell); one that appeared or went,
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
     [`workspace.md`](#srcworkspaceconfig-importsts--the-config-import-selection-channel). Resolved-config
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
[documents where it stops](#where-this-stops).

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

### Filter integration

`cli/select.ts:resolveFilters` invokes `affectedProjects` once per
`[<since>]` filter (`affectedChanges` for `--affected`'s), one after
another, starting before the workspace config and discovery with the
whole-tree walk beside them: those need only the root and the ref, and
`projects` is the discovery's promise. It stuffs the result in
`affectedByFilter: Map<ParsedFilter, Set<string>>`, then calls
`applyFilters({ filters, projects, graph, affectedByFilter })`.

This separation keeps `workspace/filter.ts` pure (no FS / no git
spawns) — easy to test against in-memory fixtures.

### What this does NOT do

- **Doesn't refresh a base the clone has.** If the local clone is
  stale, `affectedProjects` operates on stale refs. A clone fetches
  only a base it lacks. A whole clone that fetched one branch (GitLab
  at any `GIT_DEPTH`, Jenkins "honor refspec") fetches the base tip with
  its history, so the merge base is there at once. A shallow clone
  fetches only what its merge base needs
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
  `[remote "origin"]` into the user's config. A failed fetch's first
  line of git's stderr goes into the refusal; a full commit id is
  verified as `<sha>^{object}`, since `rev-parse --verify <sha>` passes
  one whose object is missing.
- **Doesn't honor `.gitattributes` or `--diff-filter`.** A
  whitespace-only commit still marks projects as affected.
- **Doesn't intersect with `inputs.files`.** A project is
  affected if any file changed under its dir — even if no cached
  task lists that file as an input. (We default to "be permissive";
  Turbo behaves the same.)

### Tests

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

## `src/workspace/config-imports.ts` — the config-import selection channel

### Purpose

Answer one question for `--affected`: **which projects' `vx.config.*`
transitively import this changed file?**

vx hashes the RESOLVED config (architecture principle #4), so a value a
config imports participates in the cache key. Editing such a file
re-keys the task — and `affected.ts` states the rule this module exists
to keep: _"input hashing sees it, so `--affected` must too."_ Neither
existing channel can see it. Containment maps a file to the project
that OWNS it, and `inputs.workspaceFiles` maps a file a project
DECLARED. A config import is neither.

### Public surface

```ts
/** The bare specifiers in `source` no `node_modules/<package>` above `fromDir` provides
 *  (what Bun would auto-install); builtins and `@vzn/vx` never count. */
export function unprovidedBareImports(
  source: string,
  fromDir: string,
  loader: 'ts' | 'js',
): string[]

// Whether Bun's parser finds an ESM `export` in `source` — the loader
// serves only such a config from the bytes it read (project-loader.md).
export function hasEsmExport(source: string, loader: 'ts' | 'js'): boolean

export interface ConfigImportOwnersArgs {
  workspaceRoot: string
  projects: readonly ProjectMeta[]
  changed: readonly string[] // workspace-relative POSIX
  skip: ReadonlySet<string> // already-selected projects
  workspaceConfigs?: readonly string[] // `.vx/workspace.*` paths, walked as roots too
}
export interface ConfigImportOwners {
  owners: Set<string>
  workspace?: string // a changed file a workspace config imports: `affected.ts` widens to all
  outside?: string[] // files a workspace config imports above the root: `affected.ts` asks git
}
export function configImportOwners(a: ConfigImportOwnersArgs): Promise<ConfigImportOwners>

/** Every file a config imports by local specifier, transitively, outside
 *  `node_modules`, the config excluded; an unresolved one by the names it would have.
 *  `configSource` spares the config's read; `read` reads the rest; `statics` gets
 *  the files reached through static imports alone (the loader's `ModuleWatch`). */
export async function configImports(
  configPath: string,
  configSource?: string,
  read?: (file: string) => Promise<string>,
  statics?: Set<string>,
): Promise<string[]>
```

### How it works

Nothing is evaluated. `Bun.Transpiler.scanImports` reads the
specifiers and `Bun.resolveSync` turns them into paths — static
analysis, so the `project-loader.ts` note that a cache-bust "cannot
reach the config's import closure" (which is about runtime `import()`)
does not apply.

1. Roots are every project's `configPath`, minus `skip`, and the
   workspace configs: their plugins shape every resolved config, so a
   file they import can re-key any task.
2. Read each level of the walk together, scan each file (a file with no
   quoted `./`, `../`, `.`, `..`, `#`, escape or tsconfig alias skips the scan), keep the
   local specifiers (below), resolve them, and record the REVERSE edge `target → importer`.
   Targets outside the workspace, or under `node_modules`, are dropped.
   The workspace config's walk goes further (below).
3. **Descend through every file the walk reaches**, another project's
   included: the evaluation follows those imports (`configImports`), so
   the key does too (X-128). Each file is read once however many configs
   reach it.
4. One reverse BFS from the changed set answers every root at once.

Any read or parse failure skips that file silently: failing selection
over a broken out-of-scope file would break a working build. Out of
file descriptors (`EMFILE`, `ENFILE`) is the exception: a level's
reads run together, so the refusal is the level's width, not the
file, and it fails the pass with the `ulimit -n` hint where it had
dropped every project the import selects (D-63). A
specifier that does not RESOLVE still records its edge, to the path it
names (and, bare of an extension, to each file Bun would have tried):
most often the change itself deleted or renamed the target, and the
config importing it is the project the change broke. Without the edge,
`--filter '[HEAD]'` exited 0 with that config broken (item 958).

**A file a config READS is not followed.** The scan sees imports only:
a config that reads `shared/cfg.json` with `readFileSync` folds its
bytes into the key (resolved-config hashing) while selection never
learns of the edge. Import the file instead (`import cfg from
'../../shared/cfg.json' with { type: 'json' }` is followed), or declare
it in `inputs.workspaceFiles`. Selecting every config the purity
gate cannot vouch for on any unowned change was weighed and left: it
would run every such project on a README edit.

### The rule that bounds it

**Local specifiers only**, by one rule (`localTarget`) both this walk
and `configImports` ask, so `--affected` and `vx watch` follow the same
files: a relative path (`./x`, `../x`, `.`, `..`), a package.json
`#imports` entry with a `./` target (nearest `package.json`; exact key,
else the `*` pattern with the longest head; Bun picks the condition, and
a deleted target names every local one), or a bare specifier the nearest
tsconfig maps through `paths` or `baseUrl` (D-27). Bun loads each from
disk, so each is an edge, a deleted target included. Any other bare
specifier is a package; it moves when the lockfile moves, and the
lockfile's claimant (`@vzn/vx-lockfile`) already selects the projects a
lockfile change reaches; so does a `#imports` entry naming a package.
The watch walk once kept `./` and `../` alone, and both walks dropped
`..` and `#imports`: an aliased preset edit was served stale, unrefused. A config quoting no bare specifier such a tsconfig
maps is not scanned for one; at 5,000 configs that each import a
package and sit under a tsconfig, the lookup costs a one-file change
140 → 200 ms, and nothing when the configs import only `@vzn/vx`.

**The workspace config goes further.** A project config is read from
the lock; the workspace config is loaded live, so whatever its import
closure holds moves every key. Its walk (and the walk of what it
reaches) also follows a bare specifier whose nearest
`node_modules/<package>` links outside any `node_modules`: a workspace
package (`workspace:*`), which no lockfile pins. And it keeps a target
above the workspace root (`../../shared/p.ts` from a workspace in a
repository's subdirectory) as `outside`: `git diff --relative` never
lists such a file, so `affected.ts` asks git about those paths alone
and widens to every project when one changed or is untracked. A file
outside the repository is not asked.

**Not bounded by project.** The walk stopped at the first file of
another project, on the reasoning that containment selects that project.
It selects the owner, not the importer: `x`'s config imports
`packages/lib/preset.mjs`, which imports `internal.mjs`, and an edit to
`internal.mjs` moved `x`'s key while `--affected` ran `lib` alone. So did
D-41's root-project case before it. The walk now follows every import
the evaluation follows; a config reaching into another project's source
pays for that project's import closure once (200 configs importing a
500-file library: 10 → 28 ms for one changed file, min of 3).

### Realpath

`Bun.resolveSync` returns **realpath'd** paths, so the workspace root
is realpath'd INSIDE this module rather than by the caller. A raw root
fails every containment check and reports "no imports" — which is
indistinguishable from a clean tree. Owning the normalisation in one
place makes that misuse unrepresentable; the first benchmark written
against this API hit exactly that trap and measured a code path that
found nothing.

### Cost

Measured (Bun 1.4.0, warm, min-of-5, synthetic workspace, every config
importing a shared preset that imports a second file):

| configs | scan   | selected |
| ------- | ------ | -------- |
| 100     | 9.1 ms | 100      |
| 1000    | 87 ms  | 1000     |

Since D-23 a level's files are read together and a config with no
relative-specifier candidate skips the scan: `affectedProjects` for one
changed file at 5,000 configs with no relative imports went 433 → 140 ms
(min of 10, three interleaved rounds; A/A 433–445).

Before that, a workspace whose configs have NO relative imports cost 80 ms at 1000
configs — so the price is dominated by READING the config files, not by
resolving imports, and the closure is close to free once the read is
paid. For scale: full config EVALUATION, which selection deliberately
avoids, is ~200 ms at that size. On this repo (5 projects when measured)
the channel cost 0.36 ms.

### Where this stops

Imports only (a file a config READS is not followed, above), local
specifiers only (relative, `#imports` or tsconfig-mapped), and nothing under `node_modules` or outside the
workspace, but for the workspace config's walk (above). Until X-128 the walk also stopped at the first file of
another project (and, before D-41, of a root project): both left an
importer out while its key moved.

### Known over-selection

A config that imports a file by relative path is selected by every edit
to that file, even when the imported value cannot change the key (an
identity like `defineProject`). vx cannot tell those apart without
evaluating, and selection may over-select safely (it is never hashed)
but must never under-select. A project config importing its helpers by BARE
specifier opts out of this channel; every config in this repo imports
`@vzn/vx` that way (`@vzn/vx-docs` once imported core's `src/index.ts`
relatively and was selected by every edit to it).

### `unprovidedBareImports` (item 239)

The bare specifiers of a config that no `node_modules/<package>` above it
provides — the ones Bun would auto-install from the npm registry when no
`node_modules` exists anywhere above (sixteen connections and 150 ms before
"cannot find", measured 2026-09-16). The loader refuses such a config before
evaluating it: `cannot find '<name>' — no node_modules above the config
provides it; install the workspace's dependencies first`, and so is one
whose relative import closure (`configImports`) holds a script with such
an import: `<file> imports '<name>', which no node_modules above it
provides`, looked up from that file. Builtins, `@vzn/vx`
(the core alias), relative or absolute specifiers, and package.json
subpath imports (`#tasks`: Bun maps them inside the package and never asks
the registry, D-28) are never listed. Nor is a self-reference: a
specifier naming the package the config sits in, whose nearest
`package.json` has `exports`, resolves inside it (D-29).
Nor is a specifier the nearest `tsconfig.json` (else `jsconfig.json`) maps,
through `paths` or `baseUrl` with a relative string `extends` followed (Bun
follows no array `extends`, D-30), to a file on
disk: Bun loads that file and never reaches the registry (D-26).
`tests/config-missing-import.test.ts`.

### `configImports`

The files `vx watch` watches beside each config, the files a repeat
load checks before it evaluates the workspace config again (item 1046),
and the files the loader scans for an unprovided bare import before a
source evaluation (its reads kept across one load's configs):
a shared preset outside the project changed what a run evaluates and no
watcher saw it (item 949). The walk scans each file with
`Bun.Transpiler.scanImports` (a plain match when the parser refuses the
source mid-edit), resolves local specifiers by the rule above from the
file's real directory (item 950), and lists an unresolvable one by the paths it
names, so `vx watch` sees it come back.

## `src/workspace/nested-dirs.ts` — project-boundary set

### Purpose

For each project, compute the set of other projects' directories that
live underneath it. Passed to `cache/inputs.ts` glob resolution so a
parent project's `inputs.files` can never reach into a nested
project's tree. The entries are every workspace project, a
config-less package included (X-57): `--affected` gives a changed path
to the deepest project dir, so the key and the output clean fence the
same set. A nested workspace (a directory holding its own
`.vx/workspace.*`, which `vx lock` records in the lock's
`nestedWorkspaces`) fences outputs only: the clean before a run deleted
its untracked files. A run passes `workspaces` for its output readers
alone (prepare.ts `outputWallsOf`); its key and sandbox walls take the
projects, as a task may read a nested workspace (a git worktree checked
out under `src/` holds one), and leaving its files out of the key was a
stale hit.

### Public surface

```ts
export function computeNestedProjectDirs(
  entries: Array<Pick<ProjectEntry, 'name' | 'dir'>>,
  workspaces: readonly string[] = [],
): Map<string, string[]>
```

Returns `Map<projectName, absoluteDirs[]>`. Empty array for a project
with no nested children. `workspaces` are the absolute nested workspace
roots; each joins the list of every project it lies under, after the
nested projects. None leaves every list as it was.

### Algorithm

Sort the entries by `dir` once, then for each project `p` scan
forward: every dir sharing `p.dir` as a string prefix is contiguous in
sorted order, and `p`'s descendants (`p.dir + sep + …`) are a run
inside that block. A sibling whose name extends `p.dir` by a character
that sorts below the separator (`foo-utils` beside `foo`; `-`, `.`, `+`
and a space all sort before `/`) lands between `p.dir` and
`p.dir + sep`, so the scan skips such interlopers and stops only on
leaving the block — a plain break on the first non-descendant missed
`foo/nested` behind `foo-utils` and silently broke the boundary. Near
O(P log P) on real trees.

### Why precompute

The result is consumed by every glob pass in every task during the
run. Precomputing once lets `cache/inputs.ts:resolveInputs` operate
in a hot loop without re-walking the project list.

### Tests

`tests/nested-dirs.test.ts` (the function, the interloper class and
nested workspaces included) and `tests/inputs-resolution.test.ts` (the same class through
the resolver); end to end, the "project boundary" cases in
`tests/orchestrator.test.ts` create a parent + nested layout and verify
that the parent's `inputs.files: ['**/*']` doesn't pick up files from
the nested project. `tests/configless-fence.test.ts` holds a config-less
member to the same fence: the root's key and `--affected` agree on its
edit, and the root's output clean leaves its source.
`tests/nested-input.test.ts` ("a nested workspace") holds a nested
workspace out of an outer project's output clean, in its key, refused at
lock as an output glob rooted in it (not an input one), and in the lock;
`tests/stale-hit.test.ts` holds an edit in a git worktree under the
inputs to a re-key.

### What this does NOT do

- Doesn't enforce the boundary itself — `cache/inputs.ts` does, using
  the result of this function.
- Doesn't resolve symlinks: the dirs are the discovered project
  directories as strings, and inputs come from git's listing, which
  reports a link as a link.

## `src/workspace/fingerprint.ts` — claimed root files

### Purpose

Read the root files a plugin claims, once per run. Core folds none of
them into a key (2026-10-14): a lockfile or install setting keys a task
only through the plugin that claims it, and its `key` hook decides how.
The bytes read here are what the run compares against when a task may
have rewritten one (`orchestrator/fingerprint-watch.ts`,
[`orchestrator.md`](./orchestrator.md#srcorchestratorfingerprint-watchts--has-a-task-rewritten-the-lockfile)).

### Public surface

```ts
export function readClaimedFiles(
  workspaceRoot: string,
  names: Iterable<string>,
  reads?: LoadReads,
): Promise<ReadonlyMap<string, Uint8Array>> // the bytes of each name present
export function bunPatchFiles(bytes: Uint8Array): string[] // the patches a bun.lock names
```

`readClaimedFiles` reads through the load's `reads` (workspace.md), so a
root file the load already read is not read again.
Each name costs one `open`: the read's ENOENT (or EISDIR) is the
absence, where an `exists()` stat before it doubled the calls for every
file present (`tests/syscall-repeats.unsafe.test.ts`). With nothing
claimed, nothing is read.

`bun.lock` names a patch by path (`patchedDependencies`), never by its
content, so an edited patch leaves it byte-identical while `bun install`
applies the new one. `bun()` folds each named patch itself (item 1014).
On a named patch's edit, `--affected` asks the plugin that claims
`bun.lock` about `bun.lock`, with the patch's bytes at the base ref and
in the working tree in `change.extras`, when the claim names the patch
through `extraFiles`. `bun()` selects only the projects that reach the
patched package. A claimant without `extraFiles` widens to every
project (`affected.ts`). A lockfile without the key is not parsed.

The same holds for any file a claim's `extraFiles` names, and for a
directory it names (a `file:` dependency a manager copies at install or links, or a `link:` / `portal:` directory that is no workspace):
any changed path loads the claims, and one equal to or under a named
path asks the claimant about its lockfile. Every path, not only the ones
no project owns: a `file:` directory or a patch may sit inside another
project, and asking only the unowned ones selected that owner alone. A
claimed file the diff does not name is read once and parsed once, with
no git. A directory's two sides are not its bytes; they differ, so only
the projects reaching it move.

A named path above the root (a `file:` or `link:` directory beside the
checkout, `../vendor/dep`) is read and hashed into the key like one
inside it, and so is a gitignored file in a directory inside the root,
which `hashDir` reads as the manager copies it. Git lists no change to
either, so `--affected` hashes each extra file the base's
`.vx/dependencies.lock.json` records (`FingerprintClaims.hashExtra`, the
run's own hashes, which its key reads too) and hands one that moved to
the claimant as a changed directory: only the projects reaching it are
selected.

### Claiming a file (`VxPlugin.fingerprint`)

A plugin that reads a root file declares `fingerprint: { files:
['bun.lock'], affected(change, ctx), extraFiles?(file, bytes, ctx),
digests?(file, ctx) }`
(`extraFiles`: the files a claimed file names that the plugin's key
reads too, such as `bun.lock`'s patches and a `file:` dependency's
directory; the same ones the key reads, since `--affected` asks about
every changed path; `digests`: each project's digest now, the xxh3 of
the bytes it came from and the other files it read
(`FingerprintDigests`), which `vx lock` records in
`.vx/dependencies.lock.json`: a run's key reads them back
(`KeyHookContext.locked`) and refuses when a recorded file's bytes
moved, and `--affected` never parses the base side). The schema refuses a
second claimant for one file. `fingerprintClaims(plugins)` in
`plugin-host.ts` indexes the claims. `--affected`
(`workspace/affected.ts`) asks the claimant's `affected` with the file's
bytes at the base ref and in the working tree and selects the projects
it names; `undefined` ("cannot tell") selects every project. An
unclaimed root file is an ordinary path, owned by the root project.
`vx watch` re-reads the set on a claimed file's change, and the keys
decide. `@vzn/vx-lockfile` (`bun()`, `pnpm()`, `npm()`, `yarn()`) are
the claimants, over the shell in [`orchestrator.md`](./orchestrator.md#srcorchestratorlockfile-claimts--the-claimants-shell).

What each claims:

| Plugin   | Lockfile                                       | Install settings                                                                                                             |
| -------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm()` | `pnpm-lock.yaml`                               | `pnpm-workspace.yaml`, `.npmrc`, `package.json` (its `pnpm` field)                                                           |
| `bun()`  | `bun.lock` (a lone `bun.lockb` is refused)     | `bunfig.toml`, `.npmrc`                                                                                                      |
| `npm()`  | `npm-shrinkwrap.json` over `package-lock.json` | `.npmrc`                                                                                                                     |
| `yarn()` | `yarn.lock`                                    | `.yarnrc.yml`, `.yarnrc`, `.npmrc`, `package.json` (`workspaces.nohoist`, `installConfig`, `resolutions`, dependency ranges) |

Under yarn 1, `yarn()` also names each workspace's `package.json` through
`extraFiles`: yarn.lock records no workspace's ranges, so one moved to a
range another already keys changes the install with yarn.lock byte for byte.

An install setting moves `node_modules` under a byte-identical lockfile:
bun 1.4.2 with `[install] linker = "isolated"` rewrote no byte of
`bun.lock` and moved every dependency out of the root `node_modules`
(D-7), and a Yarn 4 catalog flip rewrote no byte of `yarn.lock`
(turborepo#12635). So each plugin folds its settings whole into every
task. Only the root copies are read.

Deliberately unclaimed: `.vx/workspace.{ts,mts,js,mjs,cts,cjs}`.
Everything it declares — `concurrency`, `cache.dir`, `timeout`, the
plugin list — is placement, storage or observability, never what a
command produces; folding it would split the cache between a laptop
and a CI runner declaring `reapi()`.

### Tests

`tests/in-run-writes.test.ts` pins the read and the watch (an
unclaimed file is not watched). `tests/affected.test.ts` pins the
`--affected` half of a claim; `packages/vx-lockfile/tests` the key half.

## `src/workspace/lockfile.ts` — .vx/projects.lock.json

### Purpose

`vx lock` finds every project (`findProjectConfigs`, then the plugin
`discover` stage), freshly evaluates each config and freezes it, by
directory, into `.vx/projects.lock.json`. Every run takes its project
directories from the lock as well as their configs, so a config added
since does not run until locked. Every run loads configs FROM the
lock (zero eval, no staleness check, no schema validation);
`vx lock --check` re-evaluates every config and reports one drift
message per project that differs. With a plugin `project` stage, the
lock also records what the stage left of every project, a config-less
one included (`projectStage`): a run reads that and calls no hook
(2026-11-11), and `--check` names each project the stage now maps
otherwise. The plugin `discover` stage is recorded alike
(`discoverStage`): each project it added, named or gave edges. A run
applies it to the locked directories and calls no `discover` hook, so a
plugin's live answer (an Nx graph, a manifest) never moves a run until
`vx lock`.

### Public surface

```ts
export const LOCKFILE_NAME = '.vx/projects.lock.json'
export const LOCKFILE_VERSION = 6

export interface LockedProject {
  file: string // the config file's name in the directory (`vx.config.ts`)
  config: ProjectConfig // as `vx lock` evaluated it, JSON-normalized
}
export interface Lockfile {
  version: number
  // root-relative POSIX directory (`.` for the root) → its project; by
  // directory, so a name a plugin gives never invalidates the lock
  projects: Record<string, LockedProject>
  // root-relative POSIX dirs holding their own `.vx/workspace.*`, where every
  // outer project's outputs stop; written only when there is one
  nestedWorkspaces?: string[]
  // the `project` stage as `vx lock` ran it; absent when no plugin fills it
  projectStage?: ProjectStageLock
  // the `discover` stage as `vx lock` ran it; absent when no plugin fills it
  discoverStage?: DiscoverStageLock
  validated?: string // the self-digest writeLockfile appends
}
export interface ProjectStageLock {
  plugins: string[] // the plugins that filled it, in order; `--check` names another set
  configs: Record<string, ProjectConfig> // by directory: each config after the stage, before the default build
}
export interface DiscoverStageLock {
  plugins: string[] // the plugins that filled it, in order; `--check` names another set
  projects: Record<string, DiscoveredLock> // by directory: each project the stage added, named or gave edges
}
export interface DiscoveredLock {
  name: string
  by?: string // the plugin that added it, on a project with no locked config
  deps?: string[] // project names, as ProjectMeta.deps; present, even empty, makes an edge source
  reach?: string[]
}
// On disk only: `pool` holds each task, exec, env, sandbox, inputs or cache
// value two places hold alike, once; each place holds its index. A read
// puts the values back, shared, and drops `pool`.

export function lockfilePath(root: string): string
export const NO_LOCK = 'no lock: run `vx lock`' // a run's refusal when no lock exists
export const EMPTY_LOCK =
  'The lock holds no project — write a vx.config (`vx init`), then run `vx lock`' // run and vx show, when it holds none
export const LOCK_INVALID = '.vx/projects.lock.json is invalid, run `vx lock`'
// On a run's crash path only: does the lock hold an entry `vx lock` could
// not have written? A run validates no entry, so it pays nothing for this.
export function lockEntryBroken(root: string): boolean
export async function readLockfile(root: string): Promise<Lockfile | null>
// The digest of the bytes a read lock came from: what its configs are a function of.
export function lockDigest(lock: Lockfile): string | undefined
export async function writeLockfile(root: string, lock: Lockfile): Promise<void>
// The lock's file and bytes, for `writeAllOrNone` (util): `vx lock` writes it with the dependency lock.
export function lockfileWrite(root: string, lock: Lockfile): PendingWrite
// A lock's entries from its bytes, pool put back, each with its `project`-stage
// config; null when they do not parse
export function lockEntries(bytes: Uint8Array | null): Record<string, unknown> | null
export function frozenProjectConfigs(
  lock: Lockfile,
  metas: ReadonlyArray<{ name: string; dir: string; configPath: string }>,
  root: string,
): ProjectConfig[]
// A project directory as the lock keys it: root-relative POSIX, `.` for the root
export function lockKey(root: string, dir: string): string
```

`readLockfile` checks the JSON shape only: an object, this
`LOCKFILE_VERSION`, `projects` an object of `{ file, config }` entries,
each keyed by a directory under the root as `lockKey` spells it (`.`, or
a relative POSIX path with no empty, `.` or `..` segment: a run joins it
onto the root, and `../x` ran a project outside the workspace), and the
shapes a run walks: `name` a string, `tags` a list, `tasks` an object of
objects, each `dependsOn` a list (a string one was walked per character),
and `nestedWorkspaces`, when present, a list of such keys other than `.`;
`projectStage`, when present, a list of plugin names and an object of
such keys to configs of the same shapes; `discoverStage`, when present,
a list of plugin names and an object of such keys to `{ name, by?,
deps?, reach? }` of strings and lists of strings.
Anything else, including a lock an earlier vx wrote (version 2 keyed
by name), is a `UserError` asking to re-run `vx lock`; a lock a newer vx
wrote (a higher version) asks to upgrade vx instead, as re-locking would
write the older version over it. `frozenProjectConfigs` is what a run's load serves instead
of an evaluation: an entry missing for the project is a
`UserError` naming the project and the remedy. `discoverProjects` refuses
what its parse already holds and `vx lock` never writes, in
`LOCK_INVALID`'s words with the reason (a `discoverStage` edge or a recorded name that clashes, a
`projectStage` config for no project): followed blindly, the edge was
dropped and the dependant ran without it. No entry is otherwise validated:
`vx lock` validated what it wrote, and `--check` re-evaluates
(2026-10-14). A hand-broken entry that then crashes a run is
named, not shown as a raw TypeError: on that crash's path only, a task
or the CLI asks `lockEntryBroken` (which reads past a leading BOM, as
`readLockfile` does) and prints `LOCK_INVALID` (2026-10-14). `writeLockfile` writes a value two places hold alike once, in `pool`
(`task`, `exec`, `env`, `sandbox`, `inputs`, `cache`), and puts its index
in each place. Each slot is one the schema types as an object, so a number
there can only be an index. Big workspaces repeat their tasks: 2,000
projects of five tasks read in 0.71 ms against 2.62 ms, from a fifth of
the bytes; this repo's lock went from 126 KB to 55 KB. The pool spans
`projectStage`'s configs too, so a task the stage left as it was is
held once. `readLockfile`
puts each value back once, so projects share it; the `project` stage
(under `vx lock`) and the `graph` stage, which edit a config in place,
copy it first. An index with no
pool entry is a `UserError` (`no task 3 in its pool`). `writeLockfile` ends the lock with a `validated`
field, a digest of the bytes above it under vx's version; no reader
consults it. The CLI's own selection load (`loadCliProjects`, what a
filter that walks the graph stages) reads the lock the same way, so
the selection and the run see one graph. A run with
nothing staged starts reading the lock when it finds the workspace root,
beside discovery; a missing lock still refuses at the config load, after
any refusal that comes first.

#### `.vx/dependencies.lock.json` (`dependencies-lock.ts`)

```ts
export const DEPENDENCIES_LOCK_NAME = '.vx/dependencies.lock.json'
export interface DependenciesLock {
  version: number // 3
  projects: string[] // directories, sorted; every other list indexes this one
  deps: number[][] // per project, the projects it builds after, sorted
  reach: number[][] // per project, the projects it reaches for selection only, sorted
  // claimed file → its bytes' xxh3, each project's digest ('' none), and each
  // other file the digests read → its hash (absent when none)
  files: Record<string, { hash: string; digests: string[]; extras?: Record<string, string> }>
}
export function dependenciesLock(
  root: string,
  metas: readonly ProjectMeta[],
  files: ReadonlyMap<
    string,
    {
      hash: string
      projects: Readonly<Record<string, string>>
      extras?: Readonly<Record<string, string>>
    }
  >, // by project name
): DependenciesLock
export function readDependenciesLock(root: string, reads?: LoadReads): Promise<Uint8Array | null>
export function parseDependenciesLock(bytes: Uint8Array | null): DependenciesLock | null
export function dependantsOf(lock: DependenciesLock, dir: string): string[]
export function recordedDigests(
  lock: DependenciesLock,
  file: string,
):
  | {
      hash: string
      extras: Readonly<Record<string, string>>
      has: (dir: string) => boolean
      of: (dir: string) => string | undefined
    }
  | undefined
export function dependenciesLockWrite(root: string, lock: DependenciesLock): PendingWrite
```

`vx lock` writes it beside the lock, minified (only vx reads it) and committed:
each project's `discover` edges and each claimed file's
`FingerprintClaim.digests`, with the xxh3 of the file's bytes and the
hash of each other file the digests read (`extras`: a `bun.lock`
patch, a `file:` directory). A run keys from those digests and never
parses the file (`orchestrator/locked-digests.ts`, below). Flat: each directory once, in a sorted
`projects` list, and every edge and digest an index into it (a third
the size of keying each by its directory, and a quarter of the parse
and lookup time at 2,000 projects). Every list is sorted, so the same
workspace writes the same bytes. `--affected` reads the base commit's
copy (`git show`): a deleted project's dependants are the projects
whose edges hold its index, and a changed claimed file
whose base bytes hash to the recorded `hash` takes its base digests
from the record, never a parse. `parseDependenciesLock` answers null
for a missing file, another version or another shape, and selection
then falls back (every project for a deletion, the claimant's
`affected` for a change). `vx lock --check` holds it to a fresh
derivation once the lock itself holds.

#### A run's read (`orchestrator/locked-digests.ts`)

```ts
export function lockedFiles(
  workspaceRoot: string,
  claimed: readonly string[],
  bytes: ReadonlyMap<string, Uint8Array>, // the claimed files the run read
  lockBytes: Uint8Array | null,
): KeyHookContext['locked']
```

A run reads the lock once (through the load's `reads`, beside the
claimed files) when a plugin claims a file, and builds
`KeyHookContext.locked` from it before the `key` stage. Every claimed
file the lock records is checked first: its bytes (as the run read
them) must hash to the record; one that moved, or a recorded file now
gone, refuses the run (`VX_E_LOCK`: "bun.lock changed since `vx lock`:
run `vx lock`"). A claimant that asks for a present file the lock does
not record refuses too: with no lock ("no .vx/dependencies.lock.json:
run `vx lock`"), an invalid one or another version, or a lock written
before the file was there. A file absent and unrecorded answers
`undefined`. The answer's `digest(projectDir)` refuses a project the
lock does not list, and answers `undefined` for one it lists with no
digest. Never a guess: a stale lockfile refuses, so a key comes from
the bytes `vx lock` read.

The files the digests read besides the lockfile (`extras`) are handed
to the claimant with their recorded hashes, unchecked: a `link:` or
`file:` directory is source edited with no install, and refusing each
edit until `vx lock` failed eight conformance cases
(`inputs/link-dir-dependency-edit-reruns` and its kin). `lockfileClaim`
re-hashes them, as its memo did on every run before, and digests anew
(through the memo) when one moved.

### Invariants

- Deliberate asymmetry: runs TRUST the lock outright — a
  config edited since `vx lock` runs as locked (2026-06-13: a
  byte-hash re-check cannot see import closures or env, so it would be
  a weaker guarantee pretending to add safety); only `--check` pays the
  full re-evaluation, and the CI recipe is `vx lock --check && vx run`.
- The dependencies lock is the other way round: a run holds each
  recorded file to its hash. A claimed file is its bytes, so the hash is
  the whole guarantee, and it costs one xxh3 of bytes the run reads
  anyway (2026-11-05).
- A missing entry (or a missing lock) in a run is a hard
  `UserError` — never a silent fallback to evaluation. A locked
  directory whose config file is gone is refused before the lock is
  read further (`locks <dir>, but its <file> is gone`). The lock is
  keyed by directory, so a project renamed by its `name` or a plugin
  is still locked; a moved directory is a new project.
- `writeLockfile` writes a temp file beside the lock and renames it over
  the lock, so a reader sees the old lock or the new one, never a
  truncated one. A write in place truncated first, and a run or a
  `vx watch` cycle woken by the write could read the lock empty
  (item 972). `vx lock` writes the lock and the dependency lock that
  way together (`writeAllOrNone`): both temps first, then both renames,
  after checking no directory stands at either name, so a refusal
  leaves both as they were.
- `--check` refuses at least what a run refuses: a config with no
  entry, and it also names a locked directory with no config in the
  workspace and an entry whose config file was renamed. It compares a fresh evaluation in the
  lock's JSON form, so a field a config leaves `undefined` is not drift.
  An unknown argument exits 1 before anything is read or written.
- A read lock's configs share each pooled value, so a reader never edits
  one in place: the `project` and `graph` stages copy first
  (`tests/plugin-pipeline.test.ts`, "an alike task").
- `.vx/projects.lock.json` is globally excluded from cache inputs and
  `--affected` (it's vx's own metadata, never a task input).

## `src/workspace/migration.ts` — the plan → files seam

### Purpose

What any migrator needs once it has decided what a project's tasks
are: the plan's shape, TypeScript emission, the overwrite guard, the
writes and the lock step. It draws nothing: `writeMigration` answers with
a `MigrationReport`; `applyMigration` (`src/orchestrator/migration.ts`)
writes, then `report` draws it. Core knows no source format or ecosystem
here: a mapper returns a `MigrationPlan` and `applyMigration` does the
rest. `@vzn/vx-migrate` is one migrator; a Moon or Bazel one writes
through the same seam (`private/vx-plugin-examples/migrators/makefile.ts`
maps a Makefile).

### Public surface (exported from `@vzn/vx`)

```ts
export interface MigrationPlan {
  headerNotes: string[]
  projects: GeneratedProject[]
  extraFiles: { relPath: string; contents: string }[]
  notes: string[]
}
export interface GeneratedProject {
  name: string
  dir: string
  importLines: string[]
  tags?: readonly string[] // written as the config's `tags` when non-empty
  writeName?: boolean // writes `name`: no manifest names the project
  tasks: GeneratedTask[]
}
export interface GeneratedTask {
  name: string
  todos: string[] // rendered as `// TODO(<verb>): …` (a line break continues the comment) and listed in the report
  task: Record<string, unknown> | null // TaskConfig-shaped; arrays may hold a RawExpr splice
}
export interface RawExpr {
  readonly raw: string
} // a verbatim TS expression
export type MigrationFormat = 'ts' | 'mjs'
// A project the tool found. Beside a tsconfig.json, `esModule` not true
// writes `vx.config.mts`.
export interface MigrationMember {
  readonly name: string
  readonly dir: string
  readonly configPath: string | null
  readonly esModule?: boolean
}
export interface ApplyMigrationArgs {
  root: string
  metas: readonly MigrationMember[]
  plan: MigrationPlan
  source: string // what the plan was read from, e.g. turbo.json
  verb: string // the tool's name: the report title and each TODO(<verb>)
  dry: boolean
  force: boolean
  init?: boolean
  notes?: readonly string[]
  emptyReason?: string // why the plan is empty: init's `tasks` row, else the refusal; default `no tasks in <source>`
  example?: boolean // an empty init plan shows a worked example; default when emptyReason is unset
  written?: (relPaths: readonly string[]) => readonly string[] // after the write, not under dry: the tool's own step (a formatter); its lines join the notes
  format?: MigrationFormat // default 'ts'
  json?: boolean // with dry: one JSON document (schemas/init.json) for files + report
  lock?: (root: string) => Promise<{ code: number; said: string }> // after the write: vx lock's step, its line the `lock` row; a refusal prints above the report, the files stay, exit 1
  steps?: readonly (readonly [label: string, value: string])[] // what the tool did first, e.g. ['ran', 'bun add -d …']
  plugins?: readonly WorkspacePlugin[] // { pkg, factory }: what the written workspace file declares
}
// Internal: what the write did, for report's drawMigration; under
// `json`, the dry run's one document.
export function writeMigration(
  args: ApplyMigrationArgs,
): Promise<MigrationReport | { json: string }>
// On the façade from src/orchestrator/migration.ts: write, then draw. The exit code.
export function applyMigration(args: ApplyMigrationArgs): Promise<number>
// The files `vx init` writes when no migrator maps the workspace (type-only import,
// so a user's tsc checks them against config.ts alone), and whether a file
// is that root config, untouched: a migration maps over it (no conflict).
export function starterProject(format: MigrationFormat): string
export function renderWorkspace(
  format: MigrationFormat,
  plugins: readonly WorkspacePlugin[],
): string
export function isStarterConfig(file: string): boolean
// A note per written `vx.config.ts` an emitting `tsc` beside it would compile
// (a tsconfig.json with no `include` or `files`: a NestJS app's output moves).
// `vx init` and a migration print them.
export function tscCompilesConfigNotes(root: string, written: readonly string[]): string[]
export function quoteTsLiteral(s: string): string
export const PERSISTENT_TODO: string
// Drops `note` from each persistent task no `dependsOn` in the mapping
// names: nothing waits on it, so there is nothing to gate. Every mapper
// runs it last.
export function pruneOrphanPersistentNotes(
  projects: readonly {
    readonly tasks: readonly {
      readonly name: string
      readonly todos: string[]
      readonly task: Record<string, unknown> | null
    }[]
  }[],
  note: string,
): void
// Why `name` cannot be a task's (the schema's rule), or null: a mapper
// leaves such a script out with a TODO.
export function taskNameProblem(name: string): string | null
```

### Rules

- A generated config is `import type { ProjectConfig } from '@vzn/vx/config'` plus
  `satisfies ProjectConfig`: the type-only form loads in a workspace that
  runs the binary without the package installed. `format: 'mjs'`
  (`--mjs`) writes the same object untyped as `vx.config.mjs`, for a
  project whose `tsconfig` `include` would not cover a `.ts` config.
- A `ts` config is `vx.config.mts` beside a `tsconfig.json` unless the
  member says `esModule: true`: tsc reads a `.ts` there as CommonJS and
  its type import of the ESM `@vzn/vx/config` fails (TS1479, TS1541). An
  output's `!vx.config.ts` take-back there becomes `!vx.config.mts`.
- After the write (not under `dry`), `written` gets the paths: the
  tool's own step over them. vx-migrate runs the first formatter the
  root's `node_modules/.bin` holds, so the repo's format check passes
  them; its lines join the `note` row.
- A written file `.gitignore` drops gets a `note`: the `!file` line
  that keeps it, or, inside an ignored directory (an old `/.vx/` line),
  that directory, since no `!` line re-includes a file there. vx never
  edits `.gitignore`.
- An empty plan says why: `emptyReason`, in the tool's words, or
  `no tasks in <source>`.
- The workspace file is written when no `.vx/workspace.{ts,mts,js,mjs,cts,cjs}` exists:
  a migrated workspace declares its plugins (`plugins`), and an empty
  list is a complete workspace (the floor). A plan that brings its own
  replaces it. Neither the configs nor the workspace
  file carries a "generated by" header or explanatory comment.
- Nothing is overwritten without `force`. Under an `init` migration a
  project that already has a config keeps it, untouched, and the report
  lists it under `kept`; the rest are written. For a migration, a
  discovered project with any existing config, and under either caller
  every actual write target (a synthesized root project, an extra
  file), abort the whole run before a byte lands. `vx init`'s untouched
  root starter is no conflict: a root config of another extension
  replaces it, and the report lists it under `replaced`.
- No write goes through a symlink (`src/util/write-file.ts`, shared with
  `vx init` and `vx lock`): `refuseSymlink` refuses every target that is a
  link, or whose directory resolves outside the workspace root (a cloned
  `.vx -> ../x`), before the first write, so a refusal leaves none half-made, and
  `writeNoFollow` writes a temp beside the file, renamed over it, so a
  link put there after the check is replaced, not followed. A directory
  where the file goes is named (`directoryInTheWay`), not shown as `EISDIR`.
- `init` distinguishes the two callers on an empty plan: an `init`
  migration still writes the workspace file and shows a worked example
  (unless `emptyReason` replaces it and `example` is unset); any other
  migration with nothing to convert is an error.
- A plan that names a file outside the root (a project dir, an
  `extraFiles` path) is refused before anything is written, by its
  spelling and by its real directory: a member linked out of the root
  (`packages/a -> ../../out/a`) is refused too, as core's discovery never
  loads a config there. One linked to a directory inside the root is
  written at the real place. A `.vx` (or any parent) that resolves outside
  the root is refused at the write, by `refuseSymlink` and `writeNoFollow`.
- `quoteTsLiteral` escapes backslash, quote and raw newlines — a value with
  an embedded newline (legal JSON) must round-trip through the loader.

### What it does NOT do

- Read any source format or ecosystem file (`package.json`, `turbo.json`,
  `Cargo.toml`). That is the migrator's job.

### Tests

`tests/migration.test.ts` (rendering, the overwrite guard, the report);
`private/vx-plugin-examples/migrators/makefile.test.ts` (a Makefile
migrator on the public seam alone); `packages/vx-migrate/tests/`.
