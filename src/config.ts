// Public schema for vx project and workspace configuration.

export interface WorkspaceConfig {
  /** Maximum concurrent tasks. Defaults to the number of CPUs. */
  concurrency?: number
  /** Cache directory, relative to the workspace root. Defaults to `.vx/cache`. */
  cacheDir?: string
}

export interface ProjectConfig {
  /** Tasks declared by this project, keyed by task name. */
  tasks?: Record<string, TaskConfig>
}

export interface TaskConfig {
  /**
   * Shell command + optional env. One command per task. Omit `exec` to
   * declare a **group task** — a no-op that exists only to chain
   * `dependsOn`. Running a group is equivalent to running its
   * dependencies; nothing else happens (no spawn, no I/O, no cache
   * read/write). Useful for "install" / "ci" umbrella tasks that fan
   * out to per-package work.
   */
  exec?: ExecConfig
  /**
   * Tasks that must complete successfully before this task runs.
   * Turbo/Nx-style micro-syntax:
   *   - `'name'`       — same-project task named `name`.
   *   - `'^name'`      — task `name` in every transitive workspace dep.
   *   - `'pkg#name'`   — specific package's `name` task.
   */
  dependsOn?: readonly string[]
  /**
   * Caching configuration. **Caching is opt-in.** If this field is omitted,
   * the task always runs and nothing is read from or written to the cache.
   * Provide a `cache` block (with at least `outputs`) to enable caching.
   * Requires `exec` — a group task can't cache anything because nothing
   * runs.
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
   * Uses the same Turbo/Nx micro-syntax as `dependsOn`, plus
   * wildcards and negation for filtering:
   *
   *   - `'*'`         include every same-project upstream
   *   - `'^*'`        include every dep-workspace upstream
   *   - `'name'`      include same-project task `name`
   *   - `'^name'`     include the `name` task in dep workspaces
   *   - `'pkg#name'`  include the specific package's `name` task
   *   - `'!name'`, `'!^name'`, `'!pkg#name'` — exclude
   *
   * Patterns are applied in order, last write wins, so
   * `['*', '^*', '!^noisy']` reads as "all upstream except deps' noisy".
   *
   * Defaults:
   * - omitted entirely → all upstream contribute (same as `['*', '^*']`).
   * - `[]` → fully decoupled; no upstream contributes.
   */
  tasks?: readonly string[]
}

export function defineProject<T extends ProjectConfig>(config: T): T {
  return config
}

export function defineWorkspace<T extends WorkspaceConfig>(config: T): T {
  return config
}
