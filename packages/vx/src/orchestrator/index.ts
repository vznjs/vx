// Module contract for `orchestrator`. Cross-module imports must come
// through here (enforced by tests/module-boundaries.test.ts).

export { run, planRun, nxProjectTarget, projectNamed } from './run.js'
export { CYCLE_INTERRUPT } from './run-stop.js'
export {
  namesRemote,
  openRemotes,
  prepareRun,
  workspaceCachePolicy,
  type PreparedRun,
} from './prepare.js'
export { affectedTaskProjects } from './affected-tasks.js'
export { applyGraphStage } from './graph-stage.js'
export type { AffectedReason } from './affected-tasks.js'
export {
  discoverProjects,
  gitOfDiscovery,
  keepDiscoveryGraph,
  loadProjects,
  loadResolvedProjects,
  loadWorkspacePlugins,
  lockOfDiscovery,
  lockReader,
  type LoadedProjects,
  type LoadProjectsArgs,
} from './projects.js'
export { computeTaskHash, createHashCache, type HashCache } from './task-hash.js'
export type { HeldPersistent, RunOptions, RunSummary } from './options.js'
// Re-surface the cache policy contract (defined in the cache module) so
// embedders constructing RunOptions.cache and the package façade can
// reach it without importing the cache module directly.
export {
  type CacheFlags,
  type CachePolicy,
  FULL_CACHE_POLICY,
  parseCachePolicy,
} from '../cache/index.js'
// The CLI reads a recorded exit code; the runner's convention decodes it.
// It records its own argv quoted as the runner quotes forwarded args.
export { exitSignal, shellQuote } from '../exec/index.js'
export { forwardedSignal } from './signals.js'
// `vx cache clean` waits for a run on the workspace before it evicts.
export { acquireRunLock } from './run-lock.js'
export { type LiveSnapshot, liveSocketPath } from './run-live.js'
export type { RunPlan, PlannedTask, PlanPrediction, CacheStatus } from './plan.js'
export {
  cacheFacts,
  taskArtifacts,
  type ArtifactRun,
  type ArtifactTask,
  type CacheFacts,
  type TaskArtifacts,
} from './task-artifacts.js'
export {
  installPlugins,
  type CacheContext,
  type ExecutorContext,
  type OutputContext,
  type CommandContext,
  type GraphHookContext,
  type KeyHookContext,
  type PluginCommand,
  type ProjectHookContext,
  type ScheduleHookContext,
  type AdmitContext,
  type WorkspaceHookContext,
  type ConfigContext,
  type BranchFacts,
  type DiscoverContext,
  type DiscoveredProject,
  type InstallPluginsArgs,
  type Plugin,
  type PluginContext,
  type PluginHookHandlers,
  type PluginHookName,
  type PluginSetupContext,
  type RunReport,
  type RunReportTask,
  type FingerprintChange,
  type FingerprintClaim,
  type FingerprintContext,
  type VxPlugin,
  definePlugin,
  refuseUnknownOptions,
  type PluginOptionKinds,
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
  claimedExtraFiles,
  fingerprintClaims,
  hasHook,
  REMOTE_CACHE_METHODS,
  resolveCache,
  type CacheHost,
  resolveExecutors,
} from './plugin-host.js'
export {
  lockfileClaim,
  reachDigests,
  type LockfileClaimHooks,
  type LockfileClaimOptions,
  type LockfileImporter,
  type ReachGraph,
} from './lockfile-claim.js'
export { subscribeTelemetry, type TelemetryHandle } from './telemetry-host.js'
// The bounded log-capture buffer every telemetry sink shares — see the
// module header for why one implementation, not one per sink.
export { LOG_WIRE_VERSION, TaskLogBuffer } from './task-log-buffer.js'
export type { TaskLogBundle, TaskLogEntry } from './task-log-buffer.js'
export { assembleRunSummary, createTelemetrySource, TELEMETRY_SCHEMA_VERSION } from './telemetry.js'
export type {
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
  currentBranch,
  detectCi,
  localBranchScope,
  cacheRefs,
  resolveCacheScope,
} from './run-context.js'
export type { CiContext, GitContext, HostContext, WorkspaceIdentity } from './run-context.js'
export {
  runFailures,
  type RunFailures,
  type TaskFailure,
  type TaskLog,
  taskLog,
} from './run-failures.js'
export { resolveRunId, shortRunId } from './run-id.js'
export { collectInfo, type CollectInfoOptions, type InfoFacts } from './doctor.js'
export { localFloor, type LocalFloor } from './local-floor.js'
export { sandboxRequestFor, sweepPlaceholders, type SandboxRequest } from './sandbox-request.js'
