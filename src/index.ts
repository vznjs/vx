// Public API for @vzn/vx.

export { VERSION } from './version.js'

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
  SandboxConfig,
  SandboxNetworkConfig,
} from './config.js'
export { defineProject, defineWorkspace } from './config.js'

// Programmatic engine API (for embedding in other tools).
export { run, FULL_CACHE_POLICY, parseCachePolicy } from './orchestrator/index.js'
export type { CachePolicy, Logger, RunOptions, RunSummary } from './orchestrator/index.js'
export type { TaskNode, TaskOutcome, TaskStatus } from './graph/index.js'

// Plugin API — the three run-level extension points (backend / cache /
// eventSink). A plugin is declared in vx.workspace.ts via
// defineWorkspace({ plugins: [...] }). See
// docs/design/core-cloud-split-2026-06.md.
export type {
  VxPlugin,
  EventSink,
  BackendContext,
  CacheContext,
  EventSinkContext,
  PluginSetupContext,
  RunBackend,
} from './orchestrator/index.js'

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
