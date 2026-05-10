// Public schema for nxt project and workspace configuration.

export interface WorkspaceConfig {
  /** Maximum concurrent tasks. Defaults to the number of CPUs. */
  concurrency?: number
  /** Cache directory, relative to the workspace root. Defaults to `.nxt/cache`. */
  cacheDir?: string
}

export interface ProjectConfig {
  /** Project name. If set, must match `package.json#name`. */
  name?: string
  /** Tasks declared by this project, keyed by task name. */
  tasks?: Record<string, TaskConfig>
}

export interface TaskConfig {
  /** How the task is executed. */
  process: ProcessConfig
  /** Tasks that must complete successfully before this task runs. */
  dependsOn?: TaskDependency[]
  /** Caching configuration. */
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
  /** Default: true. */
  enabled?: boolean
  /**
   * What participates in the cache key. Omitted = all project files
   * (gitignore-aware, with declared outputs excluded).
   *
   * Each entry may be:
   * - a string: project-relative glob; prefix with `!` to negate.
   * - `{ default: true }`: the implicit "all project files" set.
   * - `{ env }`: parent env var name; its value is part of the key.
   * - `{ externalDependencies }`: package names from package.json; their
   *   declared version range is part of the key.
   */
  inputs?: Input[]
  /**
   * Files this task produces, as project-relative globs. Captured for
   * restore on a cache hit.
   */
  outputs?: string[]
  /**
   * Which upstream tasks' cache keys participate in this task's key.
   * Names refer to entries in `dependsOn` (by their `task` name).
   * - `true` (default): all entries in `dependsOn`.
   * - `string[]`: only the listed task names.
   */
  dependencies?: boolean | string[]
}

export type Input = string | DefaultInput | EnvInput | ExternalDependenciesInput

export interface DefaultInput {
  /** The implicit "all project files" set. Use to compose with other entries. */
  default: true
}

export interface EnvInput {
  /** Parent env var name. Its current value is folded into the cache key. */
  env: string
}

export interface ExternalDependenciesInput {
  /**
   * npm package names. Each package's version range, as declared in this
   * project's `package.json`, is folded into the cache key.
   */
  externalDependencies: string[]
}

export interface TaskDependency {
  /** Name of the dependency task. */
  task: string
  /**
   * Where to find the dependency task.
   * - omitted / `false`: same project.
   * - `true`: all transitive workspace dependencies.
   * - `{ transitive }`: explicit form.
   */
  dependencies?: boolean | DependenciesScope
}

export interface DependenciesScope {
  transitive?: boolean
}

export function defineProject<T extends ProjectConfig>(config: T): T {
  return config
}

export function defineWorkspace<T extends WorkspaceConfig>(config: T): T {
  return config
}
