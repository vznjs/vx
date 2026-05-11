// Public API for @vzn/run.

export const VERSION = '0.0.0'

// Schema types and helpers (used by user vzn-config files and presets).
export type {
  WorkspaceConfig,
  ProjectConfig,
  ProjectRunConfig,
  TaskConfig,
  ExecConfig,
  ExecEnv,
  CacheConfig,
  CacheInputs,
  CacheOutputs,
  TaskDependsOn,
} from './config.js'
export { defineProject, defineWorkspace } from './config.js'

// Programmatic engine API (for embedding in other tools).
export { run } from './orchestrator.js'
export type { Logger, RunOptions, RunSummary } from './orchestrator.js'
export type { TaskOutcome, TaskStatus } from './scheduler.js'
export type { TaskNode } from './task-graph.js'
