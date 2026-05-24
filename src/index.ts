// Public re-exports. Each module owns its own surface; this file is
// the single entry point for users embedding @vzn/vx programmatically.

export type { Discover, DiscoverOptions, Project, Workspace } from './workspace/index.ts'
export { discover, findWorkspaceRoot } from './workspace/index.ts'

export type {
  ExecConfig,
  LoadConfigs,
  LoadOptions,
  LoadedConfig,
  ProjectConfig,
  TaskConfig,
} from './config/index.ts'
export { defineProject, loadConfigs } from './config/index.ts'

export type {
  BuildInventoryOptions,
  Inventory,
  InventoryProject,
  InventoryTarget,
} from './inventory/index.ts'
export { buildInventory } from './inventory/index.ts'

export type {
  BuildGraph,
  BuildOptions,
  DependencySpec,
  TaskGraph,
  TaskNode,
} from './graph/index.ts'
export { DependencySpecError, GraphError, buildGraph, parseDependencySpec } from './graph/index.ts'

export type { CliOptions, ParsedArgs } from './cli/index.ts'
export { graphCommand, parseArgs, runCli } from './cli/index.ts'
