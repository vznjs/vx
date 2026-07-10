// Public API for @vzn/vx.
//
// This is the stable cross-package contract — any plugin or integration
// package imports everything it needs from here via the bare
// `'@vzn/vx'` specifier (never a deep `src/...` path). The surface is pinned
// by tests/package-boundaries.test.ts; a widening updates that snapshot
// deliberately. See docs/design/core-cloud-split-2026-06.md §3.5.

export { VERSION } from './version.js'

// Clean error type — user-input failures print a message without a stack.
export { UserError } from './util/index.js'

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
export type { PreparedRun } from './orchestrator/index.js'
export { computeTaskHash, createHashCache, deriveStableKeys } from './orchestrator/index.js'
export type { DeriveStableKeysArgs, HashCache, StableKey } from './orchestrator/index.js'
export {
  captureGitContext,
  captureWorkspaceIdentity,
  resolveCacheScope,
} from './orchestrator/index.js'
export type { GitContext, WorkspaceIdentity } from './orchestrator/index.js'
export { FULL_CACHE_POLICY, parseCachePolicy } from './orchestrator/index.js'
export type {
  CachePolicy,
  Logger,
  OutputView,
  RunOptions,
  RunSummary,
} from './orchestrator/index.js'
export { defaultLogger, resolveOutputView } from './orchestrator/index.js'
export { buildTaskGraph, expandRequested, isGroupTask, markSurfacedDeps } from './graph/index.js'
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
  RemoteCache,
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
// `listProjectMetas` — the bare name belongs to the metrics query below.
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
// (backend / cache) change WHAT/HOW work runs; the observe-only `telemetry`
// capability is the canonical data-export path and cannot change behavior.
// A plugin is declared in vx.workspace.ts via defineWorkspace({ plugins }).
// See docs/design/observability-architecture-2026-06.md.
export type {
  VxPlugin,
  EventSink,
  BackendContext,
  CacheContext,
  EventSinkContext,
  PluginSetupContext,
} from './orchestrator/index.js'

// Telemetry — THE canonical, versioned data-export contract every exporter
// (an OTel exporter, an HTTP sink, or any third-party consumer) reads. A sink implements TelemetrySink and is
// returned from VxPlugin.telemetry(); it receives immutable records and holds
// no run handle (observe-only by construction).
export { TELEMETRY_SCHEMA_VERSION, deriveCacheSource } from './orchestrator/index.js'
export type {
  CacheSource,
  RunContextRecord,
  RunSummaryRecord,
  TaskTelemetry,
  TelemetryContext,
  TelemetryRecord,
  TelemetrySink,
} from './orchestrator/index.js'

// The submitter wire contract + backend interface (the `backend`
// capability's currency) and the serializable event projection.
export {
  optionsToRequest,
  requestToOptions,
  projectNode,
  projectOutcome,
  createWireRenderer,
} from './orchestrator/index.js'
export type {
  RunBackend,
  RunRequest,
  RunResult,
  ClientMessage,
  ServerMessage,
} from './orchestrator/index.js'

// Event bus + wire form — adapters (otel-bridge, custom subscribers) ride this.
export {
  createEventBus,
  wireForwarder,
  toWireEvent,
  createVxSurface,
} from './orchestrator/index.js'
export type {
  EventBus,
  RunEvent,
  RunEventSubscriber,
  WireEvent,
  TaskView,
  OutcomeView,
} from './orchestrator/index.js'

// The JSON-RPC 2.0 wire envelope — an out-of-process serve/agent speaks this framing.
export {
  clientMessageToEnvelope,
  decodeEnvelope,
  encodeForNDJSON,
  encodeForSSE,
  encodeForWS,
  ENVELOPE_ERRORS,
  envelopeToClientMessage,
  envelopeToServerMessage,
  isEnvelope,
  isNotification,
  isRequest,
  makeError,
  makeNotification,
  makeRequest,
  makeResponse,
  serverMessageToEnvelope,
  WIRE_CHANNELS,
  WIRE_PROTOCOL_VERSION,
} from './orchestrator/index.js'
export type {
  Envelope,
  ErrorResponse,
  Notification,
  WireRequest,
  WireResponse,
  WireChannel,
} from './orchestrator/index.js'

// Metrics / analytics query layer over cache.db — a service plugin's HTTP
// surface reads from these (the queries stay in core; a serve exposes them over HTTP).
export {
  cacheKeyDiff,
  compareRuns,
  explainCacheKeyQuery,
  getBottlenecks,
  getCacheBreakdown,
  getCacheSavings,
  getCacheStatsSql,
  getFlakiestTasks,
  getHistory,
  getHitRateSplit,
  getInvocation,
  getParallelismHistory,
  getPeriodComparison,
  getPrunableEntries,
  getRecentFailures,
  getRegressions,
  getRun,
  getRunHeatmap,
  getRunTrends,
  getStorageGrowth,
  getTaskDetail,
  getTopTimeBurners,
  listCacheEntries,
  listInvocations,
  listProjects,
  listRuns,
  whyDidThisRerunQuery,
} from './orchestrator/index.js'
