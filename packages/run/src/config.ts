// Public schema for nxt project and workspace configuration.

export interface WorkspaceConfig {
  /** Maximum concurrent tasks. Defaults to the number of CPUs. */
  concurrency?: number
  /** Cache directory, relative to the workspace root. Defaults to `.vzn/cache`. */
  cacheDir?: string
}

export interface ProjectConfig {
  /** Tasks declared by this project, keyed by task name. */
  tasks?: Record<string, TaskConfig>
}

export interface TaskConfig {
  /**
   * Steps to execute, in order. Each step is a shell command with its own
   * optional env. The whole array is one task: cached, scheduled, and
   * reported as a single unit. Execution stops on the first non-zero exit;
   * stdout/stderr from each step are concatenated for cache replay.
   */
  exec: ExecConfig[]
  /** Tasks that must complete successfully before this task runs. */
  dependsOn?: TaskDependsOn
  /**
   * Caching configuration. **Caching is opt-in.** If this field is omitted,
   * the task always runs and nothing is read from or written to the cache.
   * Provide a `cache` block (with at least `outputs`) to enable caching.
   */
  cache?: CacheConfig
}

export interface ExecConfig {
  /** Shell command to run, from the project's directory. */
  command: string
  /** Environment exposed to the child process. */
  env?: ExecEnv
}

export interface ExecEnv {
  /**
   * Names of env vars whose values are taken from the host (parent
   * `process.env`) and forwarded to the child. Their values are NOT
   * folded into the cache key — for things like CI flags, regional
   * vars, secrets that change between machines without affecting output.
   */
  passThrough?: string[]
  /**
   * Explicit `name: value` pairs. The values are set on the child AND
   * folded into the cache key (they are literal in your config, captured
   * via the task config hash).
   */
  define?: Record<string, string>
}

export interface CacheConfig {
  /** What participates in the cache key. */
  inputs: CacheInputs
  /** What this task produces. Captured for restore on a cache hit. */
  outputs: CacheOutputs
}

export interface CacheOutputs {
  /**
   * Files produced by this task, as project-relative globs. Pass `[]`
   * when the task has no files to capture (e.g. `lint`, `typecheck`).
   * Outputs are not filtered through gitignore — typical artifact dirs
   * like `dist/` and `coverage/` are captured normally even when ignored.
   */
  files: string[]
}

export interface CacheInputs {
  /**
   * Project-relative globs. Each entry is a positive glob, or a negation
   * prefixed with `!`. Required: pass a recursive glob to mean "all
   * project files" (gitignore-aware), or narrow as needed. An empty
   * array means no file inputs at all.
   *
   * Declared outputs and any nested-project files are excluded
   * automatically — a task cannot invalidate itself, and cannot read
   * across project boundaries.
   */
  files: string[]
  /**
   * Env var names whose runtime values from parent `process.env` are
   * folded into the cache key. **Independent of `exec.env`** — declaring
   * a name here does not forward it to the child; it only affects cache
   * invalidation. To both forward AND track, list the name in both
   * `exec.env.passThrough` and here.
   */
  env?: string[]
  /**
   * Which upstream tasks' cache keys participate in this task's key.
   * Same shape as `dependsOn`: list task names by source bucket.
   *
   * **Per-bucket defaults.** When a bucket is omitted, all upstream from
   * that source contribute. When provided, entries are patterns applied
   * in order, last write wins:
   *   - `'*'`     include all from this bucket
   *   - `'name'`  include the literal task name
   *   - `'!name'` exclude the literal task name
   *
   * Examples:
   * - omitted entirely → all upstream contribute (default).
   * - `{ self: ['*'], dependencies: ['build'] }` → explicit "all self,
   *   only build from deps".
   * - `{ dependencies: ['*', '!noisy'] }` → all deps except `noisy`.
   * - `{ self: [], dependencies: [] }` → fully decoupled.
   */
  tasks?: TaskDependsOn
}

export interface TaskDependsOn {
  /**
   * Task names in this same project that must complete first.
   * Equivalent to Turbo's bare `taskname` notation.
   */
  self?: string[]
  /**
   * Task names to run in every transitive workspace dependency before
   * this task starts. Equivalent to Turbo's `^taskname` notation.
   */
  dependencies?: string[]
}

export function defineProject<T extends ProjectConfig>(config: T): T {
  return config
}

export function defineWorkspace<T extends WorkspaceConfig>(config: T): T {
  return config
}
