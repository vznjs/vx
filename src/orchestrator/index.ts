// Module contract for `orchestrator`. Cross-module imports must come
// through here (enforced by tests/module-boundaries.test.ts).

export { run, planRun } from './run.js'
export { prepareRun, type PreparedRun } from './prepare.js'
export { computeTaskHash, createHashCache, type HashCache } from './task-hash.js'
export type { RunOptions, RunSummary } from './options.js'
// Re-surface the cache policy contract (defined in the cache module) so
// embedders constructing RunOptions.cache and the package façade can
// reach it without importing the cache module directly.
export { type CachePolicy, FULL_CACHE_POLICY, parseCachePolicy } from '../cache/index.js'
export { defaultLogger, resolveOutputView } from './logger.js'
export type { Logger, OutputView } from './logger.js'
export type { RunPlan, PlannedTask, CacheStatus } from './plan.js'
export {
  createEventBus,
  wireForwarder,
  toWireEvent,
  projectNode,
  projectOutcome,
} from './events.js'
export type {
  EventBus,
  RunEvent,
  RunEventSubscriber,
  WireEvent,
  TaskView,
  OutcomeView,
} from './events.js'
export { createVxSurface } from './devframe-surface.js'
export { createWireRenderer } from './wire-render.js'
export { optionsToRequest, requestToOptions } from './protocol.js'
export type { ClientMessage, RunBackend, RunRequest, RunResult, ServerMessage } from './protocol.js'
export { formatRunReportMarkdown } from './run-report.js'
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
} from './wire.js'
export type {
  Envelope,
  ErrorResponse,
  Notification,
  Request as WireRequest,
  Response as WireResponse,
  WireChannel,
} from './wire.js'
export {
  EmptyHistoryProvider,
  type HistoryProvider,
  type HistoryTable,
  LocalHistoryProvider,
  type TaskHistory,
} from './history.js'
export { computePredictedPriorities } from './predict.js'
export {
  installPlugins,
  type BackendContext,
  type CacheContext,
  type EventSink,
  type EventSinkContext,
  type InstallPluginsArgs,
  type Plugin,
  type PluginContext,
  type PluginHookHandlers,
  type PluginHookName,
  type PluginSetupContext,
  type VxPlugin,
} from './plugin.js'
export { resolveBackend, resolveCache, subscribeEventSinks } from './plugin-host.js'
export { subscribeTelemetry, type TelemetryHandle } from './telemetry-host.js'
export { createTelemetrySource, deriveCacheSource, TELEMETRY_SCHEMA_VERSION } from './telemetry.js'
export type {
  CacheSource,
  RunContextRecord,
  RunSummaryRecord,
  TaskTelemetry,
  TelemetryContext,
  TelemetryRecord,
  TelemetrySink,
  TelemetrySource,
} from './telemetry.js'
export { deriveStableKeys } from './stable-keys.js'
export type { DeriveStableKeysArgs, StableKey } from './stable-keys.js'
export { captureGitContext, captureWorkspaceIdentity, resolveCacheScope } from './run-context.js'
export type { GitContext, WorkspaceIdentity } from './run-context.js'
export {
  cacheKeyDiff,
  compareRuns,
  explainCacheKey as explainCacheKeyQuery,
  getBottlenecks,
  getCacheBreakdown,
  getCacheSavings,
  getCacheStatsSql,
  getFlakiestTasks,
  getHistory,
  getHitRateSplit,
  getInvocation,
  getParallelismHistory,
  getPrunableEntries,
  getRecentFailures,
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
  whyDidThisRerun as whyDidThisRerunQuery,
} from './metrics.js'
export type {
  BottleneckRow,
  CacheEntryRow,
  CacheKeyDiff,
  CacheKeyExplanation,
  CacheProjectRow,
  CacheSavings,
  CacheStatsResult,
  CompareRuns,
  CompareTaskRow,
  CompareTaskSide,
  FailureRow,
  FlakyTask,
  GetHistoryArgs,
  HeatmapCell,
  HitRateSplit,
  InputDiffEntry,
  InvocationDetail,
  InvocationRow,
  ListCacheEntriesArgs,
  ListInvocationsArgs,
  ListRunsArgs,
  ParallelismPoint,
  PrunableEntry,
  ProjectRollup,
  RunDetail,
  RunSummaryRow,
  StoragePoint,
  TaskDetail,
  TaskHistoryRow,
  TopTaskRow,
  TrendBucket,
  TrendPoint,
  WhyDidThisRerun,
} from './metrics.js'
