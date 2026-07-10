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
  projects: Map<string, ProjectEntry>
  packageGraph: PackageGraph
  nodes: Map<string, TaskNode> // empty if `empty !== null`
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
   `computeNestedProjectDirs`, `expandRequested`.
4. **Cache + fingerprint** — `new Cache(resolveCacheDir(root,
workspaceConfig))`, then the layer resolution (an injected
   `RunOptions.remoteCache` composed into a `LayeredCache` wins; else
   a plugin's `cache` capability; else the bare local cache),
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

- **Named inputs / target defaults.** A workspace-level transformation
  that rewrites each `ProjectEntry.config` (e.g. expanding
  `$inputs:default` references) should run between project-config load
  and graph build. Add it as a step here.
- **`globalInputs` / `globalEnv`.** Workspace-level cache-key
  contributions would land in the fingerprint step.
- **Telemetry handle.** A `Telemetry` sink could be constructed here
  and added to `PreparedRun`, with default a no-op. Both callers would
  receive it via the context.

## Tests

Covered transitively by every orchestrator e2e test
(`tests/orchestrator.test.ts`) and by `tests/cli.test.ts`'s
end-to-end fixtures. No dedicated unit-test file; the function has
no externally-visible behaviour beyond what the integration tests
exercise.
