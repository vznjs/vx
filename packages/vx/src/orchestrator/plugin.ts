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
import {
  absentPluginCache,
  type Cache,
  type PluginCache,
  type RemoteCacheLayer,
} from '../cache/index.js'
import { PLUGIN_PACKAGE, type ProjectConfig, type WorkspaceConfig } from '../config.js'
import type { TaskExecutor } from '../exec/index.js'
import type { TaskNode, TaskOutcome, TaskStatus } from '../graph/index.js'
import { maskedLine, nearest, type PluginSecrets, SecretBroker, UserError } from '../util/index.js'
import type { ProjectMeta } from '../workspace/index.js'
import type { EventBus, Logger, RunStartInfo } from '../report/index.js'
import type { CiContext } from './run-context.js'
import type { CacheFacts, TaskArtifacts } from './task-artifacts.js'
import type { TelemetryContext, TelemetrySink } from './telemetry.js'

/**
 * A vx plugin. Contributes any subset of the run-level capabilities —
 * where work runs (executor), which cache is used (cache), who
 * observes the run (telemetry). It never changes WHAT a task is (the
 * command string — principle #3), only where and how that command is
 * executed. Registered explicitly in .vx/workspace.ts via
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
   * `ctx.setBranch` names what the CI knows of the branch: its cache scope
   * and the commit it is compared with.
   */
  config?(workspace: WorkspaceConfig, ctx: ConfigContext): void | Promise<void>

  /**
   * Projects beyond the directories holding a vx.config, their names, and
   * edges between projects, as `DiscoveredProject`s (each directory
   * absolute or relative to the workspace root): a lockfile's importers,
   * their package names and the dependencies it records; a runner's root
   * tasks. Runs once per discovery, before any project config loads; each
   * plugin sees the locked projects and the ones earlier plugins added,
   * without their edges. A directory that is not a project becomes one
   * (with no config; named by `name`, else its path). A project named by
   * its path takes `name`; one its config names keeps that name, and a
   * different name from an earlier plugin is refused, as is a directory
   * outside the root. Two projects of one name are refused once the stage
   * ends. `deps` and `reach` from every plugin union then; a target that is
   * no project is refused.
   */
  discover?(
    ctx: DiscoverContext,
  ): readonly DiscoveredProject[] | Promise<readonly DiscoveredProject[]>

  /**
   * One project's validated config, right after it loaded and before the
   * graph is built. Add, remove or edit tasks. Runs for every loaded project
   * on every run — a locked config is the user's file, and the hook is
   * applied on top of it live. A project with NO config file (a
   * `discover` plugin added it) is loaded too, as `{ tasks: {} }`, so a
   * plugin can give it tasks; with no `project` plugin such a project is
   * never visited. Its `name` is fixed by then: a change is refused.
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
   * Workspace-root files this plugin keys on: core folds no root file into
   * any key, so a plugin that reads one (a lockfile it folds per project
   * through `key`, `turbo.json` that shapes every task through its
   * `project` stage) claims it here. `--affected` asks `affected` which
   * projects a change to it touches (undefined: every project), `vx watch`
   * re-runs on an edit (item 961), and a task that rewrites one during the
   * run withholds every later save. A claim is a bare name at the root; a
   * file has one claimant.
   */
  readonly fingerprint?: FingerprintClaim

  /**
   * Scheduling priorities: task id → weight, higher runs first among READY
   * tasks (merged over the structural baseline, which stays the tie-break).
   * Runs once, after the graph is final and the local hits are known, and
   * only when a task will start: a run of confirmed local hits restores
   * in no order a weight changes. A later plugin's weight for a task
   * overrides an earlier one's. Return undefined to leave the baseline.
   * The run waits for this answer before its first task, so it should
   * come from what is at hand (local history); better weights that need
   * a fetch go to `ctx.refine` when they arrive, without holding the run.
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
   * breaks a run. Restore-tier hits, tasks on an executor pool and groups
   * hold no local resources: never asked, never in `ctx.running`. When
   * several plugins answer, all must admit. Core keeps no notion of what a task needs: a plugin that
   * packs memory or CPU learns or declares the numbers itself
   * (`@vzn/vx-history` packs what past executions used).
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
   * Contribute a remote cache: the wire (`has`, `get`, `put`, optional
   * `hasMany`), or undefined to decline. Consulted ONCE per prepareRun.
   * Core layers each one behind its own local cache and owns the rest:
   * the local store is asked first, then each remote in declaration order;
   * the run's policy and scope gate every remote; a remote's throw is a
   * miss and a warning naming the plugin, never a failed run.
   */
  cache?(ctx: CacheContext): RemoteCacheLayer | undefined | Promise<RemoteCacheLayer | undefined>

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
   * Take the terminal for this run: return the `Logger` that renders it
   * (the contract `run({ log })` takes), or `undefined` to leave core's
   * renderer in place. The first plugin, in declaration order, that
   * returns one renders the run; the rest are not asked. Not consulted
   * when an embedder passed its own `log`. A logger that throws hands the
   * rest of the run back to core's renderer with one warning.
   */
  output?(ctx: OutputContext): Logger | undefined | Promise<Logger | undefined>

  /**
   * Optional one-time setup per run (validate the workspace, open a
   * connection, read a token). Throwing aborts the run with a clean
   * UserError naming the plugin. It is not a guard over the pipeline: the
   * config, project, cache, graph and key stages have run by the time it
   * is called, and a plan (`--dry`, `planRun`) never calls it. It
   * precedes the schedule stage, the executors, the telemetry sinks,
   * admission and the first task (tests/plugin-e2e.test.ts).
   */
  setup?(ctx: PluginSetupContext): void | Promise<void>

  /**
   * Optional teardown at end-of-run (flush a sink, close a socket), in
   * declaration order, a plugin with `cache` after every other: the
   * others may still write through its remote. Errors are logged, never
   * thrown. A run that ran to its end passes its
   * `RunReport`; every other exit (a refused setup, a stop) passes none.
   */
  teardown?(run?: RunReport): void | Promise<void>
}

/**
 * What a finished run hands each plugin's `teardown`: its facts and every
 * task, with the names core kept the task's bytes under. Core keeps them
 * only when a remote takes the run's writes (CI by default): the log of a
 * task that saved no entry, and a failed task's log and the files its
 * outputs left when `cache.upload.failures` covers the run. Read
 * them with `ctx.cache.getRun(name)`. Core keeps no manifest of its own; a
 * plugin that wants one writes it from here (`ctx.cache.put`).
 */
export interface RunReport {
  /** The `run_id` the run's history rows and telemetry carry. */
  readonly runId: string
  /** `HEAD`'s commit, null outside a git worktree. */
  readonly commit: string | null
  /** What the CI provider says about this run: provider, run URL, pipeline, job, attempt. */
  readonly ciRun: CiContext
  readonly ok: boolean
  /** Every task the run decided, in completion order; group tasks are left out. */
  readonly tasks: readonly RunReportTask[]
}

export interface RunReportTask {
  readonly id: string
  readonly status: TaskStatus
  readonly durationMs: number
  /** The task's cache key, when one was computed. */
  readonly key?: string
  /** Its output (both streams, secrets masked), when core kept it: `ctx.cache.getRun(log)`. */
  readonly log?: string
  /** A tar of the files its declared outputs left, when core kept it: `ctx.cache.getRun(outputs)`. */
  readonly outputs?: string
}

/** Shared, read-only context every capability factory receives. */
interface BaseContext {
  readonly workspaceRoot: string
  readonly cacheDir: string
  /** Funnel warnings into the run:status channel (framed output). */
  warn(message: string): void
}

/**
 * What `setup` receives: the run's lifecycle, observe-only, and the
 * plugin's keychain (`secret`, `forgetSecret`): setup runs before the
 * status line, so a prompt there is seen.
 */
export interface PluginSetupContext extends BaseContext, PluginSecrets {
  /** This plugin's entries in the workspace's cache (`PluginCache`). */
  readonly cache: PluginCache
  /** The run is on CI (`CI` set, or a provider core detects). */
  readonly ci: boolean
  /** The run's branch (`currentBranch`): `run.branch`, else git's, else the CI provider's. */
  readonly branch: string | null
  /**
   * Subscribe a lifecycle handler; it leaves with the run. A throw or a
   * rejection warns once and switches the plugin's handlers off for the run.
   */
  on<K extends PluginHookName>(hook: K, handler: PluginHookHandlers[K]): void
}

/** One CLI verb contributed by a plugin. */
export interface PluginCommand {
  /** One line for `vx help`. */
  readonly description: string
  run(argv: readonly string[], ctx: CommandContext): number | Promise<number>
}

export interface CommandContext extends BaseContext {
  /**
   * The worker count a `vx run` here uses unless `--concurrency` says
   * otherwise: `.vx/workspace`'s `concurrency`, else what the machine allows.
   * A verb that budgets a run (`vx history`) reads it here; its own
   * `machineParallelism()` said 4 cores beside `concurrency: 1` (item 1068).
   */
  readonly concurrency: number
  /**
   * The argv that runs this vx again: the binary alone when compiled, the
   * runtime and its entry script from source. A verb that runs tasks
   * spawns `[...vx, 'run', …]` rather than guess
   * which `vx` a PATH holds.
   */
  readonly vx: readonly string[]
  /**
   * This plugin's entries in the workspace's cache, as `setup` reaches them
   * (`PluginCache`), read-only: the local store, then each remote the
   * workspace's cache plugins supply, under the run's scope. Opened on first use.
   */
  readonly cache: PluginCache
  /**
   * Task entries by key in the workspace's cache, under a run's policy and
   * scope (a laptop writes no remote unless the workspace's policy names
   * it): what a verb that runs a run's tasks on this machine saves and
   * restores through (`TaskArtifacts`). Opened on first use.
   */
  readonly artifacts: TaskArtifacts
  /**
   * `artifacts` read as another machine's run would read them: under its
   * refs, with the access its remotes lent (`CacheFacts`, asked on each
   * request, so a token it lends again replaces the last). Opened on first
   * use; until `facts` answers, under this machine's own.
   */
  artifactsFor(facts: () => CacheFacts | undefined): TaskArtifacts
}

/** `config` runs before the cache dir is known — it may be what the hook changes. */
export interface WorkspaceHookContext {
  readonly workspaceRoot: string
  warn(message: string): void
}

/**
 * What a CI knows of the run's branch (2026-10-17): `scope`, the
 * cache scope (`'vznjs/vx:feat-x'`; `VX_CACHE_SCOPE` beats it, and it
 * beats the one git names), and `base`, the commit the branch is compared
 * with (a pull request's base), for a bare `--affected`. `trusted`: the
 * run has no scope, whatever git names (a merge queue's run,
 * 2026-10-18). The scope keys plugin entries only. `refs`: the refs a
 * remote reads, in order (`CacheContext.refs`; 2026-10-25: a pull
 * request its head branch, then its base, then the default branch; a
 * merge queue or train only its base); unset, git's. A later plugin's
 * field wins.
 */
export interface BranchFacts {
  scope?: string
  base?: string
  trusted?: boolean
  refs?: readonly string[]
}

export interface ConfigContext extends WorkspaceHookContext {
  setBranch(facts: BranchFacts): void
}

export interface DiscoverContext extends WorkspaceHookContext {
  /** Where vx's cache lives: a plugin may keep what it read to answer here. */
  readonly cacheDir: string
  /** The projects found so far: the lock's, then earlier plugins'. */
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

/** What a `discover` hook returns per directory — see `VxPlugin.discover`. */
export interface DiscoveredProject {
  /** Absolute or relative to the workspace root. */
  readonly dir: string
  /**
   * Its name, when its config names none: replaces a path name, never a
   * config's; a different name from an earlier plugin is refused. Unset on
   * a new directory: its root-relative path.
   */
  readonly name?: string
  /** Directories this project builds after: `^task` order, and reach for `--filter` and `--affected`. */
  readonly deps?: readonly string[]
  /** Directories a change reaches this project through (`--filter`, `--affected`), with no order. */
  readonly reach?: readonly string[]
}

export interface ProjectHookContext extends BaseContext {
  /** The project's name (`ProjectMeta.name`). */
  readonly name: string
  /** The project's directory, absolute. */
  readonly dir: string
  /**
   * Every project the workspace discovered — the one being visited, the
   * rest of the run's scope and the projects outside it, config file or
   * not — as the `discover` stage left them. A plugin whose mapping needs
   * the whole workspace (a `dependsOn` is only valid against every
   * package's scripts at once) reads it here instead of walking the workspace a
   * second time. The same array is handed to every visit of a run and a
   * new one to the next run — a plugin instance outlives a run under `vx
   * watch`, so a per-run memo keys on this array's identity, never on the
   * process.
   */
  readonly projects: readonly ProjectMeta[]
  /**
   * True when `vx lock` (or `--check`) visits: the one pass that checks the
   * configs, so the place to report what a plugin's mapping could not say.
   * A run checks nothing (the lock model), so such a report there repeats
   * on every run.
   */
  readonly lock: boolean
}

export interface GraphHookContext extends BaseContext {
  /**
   * Task ids the user asked for (the rest were pulled in by `dependsOn`).
   * Under `--affected` this is every candidate: the selection reads the
   * graph the hooks leave and cuts it down afterwards.
   */
  readonly requested: readonly string[]
}

export interface KeyHookContext extends BaseContext {}

/** A plugin's claim on workspace-root files — see `VxPlugin.fingerprint`. */
export interface FingerprintClaim {
  /** Bare names at the workspace root the plugin reads: a lockfile (`pnpm-lock.yaml`), a settings file, `turbo.json`. */
  readonly files: readonly string[]
  /**
   * The projects (by name) a change to a claimed file affects. Called
   * by `--affected` with the file's bytes at the base ref and in the
   * working tree (`null` where it does not exist). Return `undefined` to
   * select every project — the answer a claimant gives when it cannot
   * tell.
   */
  affected(
    change: FingerprintChange,
    ctx: FingerprintContext,
  ): Iterable<string> | undefined | Promise<Iterable<string> | undefined>
  /**
   * The workspace-relative files a claimed file's bytes name that the
   * plugin's key reads too: `bun.lock`'s patch files, which it names by
   * path and hashes nowhere, or a `file:` dependency's directory. A change
   * to one, or under one, asks `affected` about the file naming it, with
   * `change.extras`. Without it, a `bun.lock` patch edit selects every
   * project.
   */
  extraFiles?(file: string, bytes: Uint8Array): readonly string[]
}

export interface FingerprintChange {
  /** The claimed file's root-relative name. */
  readonly file: string
  readonly before: Uint8Array | null
  readonly after: Uint8Array | null
  /**
   * Each changed `extraFiles` entry, as the claimant names it, at the base
   * ref and in the working tree. A directory's sides are not its bytes:
   * they differ because a file under it changed.
   */
  readonly extras?: ReadonlyMap<
    string,
    { readonly before: Uint8Array | null; readonly after: Uint8Array | null }
  >
}

export interface FingerprintContext extends BaseContext {
  /** Every project in the workspace: name and absolute directory. */
  readonly projects: ReadonlyArray<{ readonly name: string; readonly dir: string }>
}

export interface AdmitContext {
  /**
   * The tasks holding a worker on this machine right now, in dispatch
   * order. A persistent task leaves at ready, when it gives its worker
   * back: it runs until the graph ends, so a policy that counted it would
   * hold its dependants with no completion left to ask again.
   */
  readonly running: readonly TaskNode[]
  /** The run's worker count — the ceiling the count gate already applies. */
  readonly concurrency: number
}

export interface ScheduleHookContext extends BaseContext {
  /** The run's local cache handle — its `dbHandle()` holds the run history a policy can learn from. */
  readonly localCache: Cache
  /** The run's branch (`currentBranch`), the timings a forecast reads first: pass it to `LocalHistoryProvider`. */
  readonly branch: string | null
  /** The refs the run reads, in order (`CacheContext.refs`): a remote's timings are read by them too. */
  readonly refs: readonly string[]
  /** This plugin's entries in the workspace's cache, as `setup` has them. */
  readonly cache: PluginCache
  /**
   * Replace this plugin's weights while the run goes on: the tasks not yet
   * started re-rank at once. For weights that arrive late (timings fetched
   * from a remote). Ignored in a plan and once the run's tasks are done.
   * Given a promise, the weights it resolves to, if any, when it does:
   * `refining()` waits for it meanwhile.
   */
  refine(
    weights: ReadonlyMap<string, number> | Promise<ReadonlyMap<string, number> | undefined>,
  ): void
  /**
   * Settles once every refine promised so far (a promise to `refine`) has
   * landed or failed, its listeners called: a plugin that sizes the run by
   * the fetched data waits for it here rather than guessing without it.
   */
  refining(): Promise<void>
  /**
   * Calls `listener` each time another plugin `refine`s: the late data it
   * waited for (timings fetched from a remote) has landed in history, so a
   * plugin that read history in `schedule` may read it again. Never called
   * in a plan.
   */
  onRefine(listener: () => void): void
}

/** A `cache` hook's context: the workspace and the run's scope, never the local store or the policy, which core owns. */
export interface CacheContext extends BaseContext {
  /**
   * The run's cache scope (`'vznjs/vx:feat-x'`), `undefined` when none: what
   * plugins' `ctx.cache` entries and stored runs are keyed apart by.
   */
  readonly scope: string | undefined
  /**
   * The refs the run reads, in order (`['refs/heads/feat-x', 'refs/heads/main']`):
   * its own branch, the branch it merges into, the default branch. A remote
   * keys or scopes its entries by them; core keys task entries by none.
   */
  readonly refs: readonly string[]
  /**
   * The token a run lent this plugin's remote (`RemoteCacheLayer.lend`),
   * on a machine that runs that run's tasks (`CommandContext.artifactsFor`);
   * undefined anywhere else. Read it per request: a run lends again before
   * a token ends. A plugin uses it only when it has no access of its own.
   */
  readonly lent?: () => string | undefined
}

export interface OutputContext extends BaseContext {
  /** Core would write to a terminal: stdout is a TTY. */
  readonly isTTY: boolean
  /** The run is on CI (`CI` set, or a provider core detects). */
  readonly ci: boolean
}

export interface ExecutorContext extends BaseContext {
  /** The run's worker count — an executor that paces itself reads it here. */
  readonly concurrency: number
  /** Task entries by key in the run's cache, for a task another machine ran (`TaskArtifacts`). */
  readonly artifacts: TaskArtifacts
  /**
   * What a machine that runs this run's tasks reads the cache under
   * (`CacheFacts`): the run's refs, and each remote's lent access, asked
   * now. Ask again before `expiresAt`.
   */
  cacheFacts(): Promise<CacheFacts>
}

export interface PluginContext extends PluginSetupContext {
  /**
   * The run event bus. A plugin can subscribe directly if its needs exceed
   * the hooks; the subscription ends with the run, as a hook's does.
   */
  readonly bus: EventBus
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
      // A byte-order mark is stripped, as npm, Node and discovery strip it.
      text = readFileSync(path.join(d, 'package.json'), 'utf8').replace(/^\uFEFF/, '')
    } catch {
      /* not here; look one level up */
    }
    if (text !== undefined) {
      // A bare JSON.parse reached the user as a SyntaxError and a stack,
      // naming no file (X-20).
      let pkg: { name?: unknown } | null
      try {
        pkg = JSON.parse(text) as { name?: unknown } | null
      } catch (err) {
        throw new UserError(
          `definePlugin: failed to parse ${path.join(d, 'package.json')}: ${(err as Error).message}`,
        )
      }
      const name = pkg?.name
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
  /** Each plugin's `ctx.cache`, by plugin name. Default: a cache with no layer. */
  cache?: (plugin: string) => PluginCache
  /** Default false. */
  ci?: boolean
  /** Default null. */
  branch?: string | null
  /** The run's secrets; default: the OS keychain and this terminal. */
  secrets?: SecretBroker
  /** Each setup as the step `<plugin>:setup`; default: untimed. */
  step?: <T>(id: string, work: () => Promise<T>) => Promise<T>
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
  const secrets = args.secrets ?? new SecretBroker(args.ci ?? false, warn)
  const disposers: Array<() => void> = []
  // By object, not name: one package can export two plugins.
  const disabled = new Set<Plugin>()

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

    const fail = (where: string, err: unknown): void => {
      if (disabled.has(plugin)) return
      disabled.add(plugin)
      warn(
        `[vx] plugin '${plugin.name}' threw in ${where}; disabled for this run: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const ctx: PluginContext = {
      workspaceRoot,
      cacheDir,
      warn,
      cache: args.cache?.(plugin.name) ?? absentPluginCache,
      ...secrets.for(plugin.name),
      ci: args.ci ?? false,
      branch: args.branch ?? null,
      // A subscription made past the hooks leaves with the run like a
      // hook's does: the bus can outlive the run (`RunOptions.bus`), and
      // one left behind hears every later run on it (item 635).
      bus: {
        emit: (event) => bus.emit(event),
        subscribe(subscriber) {
          // Isolated like an `on` handler: the bus itself swallows a throw.
          const dispose = bus.subscribe((event) => {
            if (disabled.has(plugin)) return
            let ret: unknown
            try {
              ret = subscriber(event)
            } catch (err) {
              fail('a bus subscriber', err)
              return
            }
            if (ret instanceof Promise) ret.catch((err: unknown) => fail('a bus subscriber', err))
          })
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
        const onFail = (err: unknown): void => fail(hook, err)
        const dispose = bus.subscribe((event) => {
          if (disabled.has(plugin)) return
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
            onFail(err)
            return
          }
          if (ret instanceof Promise) ret.catch(onFail)
        })
        disposers.push(dispose)
      },
    }

    try {
      if (args.step === undefined) await plugin.setup(ctx)
      else await args.step(`${plugin.name}:setup`, async () => plugin.setup?.(ctx))
    } catch (err) {
      // Earlier plugins' subscriptions too: the caller never gets the
      // disposer, and a bus that outlives the run would keep them.
      for (const d of disposers) d()
      throw new PluginSetupError(
        plugin,
        // Masked at the source, as plugin-host.ts's `safe()` does (L-11).
        maskedLine(
          `plugin '${plugin.name}' failed in setup: ${err instanceof Error ? err.message : String(err)}`,
        ),
      )
    }
  }

  return () => {
    for (const d of disposers) d()
  }
}
