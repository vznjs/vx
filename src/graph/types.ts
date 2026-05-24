// Task graph contract. The graph is a directed acyclic graph where
// nodes are (project, task) pairs and edges encode `dependsOn`.

import type { LoadedConfig, TaskConfig } from '../config/types.ts'

export interface TaskNode {
  /** Stable identity: `${project}#${task}`. */
  readonly id: string
  readonly project: string
  readonly task: string
  /** The validated TaskConfig from the project's vx.config. */
  readonly config: TaskConfig
  /** Direct upstream task ids. Must run before this node. */
  readonly dependencies: readonly string[]
}

export interface TaskGraph {
  /** Nodes in topological order — every node appears after its dependencies. */
  readonly nodes: readonly TaskNode[]
  /** O(1) lookup by id. */
  readonly byId: ReadonlyMap<string, TaskNode>
}

export interface BuildOptions {
  /** Loaded project configs. Source of truth for tasks + deps. */
  readonly configs: readonly LoadedConfig[]
  /** Requested tasks — bare (`'build'`) or anchored (`'pkg#build'`). */
  readonly requested: readonly string[]
}

export type BuildGraph = (opts: BuildOptions) => TaskGraph

export class GraphError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GraphError'
  }
}
