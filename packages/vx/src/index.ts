// Public API for @vzn/vx.
//
// This is the stable cross-package contract — any plugin or integration
// package imports everything it needs from here via the bare
// `'@vzn/vx'` specifier (never a deep `src/...` path). The surface is pinned
// by tests/package-boundaries.unsafe.test.ts; a widening updates that snapshot
// deliberately. The boundary law: docs/architecture.md § Repository shape.

export { VERSION } from './version.js'

// Clean error type — user-input failures print a message without a stack.
// `clampInt` rides along for the same reason the status predicates do:
// without it on the façade an integration package writes its own, and that
// had already happened. A bounds helper whose floor is load-bearing (a
// fractional SQL LIMIT is a datatype mismatch, not a smaller page) should
// have one implementation.
export { clampInt, UserError, isUserError } from './util/index.js'
// "Did you mean": the hint core's own verbs give for a near-miss name, for a
// plugin verb to give the same one.
export { nearMatches } from './util/index.js'

// Schema types and helpers (used by user vx.config files and presets).
export type {
  WorkspaceConfig,
  ProjectConfig,
  TaskConfig,
  ExecConfig,
  ExecEnv,
  CacheConfig,
  CacheInputs,
  CacheOutputs,
  ResourcesConfig,
  SandboxConfig,
  SandboxGrants,
  SandboxDenials,
} from './config.js'
export { defineProject, defineWorkspace } from './config.js'
export { definePlugin } from './orchestrator/index.js'

// Programmatic engine API: run / plan / prepare (docs/cli.md § Programmatic
// API). The graph primitives, the cache-key hashing seam and the git / host
// context capture used to sit beside these for a distributed submitter that
// left the repo (2026-08); they went with it (2026-09-10) — a seam with no
// consumer is re-added when one appears, shaped by its use.
export { run, planRun, prepareRun } from './orchestrator/index.js'
// The per-task duration history a `schedule` plugin learns from
// (`@vzn/vx-schedule-history` does; a plugin package reaches core only
// through this façade, which is what put these here).
export { LocalHistoryProvider } from './orchestrator/index.js'
export type { HistoryProvider, HistoryTable, TaskHistory } from './orchestrator/index.js'
export type { PreparedRun } from './orchestrator/index.js'
export type { CiContext, GitContext, HostContext, WorkspaceIdentity } from './orchestrator/index.js'
export type {
  CachePolicy,
  Logger,
  OutputView,
  RunOptions,
  RunSummary,
} from './orchestrator/index.js'
// `splitTaskId` is on the façade because the alternative is what happened:
// with only `taskId()` to JOIN an id and nothing exported to SPLIT one,
// consumers roll their own `split('#', 2)` and drift from the graph, which
// splits on the FIRST '#'.
export { splitTaskId } from './graph/index.js'
export type { TaskNode, TaskOutcome, TaskStatus } from './graph/index.js'

// Cache classes + the layer interface (the `cache` capability's currency).
export { Cache, LayeredCache } from './cache/index.js'
export type { CacheLayer, RemoteCacheLayer, RunRecord, InvocationRecord } from './cache/index.js'

// Workspace discovery + the project/config catalog surface — an
// out-of-process service/CLI needs these. `loadProjectConfig` is the RAW
// per-file load (`vx lock` freezes exactly that); the resolved view a run
// or `vx show` sees — plugin stages applied — is `loadResolvedProjects`
// below. Workspace's `listProjects` re-exports as `listProjectMetas` (the
// bare name once belonged to a metrics query).
export { findWorkspaceRoot } from './workspace/index.js'
export {
  loadWorkspace,
  loadProjectConfig,
  listProjects as listProjectMetas,
} from './workspace/index.js'
export type { ProjectMeta } from './workspace/index.js'
// The package graph as a run sees it (workspace deps by manifest), for a tool
// that needs a project's transitive closure the way `vx run` computes it.
export { buildPackageGraph } from './workspace/index.js'
// The run path's RESOLVED view — plugin `config` and `project` stages
// applied, cached evaluations served — for a reader outside the CLI (the
// MCP server's `listTasks`, an embedder's task catalog). What `vx show`
// prints.
export { loadResolvedProjects } from './orchestrator/index.js'
export type { ProjectEntry } from './workspace/index.js'
// The migration seam: how a generated config is planned, rendered, guarded
// and written. `vx init` (package.json scripts) uses it in core;
// `@vzn/vx-migrate` (Turbo, Nx) and any other adoption tool use it from here.
export {
  applyMigration,
  PERSISTENT_TASK_NAMES,
  PERSISTENT_TODO,
  quoteTsLiteral,
} from './workspace/index.js'
export type {
  ApplyMigrationArgs,
  MigrationFormat,
  GeneratedProject,
  GeneratedTask,
  MigrationPlan,
  RawExpr,
} from './workspace/index.js'

// Plugin API — the run-level extension points. Behavior capabilities
// (executor / cache) change WHAT/HOW work runs; the observe-only `telemetry`
// capability is the canonical data-export path and cannot change behavior.
// A plugin is declared in vx.workspace.ts via defineWorkspace({ plugins }).
// See docs/design/observability-architecture-2026-06.md.
// The claimant's shell for a lockfile plugin (`@vzn/vx-lockfile`):
// the claim, the per-project key, the memo and the `--affected` diff around
// a parser; `reachDigests` is the Merkle-over-components digest both use.
export {
  lockfileClaim,
  reachDigests,
  type LockfileClaimHooks,
  type LockfileClaimOptions,
  type ReachGraph,
} from './orchestrator/index.js'
export type {
  VxPlugin,
  PluginHooks,
  PluginOrigin,
  CacheContext,
  ExecutorContext,
  CommandContext,
  FingerprintChange,
  FingerprintClaim,
  FingerprintContext,
  GraphHookContext,
  KeyHookContext,
  PluginCommand,
  ProjectHookContext,
  ScheduleHookContext,
  WorkspaceHookContext,
  PluginSetupContext,
} from './orchestrator/index.js'
// The per-task execution contract a plugin's `executor` capability returns.
// (`runCommand` / `runSandboxed`, the local executor's own primitives, left
// the façade 2026-09-10: no executor plugin built on them — `@vzn/vx-reapi`
// speaks a wire — and a seam with no consumer is a special case in waiting.)
export type {
  ExecuteRequest,
  ExecuteResult,
  ExecuteSandbox,
  ResolvedSandboxConfig,
  TaskExecutor,
  TaskPlacement,
} from './exec/index.js'

// Telemetry — THE canonical, versioned data-export contract every exporter
// (an OTel exporter, an HTTP sink, or any third-party consumer) reads. A sink implements TelemetrySink and is
// returned from VxPlugin.telemetry(); it receives immutable records and holds
// no run handle (observe-only by construction).
// `isPassStatus` / `isCacheHit` are on the façade for the reason the sweep
// that added them found: with only the raw `TaskStatus` union exported, every
// consumer rolls its own Set of status literals — and a Set has no
// compile-time tripwire when the union gains a member, so it silently answers
// "no" for the new one. `TASK_STATUSES` is the union at runtime, for a
// consumer that needs the list rather than the predicate.
// `escapeMarkdownCell` is on the façade for the same demonstrated need: a
// plugin that renders a run as a markdown table takes the same unvalidated
// task names core does, and the cloud job summary shipped without the escape.
export {
  escapeMarkdownCell,
  TELEMETRY_SCHEMA_VERSION,
  deriveCacheSource,
  isCacheHit,
  isPassStatus,
  TASK_STATUSES,
} from './orchestrator/index.js'
// `TaskLogBuffer` is on the façade on the same demonstrated need: EVERY
// telemetry sink that ships build output has to bound it, and the retention
// rules (per-task tail, per-run budget, failures never evicted by successes,
// a hit's bytes belong to the run that executed) are a decision, not an
// implementation detail. Two sinks rolling their own is how they fork.
export { LOG_WIRE_VERSION, TaskLogBuffer } from './orchestrator/index.js'
export type {
  CacheSource,
  RunContextRecord,
  RunSummaryRecord,
  TaskLogBundle,
  TaskLogEntry,
  TaskTelemetry,
  TelemetryContext,
  TelemetryRecord,
  TelemetrySink,
} from './orchestrator/index.js'

// The serializable run result and its per-task views (what `run()` returns).
export type { RunResult, TaskView, OutcomeView } from './orchestrator/index.js'

// The one run-history query a reader outside the CLI takes today: `vx why`'s
// answer, which `@vzn/vx-mcp` serves. The event bus / wire form and the
// other history readers (`listRuns`, `getRun`, …) left the façade 2026-09-10
// with no consumer; the telemetry seam above is the canonical export path.
export { whyDidThisRerunQuery } from './orchestrator/index.js'
