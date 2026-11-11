# `src/orchestrator/projects.ts` — the project-config load

## Purpose

One code path for "which tasks exist, resolved": `prepareRun` (a run,
a plan) and `vx show` both call `loadProjects`, so what `show` prints
is what a run would see — the plugin `config` and `project` stages
included. Before this, `show` read config files raw and printed
`(no vx config)` for a project `turbo()` gives tasks to.

Only `vx lock` runs the `project` stage's hooks (`lock: true`); it
records what they left in the lock (`Lockfile.projectStage`), and every
other load reads that record and calls no hook, so a run reads nothing
a mapping reads (turbo.json, a manifest, git, the environment). It
follows the record blindly, whatever plugins the workspace declares now:
a project the record holds loads its recorded config, any other its
locked one, or `{ tasks: {} }` with no config file (2026-11-11: "we
never relock during runs ... it should always follow the lock blindly").
`vx lock --check` names the drift.

`loadWorkspacePlugins` runs the `config` stage on a copy of the
workspace file's export (its plugins kept as they are): the export is one
object per process, and hooks that edited it in place saw the last load's
edits on the next (the CLI's selection pass, then the run; each `vx
watch` cycle).

A project whose config and plugins declare no `build` gets one, after the
`project` stage: a group with `dependsOn: ['^build']` keyed on `**`
(2026-10-04; `computeGroupKey`, task-hash.md), the graph module's
`DEFAULT_BUILD` (task-graph.md).

## Public surface

```ts
export function loadWorkspacePlugins(
  workspaceRoot: string,
  warn: (m: string) => void,
): Promise<{ workspaceConfig: WorkspaceConfig | null; plugins: readonly VxPlugin[] }>

// The lock's directories (lockedProjects; a run never walks for configs),
// with the `discover` stage `vx lock` recorded (Lockfile.discoverStage)
// applied: added projects, names, deps and reach. No hook runs. An edge
// to no project, a recorded name that clashes, or a `projectStage` config
// for no project is refused as an invalid lock. Then checkProjectNames.
export function discoverProjects(
  workspaceRoot: string,
  lock: () => Promise<Lockfile>,
  git?: LazyGitEnumeration, // the run's enumeration, which `--affected` reads and starts
): Promise<ProjectMeta[]>
// `vx lock`'s discovery, the one place a `discover` hook runs: the lock's
// directories through the stage (skipped when no plugin has it), its edges
// onto the metas (linkDiscoveredEdges), checkProjectNames, and what to record
// (`stage`: each project the stage added, renamed or gave edges, with the
// plugins that filled it; absent with no `discover` plugin).
export function lockDiscovery(
  workspaceRoot: string,
  lock: () => Promise<Lockfile>,
  plugins: readonly VxPlugin[],
  cacheDir: string,
  warn: (m: string) => void,
): Promise<{ projects: ProjectMeta[]; stage?: DiscoverStageLock }>
// The enumeration a discovery registered, by the array it returned (G-75).
export function gitOfDiscovery(projects: readonly ProjectMeta[]): LazyGitEnumeration | undefined
// The run's extra-file hashes (`ExtraHashes`, lockfile-claim.md), by the same array:
// `discover`, the `project` stage, `--affected` and the key hash a `file:` directory once.
export function extraHashesOfDiscovery(projects: readonly ProjectMeta[]): ExtraHashes | undefined
// The lock that discovery read, by the same array: a later config load reads no second copy.
export function lockOfDiscovery(
  projects: readonly ProjectMeta[],
): (() => Promise<Lockfile>) | undefined
// The nested workspace roots (absolute) that lock records, by the same array;
// none for an array no discovery made. A run's outputs stop at each.
export function nestedWorkspacesOf(projects: readonly ProjectMeta[]): readonly string[]
// The package graph a selection pass built over that array whose task edges
// added none: the graph a run reusing the discovery would build again.
export function keepDiscoveryGraph(projects: readonly ProjectMeta[], graph: PackageGraph): void
export function graphOfDiscovery(projects: readonly ProjectMeta[]): PackageGraph | undefined
// The workspace (`loadWorkspacePlugins`) the CLI loaded before that discovery:
// a run reusing the array runs the `config` stage no second time.
export function keepDiscoveryWorkspace(
  projects: readonly ProjectMeta[],
  workspace: Awaited<ReturnType<typeof loadWorkspacePlugins>>,
): void
export function pluginsOfDiscovery(
  projects: readonly ProjectMeta[],
): Awaited<ReturnType<typeof loadWorkspacePlugins>> | undefined
// Why a project a `discover` plugin added has no config while its directory
// holds one git ignores (`config`, looked for when not given), naming the
// plugin, or undefined: `vx lock` refuses it, and a run says it instead of
// "run `vx lock`", which reads only what git lists.
export function ignoredConfigRefusal(
  root: string,
  meta: { readonly name: string; readonly dir: string },
  config?: string,
): string | undefined

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
  lock?: boolean // `vx lock`'s audit: the one load that runs the `project` hooks
  staged?: ReadonlyMap<string, ProjectEntry> // entries a load in this process already produced
}
export interface LoadedProjects {
  projects: Map<string, ProjectEntry>
  configured: readonly ProjectMeta[] // every project that can carry tasks
  stage?: Map<string, ProjectConfig> // with `lock`: each config the hooks left, by dir, before the default build
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
   applies the `project` stage per project — under `lock`, the hooks,
   re-validating after EACH plugin under an `(after plugin '<name>')`
   label; otherwise the lock's record of them — then queues any project a
   `pkg#task` dependsOn entry names — the package graph cannot see
   the cross form. No cross deps → one round. A project present in
   `staged` is taken as is — no evaluation, no stage — and still
   contributes its cross deps; seeding and scoping do not change. The
   CLI's selection pass (`resolveFilters` → `taskEdges`, or the tags a
   `tag:` filter reads) is the producer: before it, a graph-walking filter loaded every config
   twice per run.

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
- `tests/project-stage-lock.test.ts`, `tests/staged-once.test.ts` — a
  run follows the stage `vx lock` recorded and calls no hook; an edit
  maps at the next `vx lock`, and `--check` names the drift.
- `tests/show-info.test.ts` — `show` through the same load: a
  config-less package under a `project` plugin shows its tasks.
