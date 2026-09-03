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
  cacheDir: string
  cache: CacheLayer // caller owns close()
  nodes: Map<string, TaskNode> // empty if `empty !== null`
  /**
   * Requested specs that matched NO project — a typo, or a stray
   * positional from an `=`-only flag written with a space. Non-empty
   * means the caller must refuse: `run()` returns NOT-ok, `planRun()`
   * returns an abandoned plan carrying the same list.
   */
  unresolvedTasks: readonly string[]
  workspaceFingerprint: string
  nestedDirsByProject: Map<string, string[]>
  /**
   * Reason `nodes` is empty:
   *   - `null`                — graph is non-empty, ready to execute.
   *   - `'no-tasks-declared'` — `requested.length === 0` after
   *                              resolving the user's task names
   *                              against `projects`. CI footgun;
   *                              `run()` returns NOT-ok.
   *   - `'empty-graph'`       — `requested` was non-empty but
   *                              `buildTaskGraph` produced no nodes.
   *                              Defensive; unreachable under current
   *                              builder semantics.
   */
  empty: null | 'no-tasks-declared' | 'empty-graph'
}

export function prepareRun(options: RunOptions, log: Logger): Promise<PreparedRun>
```

## Steps

1. **Workspace discovery** — `findWorkspaceRoot`, `loadWorkspace`,
   `loadWorkspaceConfig`, `listProjects`.
2. **Project config load** — `loadProjectConfig` per project that has
   a `vx.config.*` sibling. Projects without configs are kept in the
   workspace graph (for cross-package dep edges) but contribute no
   tasks.
3. **Package + task structure** — `buildPackageGraph`,
   `computeNestedProjectDirs`, `expandRequested` (plus
   `unresolvedRequests`, the same predicate run in reverse to name the
   specs that resolved to nothing).
4. **Cache + fingerprint** — `new Cache(resolveCacheDir(root,
workspaceConfig))`, then the layer resolution (an injected
   `RunOptions.remoteCache` composed into a `LayeredCache` wins; else
   every `cache` capability in the declared plugin list, chained in
   order — nothing is appended, and no layer at all is a named error),
   `computeWorkspaceFingerprint`.
5. **Build the task graph** — `buildTaskGraph(...)` with optional
   `excludeDependencies` filter.

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
  `project` pipeline stage (`VxPlugin.project(config, meta, ctx)`): a
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

Covered transitively by every orchestrator e2e test
(`tests/orchestrator.test.ts`) and by `tests/cli.test.ts`'s
end-to-end fixtures. No dedicated unit-test file; the function has
no externally-visible behaviour beyond what the integration tests
exercise.
