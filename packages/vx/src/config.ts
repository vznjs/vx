// Public schema for vx project and workspace configuration.

export interface WorkspaceConfig {
  /** Maximum concurrent tasks. Defaults to the number of CPUs. */
  concurrency?: number
  /** Cache directory, relative to the workspace root. Defaults to `.vx/cache`. */
  cacheDir?: string
  /**
   * Default per-task timeout (ms) — the lowest-precedence fallback for a
   * task that declares no `exec.timeout`. Precedence, highest first:
   * per-task `exec.timeout` → `VX_TASK_TIMEOUT` env → this workspace
   * default. Purely a runaway-process guard; never folded into a cache
   * key (a timed-out task fails and is never cached). Omitted → no default.
   */
  timeout?: number
  /**
   * Plugins registered for this workspace. Each plugin is an
   * in-process subscriber on the run event bus, installed once per
   * `vx run`. See `docs/design/extension-protocol-2026-06.md` §5.
   */
  plugins?: readonly Plugin[]
}

/**
 * Structural plugin shape — any subset of the pipeline stages
 * (`config`/`project`/`graph`/`key`/`schedule`), run-level capabilities
 * (`cache`/`executor`/`telemetry`) and CLI `commands`, plus optional
 * `setup`/`teardown`. The fully-typed `VxPlugin` lives in
 * `src/orchestrator/plugin.ts` and is what users import; this is a
 * re-declaration with opaque function types so `config.ts` stays a leaf
 * module (no orchestrator import). The orchestrator casts to `VxPlugin`
 * before consulting capabilities.
 */
export interface Plugin {
  readonly name: string
  config?(workspace: unknown, ctx: unknown): unknown
  project?(config: unknown, ctx: unknown): unknown
  graph?(nodes: unknown, ctx: unknown): unknown
  key?(task: unknown, ctx: unknown): unknown
  schedule?(nodes: unknown, ctx: unknown): unknown
  readonly commands?: Readonly<Record<string, unknown>>
  cache?(ctx: unknown): unknown
  executor?(ctx: unknown): unknown
  telemetry?(ctx: unknown): unknown
  setup?(ctx: unknown): void | Promise<void>
  teardown?(): void | Promise<void>
}

export interface ProjectConfig {
  /** Tasks declared by this project, keyed by task name. */
  tasks?: Record<string, TaskConfig>
}

export interface TaskConfig {
  /**
   * Optional one-line description of what this task does. Surfaced in
   * the interactive task picker and the `--dry` text view so users
   * can grep for what each task does without opening every config.
   *
   * No effect on scheduling or execution. It DOES participate in the
   * cache key, because the key hashes the whole resolved task config
   * (`docs/caching.md`, step 5) — deliberate: editing a description
   * isn't a correctness change, but a one-off re-run costs little and
   * carving exceptions out of the resolved object is what invites
   * stale hits.
   */
  description?: string
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
   *   - `'name'`       — same-project task named `name`. When authored
   *                      through `defineProject`, a bare entry is
   *                      **type-checked against this config's task keys**
   *                      (a typo is a compile error).
   *   - `'^name'`      — task `name` in every transitive workspace dep
   *                      (e.g. `'^build'`, `'^all'`); not key-checked.
   *   - `'pkg#name'`   — specific package's `name` task; not key-checked.
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

/**
 * What a sandboxed task may do, declared as CAPABILITIES.
 *
 * One shape for the whole policy. You say what the task is allowed to
 * touch; vx decides how each capability is realised — some become sandbox
 * runtime config, some become rules in the OS policy, and one the platform
 * cannot express is an error rather than a silent no-op. None of that
 * reaches the config.
 *
 * The baseline is always the task's own declarations: it may read its
 * resolved `cache.inputs.files`, write the prefixes of its
 * `cache.outputs.files`, and reach nothing else. Everything here is on top
 * of that.
 *
 * Paths are project-relative, absolute, or `~`-expanded — and are path
 * PREFIXES, never globs (a glob cannot be enforced by a mount).
 */
export interface SandboxConfig {
  /** Capabilities granted on top of the task's own declarations. */
  allow?: SandboxGrants
  /**
   * Capabilities taken away. Evaluated before `allow`, so a domain in both
   * is denied.
   */
  deny?: SandboxDenials
  /**
   * Denials to leave out of the report, in the same shape as `allow`.
   *
   * This does NOT permit anything: the OS still denies the operation, and
   * a command that cannot proceed without it still fails. It says "I know,
   * and it does not affect this task's output" — for a denial you cannot
   * grant away and do not want failing the run.
   *
   * Unlike `allow`, the values are GLOB PATTERNS, and they work the same
   * on every platform: `allow` has to be expressible by the OS sandbox
   * (bwrap mounts a path; it cannot mount a pattern), while `ignore` only
   * has to match a line vx already holds. Relative patterns anchor at the
   * project dir.
   *
   * ```ts
   * ignore: { write: ['*.bun-build'] }   // bun --compile stages a random
   *                                      // temp name in the cwd
   * ```
   */
  ignore?: SandboxGrants
  /**
   * Accept a weaker sandbox when vx itself already runs inside one
   * (a container, another sandbox). Without it, nesting fails fast rather
   * than pretending to confine.
   */
  weakerWhenNested?: boolean
  /** Accept weaker network isolation (host proxy) for lower overhead. */
  weakerNetworkIsolation?: boolean
}

export interface SandboxGrants {
  /** Readable path prefixes, beyond the resolved `cache.inputs.files`. */
  read?: string[]
  /** Writable path prefixes, beyond the `cache.outputs.files` prefixes. */
  write?: string[]
  /**
   * Reachable domains. `true` allows all, `['*.example.com']` a pattern.
   * Omitted means no network at all.
   */
  network?: true | string[]
  /**
   * Kernel information the task may query, by info type — the name that
   * appears in a denial, e.g. `vfs.disk-space` (every Bun and git process
   * probes free space at startup).
   */
  systemInfo?: string[]
  /** Unix socket paths the task may connect to. `true` allows any. */
  unixSockets?: true | string[]
  /** Bind a localhost port — a test that boots a server for itself. */
  localBinding?: boolean
  /** macOS: Mach service names the task may look up. */
  machLookup?: string[]
  /** Acquire a TTY. Rare outside interactive tools. */
  pty?: boolean
  /** Write to `.git/config`. Most build tools should not. */
  gitConfig?: boolean
}

export interface SandboxDenials {
  /** Domains blocked even if `allow.network` would admit them. */
  network?: string[]
}

export interface ExecConfig {
  /** Shell command to run, from the project's directory. */
  command: string
  /**
   * `false` pins the task to this machine: it is never offered to a remote
   * executor (it talks to a local daemon, the network, Docker, …). Default
   * `true`. Tasks that are persistent, or depend on one, are pinned
   * regardless — a worker cannot reach a port on the submitter.
   *
   * `'only'` is the inverse pin: the task exists to produce a REMOTE input
   * tree (the canonical case is `pnpm install` feeding remote workers) and is
   * a NO-OP on this machine — never executed locally, its declared outputs
   * never cleaned or restored on this disk. With no remote executor declared
   * the task succeeds without running and dependents use whatever ambient
   * state the machine has, exactly as they did before the field existed.
   */
  remote?: boolean | 'only'
  /** Environment exposed to the child process. */
  env?: ExecEnv
  /**
   * Upper bound (ms) before vx SIGTERMs the child. A normal task that
   * runs longer is killed and reported `failed` (timed out) — never
   * cached. Omitted → no limit.
   *
   * For a `persistent` task this bounds the READINESS wait instead: if
   * `readyWhen` hasn't matched within the window the child is SIGTERMed
   * and the task fails — without it a server that prints an unexpected
   * banner would hang the run forever. A persistent task that's ready
   * on spawn (no `readyWhen`) becomes ready before the timer can fire,
   * so the timeout is a no-op for it.
   */
  timeout?: number
  /**
   * Max ADDITIONAL attempts after a failed attempt. `retries: 2` means
   * up to 3 executions total. 0 / omitted → no retries (today's
   * behavior: fail on the first non-zero exit). A retry fires after ANY
   * failure, timeout kills included; a Ctrl-C teardown (`aborted`) is
   * never retried. Declared outputs are re-cleaned before each retry so
   * a failed attempt's partial outputs can't leak into the next. The
   * final outcome (and the cached artifact) is the last attempt's.
   * Not allowed with `persistent` — a persistent task has no exit to
   * retry. Explicit config wins over the run-level `--retry <n>`
   * default, including `retries: 0`.
   */
  retries?: number
  /**
   * Resource RESERVATIONS for admission control — NOT enforcement: vx
   * does not cgroup-limit, nice, or kill the task; it only decides what
   * to co-schedule so concurrent reservations never exceed the CPU /
   * memory budget. Each axis defaults to 0 = reserve nothing: the task
   * runs subject only to the concurrency-count limit. A pure scheduling
   * hint — the whole object is stripped from the cache key, so tuning a
   * reservation never invalidates a cached result.
   */
  resources?: ResourcesConfig
  /**
   * Long-running / continuous task (dev server, watcher, daemon).
   * When present, the task is spawned but the runner does NOT wait
   * for it to exit. Instead it considers the task "ready" — either
   * immediately on spawn (no `readyWhen`) or once the readiness
   * pattern matches a line of stdout/stderr. Downstream tasks unblock
   * on ready, not on exit. The orchestrator SIGTERMs every persistent
   * subprocess once the rest of the graph has finished.
   *
   * `cache` is silently ignored for persistent tasks — there's no
   * exit code to cache and the work continues after vx's run notion
   * of "done".
   */
  persistent?: PersistentConfig
  /**
   * Confine this task's process: what it may read, write and reach.
   * Nothing is confined unless this is present.
   *
   * It sits in `exec` because it constrains the same spawn `env` and
   * `resources` do — the environment the child gets, the CPU and memory it
   * gets, the filesystem and network it gets. A group task has no process,
   * so the field cannot be reached from one.
   *
   * **Policy: fail on violation.** An undeclared touch of the project's own
   * files fails the task, and a failed task is never cached. Reaching
   * OUTSIDE the project is denied but not reported — that is the wall
   * doing its job, not a finding.
   *
   * Silently skipped for persistent tasks: a dev server needs unrestricted
   * network and an indefinite process.
   */
  sandbox?: SandboxConfig
}

/**
 * Per-task resource reservation (see `ExecConfig.resources`). Grouped so
 * a future axis slots in without new top-level `exec` fields; the loader
 * rejects unknown keys.
 */
export interface ResourcesConfig {
  /** CPU cores; fractional is allowed (`0.5`). */
  cpus?: number
  /** Megabytes. `memory: 4096` is four gigabytes. */
  memory?: number
  /**
   * The container image this task needs, MATCHED against what a worker
   * advertises — never a provisioning instruction, since a distributed
   * executor's workers belong to whoever runs the fleet. Ignored by
   * executors that do not run containers.
   */
  image?: string
}

export interface PersistentConfig {
  /**
   * Regex pattern (string) matched against stdout/stderr line-by-line.
   * The task is marked "ready" the first time a line matches. Omitted
   * → ready immediately on spawn (fire-and-forget; downstream still
   * runs but doesn't gate on a signal).
   *
   * Example: Vite prints `Local:   http://localhost:5173/` when its
   * dev server is up — `readyWhen: 'Local:'` waits for that line.
   */
  readyWhen?: string
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
  /**
   * Files produced OUTSIDE the project dir, as workspace-root-relative
   * globs (the Turbo `$TURBO_ROOT$` / Nx `{workspaceRoot}` escape
   * hatch). NO project-boundary rule applies: these globs may capture
   * files anywhere in the workspace, including inside other projects'
   * directories. Deliberate escape hatch — prefer project-relative
   * `files` whenever the task can write inside its own dir. Two tasks
   * declaring overlapping workspace outputs is user responsibility;
   * vx does not police it.
   */
  workspaceFiles?: string[]
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
   * Workspace-root-relative globs (the Turbo `$TURBO_ROOT$` / Nx
   * `{workspaceRoot}` equivalent), for inputs that live outside the
   * project dir — a root tsconfig, shared codegen output, etc. Same
   * syntax as `files` (`!` negation supported), resolved against the
   * workspace-wide git file set (gitignored files are invisible).
   *
   * NO project-boundary rule applies: these globs may match files
   * inside other projects' directories. Deliberate escape hatch —
   * prefer project-relative `files` declarations where possible.
   * Declared `outputs.workspaceFiles` are excluded automatically (a
   * task cannot invalidate itself).
   */
  workspaceFiles?: string[]
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
  /**
   * Shell commands run in the PROJECT dir at hash time; their combined,
   * trimmed (stdout + stderr) output is folded into the cache key.
   * Deduped per (projectDir, command) within a run. A non-zero exit
   * fails the run. Modeled on `env`: the COMMANDS are frozen in the
   * lock, the OUTPUT is resolved live every run — correct under
   * `--frozen`. Use for project-specific runtime probes.
   */
  runtime?: string[]
  /**
   * Like `runtime`, but commands run at the WORKSPACE ROOT and are
   * deduped GLOBALLY per command across the whole run — a `node -v`
   * declared in 500 projects spawns exactly once. The runtime-input
   * analog of `workspaceFiles`: per-task, root-anchored. Use for global
   * tool versions, OS info, etc.
   */
  workspaceRuntime?: string[]
}

/**
 * A valid `dependsOn` entry, given the set of sibling task names `K`:
 *   - `K`                — a same-project task; type-checked against the
 *                          keys of THIS config's `tasks` (typo → error).
 *   - `` `^${string}` `` — a task in workspace deps (e.g. `'^build'`,
 *                          `'^all'`); the dep's task names aren't known
 *                          here, so any `^`-prefixed string is allowed.
 *   - `` `${string}#${string}` `` — a specific package's task
 *                          (`'pkg#build'`); cross-project, not key-checked.
 *   - `` `${string}*${string}` `` — a task-name pattern (`'build.*'`);
 *                          expands at graph build, so it can't be
 *                          key-checked (a bare `'*'` still fails at
 *                          runtime — bare wildcards are filter-only).
 */
type DependsOnEntry<K extends string> =
  | K
  | `^${string}`
  | `${string}#${string}`
  | `${string}*${string}`

/**
 * Identity function — exists only so TypeScript narrows literal types
 * and, crucially, **validates `dependsOn` against this project's own
 * task names**. A bare entry that isn't a declared task key is a compile
 * error; `^name` / `pkg#name` forms reference other projects and stay
 * free strings. Runtime behavior is unchanged (it returns its input).
 */
export function defineProject<const T extends ProjectConfig>(
  config: T & {
    tasks?: {
      [K in keyof NonNullable<T['tasks']>]?: {
        dependsOn?: readonly DependsOnEntry<Extract<keyof NonNullable<T['tasks']>, string>>[]
      }
    }
  },
): T {
  return config as T
}

export function defineWorkspace<T extends WorkspaceConfig>(config: T): T {
  return config
}
