# `src/orchestrator/projects.ts` — the project-config load

## Purpose

One code path for "which tasks exist, resolved": `prepareRun` (a run,
a plan) and `vx show` both call `loadProjects`, so what `show` prints
is what a run would see — the plugin `config` and `project` stages
included. Before this, `show` read config files raw and printed
`(no vx config)` for a project `turbo()` gives tasks to.

`loadWorkspacePlugins` runs the `config` stage on a copy of the
workspace file's export (its plugins kept as they are): the export is one
object per process, and hooks that edited it in place saw the last load's
edits on the next (the CLI's selection pass, then the run; each `vx
watch` cycle).

A project whose config and plugins declare no `build` gets one, after the
`project` stage: a group with `dependsOn: ['^build']` keyed on `**`
(owner, 2026-10-04; `computeGroupKey`, task-hash.md), the graph module's
`DEFAULT_BUILD` (task-graph.md).

## Public surface

```ts
export function loadWorkspacePlugins(
  workspaceRoot: string,
  warn: (m: string) => void,
): Promise<{ workspaceConfig: WorkspaceConfig | null; plugins: readonly VxPlugin[] }>

// The lock's directories (lockedProjects; a run never walks for configs),
// then the plugin `discover` stage (skipped when no plugin has it), its
// edges onto the metas (linkDiscoveredEdges), then checkProjectNames
export function discoverProjects(
  workspaceRoot: string,
  lock: () => Promise<Lockfile>,
  plugins: readonly VxPlugin[],
  cacheDir: string,
  warn: (m: string) => void,
  git?: LazyGitEnumeration, // what `DiscoverContext.worktreeChanges` reads and starts
): Promise<ProjectMeta[]>
// The enumeration a discovery's hooks shared, by the array it returned (G-75).
export function gitOfDiscovery(projects: readonly ProjectMeta[]): LazyGitEnumeration | undefined
// The lock that discovery read, by the same array: a later config load reads no second copy.
export function lockOfDiscovery(
  projects: readonly ProjectMeta[],
): (() => Promise<Lockfile>) | undefined
// The package graph a selection pass built over that array with no task edge
// in it: the graph a run reusing the discovery would build again.
export function keepDiscoveryGraph(projects: readonly ProjectMeta[], graph: PackageGraph): void
export function graphOfDiscovery(projects: readonly ProjectMeta[]): PackageGraph | undefined

// The graph is read only for the closure, so only a closure load needs one.
export type LoadProjectsArgs = LoadProjectsBase &
  ({ closure: true; packageGraph: PackageGraph } | { closure: false; packageGraph?: PackageGraph })
interface LoadProjectsBase {
  workspaceRoot: string
  cacheDir: string
  plugins: readonly VxPlugin[]
  projectMetas: readonly ProjectMeta[]
  seeds: 'all' | Iterable<string> // 'all' is `configured`; unknown names ignored
  configs: (() => Promise<Lockfile>) | 'evaluate' // the lock, asked only when a config is read; 'evaluate' is `vx lock`'s alone
  warn: (m: string) => void
  lock?: boolean // `vx lock`'s audit: the `project` stage's `ctx.lock`
  staged?: ReadonlyMap<string, ProjectEntry> // entries a load in this process already produced
}
export interface LoadedProjects {
  projects: Map<string, ProjectEntry>
  configured: readonly ProjectMeta[] // every project that can carry tasks
}
export function loadProjects(args: LoadProjectsArgs): Promise<LoadedProjects>

/** A reader's view: from the lock (no lock is NO_LOCK), every stage applied, no closure. */
export function loadResolvedProjects(
  workspaceRoot: string,
  opts?: { scope?: 'all' | readonly string[]; warn?: (message: string) => void },
): Promise<Map<string, ProjectEntry>>
// The lock, read once on first ask; no lock is NO_LOCK.
export function lockReader(workspaceRoot: string): () => Promise<Lockfile>
```

## Algorithm

1. **Who can carry tasks.** A project with a config file; and, when
   any plugin declares `project`, every project — one a `discover`
   plugin added, with no config, loads as `{ tasks: {} }` for the stage
   to fill. `configured` is that set.
   Boundary geometry fences every workspace project, configured or not
   (`prepare.ts`, X-57).
2. **Seeds.** `'all'` is `configured`; named seeds load as named. With
   `closure`, each seed's `packageGraph.transitiveDeps` join, a
   config-less one too: it loads as `{ tasks: {} }` and gets the
   default `build`, so a dependant bundling its source is keyed on it
   behind `^build` (X-9). The closure is skipped when every project is
   already pending.
3. **Rounds to a fixpoint.** Each round reads its config files from
   the lock (or, for `vx lock` alone, evaluates them in one
   `loadProjectConfigs` batch),
   applies the `project` stage per project, re-validating after EACH
   plugin under an `(after plugin '<name>')` label, then queues any project a
   `pkg#task` dependsOn entry names — the package graph cannot see
   the cross form. No cross deps → one round. A project present in
   `staged` is taken as is — no evaluation, no stage — and still
   contributes its cross deps; seeding and scoping do not change. The
   CLI's selection pass (`resolveFilters` → `taskEdges`, or the tags a
   `tag:` filter reads) is the producer: before it, a graph-walking filter put every config through
   the `project` stage twice per run (`tests/staged-once.test.ts`).

Only `vx lock` and `vx lock --check` pass `configs: 'evaluate'`
(`tests/module-boundaries.test.ts`). `prepareRun` passes `closure: true`
and the run's lock. `vx show`, `vx info`, `vx watch`'s config sweep, the
picker and the CLI's selection pass read the lock too, through
`cli/workspace-config.ts` (`closure: false`; no lock is `NO_LOCK`) or
the doctor's own load (no lock counts zero). `loadResolvedProjects` is
the same read for an embedder — `@vzn/vx-history` calls it,
and `@vzn/vx` exports it — with discovery and the plugin load folded
in: `scope` is every project or a list of names, no closure.

## Tests

- `tests/prepare-run.test.ts`, `tests/plugin-pipeline.test.ts` — the
  run path (scope, closure, cross deps, the `project` stage).
- `tests/show-info.test.ts` — `show` through the same load: a
  config-less package under a `project` plugin shows its tasks.
