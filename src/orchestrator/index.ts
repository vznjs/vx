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
export type { RunPlan, PlannedTask, PlanPrediction, CacheStatus } from './plan.js'
export { formatDuration } from './summary.js'
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
export { escapeMarkdownCell, formatRunReportMarkdown, type RunResult } from './run-report.js'
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
  type CacheContext,
  type EventSink,
  type EventSinkContext,
  type ExecutorContext,
  type InstallPluginsArgs,
  type Plugin,
  type PluginContext,
  type PluginHookHandlers,
  type PluginHookName,
  type PluginSetupContext,
  type VxPlugin,
} from './plugin.js'
export { resolveCache, resolveExecutors, subscribeEventSinks } from './plugin-host.js'
export { MISSING_PLUGIN_HINT } from './missing-plugin.js'
export { subscribeTelemetry, type TelemetryHandle } from './telemetry-host.js'
// The bounded log-capture buffer every telemetry sink shares — see the
// module header for why one implementation, not one per sink.
export {
  LOG_WIRE_VERSION,
  RUN_LOG_BUDGET_CHARS,
  TASK_LOG_TAIL_CHARS,
  TaskLogBuffer,
} from './task-log-buffer.js'
export type { TaskLogBundle, TaskLogEntry } from './task-log-buffer.js'
export {
  assembleRunSummary,
  createTelemetrySource,
  deriveCacheSource,
  isCacheHit,
  isPassStatus,
  TASK_STATUSES,
  TELEMETRY_SCHEMA_VERSION,
} from './telemetry.js'
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
// `diffOutputTrees` is the ONE tree-diff implementation — the verify verdict
// and a serve's cross-machine fingerprint diff must never drift on it.
export { diffOutputTrees } from './verify.js'
export { deriveStableKeys } from './stable-keys.js'
export type { DeriveStableKeysArgs, StableKey } from './stable-keys.js'
export {
  captureDefaultBranch,
  captureGitContext,
  captureHostContext,
  captureWorkspaceIdentity,
  detectCi,
  resolveCacheScope,
} from './run-context.js'
export type { CiContext, GitContext, HostContext, WorkspaceIdentity } from './run-context.js'
export {
  cacheKeyDiff,
  explainCacheKey as explainCacheKeyQuery,
  getCacheStatsSql,
  getHistory,
  getInvocation,
  getRun,
  listInvocations,
  listProjects,
  listRuns,
  whyDidThisRerun as whyDidThisRerunQuery,
} from './metrics.js'
export type {
  CacheEntryRow,
  CacheKeyDiff,
  CacheKeyExplanation,
  CacheStatsResult,
  CompareTaskSide,
  GetHistoryArgs,
  InputDiffEntry,
  InvocationDetail,
  InvocationRow,
  ListInvocationsArgs,
  ListRunsArgs,
  ProjectRollup,
  RunDetail,
  RunSummaryRow,
  TaskHistoryRow,
  WhyDidThisRerun,
} from './metrics.js'
