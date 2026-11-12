// Public schema for vx project and workspace configuration.

/**
 * A duration with its unit: `'500ms'`, `'30s'`, `'5m'`, `'2h'`, `'1d'`. A
 * bare number is refused: a unit in the value keeps the name free of one.
 */
export type Duration = `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`

/** The machines a task can name in `exec.platforms`: `os-arch`, as Bun's compile targets name them. */
export const PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] as const

export type Platform = (typeof PLATFORMS)[number]

/**
 * The workspace: settings in groups (`run`, `cache`, `lock`, `watch`) and the
 * plugins. Each setting's environment variable and flag derive from its
 * path (`run.concurrency` → `VX_RUN_CONCURRENCY`, `vx run --concurrency`); a flag beats
 * the variable, which beats this file. `docs/schema.md` lists them all.
 * Nothing here is folded into a cache key.
 */
export interface WorkspaceConfig {
  /**
   * The repository's default branch (`'develop'`). A run on it has no
   * cache scope and a bare `--affected` has no default; elsewhere both
   * compare with the merge base of `origin/<baseBranch>` and HEAD.
   * Omitted → `origin/HEAD`'s branch, then `main`, then `master`.
   */
  baseBranch?: string
  run?: RunSettings
  cache?: CacheSettings
  /** Input defaults for every task. */
  inputs?: WorkspaceInputs
  /** Output defaults for every task. */
  outputs?: WorkspaceOutputs
  lock?: LockSettings
  watch?: WatchSettings
  /**
   * Plugins for this workspace, consulted in this order once per `vx run`:
   * each fills any of the stages and capabilities below, with core's
   * executor and cache store at the tail of every list
   * (`docs/design/pipeline-2026-09.md`). An `undefined`, `null` or `false`
   * entry is skipped, so `cond && plugin()` needs no filter.
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
   * A task's time limit, for tasks without their own `exec.timeout`. A
   * timed-out task fails and is never cached. Omitted → no limit.
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

/** `WorkspaceConfig.inputs`. */
export interface WorkspaceInputs {
  /** The `inputs.stability` of every task that does not set its own. */
  stability?: InputStability
}

/** `WorkspaceConfig.outputs`. */
export interface WorkspaceOutputs {
  /** The `outputs.clean` of every task that does not set its own. */
  clean?: boolean
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
   * Which layers a run reads and writes (`'local:rw,remote:r'`; a layer it
   * leaves out stays on); `--no-cache` and `--force` still apply on top.
   * Omitted → every layer reads and writes. The local layer is always read
   * first, then each remote in declared order.
   */
  policy?: string
  /** Which remote hits land on disk: `all` (the default), only the requested tasks' (`toplevel`), or `none`. */
  download?: 'all' | 'toplevel' | 'none'
  /**
   * Which runs keep a failed task's log and leftover outputs in the
   * remote: `'ci'` (default), `'local'` or `'always'`. Only a run whose
   * policy writes a remote keeps any.
   */
  upload?: { failures?: 'ci' | 'local' | 'always' }
  /**
   * How the local cache keeps an entry. `embeddings` (default `'32KiB'`):
   * an entry up to this size inside the index; `false`, none. `decompress` (default true): a larger one as its
   * plain files, which a hit copies or clones out with no decode; off, as
   * one `.tar.zst`.
   */
  store?: { embeddings?: false | string; decompress?: boolean }
  /**
   * Cache transfers at once. `download` and `upload` (per remote) default
   * to min(96, max(cores × 3, 64)); `restore`, local hits writing their
   * outputs, to twice `run.concurrency`.
   */
  concurrency?: { download?: number; upload?: number; restore?: number }
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
 * The brand `definePlugin` stamps on a plugin: its package's name. The
 * loader accepts a plugin only when this equals `name`, so a plugin's name
 * is its package name, with no override. A registry symbol: a plugin
 * package's own copy of `@vzn/vx` and a compiled binary's must share the
 * key.
 */
export const PLUGIN_PACKAGE: unique symbol = Symbol.for('vx.plugin.package')

/**
 * Structural plugin shape: any subset of the stages, capabilities
 * (`cache`/`executor`/`telemetry`/`output`) and `commands`, plus
 * `setup`/`teardown`. The typed `VxPlugin` (src/orchestrator/plugin.ts) is
 * what users import; this re-declaration with opaque function types keeps
 * `config.ts` a leaf module.
 */
export interface Plugin {
  /** The package name — set by `definePlugin`, never by the plugin. */
  readonly name: string
  config?(workspace: unknown, ctx: unknown): unknown
  discover?(ctx: unknown): unknown
  project?(config: unknown, ctx: unknown): unknown
  graph?(nodes: unknown, ctx: unknown): unknown
  key?(task: unknown, ctx: unknown): unknown
  measures?(nodes: unknown): unknown
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
 * Every hook a plugin may fill, in pipeline order: the one list the
 * loader's checks, the host's stage gate and `vx info` read, so a stage
 * added here is added everywhere. The type pin below refuses a list that
 * drifts from `Plugin`'s keys.
 */
export const PLUGIN_HOOKS = [
  'config',
  'discover',
  'project',
  'graph',
  'key',
  'fingerprint',
  'measures',
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
   * Optional one-line description, shown in the task picker and `--dry`.
   * No effect on scheduling, but it is in the key, since the key hashes
   * the whole resolved config (`docs/caching.md`): carving exceptions out
   * of it invites stale hits.
   */
  description?: string
  /**
   * Shell command and optional env; one command per task. Omit `exec` for
   * a group task, which only chains `dependsOn`: no spawn, no I/O, no
   * cache. Useful for umbrella tasks like `ci`.
   */
  exec?: ExecConfig
  /**
   * Tasks that must succeed before this one runs:
   * - `'name'`: a same-project task; through `defineProject`, type-checked
   *   against this config's task keys.
   * - `'^name'`: task `name` in every transitive workspace dep; not
   *   checked.
   * - `'pkg#name'`: one package's task; not checked.
   */
  dependsOn?: readonly string[]
  /**
   * What the task's key folds, whether or not it caches: its dependents
   * fold that key. A task with `exec` and no `inputs` has no key, so every
   * task that folds it runs and saves nothing. A group with `inputs` is a
   * keyed group: its inputs are a key its dependents fold, with no process.
   */
  inputs?: InputsConfig
  /** What the task produces: saved on a miss, restored on a hit. Needs `cache: true`. */
  outputs?: TaskOutputs
  /**
   * `true` caches the task. **Caching is opt-in.** Omitted or `false`, the
   * task always runs and nothing is read from or written to the cache.
   * Requires `exec`, `inputs` and `outputs`: the key is the task's inputs,
   * and a group runs nothing to cache.
   */
  cache?: boolean
}

/**
 * What a sandboxed task may do, declared as capabilities. You say what the
 * task may touch; vx decides how each is enforced, and one the platform
 * cannot express is an error, not a silent no-op.
 *
 * The baseline (`sandbox: {}`) grants almost nothing: no reads, no writes,
 * no network, not even the project directory, which is why `allow: { read:
 * ['.'] }` opens most real blocks. The one implicit grant is dependencies:
 * `node_modules` and the real paths of the workspace packages linked
 * there.
 *
 * Caching grants nothing: `inputs` says what invalidates a task, `allow`
 * what it may touch, and declared `outputs` are no write grant (only
 * `allow.write` binds).
 *
 * Enforcement anchors at the workspace root, so a task cannot leave its
 * project whatever it declares. `docs/schema.md` § `exec.sandbox` has the
 * full account.
 *
 * Paths are project-relative, absolute or `~`-expanded, and may be globs:
 * macOS matches the pattern, Linux expands it at start (a mount cannot
 * hold a pattern), so a file created later is not covered there; grant its
 * directory.
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
   * Denials to leave out of the report, shaped like `allow`. This permits
   * nothing: the OS still denies, and a command that needs it still fails.
   * It says the denial does not affect this task's output.
   *
   * Unlike `allow`, values are glob patterns, the same on every platform:
   * `ignore` only matches report lines. Relative patterns anchor at the
   * project dir.
   *
   * ```ts
   * ignore: { write: ['*.bun-build'] } // bun --compile stages a random temp name in the cwd
   * ```
   *
   * A denial is classed read, write, systemInfo or network.
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
  /**
   * Refuse every read outside the workspace too (`/usr`, `~/.cache`, the
   * system toolchain), not only the workspace's other projects. A path
   * outside it is readable only when `allow.read` names it; the shell a
   * task runs in stays readable, so a task can start.
   */
  hermetic?: boolean
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
   * Writable paths or globs. Without these the task writes nothing:
   * `outputs.files` grants no write, and a task declaring only outputs
   * writes into a tmpfs that evaporates (vx warns that `outputs` matched
   * no files).
   */
  write?: readonly string[]
  /**
   * Reachable domains (`['*.example.com']`). The proxy filters every
   * sandboxed task against the union of the run's lists, so `true` adds no
   * domain. `'localhost:4173'` reaches that local port alone.
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
   * Bind and reach localhost ports (a test booting its own server). A port
   * list also exposes those ports outside the sandbox: on Linux each is
   * bridged to the host's loopback; on macOS the host already sees them.
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
   * `false` pins the task to this machine (it needs a local daemon, the
   * network, Docker). Default `true`. Persistent tasks and their
   * dependents are pinned regardless.
   *
   * `'only'`: the task produces a remote input tree (`pnpm install`
   * feeding remote workers) and is a no-op here: never run locally, its
   * outputs never cleaned or restored on this disk. With no remote
   * executor it succeeds without running.
   */
  remote?: boolean | 'only'
  /**
   * The machines this task can run on. On another the task and its
   * dependants are skipped, never failed; an executor routing by platform
   * (`TaskExecutor.platforms`) runs it on one that fits. Omitted →
   * anywhere.
   */
  platforms?: readonly Platform[]
  /**
   * The worker type to run it on (`'ubuntu'`), for an executor that names
   * types (`TaskExecutor.workers`): only that type's machines take it, and
   * a run with no such type is refused before it starts. Placement only:
   * not in the key, ignored locally. Omitted → the first type that fits.
   */
  worker?: string
  /** Environment exposed to the child process. */
  env?: ExecEnv
  /**
   * Upper bound before vx SIGTERMs the child (`'10m'`), beating
   * `run.timeout`. A task that runs longer fails as timed out and is never
   * cached. Omitted → no limit.
   *
   * For a `persistent` task it bounds the readiness wait: if `readyWhen`
   * has not matched in time the task fails, instead of an unexpected
   * banner hanging the run.
   */
  timeout?: Duration
  /**
   * Additional attempts after a failure: `retries: 2` means up to 3 runs.
   * A retry follows any failure, timeouts included, never a Ctrl-C abort.
   * Outputs are cleaned before each retry, and the last attempt's outcome
   * is the result. Not allowed with `persistent`. Beats `run.retries`, `0`
   * included.
   */
  retries?: number
  /**
   * A long-running task (dev server, watcher, daemon): spawned without
   * waiting for exit, ready at spawn or once `readyWhen` matches a line.
   * Dependents unblock on ready. vx SIGTERMs persistent tasks once the
   * rest of the graph finishes. `cache` is refused: there is no exit to
   * cache.
   */
  persistent?: PersistentConfig
  /**
   * The task reads the terminal (a prompt, a REPL, watch-mode keys). On a
   * TTY it gets vx's stdio as is, and no other task starts while it runs
   * (a persistent one: until spawned). Its own session, so `/dev/tty`
   * still cannot be opened. Off a TTY it runs as any task. Never cached;
   * not allowed with `cache`, `sandbox` or `persistent.readyWhen`.
   */
  interactive?: boolean
  /**
   * Confine this task's process: what it may read, write and reach.
   * Nothing is confined unless present. In `exec` because it shapes the
   * same spawn `env` does.
   *
   * Fail on violation: an undeclared touch of the project's own files
   * fails the task, and a failed task is never cached. Reaching outside
   * the project is denied but not reported: that is the wall working.
   *
   * A persistent task is confined but never reported on: the report reads
   * the trace after exit, and a server exits at teardown.
   */
  sandbox?: SandboxConfig
}

export interface PersistentConfig {
  /**
   * A regex tested against each stdout/stderr line; the task is ready on
   * the first match. Omitted → ready at spawn. Vite's dev server prints
   * `Local: http://localhost:5173/`, so `readyWhen: 'Local:'` waits for
   * it.
   */
  readyWhen?: string
}

export interface ExecEnv {
  /**
   * Env vars forwarded from the host to the child, their values not folded
   * into the key: CI flags, regional vars, secrets that differ by machine
   * without changing output.
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
   * exports the task's output or command. Names holding `TOKEN`, `SECRET`,
   * `KEY`, `PASSWORD`, `PASSWD` or `CREDENTIAL` are masked anyway; this
   * reaches `GH_PAT`, `NPM_AUTH`.
   */
  secret?: readonly string[]
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

export interface TaskOutputs {
  /**
   * Files this task produces, as project-relative globs; `[]` when none
   * (`lint`, `typecheck`). Not filtered through gitignore, so ignored dirs
   * like `dist/` are captured.
   */
  files: readonly string[]
  /**
   * Files produced outside the project, as workspace-root globs (Turbo's
   * `$TURBO_ROOT$`, Nx's `{workspaceRoot}`). No boundary applies: they may
   * capture files in other projects. Prefer `files` when the task can
   * write inside its own dir. Two tasks whose workspace outputs overlap
   * are refused, as overlapping `files` are (each run cleans declared
   * outputs).
   */
  workspaceFiles?: readonly string[]
  /**
   * `false`: a miss leaves the declared outputs in place for the command
   * (tsc's `.tsbuildinfo`) instead of removing them first. A run that
   * leaves a file it found untouched saves nothing, so an entry holds only
   * what a clean run would leave. A retry still starts clean. Omitted →
   * the workspace's `outputs.clean`, else `true`.
   */
  clean?: boolean
}

export interface InputsConfig {
  /**
   * Project-relative globs, each positive or a `!` negation. Required: a
   * recursive glob means all project files (gitignore-aware); an empty
   * array means no file inputs. Declared outputs and nested projects'
   * files are excluded automatically.
   */
  files: readonly string[]
  /**
   * Workspace-root globs (Turbo's `$TURBO_ROOT$`, Nx's `{workspaceRoot}`)
   * for inputs outside the project: a root tsconfig, shared codegen. Same
   * syntax as `files`, over the workspace-wide git file set (ignored files
   * are invisible). No boundary applies; prefer `files` where possible.
   * Declared outputs are excluded.
   */
  workspaceFiles?: readonly string[]
  /**
   * Env var names whose values are folded into the key. Independent of
   * `exec.env`: this does not forward them. To forward and track, list a
   * name in both.
   */
  env?: readonly string[]
  /**
   * Which upstream tasks' keys this task's key folds, in `dependsOn`
   * syntax plus wildcards and negation:
   * - `'*'` every same-project upstream
   * - `'^*'` every dep-workspace upstream
   * - `'name'` same-project task `name`
   * - `'^name'` task `name` in dep workspaces
   * - `'pkg#name'` one package's task
   * - `'!name'`, `'!^name'`, `'!pkg#name'` exclude
   *
   * Applied in order, last wins: `['*', '^*', '!^noisy']` is all but deps'
   * noisy. Omitted → all upstream (`['*', '^*']`); `[]` → none.
   */
  tasks?: readonly string[]
  /**
   * Shell commands run in the project dir at hash time; their trimmed
   * stdout and stderr fold into the key. Deduped per (dir, command) per
   * run; a non-zero exit fails the run. The commands are locked, the
   * output read live each run.
   */
  runtime?: readonly string[]
  /**
   * Like `runtime`, but run at the workspace root and deduped across the
   * run: `node -v` in 500 projects spawns once. For tool versions, OS
   * info.
   */
  workspaceRuntime?: readonly string[]
  /**
   * What a write to an input while the command runs means for the save.
   * Each field, highest first: its env var, this, the workspace's
   * `inputs.stability`, the default (`'immutable'`, `'warn'`). Needs
   * `cache: true`.
   */
  stability?: InputStability
}

/**
 * A valid `dependsOn` entry, given sibling task names `K`:
 * - `K`: a same-project task, checked against this config's `tasks`.
 * - `` `^${string}` ``: a task in workspace deps; not checked.
 * - `` `${string}#${string}` ``: one package's task; not checked.
 * - `` `${string}*${string}` ``: a task-name pattern, expanded at graph
 *   build (a bare `'*'` still fails at runtime).
 */
type DependsOnEntry<K extends string> =
  | K
  | `^${string}`
  | `${string}#${string}`
  | `${string}*${string}`

/**
 * What `dependsOn` may hold: literals are held to `K`; a `string[]` list
 * (a preset typed `TaskConfig`) has none to check.
 */
type DependsOn<D, K extends string> =
  NonNullable<D> extends readonly (infer E)[]
    ? string extends E
      ? readonly string[]
      : readonly DependsOnEntry<K>[]
    : readonly DependsOnEntry<K>[]

/**
 * The keys of `T` that `Shape` does not declare, typed `never`: a generic
 * argument skips the excess-property check, so a Turbo-shaped `outputs` or
 * `cwd` in `exec` failed only at load. `never` puts the error on that
 * line.
 */
type Known<T, Shape> = { [P in keyof T]: P extends keyof Shape ? unknown : never }

/** `T[P]` when `T` has it; `unknown` (no keys to check) when it does not. */
type At<T, P extends PropertyKey> = T extends { readonly [Q in P]?: infer V } ? V : unknown

/** The objects inside each task's `exec`, held to their keys as `exec` is. */
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
 * Identity function, so TypeScript narrows literals and checks `dependsOn`
 * against this project's own task names: a bare entry naming no task is a
 * compile error; `^name` and `pkg#name` stay free strings.
 */
export function defineProject<const T extends ProjectConfig>(
  config: T &
    KnownExecs<T> &
    Known<T, ProjectConfig> & {
      tasks?: {
        [K in keyof NonNullable<T['tasks']>]?: Known<NonNullable<T['tasks']>[K], TaskConfig> & {
          dependsOn?: DependsOn<
            At<NonNullable<T['tasks']>[K], 'dependsOn'>,
            Extract<keyof NonNullable<T['tasks']>, string>
          >
          exec?: Known<At<NonNullable<T['tasks']>[K], 'exec'>, ExecConfig>
          inputs?: Known<At<NonNullable<T['tasks']>[K], 'inputs'>, InputsConfig>
          outputs?: Known<At<NonNullable<T['tasks']>[K], 'outputs'>, TaskOutputs>
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
      cache?: Known<At<T, 'cache'>, CacheSettings>
      inputs?: Known<At<T, 'inputs'>, WorkspaceInputs> & {
        stability?: Known<At<At<T, 'inputs'>, 'stability'>, InputStability>
      }
      outputs?: Known<At<T, 'outputs'>, WorkspaceOutputs>
      lock?: Known<At<T, 'lock'>, LockSettings>
      watch?: Known<At<T, 'watch'>, WatchSettings>
    },
): T {
  return config
}
