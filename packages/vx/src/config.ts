// Public schema for vx project and workspace configuration.

/**
 * A duration with its unit: `'500ms'`, `'30s'`, `'5m'`, `'2h'`, `'1d'`. A
 * bare number is refused: a unit in the value keeps the name free of one.
 */
export type Duration = `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`

/**
 * The workspace: settings in groups (`run`, `cache`, `lock`, `watch`) and the
 * plugins. Each setting's environment variable and flag derive from its
 * path (`run.concurrency` → `VX_RUN_CONCURRENCY`, `vx run --concurrency`); a flag beats
 * the variable, which beats this file. `docs/schema.md` lists them all.
 * Nothing here is folded into a cache key.
 */
export interface WorkspaceConfig {
  run?: RunSettings
  cache?: CacheSettings
  lock?: LockSettings
  watch?: WatchSettings
  /**
   * Plugins registered for this workspace, consulted in this order once
   * per `vx run`: each fills any of the pipeline stages and capabilities
   * below, and core's own executor and cache store sit at the tail of
   * every list. See `docs/design/pipeline-2026-09.md`. An `undefined`,
   * `null` or `false` entry is skipped, so a factory that declines
   * (`github()` off Actions) or `cond && plugin()` needs no filter.
   */
  plugins?: readonly (Plugin | undefined | null | false)[]
}

/** `WorkspaceConfig.run`: how a run runs. */
export interface RunSettings {
  /** Tasks at once: a positive integer, or a share of the cores (`'50%'`). Omitted → the cores this process may use. */
  concurrency?: number | `${number}%`
  /**
   * Which ready task starts first when there are more than workers, with no
   * timings: `most-work` (the default) the one the most work waits on at
   * any depth, `critical-path` the head of the longest chain of tasks,
   * `direct-dependents` the one the most tasks wait on directly (Nx's
   * rule), `ready-order` the one that became ready first (Turbo's). A
   * `schedule` plugin's weights still come first; this breaks their ties.
   */
  schedule?: 'most-work' | 'critical-path' | 'direct-dependents' | 'ready-order'
  /**
   * The git ref a bare `--affected` compares with (`origin/develop`).
   * `--affected=<base>` overrides it. Omitted → `origin/HEAD`, then the
   * first of `origin/main`, `origin/master`, `main`, `master` that is not
   * HEAD, else `HEAD~1`.
   */
  affectedBase?: string
  /**
   * A task's time limit, for tasks without their own `exec.timeout` (which
   * beats every run-level source). A runaway-process guard: a timed-out
   * task fails and is never cached. Omitted → no limit.
   */
  timeout?: Duration
  /** Re-runs of a failed task, for tasks without their own `exec.retries`. Omitted → 0. */
  retries?: number
  /**
   * What a failed task takes down: `never` stops the run, `deps-ok` (the
   * default) skips its dependents, `always` runs them too.
   */
  continue?: 'never' | 'deps-ok' | 'always'
  /**
   * Graph rules checked by `vx lock` and `vx lock --check`, never by a
   * run. Each is on
   * unless set to `false`; turning one off allows a shape vx handles
   * correctly but more slowly.
   */
  rules?: WorkspaceRules
}

/** `WorkspaceConfig.cache`: where the cache lives and what a run does with it. */
export interface CacheSettings {
  /**
   * Cache directory, relative to the workspace root. Named, it holds the whole
   * cache and shares nothing; unset, the workspace keeps its index in
   * `.vx/cache` and its entries in the user's shared store.
   */
  dir?: string
  /**
   * Evict from the local cache at the end of every run, whatever its
   * policy (a remote hit is ingested under any), by the same policy
   * `vx cache clean` takes as flags: entries not used for `olderThan`
   * (`'30d'`, `'12h'`), then least-recently-used entries until the cache
   * is under `maxSize` (`'10GB'`, `'500MB'`). Either or both. Omitted →
   * nothing is evicted unless you run `vx cache clean`.
   */
  retention?: { olderThan?: Duration; maxSize?: string }
  /**
   * Which layers a run reads and writes (`'local:rw,remote:r'`; a layer it
   * leaves out stays on); `--no-cache` and `--force` still apply on top.
   * Omitted → every layer reads and writes. The local layer is always read
   * first, then each remote in declared order.
   */
  policy?: string
  /**
   * Where this run's cache writes land. Omitted, a run reads and writes the
   * default keys. A name (`'pr-123'`) reads the default key first, then the
   * scope's, and writes only the scope's, so a PR never writes what the
   * default branch reads. Whether a run writes at all is `policy`'s call.
   * A client-side convention, not a security boundary: the boundary is a
   * cache token the server limits.
   */
  scope?: string
  /** Which remote hits land on disk: `all` (the default), only the requested tasks' (`toplevel`), or `none`. */
  download?: 'all' | 'toplevel' | 'none'
  /** The `cache.inputStability` of every task that does not set its own. */
  inputStability?: InputStability
  /** The `cache.outputs.clean` of every task that does not set its own. */
  outputs?: { clean?: boolean }
  /**
   * Which runs keep a failed task's log and the files its outputs left in
   * the remote: CI runs (`'ci'`, the default), runs off CI (`'local'`), or
   * both (`'always'`). Only a run whose policy writes a remote keeps any.
   */
  upload?: { failures?: 'ci' | 'local' | 'always' }
}

/** `WorkspaceConfig.lock`. */
export interface LockSettings {
  /**
   * `vx lock` writes each project's resolved config, pretty, to
   * `vx.lock.json` beside its `vx.config`, for review; vx never reads it.
   * On unless `false`.
   */
  reviewFiles?: boolean
}

/** `WorkspaceConfig.watch`. */
export interface WatchSettings {
  /** Poll for changes from the start instead of the OS watcher. */
  poll?: boolean
}

/** `WorkspaceConfig.run.rules`. */
export interface WorkspaceRules {
  /**
   * Refuse two tasks whose declared outputs overlap even when a `dependsOn`
   * edge orders them. Off, the dependant adds to its upstream's tree and
   * owns only what its run added (`caching.md` § Additive outputs). Two
   * overlapping tasks with no edge are refused either way.
   */
  exclusiveOutputs?: boolean
  /**
   * Which workspace projects a project may depend on, checked by `vx lock`
   * over each project's direct dependencies (its manifest's and its tasks'
   * cross-project `dependsOn`). Every rule whose `from` selects a project
   * applies to it; a project no rule selects is free.
   */
  dependencies?: readonly DependencyRule[]
}

/**
 * One `run.rules.dependencies` entry. A selector is `tag:<tag>`, matching
 * a project that carries the tag, or a project name; `*` matches any
 * characters in either (`tag:scope:*`, `@acme/*`, `*`).
 */
export interface DependencyRule {
  /** The projects this rule constrains. */
  from: string
  /** Given, each dependency must match one of these. */
  allow?: readonly string[]
  /** No dependency may match one of these; beats `allow`. */
  deny?: readonly string[]
}

/**
 * The runtime brand `definePlugin` stamps on a plugin: the name of the
 * package it was defined in. The workspace loader accepts a plugin only
 * when this is present and equals `name`, so a plugin's name is its
 * package name and nothing else — no field to set, no override. A
 * registry symbol on purpose: a plugin package imports its own copy of
 * `@vzn/vx` beside a compiled binary's, and the two copies must stamp
 * and check the same key.
 */
export const PLUGIN_PACKAGE: unique symbol = Symbol.for('vx.plugin.package')

/**
 * Structural plugin shape — any subset of the pipeline stages
 * (`config`/`project`/`graph`/`key`/`schedule`), run-level capabilities
 * (`cache`/`executor`/`telemetry`/`output`) and CLI `commands`, plus optional
 * `setup`/`teardown`. The fully-typed `VxPlugin` lives in
 * `src/orchestrator/plugin.ts` and is what users import; this is a
 * re-declaration with opaque function types so `config.ts` stays a leaf
 * module (no orchestrator import). The orchestrator casts to `VxPlugin`
 * before consulting capabilities.
 */
export interface Plugin {
  /** The package name — set by `definePlugin`, never by the plugin. */
  readonly name: string
  config?(workspace: unknown, ctx: unknown): unknown
  discover?(ctx: unknown): unknown
  project?(config: unknown, ctx: unknown): unknown
  graph?(nodes: unknown, ctx: unknown): unknown
  key?(task: unknown, ctx: unknown): unknown
  schedule?(nodes: unknown, ctx: unknown): unknown
  admit?(task: unknown, ctx: unknown): unknown
  readonly commands?: Readonly<Record<string, unknown>>
  cache?(ctx: unknown): unknown
  executor?(ctx: unknown): unknown
  telemetry?(ctx: unknown): unknown
  output?(ctx: unknown): unknown
  setup?(ctx: unknown): void | Promise<void>
  teardown?(): void | Promise<void>
  readonly fingerprint?: unknown
}

/**
 * Every hook a plugin may fill, in pipeline order — THE list. The loader's
 * "must be a function" and "at least one of" checks, the host's stage gate
 * and `vx info`'s seam column all read it, so a stage added here is a stage
 * everywhere: `admit` reached `vx info` a day late (2026-09-12) because
 * that column kept its own copy, and the loader kept a third. The type
 * pin below refuses a list that drifts from `Plugin`'s keys either way.
 */
export const PLUGIN_HOOKS = [
  'config',
  'discover',
  'project',
  'graph',
  'key',
  'fingerprint',
  'schedule',
  'admit',
  'executor',
  'cache',
  'telemetry',
  'output',
  'setup',
  'commands',
  'teardown',
] as const
export type PluginHook = (typeof PLUGIN_HOOKS)[number]
/** The hooks that are functions; `commands` and `fingerprint` are objects. */
export const PLUGIN_FUNCTION_HOOKS = PLUGIN_HOOKS.filter(
  (h): h is Exclude<PluginHook, 'commands' | 'fingerprint'> =>
    h !== 'commands' && h !== 'fingerprint',
)
type PluginHookKeys = Exclude<keyof Plugin, 'name'>
type HooksNotListed = Exclude<PluginHookKeys, PluginHook>
type HooksNotOnPlugin = Exclude<PluginHook, PluginHookKeys>
// Both `never`, or this line does not compile: the list and the type agree.
const _pluginHooksMatch: [HooksNotListed, HooksNotOnPlugin] extends [never, never] ? true : never =
  true
void _pluginHooksMatch

export interface ProjectConfig {
  /**
   * The project's name, as task specs, filters and `dependsOn` address it.
   * Unset: the name a `discover` plugin gives (a lockfile plugin's
   * `package.json#name`), else the directory's root-relative path (`//`
   * for the root).
   */
  name?: string
  /**
   * Labels for selection: `--filter tag:<name>` picks the projects that
   * carry one. Not in any cache key: a tag changes no task's behaviour.
   */
  tags?: readonly string[]
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
   * What the task's key folds, whether or not it caches: its dependents
   * fold that key. A task with `exec` and no `inputs` has no key, so every
   * task that folds it runs and saves nothing. A group with `inputs` is a
   * keyed group: its inputs are a key its dependents fold, with no process.
   */
  inputs?: InputsConfig
  /**
   * Caching configuration. **Caching is opt-in.** If this field is omitted,
   * the task always runs and nothing is read from or written to the cache.
   * Requires `exec` and `inputs`: the key is the task's inputs, and a group
   * runs nothing to cache.
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
 * The baseline (`sandbox: {}`) grants almost nothing: the task reads
 * nothing, writes nothing and reaches no network — NOT EVEN ITS OWN
 * PROJECT DIRECTORY, which is why `allow: { read: ['.'] }` opens almost
 * every real block. The one grant vx makes for you is dependencies:
 * `node_modules`, and through it the real path of every workspace
 * package linked there.
 *
 * `cache` grants no access in either direction: `inputs` says what
 * INVALIDATES a task, `allow` says what it may TOUCH, and deriving one
 * from the other coupled them both ways — a declaration added for
 * caching silently widened the sandbox, and a path the task needed had
 * to be laundered through the cache key to get it (owner, 2026-09-05).
 * A declared `cache.outputs` is NOT a write grant; the request
 * `sandbox-request.ts` builds carries no write of its own and binds
 * `allow.write` alone. This comment claimed the opposite — here and on
 * both grant fields — while the file beside it and `schema.md` both said
 * the truth, and no test read the bare baseline it described (item 443).
 * That case has a test of its own now.
 *
 * Enforcement anchors at the WORKSPACE ROOT, so a task cannot leave its
 * project whatever it declares here. The full account, including what a
 * write grant costs on Linux, is in `docs/schema.md` under
 * `exec.sandbox`.
 *
 * Paths are project-relative, absolute, or `~`-expanded, and may be
 * globs: macOS matches the pattern in the policy, Linux expands it when
 * the task starts (a mount cannot hold a pattern), so a file created
 * later is not covered there — grant its directory.
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
   *
   * A denial is classed read, write, systemInfo or network, so those four
   * are what can be ignored.
   */
  ignore?: SandboxIgnore
  /**
   * Accept a weaker sandbox when vx itself already runs inside one
   * (a container, another sandbox). Without it, nesting fails fast rather
   * than pretending to confine.
   */
  weakerWhenNested?: boolean
  /** Accept weaker network isolation (host proxy) for lower overhead. */
  weakerNetworkIsolation?: boolean
}

/** The denials `sandbox.ignore` can leave out of the report: patterns per class. */
export interface SandboxIgnore {
  read?: readonly string[]
  write?: readonly string[]
  systemInfo?: readonly string[]
  network?: readonly string[]
}

export interface SandboxGrants {
  /**
   * Readable paths or globs, added to the baseline — which is
   * `node_modules`, NOT `inputs.files`. A task that reads its own
   * source in the sandbox says so here.
   */
  read?: readonly string[]
  /**
   * Writable paths or globs. The task can write NOTHING without these:
   * declaring `cache.outputs.files` grants no write, and a task whose
   * only declaration is its outputs writes into a tmpfs that evaporates
   * (vx then warns that `cache.outputs` matched no files).
   */
  write?: readonly string[]
  /**
   * Reachable domains, `['*.example.com']` a pattern. The proxy is the
   * run's: it filters every sandboxed task against the union of the lists
   * the run's tasks declare, so `true` adds no domain and reaches only
   * those (none in a run with no list). Omitted adds none either.
   */
  network?: true | readonly string[]
  /**
   * Kernel information the task may query, by info type — the name that
   * appears in a denial, e.g. `vfs.disk-space` (every Bun and git process
   * probes free space at startup).
   */
  systemInfo?: readonly string[]
  /** Unix socket paths the task may connect to. `true` allows any. */
  unixSockets?: true | readonly string[]
  /**
   * Bind and reach localhost ports — a test that boots a server for
   * itself. A port LIST additionally makes those ports reachable from
   * outside the sandbox (a dev server another task or the developer
   * talks to): on Linux, where a sandboxed task lives in its own network
   * namespace, each listed port is bridged out to the host's loopback;
   * on macOS the host already sees them and the list means `true`.
   */
  localBinding?: boolean | readonly number[]
  /** macOS: Mach service names the task may look up. */
  machLookup?: readonly string[]
  /** Acquire a TTY. Rare outside interactive tools. */
  pty?: boolean
  /** Write to `.git/config`. Most build tools should not. */
  gitConfig?: boolean
}

export interface SandboxDenials {
  /** Domains blocked even if `allow.network` would admit them. */
  network?: readonly string[]
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
   * Upper bound before vx SIGTERMs the child (`'10m'`), beating
   * `run.timeout` and its flag and variable. A normal task that
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
  timeout?: Duration
  /**
   * Max ADDITIONAL attempts after a failed attempt. `retries: 2` means
   * up to 3 executions total. 0 / omitted → no retries (today's
   * behavior: fail on the first non-zero exit). A retry fires after ANY
   * failure, timeout kills included; a Ctrl-C teardown (`aborted`) is
   * never retried. Declared outputs are re-cleaned before each retry so
   * a failed attempt's partial outputs can't leak into the next. The
   * final outcome (and the cached artifact) is the last attempt's.
   * Not allowed with `persistent` — a persistent task has no exit to
   * retry. Beats `run.retries` and its flag and variable, including
   * `retries: 0`.
   */
  retries?: number
  /**
   * Long-running / continuous task (dev server, watcher, daemon).
   * When present, the task is spawned but the runner does NOT wait
   * for it to exit. Instead it considers the task "ready" — either
   * immediately on spawn (no `readyWhen`) or once the readiness
   * pattern matches a line of stdout/stderr. Downstream tasks unblock
   * on ready, not on exit. The orchestrator SIGTERMs every persistent
   * subprocess once the rest of the graph has finished.
   *
   * `cache` is rejected on a persistent task — there's no exit code
   * to cache and the work continues after vx's run notion of "done".
   */
  persistent?: PersistentConfig
  /**
   * The task reads the terminal: a prompt, a REPL, a watch mode's keys.
   * When vx's stdin is a TTY the task gets vx's stdin, stdout and stderr
   * as they are, and no other task starts while it runs (a persistent one:
   * until it is spawned). It runs in its own session, so `/dev/tty` still
   * cannot be opened. Off a TTY (CI) it runs as any task. Always on this
   * machine, never cached; not allowed with `cache`, `sandbox` or
   * `persistent.readyWhen`.
   */
  interactive?: boolean
  /**
   * Confine this task's process: what it may read, write and reach.
   * Nothing is confined unless this is present.
   *
   * It sits in `exec` because it constrains the same spawn `env` does —
   * the environment the child gets, the filesystem and network it gets.
   * A group task has no process,
   * so the field cannot be reached from one.
   *
   * **Policy: fail on violation.** An undeclared touch of the project's own
   * files fails the task, and a failed task is never cached. Reaching
   * OUTSIDE the project is denied but not reported — that is the wall
   * doing its job, not a finding.
   *
   * A persistent task is confined the same way but never REPORTED on: the
   * violation report reads the trace after the process exits, and a server
   * exits at teardown. Enforced, not reported.
   */
  sandbox?: SandboxConfig
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
  passThrough?: readonly string[]
  /**
   * Explicit `name: value` pairs. The values are set on the child AND
   * folded into the cache key (they are literal in your config, captured
   * via the task config hash).
   */
  define?: Record<string, string>
  /**
   * Names whose values are masked (`***`) wherever vx prints, stores or
   * exports the task's output or command, whatever the name. Names that
   * hold `TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `PASSWD` or `CREDENTIAL`
   * are masked without it; this reaches `GH_PAT`, `NPM_AUTH`.
   */
  secret?: readonly string[]
}

export interface CacheConfig {
  /** What this task produces. Captured for restore on a cache hit. */
  outputs: CacheOutputs
  /**
   * What a write to an input while the command runs means. Each field,
   * highest first: its env var, this, the workspace's `inputStability`,
   * the default (`'immutable'`, `'warn'`).
   */
  inputStability?: InputStability
}

export interface InputStability {
  /**
   * `'immutable'` (the default): any write to an input during the command
   * withholds the entry, whatever the file holds after, since an edit
   * undone mid-run cannot be told from no edit. `'mutable'`: a file
   * rewritten to the bytes the key folded counts as unchanged, for a task
   * that rewrites its own input identically (tsdown's `package.json`),
   * unless another task that may write it ran meanwhile.
   * `'unchecked'`: no check.
   */
  strategy?: 'immutable' | 'mutable' | 'unchecked'
  /**
   * What a withheld entry does to the run. `'warn'` (the default): the
   * result stands, vx says why, and the run goes on. `'error'`: the task
   * fails, so the run fails.
   */
  severity?: 'warn' | 'error'
}

export interface CacheOutputs {
  /**
   * Files produced by this task, as project-relative globs. Pass `[]`
   * when the task has no files to capture (e.g. `lint`, `typecheck`).
   * Outputs are not filtered through gitignore — typical artifact dirs
   * like `dist/` and `coverage/` are captured normally even when ignored.
   */
  files: readonly string[]
  /**
   * Files produced OUTSIDE the project dir, as workspace-root-relative
   * globs (the Turbo `$TURBO_ROOT$` / Nx `{workspaceRoot}` escape
   * hatch). NO project-boundary rule applies: these globs may capture
   * files anywhere in the workspace, including inside other projects'
   * directories. Deliberate escape hatch — prefer project-relative
   * `files` whenever the task can write inside its own dir. Two tasks
   * whose workspace outputs provably overlap are refused at graph build,
   * like overlapping `files` (vx cleans declared outputs before a run
   * and before a restore, so the second would delete the first's).
   */
  workspaceFiles?: readonly string[]
  /**
   * `false`: a miss leaves the declared outputs in place for the command
   * (tsc's `.tsbuildinfo`) instead of removing them first. A run that
   * leaves a file it found untouched saves nothing, so an entry holds only
   * what a clean run would leave. A retry still starts clean. Omitted →
   * the workspace's `cache.outputs.clean`, else `true`.
   */
  clean?: boolean
}

export interface InputsConfig {
  /**
   * Project-relative globs. Each entry is a positive glob, or a negation
   * prefixed with `!`. Required: pass a recursive glob to mean "all
   * project files" (gitignore-aware), or narrow as needed. An empty
   * array means no file inputs at all.
   *
   * Declared outputs (both `outputs` fields) and any nested-project
   * files are excluded automatically — a task cannot invalidate itself,
   * and cannot read across project boundaries.
   */
  files: readonly string[]
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
   * Declared outputs (both `outputs` fields) are excluded
   * automatically (a task cannot invalidate itself).
   */
  workspaceFiles?: readonly string[]
  /**
   * Env var names whose runtime values from parent `process.env` are
   * folded into the cache key. **Independent of `exec.env`** — declaring
   * a name here does not forward it to the child; it only affects cache
   * invalidation. To both forward AND track, list the name in both
   * `exec.env.passThrough` and here.
   */
  env?: readonly string[]
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
   * lock, the OUTPUT is resolved live every run. Use for
   * project-specific runtime probes.
   */
  runtime?: readonly string[]
  /**
   * Like `runtime`, but commands run at the WORKSPACE ROOT and are
   * deduped GLOBALLY per command across the whole run — a `node -v`
   * declared in 500 projects spawns exactly once. The runtime-input
   * analog of `workspaceFiles`: per-task, root-anchored. Use for global
   * tool versions, OS info, etc.
   */
  workspaceRuntime?: readonly string[]
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
 * The keys of `T` that `Shape` does not declare, typed `never`. A generic
 * argument skips TypeScript's excess-property check, so a Turbo-shaped
 * `outputs` on a task, or `cwd` in `exec`, type-checked and failed only
 * when vx loaded the config (D-69), as did a typo beside a known key in
 * `defineWorkspace` (D-70); `never` puts the error on that line.
 */
type Known<T, Shape> = { [P in keyof T]: P extends keyof Shape ? unknown : never }

/** `T[P]` when `T` has it; `unknown` (no keys to check) when it does not. */
type At<T, P extends PropertyKey> = T extends { readonly [Q in P]?: infer V } ? V : unknown

/** The objects inside each task's `exec`, held to their keys as `exec` is (D-156). */
type KnownExecs<T extends ProjectConfig> = {
  tasks?: {
    [K in keyof NonNullable<T['tasks']>]?: {
      exec?: KnownExec<At<NonNullable<T['tasks']>[K], 'exec'>>
    }
  }
}

type KnownExec<E> = {
  env?: Known<At<E, 'env'>, ExecEnv>
  persistent?: Known<At<E, 'persistent'>, PersistentConfig>
  sandbox?: Known<At<E, 'sandbox'>, SandboxConfig> & {
    allow?: Known<At<At<E, 'sandbox'>, 'allow'>, SandboxGrants>
    deny?: Known<At<At<E, 'sandbox'>, 'deny'>, SandboxDenials>
    ignore?: Known<At<At<E, 'sandbox'>, 'ignore'>, SandboxIgnore>
  }
}

/**
 * Identity function — exists only so TypeScript narrows literal types
 * and, crucially, **validates `dependsOn` against this project's own
 * task names**. A bare entry that isn't a declared task key is a compile
 * error; `^name` / `pkg#name` forms reference other projects and stay
 * free strings. Runtime behavior is unchanged (it returns its input).
 */
export function defineProject<const T extends ProjectConfig>(
  config: T &
    KnownExecs<T> &
    Known<T, ProjectConfig> & {
      tasks?: {
        [K in keyof NonNullable<T['tasks']>]?: Known<NonNullable<T['tasks']>[K], TaskConfig> & {
          dependsOn?: readonly DependsOnEntry<Extract<keyof NonNullable<T['tasks']>, string>>[]
          exec?: Known<At<NonNullable<T['tasks']>[K], 'exec'>, ExecConfig>
          inputs?: Known<At<NonNullable<T['tasks']>[K], 'inputs'>, InputsConfig>
          cache?: Known<At<NonNullable<T['tasks']>[K], 'cache'>, CacheConfig> & {
            outputs?: Known<At<At<NonNullable<T['tasks']>[K], 'cache'>, 'outputs'>, CacheOutputs>
          }
        }
      }
    },
): T {
  return config as T
}

export function defineWorkspace<T extends WorkspaceConfig>(
  config: T &
    Known<T, WorkspaceConfig> & {
      run?: Known<At<T, 'run'>, RunSettings> & {
        rules?: Known<At<At<T, 'run'>, 'rules'>, WorkspaceRules>
      }
      cache?: Known<At<T, 'cache'>, CacheSettings> & {
        retention?: Known<At<At<T, 'cache'>, 'retention'>, NonNullable<CacheSettings['retention']>>
        inputStability?: Known<At<At<T, 'cache'>, 'inputStability'>, InputStability>
      }
      lock?: Known<At<T, 'lock'>, LockSettings>
      watch?: Known<At<T, 'watch'>, WatchSettings>
    },
): T {
  return config
}
