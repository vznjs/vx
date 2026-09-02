# `src/index.ts` — public package surface

## Purpose

The single entry point for `import x from '@vzn/vx'`. Everything in
this file is the public API; everything else under `src/` is
internal. Since the core/service split this is the **cross-package
contract**: the service package, `@vzn/vx-otel`, and any third-party
plugin import everything they need from here via the bare `'@vzn/vx'`
specifier — never a deep `src/...` path. The exact symbol set (~80
exports) is pinned by `tests/package-boundaries.test.ts`; widening it
is a deliberate snapshot update.

## Public surface (by group)

| Group             | Key exports                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version + errors  | `VERSION`, `UserError`                                                                                                                                                                                                                                                                                                                                                        |
| Schema            | `defineProject`, `defineWorkspace`; types `WorkspaceConfig`, `ProjectConfig`, `TaskConfig`, `ExecConfig`, `ExecEnv`, `CacheConfig`, `CacheInputs`, `CacheOutputs`, `SandboxConfig`, `SandboxNetworkConfig`                                                                                                                                                                    |
| Engine            | `run`, `planRun`, `prepareRun`; `computeTaskHash`, `createHashCache`, `deriveStableKeys`; `captureGitContext`, `captureWorkspaceIdentity`; `FULL_CACHE_POLICY`, `parseCachePolicy`; types `RunOptions`, `RunSummary`, `CachePolicy`, `PreparedRun`, `HashCache`, `StableKey`, `GitContext`, `WorkspaceIdentity`, `Logger`, `OutputView`; `defaultLogger`, `resolveOutputView` |
| Graph             | `buildTaskGraph`, `expandRequested`, `isGroupTask`, `markSurfacedDeps`; types `TaskNode`, `TaskOutcome`, `TaskStatus`                                                                                                                                                                                                                                                         |
| Cache             | `Cache`, `LayeredCache`, `GitFilesCache`, `cleanOutputs`, `resolveInputs`, `resolveOutputs`; types `CacheLayer`, `RemoteCacheLayer`, `RunRecord`, `InvocationRecord` (the CAS seam — `CASBackend`/`Digest` — is internal until the artifact store lands)                                                                                                                      |
| Workspace         | `findWorkspaceRoot`, `loadWorkspaceConfig`, `resolveCacheDir`                                                                                                                                                                                                                                                                                                                 |
| Plugin API        | types `VxPlugin`, `EventSink`, `BackendContext`, `CacheContext`, `EventSinkContext`, `PluginSetupContext`                                                                                                                                                                                                                                                                     |
| Telemetry         | `TELEMETRY_SCHEMA_VERSION`, `deriveCacheSource`; types `TelemetrySink`, `TelemetryContext`, `TelemetryRecord`, `RunSummaryRecord`, `RunContextRecord`, `TaskTelemetry`, `CacheSource`                                                                                                                                                                                         |
| Event projection  | `projectNode`, `projectOutcome`; type `RunResult`                                                                                                                                                                                                                                                                                                                             |
| Event bus         | `createEventBus`, `wireForwarder`, `toWireEvent`; types `EventBus`, `RunEvent`, `RunEventSubscriber`, `WireEvent`                                                                                                                                                                                                                                                             |
| Run-history queries | `listRuns`, `getRun`, `getInvocation`, `listInvocations`, `cacheKeyDiff`, `whyDidThisRerunQuery`, `explainCacheKeyQuery` — what `vx why` / `vx last` read |

## Conventions

- **Types are exported with `export type`** so a downstream
  TypeScript project can import them without paying any runtime cost.
- **Everything routes through module contracts** — `index.ts` imports
  only from each module's `index.ts` (boundary-test rule 2).
- **Widening is deliberate.** Adding an export means updating the
  package-boundaries snapshot; that friction is the point.

## Versioning

`VERSION` is a string constant. Pre-alpha — currently `'0.0.0'`. Bump
on every release via the release workflow (`gh release create v0.x.y`
triggers `.github/workflows/release.yml` which builds the cross-
target binaries and attaches them).

## Tests

`tests/package-boundaries.test.ts` pins the export snapshot and the
cross-package import law. `tests/config.test.ts` imports the schema
helpers; `tests/orchestrator.test.ts` imports `run`.
