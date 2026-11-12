// Plugin API: the one `VxPlugin` contract (docs/design/pipeline-2026-09.md).
// Behaviour capabilities (`cache`, `executor`) return objects core calls
// into; observe capabilities (`telemetry`, `setup` on the bus) only read. A
// throw in a load-bearing hook aborts the run with a UserError naming plugin
// and hook; a throw in a bus hook is logged and disables it for the run.

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
import {
  errorCode,
  hookStarted,
  isMeasure,
  maskedLine,
  nearest,
  type PluginSecrets,
  SecretBroker,
  thrownMessage,
  UserError,
} from '../util/index.js'
import * as ui from '../ui/index.js'
import type { ProjectMeta } from '../workspace/index.js'
import type { EventBus, Logger, Measure, RunEvent, RunStartInfo } from '../report/index.js'
import { readOnlyEvents } from './read-only.js'
import { unlessStopped } from './signals.js'
import type { CiContext } from './run-context.js'
import type { CacheFacts, TaskArtifacts } from './task-artifacts.js'
import type { TelemetryContext, TelemetrySink } from './telemetry.js'

/**
 * A vx plugin: any subset of where work runs (executor), which cache is used
 * (cache) and who observes (telemetry). It never changes what a task is (its
 * command), only where and how it runs. Registered explicitly in
 * `.vx/workspace.ts`; no auto-discovery. Made only by
 * `definePlugin(import.meta, hooks)`. Core names no plugin; the local
 * executor and cache are the floor under the list.
 */
export interface VxPlugin {
  /**
   * The name of the package the plugin was defined in — set by
   * `definePlugin` from the nearest `package.json`, never by the plugin.
   * Heads every warning about the plugin, every `vx info` line, and the
   * key material a `key` hook contributes.
   */
  readonly name: string

  // --- PIPELINE stages (shape the run before it executes — opt-in)
  // ----------
  //
  // Each edits the object core is about to use in place; core re-validates
  // after each plugin, so a plugin cannot produce what a user could not
  // write. Declaration order is the order. A stage's changes reach the key by
  // construction (the key hashes task configs after `project` and `graph`),
  // and a reference kept past its stage cannot change it later: the run
  // copies and freezes configs.

  /**
   * The workspace config, before anything is derived from it (concurrency,
   * cacheDir, timeout, …). `plugins` is already fixed by the time this runs:
   * an edit to it is refused.
   * Core re-validates after each plugin, as it does a user's file.
   * `ctx.setBranch` names what the CI knows of the branch: its cache scope
   * and the commit it is compared with.
   */
  config?(workspace: WorkspaceConfig, ctx: ConfigContext): void | Promise<void>

  /**
   * Projects beyond the directories holding a vx.config, their names and
   * inter-project edges, as `DiscoveredProject`s (dirs absolute or
   * root-relative): a lockfile's importers, a runner's root tasks. Runs under
   * `vx lock` (and `--check`) only, before any project config loads; every
   * other verb applies the lock's record. Each plugin sees the locked
   * projects and earlier plugins' additions, without edges. A new directory
   * becomes a project (named by `name`, else its path). A path-named project
   * takes `name`; a config's name wins, and a different name from an earlier
   * plugin is refused, as is a dir outside the root or `//` off it. Duplicate
   * names are refused once the stage ends. `deps` and `reach` from every
   * plugin union; a target that is no project is refused.
   */
  discover?(
    ctx: DiscoverContext,
  ): readonly DiscoveredProject[] | Promise<readonly DiscoveredProject[]>

  /**
   * One project's validated config, after load and before the graph: add,
   * remove or edit tasks. Runs under `vx lock` (and `--check`) only, for
   * every project; a run follows the lock's record, never the files. A
   * project with no config file (a `discover` plugin added it) is visited as
   * `{ tasks: {} }`. Its `name` is fixed: a change is refused.
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
   * Extra key material for one task: a `{ name: value }` record folded into
   * the key and named in `vx why` (a tool version, a feature flag). Once per
   * task per run, before any key. Undefined adds nothing. Values must be
   * deterministic, or the key never hits. The task is read-only; `graph`
   * edits tasks.
   */
  key?(
    task: TaskNode,
    ctx: KeyHookContext,
  ):
    | Readonly<Record<string, string>>
    | undefined
    | Promise<Readonly<Record<string, string>> | undefined>

  /**
   * Workspace-root files this plugin keys on: core folds no root file, so a
   * plugin reading one (a lockfile, `turbo.json`) claims it here.
   * `--affected` asks `affected` which projects a change touches (undefined:
   * all), `vx watch` re-runs on an edit, and a task rewriting one during a
   * run withholds every later save. A bare root name; one claimant per file.
   */
  readonly fingerprint?: FingerprintClaim

  /**
   * Scheduling priorities: task id → weight, higher first among ready tasks,
   * merged over the structural baseline (the tie-break). Once, after the
   * graph is final and local hits are known, only when a task will start. A
   * later plugin's weight wins. Undefined keeps the baseline. The run waits
   * for this, so answer from what is at hand; weights needing a fetch go to
   * `ctx.refine`. The nodes are read-only.
   */
  schedule?(
    nodes: ReadonlyMap<string, TaskNode>,
    ctx: ScheduleHookContext,
  ): ReadonlyMap<string, number> | undefined | Promise<ReadonlyMap<string, number> | undefined>

  /**
   * What this plugin will measure that is no task (a worker's warm-up): id
   * (`<plugin>#<name>`) → definition hash. Asked before `schedule`, which
   * hands the union to every plugin as `ctx.measures`, so a history plugin
   * fetches them with the tasks'. Reported by `ctx.measure`, read back via
   * `localHistory(…).resourcesFor`.
   */
  measures?(nodes: ReadonlyMap<string, TaskNode>): ReadonlyMap<string, string> | undefined

  /**
   * Admission over the worker count: asked for every task about to start
   * here, with the tasks running here. `false` holds it until something
   * finishes. Asked often: cheap and synchronous. A throw or a non-boolean
   * answer is reported once and the plugin admits from then on; a policy
   * never breaks a run. Restore-tier hits, pooled tasks and groups are never
   * asked. Several plugins: all must admit. Core keeps no notion of a task's
   * needs: a packing plugin learns or declares them (`@vzn/vx-history`). Task
   * and `ctx.running` are read-only.
   */
  admit?(task: TaskNode, ctx: AdmitContext): boolean

  // --- CLI verbs (opt-in) ---------------------------------------------------

  /**
   * Verbs this plugin adds to `vx`, by name. Consulted only for verbs core
   * does not know (a clash is refused at load) and only inside a workspace
   * declaring the plugin. `vx help` lists them. The exit code is the
   * process's; a thrown `UserError` prints cleanly.
   */
  readonly commands?: Readonly<Record<string, PluginCommand>>

  // --- BEHAVIOR capabilities (change WHAT/HOW work runs — opt-in) -----------

  /**
   * Contribute a remote cache (`has`, `get`, `put`, optional `hasMany`), or
   * undefined. Consulted once per prepareRun. Core layers each behind its own
   * local cache: local first, then each remote in order, all gated by the
   * run's policy and scope; a remote's throw is a miss and a warning, never a
   * failed run.
   */
  cache?(ctx: CacheContext): RemoteCacheLayer | undefined | Promise<RemoteCacheLayer | undefined>

  /**
   * Contribute a task executor: where one task's command runs. Consulted once
   * per run; all are kept in order, and per task the first whose `accepts()`
   * passes runs it. Core's local executor is always last, so a declined task
   * runs here. Persistent tasks never reach an executor.
   */
  executor?(ctx: ExecutorContext): TaskExecutor | undefined | Promise<TaskExecutor | undefined>

  // --- OBSERVE-ONLY capability (cannot change behavior — by construction) ---

  /**
   * Contribute telemetry sinks, the export path. A sink receives versioned
   * `TelemetryRecord` / `RunSummaryRecord` values and holds no run handle, so
   * it cannot change what runs. Every plugin's sinks are active at once; a
   * throwing or slow sink is isolated.
   * docs/design/observability-architecture-2026-06.md.
   */
  telemetry?(
    ctx: TelemetryContext,
  ):
    | TelemetrySink
    | TelemetrySink[]
    | undefined
    | Promise<TelemetrySink | TelemetrySink[] | undefined>

  /**
   * Take the terminal: return the `Logger` that renders the run, or undefined
   * for core's. The first plugin returning one renders; the rest are not
   * asked; never when an embedder passed `log`. A logger that throws hands
   * the run back to core's renderer with one warning; one not answering
   * within the teardown bound (3 s) is passed over. Nodes and outcomes are
   * read-only.
   */
  output?(ctx: OutputContext): Logger | undefined | Promise<Logger | undefined>

  /**
   * Optional setup per run (validate, connect, read a token). A throw aborts
   * the run with a UserError naming the plugin. Not a guard over the
   * pipeline: the config, project, cache, graph and key stages ran already,
   * and a plan never calls it. It precedes `schedule`, the executors, the
   * sinks, admission and the first task.
   */
  setup?(ctx: PluginSetupContext): void | Promise<void>

  /**
   * Optional teardown at run end (flush, close), in declaration order,
   * `cache` plugins last since the others may write through them. Errors are
   * logged, never thrown. A completed run passes its `RunReport`; other exits
   * pass none.
   */
  teardown?(run?: RunReport): void | Promise<void>
}

/**
 * What a finished run hands each `teardown`: its facts and tasks, with the
 * names core kept their bytes under. Kept only when a remote takes the run's
 * writes (CI by default): the log of a task that saved no entry, and a failed
 * task's log and leftover outputs when `cache.upload.failures` covers the
 * run. Read with `ctx.cache.getRun(name)`; a plugin wanting a manifest writes
 * one (`ctx.cache.put`). Frozen.
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
   * Subscribe a lifecycle handler for the run. A throw or rejection warns
   * once and switches the plugin's handlers off. What a handler gets is
   * read-only, so it can never turn a failure into a pass.
   */
  on<K extends PluginHookName>(hook: K, handler: PluginHookHandlers[K]): void
  /**
   * Report a measure this plugin declared (`measures`): its id under the
   * plugin's name, its definition hash, its milliseconds and, if any, its
   * cores. Each plugin hears it (`onMeasure`); the run's last of an id is
   * kept in history at its end, as a task's timing is.
   */
  measure(measure: Measure): void
}

/** One CLI verb contributed by a plugin. */
export interface PluginCommand {
  /** One line for `vx help`. */
  readonly description: string
  run(argv: readonly string[], ctx: CommandContext): number | Promise<number>
}

export interface CommandContext extends BaseContext {
  /**
   * The worker count a `vx run` here uses without `--concurrency`: the
   * workspace's `concurrency`, else the machine's. For verbs that budget a
   * run (`vx history`).
   */
  readonly concurrency: number
  /**
   * The argv that runs this vx again: the binary when compiled, runtime and
   * entry from source. Spawn `[...vx, 'run', …]` rather than guess at PATH.
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
   * scope: what a verb running a run's tasks here saves and restores through
   * (`TaskArtifacts`). Opened on first use.
   */
  readonly artifacts: TaskArtifacts
  /**
   * `artifacts` as another machine's run reads them: under its refs, with the
   * access its remotes lent (`CacheFacts`, asked per request). Until `facts`
   * answers, under this machine's own.
   */
  artifactsFor(facts: () => CacheFacts | undefined): TaskArtifacts
}

/** `config` runs before the cache dir is known — it may be what the hook changes. */
export interface WorkspaceHookContext {
  readonly workspaceRoot: string
  warn(message: string): void
}

/**
 * What CI knows of the run's branch: `scope`, the cache scope
 * (`VX_CACHE_SCOPE` beats it, it beats git's); `base`, the commit compared
 * with (a PR's base), for a bare `--affected`; `trusted`: no scope, whatever
 * git says (a merge queue). The scope keys plugin entries only. `refs`: the
 * refs a remote reads, in order; unset, git's. A later plugin's field wins.
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
  /**
   * The projects found so far: the lock's, then earlier plugins'. Read-only;
   * a project is added by returning it. The same object `project` hooks get.
   */
  readonly projects: readonly ProjectMeta[]
  /**
   * What `git status` lists, workspace-relative (modified, staged, deleted,
   * both sides of a rename, untracked); null outside git. Core's own
   * enumeration, so a plugin needing the worktree (nx()'s graph key) reads it
   * here.
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
   * Every project the workspace discovered, as `discover` left them: for a
   * mapping that needs the whole workspace. The same array for every visit of
   * a run, a new one the next run: a plugin instance outlives a run under `vx
   * watch`, so memo on this array's identity. Frozen, entries too.
   */
  readonly projects: readonly ProjectMeta[]
  /**
   * True: the stage runs only when `vx lock` (or `--check`) visits, the one
   * pass that checks the configs and so the place to report what a
   * plugin's mapping could not say.
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

export interface KeyHookContext extends BaseContext {
  /**
   * What `vx lock` recorded of the claimed `file`
   * (`FingerprintClaim.digests`): a run keys from the record and never parses
   * the file. Undefined when absent and unrecorded. Refuses, naming `vx
   * lock`, when the lock is missing or lacks a present file.
   */
  locked(file: string): Promise<LockedFile | undefined>
}

/** `KeyHookContext.locked`'s answer. */
export interface LockedFile {
  /**
   * The other files the digests read → each one's hash then (`hashExtra`).
   * Not checked by core: a `link:` directory is edited with no install,
   * so a claimant whose extra file moved digests anew.
   */
  readonly extras: Readonly<Record<string, string>>
  /** The project at `projectDir`'s digest; undefined when none. Refuses for a project the lock does not list. */
  digest(projectDir: string): string | undefined
}

/** A plugin's claim on workspace-root files — see `VxPlugin.fingerprint`. */
export interface FingerprintClaim {
  /** Bare names at the workspace root the plugin reads: a lockfile (`pnpm-lock.yaml`), a settings file, `turbo.json`. */
  readonly files: readonly string[]
  /**
   * The projects a change to a claimed file affects, given its bytes at the
   * base and now (`null` where absent). `undefined` selects every project,
   * for a claimant that cannot tell. A name not in `ctx.projects` is refused.
   */
  affected(
    change: FingerprintChange,
    ctx: FingerprintContext,
  ): Iterable<string> | undefined | Promise<Iterable<string> | undefined>
  /**
   * Files a claimed file names that the plugin's key also reads (`bun.lock`
   * patches, a `file:` dependency's dir). A change to one asks `affected`
   * about the file naming it, with `change.extras`; without this, a patch
   * edit selects every project. Asked on every `--affected` diff, so memoise
   * in `ctx.cacheDir`.
   */
  extraFiles?(
    file: string,
    bytes: Uint8Array,
    ctx: FingerprintContext,
  ): readonly string[] | Promise<readonly string[]>
  /**
   * Each project's digest of the claimed `file` now, by project, with `hash`
   * (xxh3 of its bytes) and `extras`. `vx lock` records them in
   * `.vx/dependencies.lock.json`; a run keys from that
   * (`KeyHookContext.locked`), and `--affected` reads the base's copy instead
   * of parsing the base side when `hash` matches. `undefined`: nothing to
   * record.
   */
  digests?(
    file: string,
    ctx: FingerprintContext,
  ): FingerprintDigests | undefined | Promise<FingerprintDigests | undefined>
}

/** `FingerprintClaim.digests`' answer. */
export interface FingerprintDigests {
  readonly hash: string
  /** Project name → its digest of the file. */
  readonly projects: Readonly<Record<string, string>>
  /** Root-relative files besides `file` whose bytes the digests read (a `bun.lock` patch). */
  readonly extras?: readonly string[]
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
   * The tasks holding a worker here now, in dispatch order. A persistent task
   * leaves at ready: counted, it would hold its dependants with no completion
   * left to ask again.
   */
  readonly running: readonly TaskNode[]
  /** The run's worker count — the ceiling the count gate already applies. */
  readonly concurrency: number
}

export interface ScheduleHookContext extends BaseContext {
  /** The run's local cache: `localHistory(localCache)` reads the run history a policy learns from. */
  readonly localCache: Cache
  /** The run's branch (`currentBranch`), the timings a forecast reads first: pass it to `localHistory`. */
  readonly branch: string | null
  /** The refs the run reads, in order (`CacheContext.refs`): a remote's timings are read by them too. */
  readonly refs: readonly string[]
  /** Every plugin's `measures`, id → definition hash: timed as tasks are, fetched with them. */
  readonly measures: ReadonlyMap<string, string>
  /** This plugin's entries in the workspace's cache, as `setup` has them. */
  readonly cache: PluginCache
  /**
   * Replace this plugin's weights mid-run: unstarted tasks re-rank at once.
   * For weights that arrive late. Ignored in a plan and after the run's
   * tasks. Given a promise, `refining()` waits for it.
   */
  refine(
    weights: ReadonlyMap<string, number> | Promise<ReadonlyMap<string, number> | undefined>,
  ): void
  /**
   * Settles once every promised refine has landed or failed, so a plugin
   * sizing the run by fetched data waits here instead of guessing.
   */
  refining(): Promise<void>
  /**
   * Calls `listener` each time another plugin refines: late data has landed
   * in history, so a plugin may read it again. Never in a plan.
   */
  onRefine(listener: () => void): void
  /**
   * Name tasks a shared record knows as flaky: a failing one gets the one
   * retry a known flake gets. Unknown ids and plans ignore it.
   */
  flaky(taskIds: Iterable<string>): void
}

/** A `cache` hook's context: the workspace and the run's scope, never the local store or the policy, which core owns. */
export interface CacheContext extends BaseContext {
  /**
   * The run's cache scope (`'vznjs/vx:feat-x'`), `undefined` when none: what
   * plugins' `ctx.cache` entries and stored runs are keyed apart by.
   */
  readonly scope: string | undefined
  /**
   * The refs the run reads, in order: its branch, the branch it merges into,
   * the default branch. A remote keys or scopes by them; core keys task
   * entries by none.
   */
  readonly refs: readonly string[]
  /**
   * The token a run lent this plugin's remote (`RemoteCacheLayer.lend`), on a
   * machine running that run's tasks; undefined elsewhere. Read it per
   * request: a run lends again before it expires. Use it only without access
   * of your own.
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
   * the hooks; the subscription ends with the run, as a hook's does. The
   * events a subscriber gets are read-only, as a hook's are.
   */
  readonly bus: EventBus
}

export type PluginHookName =
  | 'onRunStart'
  | 'onTaskStart'
  | 'onTaskStdout'
  | 'onTaskStderr'
  | 'onTaskComplete'
  | 'onMeasure'
  | 'onRunStatus'
  | 'onRunEnd'

// Each hook's event. A Record so the compiler holds it to `PluginHookName`
// both ways: a name missing here, or one the type lacks, does not compile.
const HOOK_EVENTS: Record<PluginHookName, RunEvent['kind']> = {
  onRunStart: 'run:start',
  onTaskStart: 'task:start',
  onTaskStdout: 'task:stdout',
  onTaskStderr: 'task:stderr',
  onTaskComplete: 'task:complete',
  onMeasure: 'task:measure',
  onRunStatus: 'run:status',
  onRunEnd: 'run:end',
}

export interface PluginHookHandlers {
  onRunStart: (info: RunStartInfo) => void | Promise<void>
  onTaskStart: (node: TaskNode) => void | Promise<void>
  onTaskStdout: (node: TaskNode, chunk: string) => void | Promise<void>
  onTaskStderr: (node: TaskNode, chunk: string) => void | Promise<void>
  onTaskComplete: (node: TaskNode, outcome: TaskOutcome) => void | Promise<void>
  onMeasure: (measure: Measure) => void | Promise<void>
  onRunStatus: (line: string) => void | Promise<void>
  onRunEnd: () => void | Promise<void>
}

export interface Plugin {
  /** The plugin's package name (`definePlugin` sets it), logged on errors. */
  readonly name: string
  /**
   * Called at the start of every run. Register hooks via `ctx.on(name, fn)`
   * or `ctx.bus`; async setup may return a promise, but subscribe
   * synchronously so no event is missed. Optional: a capability-only plugin
   * is skipped here.
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

/** The name of the nearest named `package.json` above `dir` — the one that owns it. */
function pluginPackageName(dir: string): string {
  const memo = packageNameByDir.get(dir)
  if (memo !== undefined) return memo
  // A package.json with no `name` below the package root is no package (tshy
  // writes `{ "type": "module" }` into `dist/esm/`): passed, as Vite's lookup
  // does; with no named one above, the nearest is refused.
  let nameless: string | undefined
  for (let d = dir; ;) {
    let text: string | undefined
    try {
      // A byte-order mark is stripped, as npm, Node and discovery strip it.
      text = readFileSync(path.join(d, 'package.json'), 'utf8').replace(/^\uFEFF/, '')
    } catch {
      /* not here; look one level up */
    }
    if (text !== undefined) {
      // A bare JSON.parse reached the user as a SyntaxError and a stack, naming
      // no file.
      let pkg: { name?: unknown } | null
      try {
        pkg = JSON.parse(text) as { name?: unknown } | null
      } catch (err) {
        throw new UserError(
          `definePlugin: failed to parse ${path.join(d, 'package.json')}: ${(err as Error).message}`,
        )
      }
      const name = pkg?.name
      if (name === undefined) nameless ??= path.join(d, 'package.json')
      else if (typeof name !== 'string' || name.length === 0) {
        throw new UserError(
          `definePlugin: ${path.join(d, 'package.json')} has no name — a plugin is a package, and its name is the package's`,
        )
      } else {
        packageNameByDir.set(dir, name)
        return name
      }
    }
    const parent = path.dirname(d)
    if (parent === d) {
      throw new UserError(
        nameless === undefined
          ? `definePlugin: no package.json above ${dir} — a plugin is a package, and its name is the package's`
          : `definePlugin: ${nameless} has no name — a plugin is a package, and its name is the package's`,
      )
    }
    d = parent
  }
}

/**
 * The one way to make a plugin: `definePlugin(import.meta, { ...hooks })`.
 * The name comes from the nearest named `package.json` above the calling
 * module and is stamped where the loader checks, so a plugin is named by its
 * package alone.
 */
export function definePlugin(origin: PluginOrigin, hooks: PluginHooks): VxPlugin {
  // The hooks are copied by spread, which takes own fields only: a class
  // instance's methods stayed on its prototype and the plugin loaded
  // without them, saying nothing.
  const proto: unknown =
    hooks !== null && typeof hooks === 'object' ? Object.getPrototypeOf(hooks) : undefined
  if (proto !== Object.prototype && proto !== null) {
    const got =
      hooks === null || typeof hooks !== 'object'
        ? String(hooks)
        : `a ${(hooks as object).constructor?.name || 'class instance'}`
    throw new UserError(
      `definePlugin: the hooks must be a plain object ({ setup() { … } }), got ${got}`,
    )
  }
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
        : [V] extends [readonly unknown[]]
          ? 'array'
          : [V] extends [object]
            ? 'object'
            : 'any'

/**
 * Every option a factory takes with its kind (`'any'` for a union). Derived
 * from the options interface, so the checker refuses a missing, extra or
 * mistyped option.
 */
export type PluginOptionKinds<T> = {
  readonly [K in keyof Required<T>]-?: OptionKind<Required<T>[K]>
}

/**
 * Refuse an option a factory does not take, or a wrong kind, as core refuses
 * an unknown config field: Bun strips types, so a misspelt option (`reapi({
 * endpont })`) quietly declined, and an env string where a number belongs was
 * misread. `factory` names the call (`reapi()`).
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
    // Own keys only: the record's prototype answers `constructor`.
    const kind = Object.hasOwn(known, key) ? known[key] : undefined
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
        : kind === 'array'
          ? Array.isArray(value)
          : typeof value === kind
    if (!ok) {
      const got =
        typeof value === 'function' ? 'a function' : (JSON.stringify(value) ?? String(value))
      throw new UserError(
        `${factory} option "${key}" must be ${kind === 'object' || kind === 'array' ? 'an' : 'a'} ${kind}, got ${got}`,
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
   * Where plugin-throw warnings go. Defaults to `ui.say` on stderr; passing
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
  /** The run's held signals: a stop ends a setup's wait, which then throws. */
  signal?: AbortSignal | undefined
  /** Where `ctx.measure` keeps the run's last measure of each id; default: kept nowhere. */
  measured?: Map<string, Measure>
}

/**
 * `ctx.measure`'s measure, copied: refused when its id is not under the
 * plugin's name, it has no definition, or a number is not finite and
 * non-negative, since history keeps the row for good.
 */
function measureOf(plugin: string, m: Measure): Measure {
  const bad = (what: string): never => {
    throw new Error(`ctx.measure: ${what}`)
  }
  if (typeof m !== 'object' || m === null)
    bad(`got ${m === null ? 'null' : typeof m}, not a measure`)
  const { id, def, durationMs, cores } = m
  if (typeof id !== 'string' || !id.startsWith(`${plugin}#`) || id.length === plugin.length + 1)
    bad(`id ${JSON.stringify(id)} is not '${plugin}#<name>'`)
  if (typeof def !== 'string' || def === '') bad(`${id} has no definition hash`)
  if (typeof durationMs !== 'number' || !isMeasure(durationMs))
    bad(`${id}'s durationMs ${String(durationMs)} is not a finite number ≥ 0`)
  if (cores !== undefined && (typeof cores !== 'number' || !isMeasure(cores)))
    bad(`${id}'s cores ${String(cores)} is not a finite number ≥ 0`)
  return Object.freeze(
    cores === undefined ? { id, def, durationMs } : { id, def, durationMs, cores },
  )
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
    code = 'VX_E_REFUSED',
  ) {
    super(message, code)
  }
}

/**
 * Install every plugin's `setup` on a shared bus and context, awaited in
 * order so a plugin is subscribed before the next one's setup. A throwing
 * setup fails the run. Capability-only plugins are skipped; plugin-host.ts
 * consults them.
 */
export async function installPlugins(args: InstallPluginsArgs): Promise<() => void> {
  const { plugins, bus, workspaceRoot, cacheDir } = args
  const warn = args.warn ?? ((m) => ui.say('warn', m))
  const secrets = args.secrets ?? new SecretBroker(args.ci ?? false, warn)
  const disposers: Array<() => void> = []
  // By object, not name: one package can export two plugins.
  const disabled = new Set<Plugin>()
  // Made at the first event a plugin hears: a run no handler hears pays nothing.
  let readOnly: (<T>(value: T) => T) | undefined
  const viewOf = <T>(value: T): T => (readOnly ??= readOnlyEvents())(value)

  for (const plugin of plugins) {
    if (typeof plugin.name !== 'string' || plugin.name.length === 0) {
      throw new UserError('plugin missing `name` field')
    }
    // No setup: a capability-only plugin, skipped. A setup that is not
    // callable is an authoring error.
    if (plugin.setup === undefined) continue
    if (typeof plugin.setup !== 'function') {
      throw new UserError(`plugin '${plugin.name}' setup is not a function`)
    }

    const fail = (where: string, err: unknown): void => {
      if (disabled.has(plugin)) return
      disabled.add(plugin)
      warn(
        `[vx] plugin '${plugin.name}' threw in ${where}; disabled for this run: ${thrownMessage(err)}`,
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
      // A subscription made past the hooks leaves with the run like a hook's
      // does: the bus can outlive the run (`RunOptions.bus`), and one left
      // behind hears every later run on it.
      bus: {
        emit: (event) => bus.emit(event),
        subscribe(subscriber) {
          if (typeof subscriber !== 'function') {
            throw new Error(
              `ctx.bus.subscribe: the subscriber is ${subscriber === null ? 'null' : typeof subscriber}, not a function`,
            )
          }
          // Isolated like an `on` handler: the bus itself swallows a throw.
          const dispose = bus.subscribe((event) => {
            if (disabled.has(plugin)) return
            let ret: unknown
            try {
              ret = subscriber(viewOf(event))
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
      measure(measure) {
        const m = measureOf(plugin.name, measure)
        args.measured?.set(m.id, m)
        bus.emit({ kind: 'task:measure', measure: m })
      },
      on(hook, handler) {
        // A misspelt name ('taskComplete') subscribed a handler that never ran,
        // and no word of it; a config file has no type-checker.
        if (!Object.hasOwn(HOOK_EVENTS, hook)) {
          throw new Error(
            `ctx.on: unknown hook '${String(hook)}' (one of ${Object.keys(HOOK_EVENTS).join(', ')})`,
          )
        }
        // Taken, it threw at the first event and switched the whole plugin off.
        if (typeof handler !== 'function') {
          throw new Error(
            `ctx.on: the handler for '${hook}' is ${handler === null ? 'null' : typeof handler}, not a function`,
          )
        }
        const onFail = (err: unknown): void => fail(hook, err)
        const kind = HOOK_EVENTS[hook]
        const dispose = bus.subscribe((live) => {
          if (live.kind !== kind || disabled.has(plugin)) return
          // Not awaited: the bus is synchronous and plugin work stays off the
          // critical path. A rejection is caught like a throw. Each part's
          // view is handed, not the event's: one proxy fewer per task.
          let ret: unknown
          try {
            switch (live.kind) {
              case 'run:start':
                ret = (handler as PluginHookHandlers['onRunStart'])(viewOf(live.info))
                break
              case 'task:start':
                ret = (handler as PluginHookHandlers['onTaskStart'])(viewOf(live.node))
                break
              case 'task:stdout':
                ret = (handler as PluginHookHandlers['onTaskStdout'])(viewOf(live.node), live.chunk)
                break
              case 'task:stderr':
                ret = (handler as PluginHookHandlers['onTaskStderr'])(viewOf(live.node), live.chunk)
                break
              case 'task:complete':
                ret = (handler as PluginHookHandlers['onTaskComplete'])(
                  viewOf(live.node),
                  viewOf(live.outcome),
                )
                break
              case 'task:measure':
                ret = (handler as PluginHookHandlers['onMeasure'])(live.measure)
                break
              case 'run:status':
                ret = (handler as PluginHookHandlers['onRunStatus'])(live.line)
                break
              case 'run:end':
                ret = (handler as PluginHookHandlers['onRunEnd'])()
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
      const setup = async (): Promise<void> => {
        const settled = hookStarted(plugin.name, 'setup')
        try {
          await plugin.setup?.(ctx)
        } finally {
          settled()
        }
      }
      await unlessStopped(
        args.step === undefined ? setup() : args.step(`${plugin.name}:setup`, setup),
        args.signal,
      )
    } catch (err) {
      // Earlier plugins' subscriptions too: the caller never gets the
      // disposer, and a bus that outlives the run would keep them.
      for (const d of disposers) d()
      // A stop is no refusal of this plugin's: its setup may hold what
      // its teardown releases, so it is torn down with every other.
      if (args.signal?.aborted === true) throw err
      throw new PluginSetupError(
        plugin,
        // Masked at the source, as plugin-host.ts's `safe()` does.
        maskedLine(`plugin '${plugin.name}' failed in setup: ${thrownMessage(err)}`),
        // The plugin's own code survives, as `safe()` keeps it.
        errorCode(err) === 'VX_E_INTERNAL' ? 'VX_E_REFUSED' : errorCode(err),
      )
    }
  }

  return () => {
    for (const d of disposers) d()
  }
}
