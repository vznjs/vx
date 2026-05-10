// Public schema for nxt project and workspace configuration.
//
// Everything is explicit. There is no inheritance between tasks, no workspace
// defaults that bleed into projects, and no string DSLs. If a behaviour is not
// declared here it does not happen.

export interface WorkspaceConfig {
  /** Maximum concurrent tasks. Defaults to the number of CPUs. */
  concurrency?: number
  /** Cache directory, relative to the workspace root. Defaults to `.nxt/cache`. */
  cacheDir?: string
}

export interface ProjectConfig {
  /**
   * Project name. Optional; when set, must match `package.json#name`.
   * Used purely as a sanity check.
   */
  name?: string
  /** Tasks declared by this project, keyed by task name. */
  tasks?: Record<string, TaskConfig>
}

export interface TaskConfig {
  /** Shell command to run. Executed via the system shell in the project's directory. */
  command: string
  /** Other tasks that must complete successfully before this task runs. */
  dependsOn?: TaskDependency[]
  /**
   * Names of environment variables whose values are part of the cache key.
   * The full `process.env` is still passed to the child process; only the
   * listed names participate in cache identity.
   */
  env?: string[]
  /**
   * Caching configuration.
   * - `true` (default): cache enabled with implicit inputs (all project files,
   *   gitignore-aware) and no declared outputs.
   * - `false`: caching disabled; the task always runs.
   * - object: explicit inputs and/or outputs.
   */
  cache?: boolean | CacheConfig
}

export interface TaskDependency {
  /** Name of the dependency task. */
  task: string
  /**
   * Where to look for the dependency task.
   * - omitted / `false`: same project as the dependent task.
   * - `true`: all transitive workspace dependencies (shorthand for `{ transitive: true }`).
   * - object: explicit form, see `DependenciesScope`.
   */
  dependencies?: boolean | DependenciesScope
}

export interface DependenciesScope {
  /**
   * If true, follow workspace deps transitively.
   * If false, only direct workspace deps from `package.json`.
   */
  transitive?: boolean
}

export interface CacheConfig {
  /**
   * What goes into the cache key.
   * - omitted: implicit "all project files (gitignore-aware)".
   * - present: only the declared inputs are hashed.
   *
   * Strings are globs relative to the project directory and may use `!` to
   * negate. Objects escape to other roots; today only `{ workspace: '...' }`.
   */
  inputs?: Input[]
  /**
   * Files this task produces, as project-relative globs. Captured into the
   * cache and restored on a hit. May be empty for tasks with no artifacts.
   */
  outputs?: string[]
}

/** A single input source. */
export type Input = string | WorkspaceInput

export interface WorkspaceInput {
  /** Glob relative to the workspace root. */
  workspace: string
}

export function defineProject<T extends ProjectConfig>(config: T): T {
  return config
}

export function defineWorkspace<T extends WorkspaceConfig>(config: T): T {
  return config
}
