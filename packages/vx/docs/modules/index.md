# `src/index.ts` — public package surface

## Purpose

The single entry point for `import x from '@vzn/vx'`. Everything in
this file is the public API; everything else under `src/` is
internal. This is the **cross-package contract**: the plugin packages
(`@vzn/vx-reapi`, `@vzn/vx-otel`, `@vzn/vx-github`, `@vzn/vx-mcp`,
`@vzn/vx-migrate`, `@vzn/vx-lockfile`, `@vzn/vx-schedule-history`) and
any third-party plugin import everything they need from here via the
bare `'@vzn/vx'` specifier — never a deep `src/...` path
(`tests/package-boundaries.unsafe.test.ts` pins it). The runtime symbol
set (45 names) is pinned by the same test; widening it is a deliberate
snapshot update. A seam with no consumer leaves the façade — the graph
primitives, the hashing seam, the event bus wire form and the
run-history readers went on 2026-09-10 — and is re-added, shaped by its
use, when one appears.

## Public surface (by group)

The table names every export: the values column is the runtime symbol
set, the types column every `export type`, and
`tests/module-shape-drift.test.ts` holds both columns to the file.

| Group               | Values                                                                                                                                                                  | Types                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Version + errors    | `VERSION`, `UserError`, `isUserError`, `clampInt`, `nearMatches`                                                                                                        | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Schema              | `defineProject`, `defineWorkspace`, `PLUGIN_HOOKS`                                                                                                                      | `WorkspaceConfig`, `ProjectConfig`, `TaskConfig`, `ExecConfig`, `ExecEnv`, `CacheConfig`, `CacheInputs`, `CacheOutputs`, `SandboxConfig`, `SandboxGrants`, `SandboxDenials`, `PluginHook`                                                                                                                                                                                                                                                                                                                                      |
| Engine              | `run`, `planRun`, `prepareRun`, `splitTaskId`, `outputsOverlap`, `isLiteralPattern`, `normalizeGlob`, `LocalHistoryProvider`                                            | `RunOptions`, `RunSummary`, `CachePolicy`, `Logger`, `OutputView`, `PreparedRun`, `RunPlan`, `PlannedTask`, `RunResult`, `TaskView`, `OutcomeView`, `TaskNode`, `TaskOutcome`, `TaskStatus`, `HistoryProvider`, `HistoryTable`, `TaskHistory`, `CiContext`, `GitContext`, `HostContext`, `WorkspaceIdentity`                                                                                                                                                                                                                   |
| Machine + doctor    | `machineParallelism`, `machineMemoryBytes`, `collectInfo`                                                                                                               | `CollectInfoOptions`, `InfoFacts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Cache               | `Cache`, `LayeredCache`                                                                                                                                                 | `CacheLayer`, `RemoteCacheLayer`, `RunRecord`, `InvocationRecord`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Workspace           | `findWorkspaceRoot`, `loadWorkspace`, `loadProjectConfig`, `listProjectMetas`, `buildPackageGraph`, `loadResolvedProjects`                                              | `ProjectMeta`, `ProjectEntry`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Migration           | `applyMigration`, `PERSISTENT_TASK_NAMES`, `PERSISTENT_TODO`, `quoteTsLiteral`                                                                                          | `ApplyMigrationArgs`, `MigrationFormat`, `GeneratedProject`, `GeneratedTask`, `MigrationPlan`, `RawExpr`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Plugin API          | `definePlugin`, `lockfileClaim`, `reachDigests`                                                                                                                         | `VxPlugin`, `PluginHooks`, `PluginOrigin`, the hook contexts (`WorkspaceHookContext`, `ProjectHookContext`, `GraphHookContext`, `KeyHookContext`, `FingerprintContext`, `ScheduleHookContext`, `AdmitContext`, `CacheContext`, `ExecutorContext`, `CommandContext`, `PluginSetupContext`), `FingerprintClaim`, `FingerprintChange`, `PluginCommand`, `LockfileClaimHooks`, `LockfileClaimOptions`, `ReachGraph`, `TaskExecutor`, `ExecuteRequest`, `ExecuteResult`, `ExecuteSandbox`, `ResolvedSandboxConfig`, `TaskPlacement` |
| Telemetry           | `TELEMETRY_SCHEMA_VERSION`, `deriveCacheSource`, `isPassStatus`, `isCacheHit`, `TASK_STATUSES`, `escapeMarkdownCell`, `TaskLogBuffer`, `LOG_WIRE_VERSION`, `exitSignal` | `TelemetrySink`, `TelemetryContext`, `TelemetryRecord`, `RunSummaryRecord`, `RunContextRecord`, `TaskTelemetry`, `CacheSource`, `TaskLogBundle`, `TaskLogEntry`                                                                                                                                                                                                                                                                                                                                                                |
| Run-history queries | `latestRunId`, `whyDidThisRerunQuery`                                                                                                                                   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

The run-history pair is what `vx why` reads, served over MCP by
`@vzn/vx-mcp`. `listProjectMetas` is the workspace module's
`listProjects` under the name the façade kept when a metrics query
owned the bare one.

## Conventions

- **Types are exported with `export type`** so a downstream
  TypeScript project can import them without paying any runtime cost.
- **Everything routes through module contracts** — `index.ts` imports
  only from each module's `index.ts` (boundary-test rule 2).
- **Widening is deliberate.** Adding an export means updating the
  package-boundaries snapshot; that friction is the point. A helper
  goes on the façade on a demonstrated need — a plugin package that
  rolled its own copy (`clampInt`, `isPassStatus`, `escapeMarkdownCell`,
  `TaskLogBuffer`, `exitSignal` each got here that way).

## Versioning

`VERSION` is `package.json`'s `version`, imported as JSON (Bun inlines
it under `bun build --compile`), so the banner cannot drift from the
manifest. The tree says `0.0.0`; a release (`npm.yml`, on a published
GitHub release or by hand) stamps the tag's version into the manifest
before compiling the binaries and publishing, so only a published build
carries a real number.

## Tests

`tests/package-boundaries.unsafe.test.ts` pins the export snapshot and the
cross-package import law; `tests/module-shape-drift.test.ts` holds the
table above to the file. `tests/config.test.ts` imports the schema
helpers; `tests/orchestrator.test.ts` imports `run`.
