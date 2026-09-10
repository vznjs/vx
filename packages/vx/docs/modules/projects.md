# `src/orchestrator/projects.ts` — the project-config load

## Purpose

One code path for "which tasks exist, resolved": `prepareRun` (a run,
a plan) and `vx show` both call `loadProjects`, so what `show` prints
is what a run would see — the plugin `config` and `project` stages
included. Before this, `show` read config files raw and printed
`(no vx config)` for a package `@vzn/vx-turbo` gives tasks to.

## Public surface

```ts
export function loadWorkspacePlugins(
  workspaceRoot: string,
  warn: (m: string) => void,
): Promise<{ workspaceConfig: WorkspaceConfig | null; plugins: readonly VxPlugin[] }>

export interface LoadProjectsArgs {
  workspaceRoot: string
  cacheDir: string
  plugins: readonly VxPlugin[]
  projectMetas: readonly ProjectMeta[]
  packageGraph: PackageGraph
  seeds: 'all' | Iterable<string> // unknown / config-less names ignored
  closure: boolean // also load each seed's transitive package deps
  lock: Lockfile | null // read from the lock instead of evaluating
  evalCache: LoadProjectConfigOptions['evalCache']
  warn: (m: string) => void
  staged?: ReadonlyMap<string, ProjectEntry> // entries a load in this process already produced
}
export interface LoadedProjects {
  projects: Map<string, ProjectEntry>
  configured: readonly ProjectMeta[] // every project that can carry tasks
}
export function loadProjects(args: LoadProjectsArgs): Promise<LoadedProjects>
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
   CLI's selection pass (`resolveFilters` → `taskEdges`) is the
   producer: before it, a graph-walking filter put every config through
   the `project` stage twice per run (`tests/staged-once.test.ts`).

`prepareRun` passes `closure: true` and the run's lock and eval cache;
`vx show` passes `closure: false`, no lock, and a local cache opened
for the evaluations alone.

## Tests

- `tests/prepare-run.test.ts`, `tests/plugin-pipeline.test.ts` — the
  run path (scope, closure, cross deps, the `project` stage).
- `tests/show-info.test.ts` — `show` through the same load: a
  config-less package under a `project` plugin shows its tasks.
