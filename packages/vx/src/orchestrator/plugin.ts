// Plugin API — the ONE `VxPlugin` contract (docs/design/pipeline-2026-09.md).
//
// Users register plugins via defineWorkspace({ plugins }). Behaviour
// capabilities (`cache`, `executor`) return objects core calls INTO;
// observe capabilities (`telemetry`, `setup` on the bus) can only read.
//
// Crash isolation: a plugin that throws in a load-bearing hook aborts the
// run with a clean UserError naming plugin + hook. A plugin that throws
// inside a bus hook is logged and disabled for the remainder of the run.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Cache, CacheLayer, CachePolicy } from '../cache/index.js'
import { PLUGIN_PACKAGE, type ProjectConfig, type WorkspaceConfig } from '../config.js'
import type { TaskExecutor } from '../exec/index.js'
import type { TaskNode, TaskOutcome } from '../graph/index.js'
import { nearest, UserError } from '../util/index.js'
import type { ProjectMeta } from '../workspace/index.js'
import type { EventBus, RunStartInfo } from './events.js'
import type { TelemetryContext, TelemetrySink } from './telemetry.js'

/**
 * A vx plugin. Contributes any subset of the run-level capabilities —
 * where work runs (executor), which cache is used (cache), who
 * observes the run (telemetry). It never changes WHAT a task is (the
 * command string — principle #3), only where and how that command is
 * executed. Registered explicitly in vx.workspace.ts via
 * defineWorkspace({ plugins: [...] }). No auto-discovery.
 *
 * Made by `definePlugin(import.meta, hooks)` only: the loader refuses a
 * plain object. The capabilities are consulted by `plugin-host.ts`. Core
 * names no plugin; the local executor and the local cache are the floor
 * under the list, taking what every plugin declines.
 */
export interface VxPlugin {
  /**
   * The name of the package the plugin was defined in — set by
   * `definePlugin` from the nearest `package.json`, never by the plugin.
   * Heads every warning about the plugin, every `vx info` line, and the
   * key material a `key` hook contributes.
   */
  readonly name: string

  // --- PIPELINE stages (shape the run before it executes — opt-in) ----------
  //
  // Each receives the object core is about to use and edits it IN PLACE;
  // core re-validates after each plugin, so a plugin cannot produce what
  // the loader would refuse from a user. Declaration order is the order.
  // Whatever a stage changes reaches the cache key by construction: the key
  // hashes the task config AFTER `project` ran. See
  // docs/design/pipeline-2026-09.md.

  /**
   * The workspace config, before anything is derived from it (concurrency,
   * cacheDir, timeout, …). `plugins` is already fixed by the time this runs.
   * Core re-validates after each plugin, as it does a user's file.
   */
  config?(workspace: WorkspaceConfig, ctx: WorkspaceHookContext): void | Promise<void>

  /**
   * Directories to make projects beyond the package manager's members, as
   * `{ dir, name }` (`dir` absolute or relative to the workspace root): a
   * runner's root tasks, a project no member glob lists. Runs once per
   * discovery, before any project config loads; each plugin sees core's
   * projects and the ones earlier plugins named. A named directory keeps
   * a `package.json` of the same name, if it has one; a name or directory
   * already taken otherwise, or one outside the root, is refused.
   */
  discover?(ctx: DiscoverContext): readonly NamedProject[] | Promise<readonly NamedProject[]>

  /**
   * One project's validated config, right after it loaded and before the
   * graph is built. Add, remove or edit tasks. Runs for every loaded project
   * on every run — a config's cached evaluation is the user's file, and the
   * hook is applied on top of it live. A package with NO config file is
   * loaded too, as `{ tasks: {} }`, so a plugin can give tasks to packages
   * that never wrote one (`ctx.packageJson` carries their scripts); with no
   * `project` plugin such a package is never visited.
   */
  project?(config: ProjectConfig, ctx: ProjectHookContext): void | Promise<void>

  /**
   * The task graph, after `dependsOn` expansion and before scheduling. Add
   * or drop edges (`node.deps`), mark tasks requested. A
   * dep naming a task that is not in the graph, or a cycle, is refused with
   * the plugin's name.
   */
  graph?(nodes: Map<string, TaskNode>, ctx: GraphHookContext): void | Promise<void>

  /**
   * Extra cache-key material for one task: a `{ name: value }` record that
   * is folded into the key (and named in `vx why`) — a tool version, a
   * feature flag, anything the declared inputs cannot see. Runs once per
   * task per run, before any key is derived. Return undefined to add
   * nothing. Values must be deterministic for the same inputs or the key
   * never hits.
   */
  key?(
    task: TaskNode,
    ctx: KeyHookContext,
  ):
    | Readonly<Record<string, string>>
    | undefined
    | Promise<Readonly<Record<string, string>> | undefined>

  /**
   * Workspace-root files this plugin keys on its own, taken OUT of the
   * workspace fingerprint. Core folds every lockfile it knows into every
   * task's key, so one `pnpm install` re-keys the whole workspace. A plugin
   * that reads the lockfile and folds each project's own dependency
   * closure through `key` claims the file here: core leaves it out of the
   * fingerprint every key sees (the config-evaluation cache still keys on
   * it — a config may import a dependency), and `--affected` asks
   * `affected` which projects a change to it touches instead of selecting
   * every project. A file has one claimant.
   *
   * A root file core does NOT fold is claimed the same way when the
   * plugin's stages read it: `turbo()` shapes every task from
   * `turbo.json`, so an edit to it re-keys tasks through their resolved
   * configs while no project owns the path. Nothing is taken out;
   * `--affected` asks `affected` (undefined: every project) and `vx watch`
   * re-runs on an edit (item 961). A claim is a bare name at the root.
   */
  readonly fingerprint?: FingerprintClaim

  /**
   * Scheduling priorities: task id → weight, higher runs first among READY
   * tasks (merged over the structural baseline, which stays the tie-break).
   * Runs once, after the graph is final. A later plugin's weight for a task
   * overrides an earlier one's. Return undefined to leave the baseline.
   */
  schedule?(
    nodes: ReadonlyMap<string, TaskNode>,
    ctx: ScheduleHookContext,
  ): ReadonlyMap<string, number> | undefined | Promise<ReadonlyMap<string, number> | undefined>

  /**
   * Admission over the worker count: asked for every task about to start
   * on this machine, with the tasks running here right now. Return `false`
   * to hold it until something finishes (it is asked again then). Asked
   * many times per run, so it must be cheap and synchronous; a throw, or
   * an answer that is a Promise, is reported once and the plugin admits
   * from then on — a policy never
   * breaks a run. Restore-tier hits and tasks on an executor pool hold no
   * local resources and are never asked. When several plugins answer, all
   * must admit. Core keeps no notion of what a task needs: a plugin that
   * packs memory or CPU learns or declares the numbers itself
   * (`@vzn/vx-schedule-history` packs what past executions used).
   */
  admit?(task: TaskNode, ctx: AdmitContext): boolean

  // --- CLI verbs (opt-in) ---------------------------------------------------

  /**
   * Verbs this plugin adds to the `vx` CLI, keyed by name. Consulted only
   * for a verb core does not know — a verb named like a core verb is
   * refused at load — and only
   * when the cwd is inside a workspace that declares the plugin. `vx help`
   * lists them under "Plugin commands". A verb's exit code is the process
   * exit code; a thrown `UserError` prints cleanly, like core's own.
   */
  readonly commands?: Readonly<Record<string, PluginCommand>>

  // --- BEHAVIOR capabilities (change WHAT/HOW work runs — opt-in) -----------

  /**
   * Contribute a cache layer. Returns a CacheLayer wrapping (or replacing)
   * the local Cache, or undefined to decline. Consulted ONCE per prepareRun.
   * Precedence: first non-undefined plugin cache wins, in declaration
   * order, ahead of core's own `.vx/cache` handle at the tail. A layer
   * that WRAPS the local handle subsumes that tail, so it is not written
   * twice.
   */
  cache?(ctx: CacheContext): CacheLayer | undefined | Promise<CacheLayer | undefined>

  /**
   * Contribute a task executor — WHERE one task's command runs. Consulted
   * ONCE per run; every contributed executor is kept, in declaration order,
   * and per task the first whose `accepts()` passes executes it. Nothing is
   * appended in front: core's own local executor is always the TAIL, so
   * declining a task hands it back to this machine rather than failing
   * the run. Persistent tasks never reach an executor (local by
   * construction).
   */
  executor?(ctx: ExecutorContext): TaskExecutor | undefined | Promise<TaskExecutor | undefined>

  // --- OBSERVE-ONLY capability (cannot change behavior — by construction) ---

  /**
   * Contribute one or more telemetry sinks — the canonical data-export path.
   * A sink receives versioned `TelemetryRecord` / `RunSummaryRecord` values
   * and holds NO run handle (no bus, no cache, no request), so it provably
   * cannot change what or how tasks run. ALL plugins' sinks are active at
   * once (additive); a throwing/slow sink is isolated and can never fail or
   * stall a run. This is THE export contract OTel, the manual HTTP API, and
   * any third-party exporter all speak. See docs/design/observability-architecture-2026-06.md.
   */
  telemetry?(
    ctx: TelemetryContext,
  ):
    | TelemetrySink
    | TelemetrySink[]
    | undefined
    | Promise<TelemetrySink | TelemetrySink[] | undefined>

  /**
   * Optional one-time setup per run (validate the workspace, open a
   * connection, read a token). Throwing aborts the run with a clean
   * UserError naming the plugin. It is not a guard over the pipeline: the
   * config, project, cache, graph, key and schedule stages have run by the
   * time it is called, and a plan (`--dry`, `planRun`) never calls it. It
   * precedes the executors, the telemetry sinks, admission and the first
   * task (tests/plugin-e2e.test.ts).
   */
  setup?(ctx: PluginSetupContext): void | Promise<void>

  /** Optional teardown at end-of-run (flush a sink, close a socket). Errors are logged, never thrown. */
  teardown?(): void | Promise<void>
}

/** Shared, read-only context every capability factory receives. */
interface BaseContext {
  readonly workspaceRoot: string
  readonly cacheDir: string
  /** Funnel warnings into the run:status channel (framed output). */
  warn(message: string): void
}

export interface PluginSetupContext extends BaseContext {}

/** One CLI verb contributed by a plugin. */
export interface PluginCommand {
  /** One line for `vx help`. */
  readonly description: string
  run(argv: readonly string[], ctx: CommandContext): number | Promise<number>
}

export interface CommandContext extends BaseContext {
  /**
   * The worker count a `vx run` here uses unless `--concurrency` says
   * otherwise: `vx.workspace`'s `concurrency`, else what the machine allows.
   * A verb that budgets a run (`vx history`) reads it here; its own
   * `machineParallelism()` said 4 cores beside `concurrency: 1` (item 1068).
   */
  readonly concurrency: number
}

/** `config` runs before the cache dir is known — it may be what the hook changes. */
export interface WorkspaceHookContext {
  readonly workspaceRoot: string
  warn(message: string): void
}

export interface DiscoverContext extends WorkspaceHookContext {
  /** Where vx's cache lives: a plugin may keep what it read to answer here. */
  readonly cacheDir: string
  /** The projects found so far: core's, then earlier plugins'. */
  readonly projects: readonly ProjectMeta[]
  /**
   * What `git status` lists in the workspace, workspace-relative: modified,
   * staged or deleted paths (both sides of a rename) and untracked files;
   * null outside a git worktree. It is the run's own enumeration, so a
   * plugin whose answer depends on the worktree (nx()'s graph key) reads it
   * here instead of walking the tree a second time.
   */
  worktreeChanges(): Promise<readonly string[] | null>
}

export interface NamedProject {
  readonly dir: string
  readonly name: string
}

export interface ProjectHookContext extends BaseContext {
  /** The package name (`package.json#name`). */
  readonly name: string
  /** The project's directory, absolute. */
  readonly dir: string
  /** The parsed `package.json`, read-only. */
  readonly packageJson: Readonly<Record<string, unknown>>
  /**
   * Every package the workspace discovered — the one being visited, the
   * rest of the run's scope and the packages outside it, config file or
   * not — as core read them at startup. A plugin whose mapping needs the
   * whole workspace (a `dependsOn` is only valid against every package's
   * scripts at once) reads it here instead of walking the workspace a
   * second time. The same array is handed to every visit of a run and a
   * new one to the next run — a plugin instance outlives a run under `vx
   * watch`, so a per-run memo keys on this array's identity, never on the
   * process.
   */
  readonly projects: readonly ProjectMeta[]
}

export interface GraphHookContext extends BaseContext {
  /** Task ids the user asked for (the rest were pulled in by `dependsOn`). */
  readonly requested: readonly string[]
}

export interface KeyHookContext extends BaseContext {}

/** A plugin's claim on workspace fingerprint files — see `VxPlugin.fingerprint`. */
export interface FingerprintClaim {
  /** Bare names at the workspace root: a lockfile core folds (`pnpm-lock.yaml`) or a file the plugin reads (`turbo.json`). */
  readonly files: readonly string[]
  /**
   * The projects (package names) a change to a claimed file affects. Called
   * by `--affected` with the file's bytes at the base ref and in the
   * working tree (`null` where it does not exist). Return `undefined` to
   * select every project — the answer a claimant gives when it cannot
   * tell, and what core does for an unclaimed file.
   */
  affected(
    change: FingerprintChange,
    ctx: FingerprintContext,
  ): Iterable<string> | undefined | Promise<Iterable<string> | undefined>
}

export interface FingerprintChange {
  /** The claimed file's root-relative name. */
  readonly file: string
  readonly before: Uint8Array | null
  readonly after: Uint8Array | null
}

export interface FingerprintContext extends BaseContext {
  /** Every project in the workspace: package name and absolute directory. */
  readonly projects: ReadonlyArray<{ readonly name: string; readonly dir: string }>
}

export interface AdmitContext {
  /** The tasks executing on this machine right now, in dispatch order. */
  readonly running: readonly TaskNode[]
  /** The run's worker count — the ceiling the count gate already applies. */
  readonly concurrency: number
}

export interface ScheduleHookContext extends BaseContext {
  /** The run's local cache handle — its `dbHandle()` holds the run history a policy can learn from. */
  readonly localCache: Cache
}

export interface CacheContext extends BaseContext {
  /** The local Cache handle the plugin may wrap (LayeredCache(local, remote)). */
  readonly localCache: Cache
  /** The run's cache policy (the 4 read/write axes). */
  readonly policy: CachePolicy
}

export interface ExecutorContext extends BaseContext {
  /** The run's worker count — an executor that paces itself reads it here. */
  readonly concurrency: number
}

export interface PluginContext {
  /** Where the workspace lives on disk. */
  readonly workspaceRoot: string
  /** Where vx's cache lives — read-only as far as the plugin is concerned. */
  readonly cacheDir: string
  /** Funnel warnings into the run:status channel, as every hook's context does. */
  warn(message: string): void
  /**
   * The run event bus. A plugin can subscribe directly if its needs exceed
   * the hooks; the subscription ends with the run, as a hook's does.
   */
  readonly bus: EventBus
  /**
   * Convenience: register a typed handler keyed off `RunEvent.kind`.
   * Multiple hooks can chain via repeated calls.
   */
  on<K extends PluginHookName>(hook: K, handler: PluginHookHandlers[K]): void
}

export type PluginHookName =
  | 'onRunStart'
  | 'onTaskStart'
  | 'onTaskStdout'
  | 'onTaskStderr'
  | 'onTaskComplete'
  | 'onRunStatus'
  | 'onRunEnd'

// A Record so the compiler holds it to `PluginHookName` both ways: a name
// missing here, or one the type lacks, does not compile.
const HOOK_NAMES: Record<PluginHookName, true> = {
  onRunStart: true,
  onTaskStart: true,
  onTaskStdout: true,
  onTaskStderr: true,
  onTaskComplete: true,
  onRunStatus: true,
  onRunEnd: true,
}

export interface PluginHookHandlers {
  onRunStart: (info: RunStartInfo) => void | Promise<void>
  onTaskStart: (node: TaskNode) => void | Promise<void>
  onTaskStdout: (node: TaskNode, chunk: string) => void | Promise<void>
  onTaskStderr: (node: TaskNode, chunk: string) => void | Promise<void>
  onTaskComplete: (node: TaskNode, outcome: TaskOutcome) => void | Promise<void>
  onRunStatus: (line: string) => void | Promise<void>
  onRunEnd: () => void | Promise<void>
}

export interface Plugin {
  /** Logged on errors; the convention is `'org/plugin-name'`. */
  readonly name: string
  /**
   * Called once at the start of every run. Register hooks via
   * `ctx.on(name, fn)` or subscribe to `ctx.bus` directly. Returning
   * a promise lets a plugin do async setup; the bus subscription must
   * be installed synchronously inside setup() so no events are missed.
   *
   * OPTIONAL: a capability-only plugin (one that contributes
   * `cache`/`executor`/`telemetry` but no `setup`) is simply skipped by
   * `installPlugins` — its capabilities are consulted by `plugin-host.ts`.
   */
  setup?(ctx: PluginContext): void | Promise<void>
}

/** What a plugin author writes: every hook, and no name. */
export type PluginHooks = Omit<VxPlugin, 'name'>

/**
 * Where a plugin is defined — `import.meta` of its module. `dir` is Bun's
 * field; `url` is the standard one, for a module evaluated elsewhere.
 */
export interface PluginOrigin {
  readonly dir?: string
  readonly url?: string
}

const packageNameByDir = new Map<string, string>()

/** The name of the nearest `package.json` above `dir` — the one that owns it. */
function pluginPackageName(dir: string): string {
  const memo = packageNameByDir.get(dir)
  if (memo !== undefined) return memo
  for (let d = dir; ;) {
    let text: string | undefined
    try {
      text = readFileSync(path.join(d, 'package.json'), 'utf8')
    } catch {
      /* not here; look one level up */
    }
    if (text !== undefined) {
      const name = (JSON.parse(text) as { name?: unknown }).name
      if (typeof name !== 'string' || name.length === 0) {
        throw new UserError(
          `definePlugin: ${path.join(d, 'package.json')} has no name — a plugin is a package, and its name is the package's`,
        )
      }
      packageNameByDir.set(dir, name)
      return name
    }
    const parent = path.dirname(d)
    if (parent === d) {
      throw new UserError(
        `definePlugin: no package.json above ${dir} — a plugin is a package, and its name is the package's`,
      )
    }
    d = parent
  }
}

/**
 * The one way to make a plugin: `definePlugin(import.meta, { ...hooks })`.
 * The name is read from the package the calling module belongs to — the
 * nearest `package.json` above it — and stamped where the workspace loader
 * checks for it, so a plugin cannot be named anything but its package.
 */
export function definePlugin(origin: PluginOrigin, hooks: PluginHooks): VxPlugin {
  if ('name' in hooks) {
    throw new UserError(`definePlugin: a plugin's name is its package name — drop the 'name' field`)
  }
  const dir =
    origin.dir ?? (origin.url !== undefined ? path.dirname(fileURLToPath(origin.url)) : undefined)
  if (dir === undefined) {
    throw new UserError(`definePlugin: the first argument must be the plugin module's import.meta`)
  }
  const name = pluginPackageName(dir)
  return { ...hooks, name, [PLUGIN_PACKAGE]: name } as VxPlugin
}

/** What `refuseUnknownOptions` holds an option's value to. */
type OptionKind<V> = [V] extends [string]
  ? 'string'
  : [V] extends [number]
    ? 'number'
    : [V] extends [boolean]
      ? 'boolean'
      : [V] extends [(...args: never[]) => unknown]
        ? 'function'
        : [V] extends [object]
          ? 'object'
          : 'any'

/**
 * Every option a factory takes, each with the one kind its type allows
 * (`'any'` for a union of kinds, such as `false | { … }`). Derived from
 * the options interface, so the type checker refuses a missing option, an
 * extra one or a wrong kind.
 */
export type PluginOptionKinds<T> = {
  readonly [K in keyof Required<T>]-?: OptionKind<Required<T>[K]>
}

/**
 * Refuse an option a plugin factory does not take, or a value of the wrong
 * kind, as core refuses an unknown config field. Bun strips a config's
 * types, so a misspelt option (`reapi({ endpont })`) reached the factory,
 * which read it as unset and quietly declined, and a string where a number
 * or a boolean belongs (`process.env.X`) was misread or threw a bare
 * TypeError. `factory` names the call in the message (`reapi()`).
 */
export function refuseUnknownOptions<T>(
  factory: string,
  options: unknown,
  kinds: PluginOptionKinds<T>,
): void {
  if (options === undefined) return
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new UserError(`${factory}: options must be an object`)
  }
  const known = kinds as Readonly<Record<string, string>>
  const names = Object.keys(known)
  for (const [key, value] of Object.entries(options)) {
    const kind = known[key]
    if (kind === undefined) {
      const near = nearest(key, names)
      throw new UserError(
        `${factory} has unknown option "${key}" (allowed: ${[...names].sort().join(', ')})` +
          (near === undefined ? '' : ` — did you mean ${near}?`),
      )
    }
    if (value === undefined || kind === 'any') continue
    const ok =
      kind === 'object'
        ? value !== null && typeof value === 'object' && !Array.isArray(value)
        : typeof value === kind
    if (!ok) {
      const got =
        typeof value === 'function' ? 'a function' : (JSON.stringify(value) ?? String(value))
      throw new UserError(
        `${factory} option "${key}" must be ${kind === 'object' ? 'an' : 'a'} ${kind}, got ${got}`,
      )
    }
  }
}

export interface InstallPluginsArgs {
  plugins: readonly Plugin[]
  workspaceRoot: string
  cacheDir: string
  bus: EventBus
  /**
   * Where plugin-throw warnings go. Defaults to console.error; passing
   * a callback lets the orchestrator funnel into the framed-output
   * `run:status` channel.
   */
  warn?: (message: string) => void
}

/**
 * A plugin's `setup` threw. It names the plugin so the run can tear down
 * every other one: their capability factories and setups ran, and the
 * one that failed set up nothing to release.
 */
export class PluginSetupError extends UserError {
  constructor(
    readonly plugin: Plugin,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Install every plugin's `setup` hook against a shared bus + context.
 * Synchronous loop; setup() promises are awaited in order so a plugin's
 * hooks are subscribed before the next plugin's setup runs. Throws if any
 * plugin's setup() throws (the run cannot start with a broken plugin).
 *
 * A plugin without a `setup` is a capability-only plugin (cache
 * / executor / telemetry) — skipped here; those capabilities are consulted by
 * `plugin-host.ts`.
 */
export async function installPlugins(args: InstallPluginsArgs): Promise<() => void> {
  const { plugins, bus, workspaceRoot, cacheDir } = args
  const warn = args.warn ?? ((m) => console.error(m))
  const disposers: Array<() => void> = []
  const disabled = new Set<string>()

  for (const plugin of plugins) {
    if (typeof plugin.name !== 'string' || plugin.name.length === 0) {
      throw new UserError('plugin missing `name` field')
    }
    // No setup → a capability-only plugin (cache / executor / telemetry),
    // consulted by plugin-host.ts; skip the hook install. A setup that's
    // present but not callable is a real authoring error — reject it.
    if (plugin.setup === undefined) continue
    if (typeof plugin.setup !== 'function') {
      throw new UserError(`plugin '${plugin.name}' setup is not a function`)
    }

    const ctx: PluginContext = {
      workspaceRoot,
      cacheDir,
      warn,
      // A subscription made past the hooks leaves with the run like a
      // hook's does: the bus can outlive the run (`RunOptions.bus`), and
      // one left behind hears every later run on it (item 635).
      bus: {
        emit: (event) => bus.emit(event),
        subscribe(subscriber) {
          const dispose = bus.subscribe(subscriber)
          disposers.push(dispose)
          return dispose
        },
      },
      on(hook, handler) {
        // A misspelt name ('taskComplete') subscribed a handler that never
        // ran, and no word of it; a config file has no type-checker (H-16).
        if (!Object.hasOwn(HOOK_NAMES, hook)) {
          throw new Error(
            `ctx.on: unknown hook '${String(hook)}' (one of ${Object.keys(HOOK_NAMES).join(', ')})`,
          )
        }
        const fail = (err: unknown): void => {
          if (disabled.has(plugin.name)) return
          disabled.add(plugin.name)
          warn(
            `[vx] plugin '${plugin.name}' threw in ${hook}; disabled for this run: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        const dispose = bus.subscribe((event) => {
          if (disabled.has(plugin.name)) return
          // Not awaited: the bus is synchronous and plugin work runs off the
          // critical path. A handler's rejection is caught like its throw.
          let ret: unknown
          try {
            switch (hook) {
              case 'onRunStart':
                if (event.kind === 'run:start')
                  ret = (handler as PluginHookHandlers['onRunStart'])(event.info)
                break
              case 'onTaskStart':
                if (event.kind === 'task:start')
                  ret = (handler as PluginHookHandlers['onTaskStart'])(event.node)
                break
              case 'onTaskStdout':
                if (event.kind === 'task:stdout')
                  ret = (handler as PluginHookHandlers['onTaskStdout'])(event.node, event.chunk)
                break
              case 'onTaskStderr':
                if (event.kind === 'task:stderr')
                  ret = (handler as PluginHookHandlers['onTaskStderr'])(event.node, event.chunk)
                break
              case 'onTaskComplete':
                if (event.kind === 'task:complete')
                  ret = (handler as PluginHookHandlers['onTaskComplete'])(event.node, event.outcome)
                break
              case 'onRunStatus':
                if (event.kind === 'run:status')
                  ret = (handler as PluginHookHandlers['onRunStatus'])(event.line)
                break
              case 'onRunEnd':
                if (event.kind === 'run:end') ret = (handler as PluginHookHandlers['onRunEnd'])()
                break
            }
          } catch (err) {
            fail(err)
            return
          }
          if (ret instanceof Promise) ret.catch(fail)
        })
        disposers.push(dispose)
      },
    }

    try {
      await plugin.setup(ctx)
    } catch (err) {
      throw new PluginSetupError(
        plugin,
        `plugin '${plugin.name}' failed in setup: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return () => {
    for (const d of disposers) d()
  }
}
