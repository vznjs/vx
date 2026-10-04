# `src/orchestrator/projects.ts` — the project-config load

## Purpose

One code path for "which tasks exist, resolved": `prepareRun` (a run,
a plan) and `vx show` both call `loadProjects`, so what `show` prints
is what a run would see — the plugin `config` and `project` stages
included. Before this, `show` read config files raw and printed
`(no vx config)` for a package `turbo()` gives tasks to.

## Public surface

A project whose config and plugins declare no `build` gets one, after the
`project` stage: a group with `dependsOn: ['^build']` keyed on `**`
(owner, 2026-10-04; `computeGroupKey`, task-hash.md).

```ts
// the default build; the picker and the "tasks here" hint leave it out
export function isDefaultBuild(task: TaskConfig | undefined): boolean

export function loadWorkspacePlugins(
  workspaceRoot: string,
  warn: (m: string) => void,
): Promise<{ workspaceConfig: WorkspaceConfig | null; plugins: readonly VxPlugin[] }>

// listProjects, then the plugin `discover` stage (skipped when no plugin has it)
export function discoverProjects(
  workspace: Workspace,
  plugins: readonly VxPlugin[],
  cacheDir: string,
  warn: (m: string) => void,
  git?: LazyGitEnumeration, // what `DiscoverContext.worktreeChanges` reads and starts
): Promise<ProjectMeta[]>
// The enumeration a discovery's hooks shared, by the array it returned (G-75).
export function gitOfDiscovery(projects: readonly ProjectMeta[]): LazyGitEnumeration | undefined
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
  seeds: 'all' | Iterable<string> // unknown / config-less names ignored
  lock: (() => Promise<Lockfile>) | null // read from the lock instead of evaluating; asked only when a config is read
  evalCache: LoadProjectConfigOptions['evalCache']
  warn: (m: string) => void
  staged?: ReadonlyMap<string, ProjectEntry> // entries a load in this process already produced
}
export interface LoadedProjects {
  projects: Map<string, ProjectEntry>
  configured: readonly ProjectMeta[] // every project that can carry tasks
}
export function loadProjects(args: LoadProjectsArgs): Promise<LoadedProjects>

/** A reader's view: every stage applied, cached evaluations served, no closure, no lock. */
export function loadResolvedProjects(
  workspaceRoot: string,
  opts?: { scope?: 'all' | readonly string[]; warn?: (message: string) => void },
): Promise<Map<string, ProjectEntry>>
```

## Algorithm

1. **Who can carry tasks.** A project with a config file; and, when
   any plugin declares `project`, every package — it loads as
   `{ tasks: {} }` for the stage to fill. `configured` is that set;
   boundary geometry fences all of them, loaded or not.
2. **Seeds.** `'all'`, or names filtered to `configured`. With
   `closure`, each seed's `packageGraph.transitiveDeps` join — that
   bounds `^task` frontier expansion. The closure is skipped when
   every configured project is already pending.
3. **Rounds to a fixpoint.** Each round evaluates its config files in
   one `loadProjectConfigs` batch (or reads them from the lock),
   applies the `project` stage per project, re-validating after EACH
   plugin under an `(after plugin '<name>')` label, then queues any project a
   `pkg#task` dependsOn entry names — the package graph cannot see
   the cross form. No cross deps → one round. A project present in
   `staged` is taken as is — no evaluation, no stage — and still
   contributes its cross deps; seeding and scoping do not change. The
   CLI's selection pass (`resolveFilters` → `taskEdges`, or the tags a
   `tag:` filter reads) is the producer: before it, a graph-walking filter put every config through
   the `project` stage twice per run (`tests/staged-once.test.ts`).

`prepareRun` passes `closure: true` and the run's lock and eval cache.
`vx show`, `vx watch`'s config sweep and the CLI's selection pass load
through `cli/workspace-config.ts`, which passes `closure: false`, the
lock only under `--frozen`, and a local cache opened for the
evaluations alone. `loadResolvedProjects` is the same read for an
embedder — `vx mcp`'s tools and `@vzn/vx-schedule-history` call it, and
`@vzn/vx` exports it — with discovery and the plugin load folded in:
`scope` is every project or a list of names, no closure, no lock, and a
cache opened and closed around the load.

## Tests

- `tests/prepare-run.test.ts`, `tests/plugin-pipeline.test.ts` — the
  run path (scope, closure, cross deps, the `project` stage).
- `tests/show-info.test.ts` — `show` through the same load: a
  config-less package under a `project` plugin shows its tasks.
