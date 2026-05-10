// Public schema for nxt project and workspace configuration.

export interface WorkspaceConfig {
  /** Maximum concurrent tasks. Defaults to the number of CPUs. */
  concurrency?: number
  /** Cache directory, relative to the workspace root. Defaults to `.nxt/cache`. */
  cacheDir?: string
}

export interface ProjectConfig {
  /** Tasks declared by this project, keyed by task name. */
  tasks?: Record<string, TaskConfig>
}

export interface TaskConfig {
  /** How the task is executed. */
  process: ProcessConfig
  /** Tasks that must complete successfully before this task runs. */
  dependsOn?: TaskDependency[]
  /**
   * Caching configuration. **Caching is opt-in.** If this field is omitted,
   * the task always runs and nothing is read from or written to the cache.
   * Provide a `cache` block (with at least `outputs`) to enable caching.
   */
  cache?: CacheConfig
}

export interface ProcessConfig {
  /** Shell command to run, from the project's directory. */
  command: string
  /**
   * Env vars whose values are passed through from the parent process to
   * the child. NOT folded into the cache key — for secrets, region, etc.
   */
  passThroughEnv?: string[]
  /**
   * Explicit env values to set for the child process. These ARE folded
   * into the cache key (they are the values, after all).
   */
  env?: Record<string, string>
}

export interface CacheConfig {
  /** What participates in the cache key. */
  inputs?: CacheInputs
  /**
   * Files this task produces, as project-relative globs. Captured for
   * restore on a cache hit. Required when `cache` is set; pass `[]` when
   * the task has no files to capture (e.g. `lint`, `typecheck`).
   */
  outputs: string[]
}

export interface CacheInputs {
  /**
   * Project-relative globs. Each entry is a positive glob, or a negation
   * prefixed with `!`. Omitted: all project files (gitignore-aware, with
   * declared outputs and nested-project files excluded automatically).
   */
  files?: string[]
  /**
   * Env var names. Their current values are folded into the cache key.
   * Independent of `process.passThroughEnv` — declaring a name here does
   * not pass it through to the child.
   */
  env?: string[]
  /**
   * Which upstream tasks' cache keys participate in this task's key.
   * Patterns refer to entries in `dependsOn` (by their `task` name):
   * - `'*'`: every dependsOn task.
   * - `'name'`: include the literal task name.
   * - `'!name'`: exclude the literal task name.
   *
   * Patterns are applied in order, last write wins. Default: `['*']`.
   */
  tasks?: string[]
}

export interface TaskDependency {
  /** Name of the dependency task. */
  task: string
  /**
   * Which workspace projects to look in for the dependency task.
   * Patterns:
   * - `'*'`: all transitive workspace dependencies.
   * - `'name'`: include the literal package name (must be a transitive dep).
   * - `'!name'`: exclude the literal package name.
   *
   * Patterns are applied in order, last write wins. Default: `[]` —
   * the same project as the dependent task.
   */
  dependencies?: string[]
}

export function defineProject<T extends ProjectConfig>(config: T): T {
  return config
}

export function defineWorkspace<T extends WorkspaceConfig>(config: T): T {
  return config
}
