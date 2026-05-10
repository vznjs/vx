// Public schema for nxt project and workspace configuration.
//
// Design constraints:
// - Explicit. No inheritance, no string DSLs.
// - Solve the common case. No knobs that exist for hypothetical needs.
// - Replaceable layers underneath: this schema is the only contract.
//
// Cache inputs are NOT configurable. Every file in the project (gitignore-
// aware) is a cache input. Outputs and declared env vars are the only knobs.

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
  /** Shell command to run, executed in the project's directory. */
  command: string
  /** Other tasks that must complete successfully before this task runs. */
  dependsOn?: TaskDependency[]
  /**
   * Environment variables to expose to the task. These — and only these,
   * plus a minimal essential allowlist for shell tooling — are visible to
   * the child process. Their values are part of the cache key.
   */
  env?: string[]
  /**
   * Files produced by this task, as project-relative globs. Captured to the
   * cache for restore on hit. Also folded into downstream cache keys via a
   * content hash, so a dependency's output change invalidates dependents.
   */
  outputs?: string[]
  /**
   * Whether to read from / write to the cache for this task. Defaults to
   * `true`. When `false` the task always runs; its outputs are still hashed
   * for downstream invalidation but not stored or restored.
   */
  cache?: boolean
}

export interface TaskDependency {
  /** Name of the dependency task. */
  task: string
  /**
   * Where to look for the dependency task.
   * - omitted / `false`: same project.
   * - `true`: all transitive workspace dependencies (shorthand for `{ transitive: true }`).
   * - object: explicit form.
   */
  dependencies?: boolean | DependenciesScope
}

export interface DependenciesScope {
  /** If true, follow workspace deps transitively. If false, only direct deps. */
  transitive?: boolean
}

export function defineProject<T extends ProjectConfig>(config: T): T {
  return config
}

export function defineWorkspace<T extends WorkspaceConfig>(config: T): T {
  return config
}
