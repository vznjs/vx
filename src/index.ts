// Public API for @vzn/vx.

export const VERSION = '0.0.0'

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
export { run } from './orchestrator.js'
export type { Logger, RunOptions, RunSummary } from './orchestrator.js'
export type { TaskOutcome, TaskStatus } from './graph/scheduler.js'
export type { TaskNode } from './graph/task-graph.js'
