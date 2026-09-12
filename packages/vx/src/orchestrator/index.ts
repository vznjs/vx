// Module contract for `orchestrator`. Cross-module imports must come
// through here (enforced by tests/module-boundaries.test.ts).

export { run, planRun } from './run.js'
export { prepareRun, type PreparedRun } from './prepare.js'
export {
  loadProjects,
  loadResolvedProjects,
  loadWorkspacePlugins,
  type LoadedProjects,
  type LoadProjectsArgs,
} from './projects.js'
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
  outcomeWord,
  outcomeLabel,
} from './events.js'
export type {
  EventBus,
  RunEvent,
  RunEventSubscriber,
  WireEvent,
  TaskView,
  OutcomeView,
} from './events.js'
export { escapeMarkdownCell, formatRunReportMarkdown, type RunResult } from './run-report.js'
export {
  EmptyHistoryProvider,
  type HistoryProvider,
  type HistoryTable,
  LocalHistoryProvider,
  type TaskHistory,
} from './history.js'
export {
  detectFlaky,
  type FailureMode,
  type FlakyCandidate,
  type FlakyFinding,
  type FlakyTask,
  flakyTasks,
} from './failure-mode.js'
export {
  installPlugins,
  type CacheContext,
  type ExecutorContext,
  type CommandContext,
  type GraphHookContext,
  type KeyHookContext,
  type PluginCommand,
  type ProjectHookContext,
  type ScheduleHookContext,
  type AdmitContext,
  type WorkspaceHookContext,
  type InstallPluginsArgs,
  type Plugin,
  type PluginContext,
  type PluginHookHandlers,
  type PluginHookName,
  type PluginSetupContext,
  type FingerprintChange,
  type FingerprintClaim,
  type FingerprintContext,
  type VxPlugin,
  definePlugin,
  type PluginHooks,
  type PluginOrigin,
} from './plugin.js'
export {
  applyConfigHooks,
  applyGraphHooks,
  applyKeyHooks,
  applyProjectHooks,
  applyScheduleHooks,
  claimedAffected,
  fingerprintClaims,
  hasHook,
  CACHE_LAYER_METHODS,
  resolveCache,
  resolveExecutors,
} from './plugin-host.js'
export {
  lockfileClaim,
  reachDigests,
  type LockfileClaimHooks,
  type LockfileClaimOptions,
  type ReachGraph,
} from './lockfile-claim.js'
export { subscribeTelemetry, type TelemetryHandle } from './telemetry-host.js'
// The bounded log-capture buffer every telemetry sink shares — see the
// module header for why one implementation, not one per sink.
export { LOG_WIRE_VERSION, TaskLogBuffer } from './task-log-buffer.js'
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
export { deriveStableKeys } from './stable-keys.js'
export type { DeriveStableKeysArgs, StableKey } from './stable-keys.js'
export {
  captureDefaultBranch,
  captureGitContext,
  captureHostContext,
  captureWorkspaceIdentity,
  detectCi,
} from './run-context.js'
export type { CiContext, GitContext, HostContext, WorkspaceIdentity } from './run-context.js'
export {
  cacheKeyDiff,
  explainCacheKey as explainCacheKeyQuery,
  getInvocation,
  getRun,
  listInvocations,
  listRuns,
  whyDidThisRerun as whyDidThisRerunQuery,
} from './metrics.js'
export type {
  CacheEntryRow,
  CacheKeyDiff,
  CacheKeyExplanation,
  InputDiffEntry,
  InvocationDetail,
  InvocationRow,
  ListInvocationsArgs,
  ListRunsArgs,
  RunDetail,
  RunSummaryRow,
  WhyDidThisRerun,
} from './metrics.js'
export { collectInfo, type CollectInfoOptions, type InfoFacts } from './doctor.js'
