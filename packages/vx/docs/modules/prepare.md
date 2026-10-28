# `src/orchestrator/prepare.ts` — shared run/planRun setup

## Purpose

`run()` and `planRun()` both go through an identical workspace-
discovery → config-load → graph-build → cache-open sequence before
they diverge into "execute" vs "predict". `prepareRun` centralises
that shared work; the two callers stay thin.

## Public surface

```ts
export interface PreparedRun {
  workspaceRoot: string
  workspaceConfig: WorkspaceConfig | null
  plugins: readonly VxPlugin[] // the workspace's declared plugins, in declaration order; nothing is added
  cacheDir: string
  cache: CacheLayer // caller owns close()
  localCache: Cache // the local handle `cache` may wrap; raw SQLite readers use it
  hasRemoteLayer: boolean // `cache` is more than the local handle — the remote policy axes mean something
  cachePolicy: CachePolicy // `--cache-policy`, `VX_CACHE_POLICY` or the workspace's `cache.policy`
  cacheScope: string | undefined // the run's scope, named on the summary's info row
  remotes: ResolvedRemote[] // the run's remotes in declared order; `openRemotes` turns one whose `open` threw off
  cacheRefs: readonly string[] // the refs the run reads, in order (`CacheContext.refs`)
  priorities: ReadonlyMap<string, number> // the `schedule` stage's weights; empty without one
  branch: () => string | null // the run's branch: history records it, a forecast reads it first; learned once on first ask
  cacheFor: (plugin: string) => PluginCache // each plugin's `ctx.cache`: the run's layers under its policy and scope
  keepRunEntry: ((name: string, bytes: Uint8Array) => Promise<boolean>) | undefined // keep run bytes in the writing remotes (run-store.ts); undefined when none writes
  nodes: Map<string, TaskNode> // empty if `empty !== null`
  keyOnly: ReadonlyMap<string, TaskNode> // what --exclude-dependencies keyed but did not schedule
  /**
   * Requested specs that matched NO project — a typo, or a stray
   * positional from an `=`-only flag written with a space. Non-empty
   * means the caller must refuse: `run()` returns NOT-ok, `planRun()`
   * returns an abandoned plan carrying the same list.
   */
  unresolvedTasks: readonly string[]
  declaredElsewhere: readonly string[] // bare names only projects outside a scoped run declare
  projects: ReadonlyMap<string, ProjectEntry> // the loaded projects: the workspace, or a scoped run's closure
  hintProjects: ReadonlyMap<string, ProjectEntry> // a typo's measure: every project when a `pkg#task` named none loaded
  anyProjectConfig: boolean // some package has a vx.config.* at all, whatever the scope
  taskless: (name: string) => boolean // a workspace project that declares no task
  fingerprintWatch: FingerprintWatch // the claimed root files: has a task rewritten one? (fingerprint-watch.md)
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache: GitFilesCache // per-run memo of `git ls-files`, by project dir
  workspaceProjectCount: number // every project discovery found, in or out of scope
  hashCache: HashCache // per-run memo of derived digests (see task-hash.md)
  /**
   * Reason `nodes` is empty:
   *   - `null`                — graph is non-empty, ready to execute.
   *   - `'no-tasks-declared'` — `requested.length === 0` after
   *                              resolving the user's task names
   *                              against `projects`. CI footgun;
   *                              `run()` returns NOT-ok.
   *   - `'none-affected'`     — as `'no-tasks-declared'`, but the
   *                              scope came from a diff and every name
   *                              is declared elsewhere in the
   *                              workspace; `run()` returns ok.
   *   - `'empty-graph'`       — `requested` was non-empty but
   *                              `buildTaskGraph` produced no nodes.
   *                              Defensive; unreachable under current
   *                              builder semantics.
   */
  empty: null | 'no-tasks-declared' | 'none-affected' | 'empty-graph'
}

export function prepareRun(options: RunOptions, log: Logger): Promise<PreparedRun>
// run() alone, before setup: each remote's `open` the policy allows, in order; true when none is left
export function openRemotes(
  remotes: readonly ResolvedRemote[],
  ci: boolean,
  secrets: SecretBroker,
): Promise<boolean>
```

## Steps

1. **Workspace discovery** — `findWorkspaceRoot`, then
   `discoverProjects`: the directories `.vx/projects.lock.json` records
   and the plugin `discover` stage (a run never walks for configs); the
   workspace config arrives evaluated and with the `config` stage
   applied (`RunOptions`, from `cli/workspace-config.ts`), and
   `loadWorkspacePlugins` gives the declared plugin list.
2. **Project config load** — `loadProjects` ([`projects.md`](./projects.md)),
   the load `vx show` shares: scoped to the seeds and their package
   closure, from the lock, through the plugin
   `project` stage. A project a `discover` plugin added has no config:
   it is kept in the graph (for its edges) and contributes no tasks
   unless a plugin fills the `project` stage, or the default `build`.
3. **Package + task structure** — `buildPackageGraph`,
   `computeNestedProjectDirs`, `expandRequested` (plus
   `unresolvedRequests`, the same predicate run in reverse to name the
   specs that resolved to nothing).
4. **Cache + fingerprint** — `new Cache(dir)` on `--cache-dir` or
   `resolveCacheDir(root, workspaceConfig)`. One this user cannot write
   serves hits and saves nothing, with one line saying so; an empty one
   is refused up front with the directory named (`readOnlyNotice`).
   Then the layer resolution: an injected `RunOptions.remoteCache`
   composed into a `LayeredCache` wins; else `resolveCache` layers
   every plugin's `cache` remote over the local store, in declared
   order, under the run's policy — one remote is one `LayeredCache`,
   two or more are chained, and none leaves the local store unwrapped
   as the floor.
   `readClaimedFiles` reads the root files the plugins claim
   (`VxPlugin.fingerprint`) once, for the `FingerprintWatch`; core
   folds none of them into a key.
5. **Build the task graph** — `buildTaskGraph(...)`, the whole graph;
   the `graph` and `key` stages see it all. A `^name` no project in the
   workspace declares is refused (`undeclaredDepsError`), with or without
   `--exclude-dependencies`; when the load was scoped (a config it left
   out, asked by name: a config-less project in the closure does not
   make it whole, X-182), the builder cannot
   see the whole workspace, so it hands such a name back
   (`undeclaredDeps`) and `refuseUndeclaredDeps` reads the locked configs
   the scope left out — only then, and never for a name something loaded
   declares — refusing if none of them declares it either. One of them
   failing to load leaves the name unjudged, since an out-of-scope broken
   config does not fail a scoped run. An `--exclude-dependencies` name no
   project declares is refused the same way (a `UserError` with a
   near-miss hint, item 1026). Then `--exclude-dependencies`
   narrows the schedule (`excludeDependencies`) and
   `keyExcludedDependencies` keys each dropped dependency on that whole
   graph, so the dependant folds the key a full run gives it.
   Under `--affected` the selection (`affected-tasks.md`) prunes the
   graph; with a `graph` plugin the hooks run before it, so it sees
   their edges and inputs, else after the git enumeration.

The cache + fingerprint are constructed even when the result will be
empty so callers always have a uniform `try { ... } finally {
cache.close() }` shape.

## Why a single shared module

Before: `run()` and `planRun()` each duplicated ~50 lines of setup,
slowly diverging (different error messages, different defaults,
`planRun` opened the cache without a logger context for the cache-layer
resolution, etc.). After: one function, one path; the two callers handle
only what's actually different (execution vs prediction).

## Extension points

- **Reshaping projects between config load and graph build** is the
  `project` pipeline stage (`VxPlugin.project(config, ctx)`): a
  plugin edits each loaded project's tasks in place and core
  re-validates. That is where a target-defaults or named-inputs
  expansion would live IF it were wanted — workspace-level
  `namedInputs`, `globalInputs` and `globalEnv` are owner-rejected
  non-goals (CLAUDE.md § Rejected): configs are TypeScript and compose
  through shared presets instead.
- **Observing the run** is the `telemetry` seam (`VxPlugin.telemetry(ctx)`)
  and the raw bus (`setup(ctx)`); both are constructed by the run, not
  here, and reach every task through the context.
- **Anything that needs the prepared graph** (priorities, resources,
  extra key material) has its own stage: `graph`, `schedule`, `key`.
  See `docs/design/pipeline-2026-09.md`.

## Tests

`tests/prepare-run.test.ts` pins its rules directly: scoped config
loading reaches every project a run can need, a `^name` no project
declares is refused in a scoped run too, `--exclude-dependencies` keys
a deep dropped chain, and the empty-run reason. Also covered
transitively by `tests/orchestrator.test.ts` and `tests/cli.test.ts`.
