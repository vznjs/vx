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
export { run } from './orchestrator/index.js'
export type { Logger, RunOptions, RunSummary } from './orchestrator/index.js'
export type { TaskNode, TaskOutcome, TaskStatus } from './graph/index.js'

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
