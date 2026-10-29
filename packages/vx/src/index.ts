// Public API for @vzn/vx.
//
// This is the stable cross-package contract — any plugin or integration
// package imports everything it needs from here via the bare
// `'@vzn/vx'` specifier (never a deep `src/...` path). The surface is pinned
// by tests/package-boundaries.unsafe.test.ts; a widening updates that snapshot
// deliberately. The boundary law: docs/architecture.md § Repository shape.

export { VERSION } from './version.js'

// Clean error type — user-input failures print a message without a stack.
export { UserError, isUserError } from './util/index.js'
// Every hook a plugin may fill, in pipeline order — the one list the
// loader, the host and `vx info` read; exported so a doc pin outside core
// (the site's guides) holds its tables to the same list.
export { PLUGIN_HOOKS, type PluginHook } from './config.js'
// The machine as this process may use it — cores and memory capped by the
// cgroup a container runs under. Core's default worker count reads the
// first; a policy that budgets memory (`@vzn/vx-history`) reads
// the second, so the cgroup walk has one implementation.
export { machineMemoryBytes, machineParallelism } from './util/index.js'
// How core reads a task glob — its spelling, and which characters are
// wildcards (`[` `]` and an escape are) — for a plugin that turns declared
// outputs into something else (`@vzn/vx-reapi`'s literal `output_paths`).
export {
  isLiteralPattern,
  normalizeGlob,
  outputDirPrefixes,
  restorableOutput,
} from './util/index.js'

// Schema types and helpers (used by user vx.config files and presets).
export type {
  WorkspaceConfig,
  RunSettings,
  CacheSettings,
  LockSettings,
  WatchSettings,
  Duration,
  ProjectConfig,
  TaskConfig,
  ExecConfig,
  ExecEnv,
  CacheConfig,
  InputsConfig,
  CacheOutputs,
  InputStability,
  SandboxConfig,
  SandboxGrants,
  SandboxDenials,
  Platform,
} from './config.js'
export { defineProject, defineWorkspace, PLATFORMS } from './config.js'
export { definePlugin, refuseUnknownOptions } from './orchestrator/index.js'
export { branchCacheScope } from './workspace/index.js'
// A plugin reading the base branch's history: a shallow clone fetches it.
export { mergeBaseWith } from './workspace/index.js'

// Programmatic engine API: run / plan / prepare (docs/cli.md § Programmatic
// API). The graph primitives, the cache-key hashing seam and the git / host
// context capture used to sit beside these for a distributed submitter that
// left the repo (2026-08); they went with it (2026-09-10) — a seam with no
// consumer is re-added when one appears, shaped by its use.
export { run, planRun, prepareRun } from './orchestrator/index.js'
// The per-task duration history a `schedule` plugin learns from
// (`@vzn/vx-history` does; a plugin package reaches core only
// through this façade, which is what put these here).
export { currentBranch } from './orchestrator/index.js'
export { localHistory } from './history/index.js'
export type {
  HistoryProvider,
  HistoryTable,
  LocalHistory,
  LocalHistoryOptions,
  TaskHistory,
  TaskResources,
} from './history/index.js'
export type { PreparedRun } from './orchestrator/index.js'
// `RunOptions.affected`: what `--affected`'s diff changed, per project.
export type { AffectedChanges } from './workspace/index.js'
// `planRun` returns these, and an embedder that cannot NAME a return type
// cannot hold it: `run` and `prepareRun` both had theirs here from the
// start, so the omission read as "planRun is not really public" while
// docs/cli.md § Programmatic API listed all three (item 387, 2026-09-19).
export type { RunPlan, PlannedTask } from './orchestrator/index.js'
export type { CiContext, GitContext, HostContext, WorkspaceIdentity } from './orchestrator/index.js'
export type { CacheFlags, CachePolicy, RunOptions, RunSummary } from './orchestrator/index.js'
export type { Logger, OutputView } from './report/index.js'
// `splitTaskId` is on the façade because the alternative is what happened:
// with only `taskId()` to JOIN an id and nothing exported to SPLIT one,
// consumers roll their own `split('#', 2)` and drift from the graph, which
// splits on the FIRST '#'.
export { criticalPath, outputsOverlap, splitTaskId, taskDefinitions } from './graph/index.js'
export type { TaskNode, TaskOutcome, TaskStatus } from './graph/index.js'

// Cache classes + the layer interface (the `cache` capability's currency).
export { Cache } from './cache/index.js'
export type {
  CacheLayer,
  PluginCache,
  ArtifactInfo,
  LentAccess,
  RemoteCacheLayer,
  RemoteOpenContext,
  RunRecord,
  InvocationRecord,
} from './cache/index.js'
// A plugin's keychain (`ctx.secret` on `setup` and a remote's `open`), the
// guard that tells a missing secret from a fault, and the names whose values
// vx masks, for a plugin that must not send one where it is shown.
export { isSecretUnavailable, secretNamed } from './util/index.js'
export type {
  PluginSecrets,
  SecretRequest,
  SecretUnavailable,
  SecretUnavailableReason,
} from './util/index.js'

// Workspace discovery + the project/config catalog surface — an
// out-of-process service/CLI needs these. `loadProjectConfig` is the RAW
// per-file load (`vx lock` freezes exactly that); the resolved view a run
// or `vx show` sees — plugin stages applied — is `loadResolvedProjects`
// below. `PROJECT_CONFIG_FILENAMES` are the names a project's config may
// have, in precedence order, for a tool that finds or writes one.
export { findWorkspaceRoot, PROJECT_CONFIG_FILENAMES } from './workspace/index.js'
export { loadProjectConfig } from './workspace/index.js'
export type { ProjectMeta } from './workspace/index.js'
// The run path's RESOLVED view — plugin `config` and `project` stages
// applied — for a reader outside the CLI
// (`@vzn/vx-history`, an embedder's task catalog). What `vx show`
// prints.
export { loadResolvedProjects } from './orchestrator/index.js'
export type { ProjectEntry } from './workspace/index.js'
// The migration seam: how a generated config is planned, rendered, guarded
// and written. `@vzn/vx-migrate` (package.json scripts, Turbo, Nx) and any
// other adoption tool use it from here; `taskNameProblem` is why a name
// cannot be a task's, so a mapper leaves such a script out.
export {
  applyMigration,
  foldScriptHooks,
  isStarterConfig,
  PERSISTENT_TODO,
  pruneOrphanPersistentNotes,
  quoteTsLiteral,
  taskNameProblem,
} from './workspace/index.js'
// Output components: a plugin draws its lines with core's, so they look alike.
export { ui } from './util/index.js'
export type {
  ApplyMigrationArgs,
  MigrationFormat,
  MigrationMember,
  GeneratedProject,
  GeneratedTask,
  MigrationPlan,
  RawExpr,
} from './workspace/index.js'

// Plugin API — the run-level extension points. Behavior capabilities
// (executor / cache) change WHAT/HOW work runs; the observe-only `telemetry`
// capability is the canonical data-export path and cannot change behavior.
// A plugin is declared in .vx/workspace.ts via defineWorkspace({ plugins }).
// See docs/design/observability-architecture-2026-06.md.
// The claimant's shell for a lockfile plugin (`@vzn/vx-lockfile`):
// the claim, the per-project key, the memo and the `--affected` diff around
// a parser; `reachDigests` is the Merkle-over-components digest both use.
export {
  lockfileClaim,
  reachDigests,
  type LockfileClaimHooks,
  type LockfileClaimOptions,
  type LockfileImporter,
  type ReachGraph,
} from './orchestrator/index.js'
export type {
  VxPlugin,
  PluginHooks,
  PluginOrigin,
  PluginOptionKinds,
  CacheContext,
  ExecutorContext,
  OutputContext,
  CommandContext,
  ArtifactRun,
  ArtifactTask,
  CacheFacts,
  TaskArtifacts,
  FingerprintChange,
  FingerprintClaim,
  FingerprintContext,
  GraphHookContext,
  KeyHookContext,
  PluginCommand,
  ProjectHookContext,
  ScheduleHookContext,
  AdmitContext,
  WorkspaceHookContext,
  ConfigContext,
  BranchFacts,
  DiscoverContext,
  DiscoveredProject,
  PluginSetupContext,
  RunReport,
  RunReportTask,
  PluginHookName,
  PluginHookHandlers,
} from './orchestrator/index.js'
export type { RunStartInfo } from './report/index.js'
// The per-task execution contract a plugin's `executor` capability returns.
// (`runCommand` / `runSandboxed`, the local executor's own primitives, left
// the façade 2026-09-10: no executor plugin built on them — `@vzn/vx-reapi`
// speaks a wire — and a seam with no consumer is a special case in waiting.)
// A remote executor gives a task back to the local floor by rejecting with
// this (B-100): core runs it here and says why once.
export { executorFallback, hostPlatform, sampleTrees, type TreeUsage } from './exec/index.js'
// How the local executor puts the args after `--` on a command, for an
// executor that runs `ExecuteRequest.command` itself: `@vzn/vx-reapi` and
// the `vx init --plugin executor` example each joined their own, and a
// trailing comment or a template literal's closing newline lost the args
// there while the local floor kept them (X-112).
export { withForwardArgs } from './exec/index.js'
// The `npm_execpath` core gives a local task: a `@vzn/vx-dte` worker gives
// its tasks the same, its own machine's, not what launched it.
export { packageManagerPath } from './exec/index.js'
// A task's output both streams in the order written, bounded as core's
// capture is: what a worker saves through `TaskArtifacts` (`@vzn/vx-dte`).
export { BoundedCapture, type CapturedChunk } from './exec/index.js'
// Core's local executor, sandbox included, for a plugin that runs tasks
// itself: `@vzn/vx-dte`'s orchestrator and its workers.
export { localFloor, type LocalFloor } from './orchestrator/index.js'
// A task's sandbox request built where a worker runs it: the paths and the
// walls are that machine's (`@vzn/vx-dte`, an orchestrator of another OS).
// Its sweep takes back each placeholder the task never wrote, as core does.
export { sandboxRequestFor, sweepPlaceholders, type SandboxRequest } from './orchestrator/index.js'
// A runtime probe answered where a `runtime` executor runs the task.
export { answerRuntime } from './cache/index.js'
export type {
  ExecuteRequest,
  ExecuteResult,
  ExecuteSandbox,
  MachineReport,
  ResolvedSandboxConfig,
  ServerSpec,
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
// "no" for the new one.
export { type CacheSource, isCacheHit, isPassStatus } from './graph/index.js'
export { TELEMETRY_SCHEMA_VERSION } from './orchestrator/index.js'
// `TaskLogBuffer` is on the façade on the same demonstrated need: EVERY
// telemetry sink that ships build output has to bound it, and the retention
// rules (per-task tail, per-run budget, failures never evicted by successes,
// a hit's bytes belong to the run that executed) are a decision, not an
// implementation detail. Two sinks rolling their own is how they fork.
export { LOG_WIRE_VERSION, TaskLogBuffer } from './orchestrator/index.js'
// `exitSignal` is on the façade on the same demonstrated need: a sink that
// renders a failed task's exit code faces 137 where the frame and `vx last`
// say `128 + SIGKILL`; the decode is the runner's convention, one copy.
export { exitSignal } from './orchestrator/index.js'
export type {
  RunContextRecord,
  RunSummaryRecord,
  TaskLogBundle,
  TaskLogEntry,
  TaskTelemetry,
  TelemetryContext,
  TelemetryRecord,
  TelemetrySink,
} from './orchestrator/index.js'

// The serializable per-task views.
export type { TaskView, OutcomeView } from './report/index.js'
