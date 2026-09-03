// Public API for @vzn/vx.
//
// This is the stable cross-package contract — any plugin or integration
// package imports everything it needs from here via the bare
// `'@vzn/vx'` specifier (never a deep `src/...` path). The surface is pinned
// by tests/package-boundaries.test.ts; a widening updates that snapshot
// deliberately. See docs/design/core-cloud-split-2026-06.md §3.5.

export { VERSION } from './version.js'

// Clean error type — user-input failures print a message without a stack.
// `clampInt` and `parseDecimalInt` ride along for the same reason the status
// predicates do: without them on the façade an integration package writes its
// own, and both had already happened. A bounds helper whose floor is
// load-bearing (a fractional SQL LIMIT is a datatype mismatch, not a smaller
// page) should have one implementation — and so should the ONE strict integer
// parser, whose entire purpose is that `Number()` silently accepts `0x10` and
// `1e3` at a boundary where a typo must be an error, not a different number.
export { clampInt, parseDecimalInt, parseSize, UserError } from './util/index.js'

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
  SandboxNetworkConfig,
} from './config.js'
export { defineProject, defineWorkspace } from './config.js'

// Programmatic engine API (run / plan / prepare) + the graph primitives a
// distribution submitter/agent reasons over + the cache-key hashing seam.
// `deriveStableKeys` is THE shared stable-key derivation (remote-prefetch,
// the local short-circuit, and the distributed submitter must never drift
// on the stability gate); `captureGitContext`/`captureWorkspaceIdentity`
// give agents + the submitter identity before/without a telemetry run.
export { run, planRun, prepareRun } from './orchestrator/index.js'
// The per-task duration history a `schedule` plugin learns from (see
// src/plugins/schedule-history — core's own plugins import core only via
// this façade, which is what put these here).
export { EmptyHistoryProvider, LocalHistoryProvider } from './orchestrator/index.js'
export type { HistoryProvider, HistoryTable, TaskHistory } from './orchestrator/index.js'
export type { PreparedRun } from './orchestrator/index.js'
export { computeTaskHash, createHashCache, deriveStableKeys } from './orchestrator/index.js'
export type { DeriveStableKeysArgs, HashCache, StableKey } from './orchestrator/index.js'
export {
  captureDefaultBranch,
  captureGitContext,
  captureHostContext,
  captureWorkspaceIdentity,
  detectCi,
} from './orchestrator/index.js'
export type { CiContext, GitContext, HostContext, WorkspaceIdentity } from './orchestrator/index.js'
export { FULL_CACHE_POLICY, parseCachePolicy } from './orchestrator/index.js'
export type {
  CachePolicy,
  Logger,
  OutputView,
  RunOptions,
  RunSummary,
} from './orchestrator/index.js'
export { defaultLogger, resolveOutputView } from './orchestrator/index.js'
// `splitTaskId` is on the façade because the alternative is what happened:
// with only `taskId()` to JOIN an id and nothing exported to SPLIT one,
// consumers roll their own `split('#', 2)` and drift from the graph, which
// splits on the FIRST '#'.
export {
  buildTaskGraph,
  expandRequested,
  isGroupTask,
  markSurfacedDeps,
  splitTaskId,
} from './graph/index.js'
export type {
  OutputFingerprint,
  TaskNode,
  TaskOutcome,
  TaskStatus,
  VerifyVerdict,
} from './graph/index.js'
// The one output-tree diff implementation (verify verdicts + a serve's
// cross-machine fingerprint diff both name rels through it).
export { diffOutputTrees } from './orchestrator/index.js'

// Cache classes + the layer interface (the `cache` capability's currency)
// and input-output resolution. The blob-CAS/digest substrate
// (cas-backend.ts / digest.ts) stays module-internal until it has a
// consumer — no speculative public API. `cleanOutputs` is public for the
// distributed submitter's targeted output materialization (wipe declared
// outputs, then `restoreOutputs` the artifact — never a naive re-run).
export {
  Cache,
  LayeredCache,
  GitFilesCache,
  cleanOutputs,
  resolveInputs,
  resolveOutputs,
} from './cache/index.js'
export type { CacheLayer, RemoteCacheLayer, RunRecord, InvocationRecord } from './cache/index.js'

// Workspace discovery + the project/config catalog surface — an
// out-of-process service/CLI needs these. `readLockfile` is THE one reader
// of vx-lock.json (the format carries its own version sentinel; a second
// parser in a sibling package would drift), and the loader chain
// (`loadWorkspace` → `listProjectMetas` → `loadProjectConfig`) is the same
// one `vx show` uses. Workspace's `listProjects` re-exports as
// `listProjectMetas` (the bare name once belonged to a metrics query).
export { findWorkspaceRoot, loadWorkspaceConfig, resolveCacheDir } from './workspace/index.js'
export { readLockfile, LOCKFILE_NAME } from './workspace/index.js'
export type { Lockfile, LockfileEntry } from './workspace/index.js'
export {
  loadWorkspace,
  loadProjectConfig,
  listProjects as listProjectMetas,
} from './workspace/index.js'
export type { ProjectMeta } from './workspace/index.js'

// Plugin API — the run-level extension points. Behavior capabilities
// (executor / cache) change WHAT/HOW work runs; the observe-only `telemetry`
// capability is the canonical data-export path and cannot change behavior.
// A plugin is declared in vx.workspace.ts via defineWorkspace({ plugins }).
// See docs/design/observability-architecture-2026-06.md.
export type {
  VxPlugin,
  CacheContext,
  ExecutorContext,
  CommandContext,
  GraphHookContext,
  KeyHookContext,
  PluginCommand,
  ProjectHookContext,
  ScheduleHookContext,
  WorkspaceHookContext,
  PluginSetupContext,
} from './orchestrator/index.js'
// Process primitives — what an executor plugin builds on. `@vzn/vx/plugins/local-executor`
// is the reference implementation and imports exactly these.
export { runCommand, runSandboxed } from './exec/index.js'
// The per-task execution contract a plugin's `executor` capability returns.
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
  assembleRunSummary,
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

// The serializable event projection.
export { projectNode, projectOutcome } from './orchestrator/index.js'
export type { RunResult } from './orchestrator/index.js'

// Event bus + wire form — adapters (otel-bridge, custom subscribers) ride this.
export { createEventBus, wireForwarder, toWireEvent } from './orchestrator/index.js'
export type {
  EventBus,
  RunEvent,
  RunEventSubscriber,
  WireEvent,
  TaskView,
  OutcomeView,
} from './orchestrator/index.js'

// Run-history queries over cache.db — what `vx why` / `vx last` read. An
// out-of-process surface (an MCP server, a dashboard plugin) reads the same.
export {
  cacheKeyDiff,
  explainCacheKeyQuery,
  getInvocation,
  getRun,
  listInvocations,
  listRuns,
  whyDidThisRerunQuery,
} from './orchestrator/index.js'
