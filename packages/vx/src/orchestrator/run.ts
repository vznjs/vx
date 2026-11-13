// End-to-end wiring: discover, load configs, build the graph, run with caching.
// Each step is a sibling file.

import type { InputStability, TaskConfig } from '../config.js'
import {
  type ProjectEntry,
  EMPTY_LOCK,
  findProjectConfigs,
  inputStabilityEnv,
  LOCK_INVALID,
  lockEntryBroken,
  lockKey,
  readLockfile,
} from '../workspace/index.js'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import {
  historyFiles,
  indexDb,
  Cache,
  type CachePolicy,
  cachesNothing,
  formatCachePolicy,
  holdCacheDir,
  networkConcurrency,
  stopRuntimeProbes,
  sweepStaging,
} from '../cache/index.js'
import {
  HistoryStream,
  runHistory,
  keepRunNotes,
  createMissExplainer,
  detectFlaky,
  type FlakyCandidate,
  knownFlaky,
  LocalHistoryProvider,
} from '../history/index.js'
import { VERSION } from '../version.js'
import {
  hostPlatform,
  signalExitCode,
  VX_RUN_TASK_ENV,
  VX_RUN_WORKSPACE_ENV,
  type MachineReport,
  type TaskExecutor,
  type WorkerAdvice,
} from '../exec/index.js'
import { resetSandbox } from '../sandbox/index.js'
import { DeferredOutputs } from './deferred-outputs.js'
import { workspaceCleanOf } from './task-hash.js'
import { resolveDownloadModes } from './download-policy.js'
import { trailable, TrailingOutputs } from './trailing-outputs.js'
import {
  deadServerBehind,
  declaredTask,
  isCacheHit,
  isGroupTask,
  markSurfacedDeps,
  runGraph,
  taskDefinitions,
  type AbortedOutcome,
  type SucceededOutcome,
  type TaskNode,
  type TaskOutcome,
  isDefaultBuild,
  isPassStatus,
} from '../graph/index.js'
import { graphCounts } from './graph-memo.js'
import {
  mark,
  stageTimes,
  MAX_TIMEOUT_MS,
  timingLines,
  ulid,
  isLiteralPattern,
  listed,
  nearest,
  UserError,
  machineParallelism,
  secretMask,
  isFsRefusal,
  isUserError,
  SecretBroker,
  thrownMessage,
  relPosix,
  owedIfStranded,
} from '../util/index.js'
import * as ui from '../ui/index.js'

/** The stage table `VX_DEBUG_TIMING=1` asks for, on stderr. */
function printTimings(): void {
  const lines = timingLines()
  if (lines !== undefined) ui.print('err', ui.trace(lines))
}
import { detectColors, type ColorSupport } from '../ui/index.js'
import { keyedProjects, nestedDirsOf, readableDeps } from './keyed-projects.js'
import { commandWriteReach, prepareSandbox } from '../sandbox/index.js'
import {
  recordOutputDirSnapshots,
  type OutputDirSnapshot,
  type SaveFacts,
  withSaveFacts,
} from './miss-save.js'
import { admitTasks, taintTracker } from './admission.js'
import {
  settleProbedHit,
  unkeyedGroupOutcome,
  type ExecuteArgs,
  type RunContext,
} from './execute-task.js'
import { executeArgsOf } from './execute-args.js'
import { excludedTaint } from './excluded-keys.js'
import { dependedOn, keyUpstream } from './upstream.js'
import { createLiveUsage } from './live-usage.js'
import {
  busLogger,
  createEventBus,
  createForecast,
  defaultLogger,
  type DefaultLogger,
  type EventBus,
  formatOutcomeTable,
  formatPersistentList,
  formatRunSummary,
  type Logger,
  type Measure,
  neverStarted,
  plainOutput,
  resolveOutputView,
  type RunEvent,
  terminalSubscriber,
  warnOf,
} from '../report/index.js'
import { installPlugins, PluginSetupError, type RunReport } from './plugin.js'
import { keepsFailures, reportOf, RunKeeper } from './run-report.js'
import { freezeDeep } from './read-only.js'
import {
  buildAdmission,
  executorDemand,
  executorFailedOn,
  executorLabel,
  resolveExecutors,
  teardownPlugins,
} from './plugin-host.js'
import { createSteps } from './steps.js'
import { liveSocketOf, serveLive } from './run-live.js'
import { subscribeTelemetry, type TelemetryHandle } from './telemetry-host.js'
import { claimOutput, guardedOutput } from './output-host.js'
import { assembleRunSummary, type RunContextRecord } from './telemetry.js'
import { plan, type RunPlan } from './plan.js'
import type { AffectedReason } from './affected-tasks.js'
import {
  namesRemote,
  openRemotes,
  outputWallsOf,
  prepareRunLocked,
  type PreparedRun,
} from './prepare.js'
import { acquireRunLock, runLockPath, type RunLockRelease } from './run-lock.js'
import {
  exitOfSignal,
  type HeldSignals,
  holdSignals,
  terminateChildren,
  unlessStopped,
} from './signals.js'
import { CYCLE_INTERRUPT, runStop } from './run-stop.js'
import {
  hasPooledExecutor,
  placeTasks,
  planExecutorOf,
  platformVerdict,
  poolOfPlacement,
  terminalHolders,
  locallyPlaced,
} from './placement.js'
import {
  telemetryRunContext,
  captureGitContext,
  captureHostContext,
  detectCi,
} from './run-context.js'
import { startRemotePrefetch } from './remote-prefetch.js'
import {
  restoreTierExclusions,
  startLocalShortCircuit,
  type ShortCircuit,
} from './local-shortcircuit.js'
import { deriveStableKeys, probesAfterWrites } from './stable-keys.js'
import { askRemote, serversToHold } from './held-servers.js'

import { writeRunFailures } from './run-failures.js'
import {
  assembleRunRecords,
  foldOutcomes,
  recordLateRemoteErrors,
  type RecordedOutcome,
  runRecordOf,
} from './run-records.js'
import {
  hasEnded,
  disposeServers,
  failServer,
  holdServers,
  keyedServers,
  onServerExit,
  sessionEnd,
  serverUsers,
  stopServer,
  takeExitNotes,
  takeHeldServers,
  unneededServers,
} from './persistent.js'
import { serverKey } from './persistent-task.js'
import { writeRunProfile } from './run-artifacts.js'
import { createSaveLane } from './save-lane.js'
import { commandWindows } from './command-windows.js'
import type { CoreRunOptions, HeldPersistent, RunOptions, RunSummary } from './options.js'
import { withRunSettings } from './run-settings.js'
import { cacheFacts, taskArtifacts } from './task-artifacts.js'
import { resolveSetting } from '../settings.js'

// Per run, never shared: a `vx watch` process runs many, and a shared map
// is one `preProbed.set` away from leaking a hit across cycles.
const emptyShortCircuit = (): ShortCircuit => ({
  preProbed: new Map(),
  restoreTier: new Set(),
  uncachedKeys: new Map(),
  groupKeys: new Map(),
  remoteAsk: new Map(),
})

/**
 * The policy that governs the run: the remote axes are inert without a remote
 * layer. Normalised here, the one place `run()` and `planRun()` read it, so
 * `--dry` describes the run you get (a raw `local:,remote:rw` was labelled
 * "would exec" in a run with caching off).
 */
function effectiveCachePolicy(requested: CachePolicy, hasRemoteLayer: boolean): CachePolicy {
  return hasRemoteLayer ? requested : { ...requested, remoteRead: false, remoteWrite: false }
}

/**
 * Gates for the local short-circuit, correctness only: the policy reads
 * locally, and there is a task. A remote does not close it: the local store
 * sits in front, so a local hit still runs ahead of its deps while remote GETs
 * prefetch in the background (else a local hit waited 18 s on a dep it never
 * read). A flat graph gains too: one batched `getMany` beats a `cache.get` per
 * task (1,000 tasks: 249 to 237 ms).
 */
export function shouldShortCircuit(nodes: Map<string, TaskNode>, policy: CachePolicy): boolean {
  if (!policy.localRead) return false
  return nodes.size > 0
}

/**
 * The run's secrets: vx's environment plus every selected task's `define` and
 * `exec.env.secret`. With the environment's alone, a secret only a config named
 * reached the stored line `vx last` prints.
 */
function invocationMask(nodes: Iterable<TaskNode>): (command: string) => string {
  const sources: Array<Readonly<Record<string, string>>> = [process.env as Record<string, string>]
  const named = new Set<string>()
  for (const n of nodes) {
    const env = n.config.exec?.env
    if (env?.define !== undefined) sources.push(env.define)
    for (const name of env?.secret ?? []) named.add(name)
  }
  const mask = secretMask(sources, [...named])
  return (command) => mask?.mask(command) ?? command
}

/**
 * The command line handed to telemetry sinks, with what follows `--` counted,
 * not quoted: those are the task's arguments, often a token. Local history
 * keeps the whole line.
 */
export function invocationCommand(line: readonly string[] | string): string {
  // A line is shell-quoted (the CLI's): its words as written, so `'a b'`
  // counts one argument, not the two a split at blanks made.
  const argv =
    typeof line === 'string'
      ? (line.match(/(?:[^\s'"\\]|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+/g) ?? [])
      : line
  const sep = argv.indexOf('--')
  if (sep === -1) return argv.join(' ')
  const rest = argv.length - sep - 1
  return [...argv.slice(0, sep), '--', `<${rest} argument${rest === 1 ? '' : 's'}>`].join(' ')
}

/**
 * The bounds the CLI and workspace config already hold, enforced at the façade:
 * a `concurrency` of 0 or NaN left no slot and the run waited forever; a NaN
 * `retries` retried without end; a `timeout` of 0, NaN or out of range killed
 * every task. A misspelled `continueMode` silently lost fail-fast; wrong-typed
 * `excludeDependencies`, `projects` or `signal` failed inside the run.
 */
function refuseRunOptions(options: CoreRunOptions): void {
  const refuse = (name: string, value: unknown, rule: string): never => {
    const shown =
      typeof value === 'string'
        ? JSON.stringify(value)
        : typeof value === 'number'
          ? String(value)
          : value === null
            ? 'null'
            : Array.isArray(value)
              ? 'an array'
              : typeof value === 'object'
                ? 'an object'
                : `a ${typeof value}`
    throw new UserError(`RunOptions.${name} is ${shown}: it must be ${rule}`)
  }
  const names = (v: unknown): boolean => Array.isArray(v) && v.every((s) => typeof s === 'string')
  if (!names(options.tasks)) refuse('tasks', options.tasks, 'an array of task names')
  // No task named read "No projects declare task(s):.".
  if (options.tasks.length === 0 || options.tasks.includes(''))
    throw new UserError(`RunOptions.tasks names no task: give at least one task name`)
  if (options.projects !== undefined && !names(options.projects))
    refuse('projects', options.projects, 'an array of project names')
  if (options.forwardArgs !== undefined && !names(options.forwardArgs))
    refuse('forwardArgs', options.forwardArgs, 'an array of strings')
  const oneOf = (name: string, value: unknown, words: readonly string[]): void => {
    if (value !== undefined && !words.includes(value as string))
      refuse(name, value, `one of ${words.map((w) => `'${w}'`).join(', ')}`)
  }
  oneOf('continueMode', options.continueMode, ['never', 'deps-ok', 'always'])
  oneOf('outputLogs', options.outputLogs, ['full', 'errors-only', 'none', 'hash-only'])
  oneOf('download', options.download, ['all', 'toplevel', 'none'])
  oneOf('flow', options.flow, ['focused', 'broad'])
  oneOf('schedule', options.schedule, [
    'most-work',
    'critical-path',
    'direct-dependents',
    'ready-order',
  ])
  const exclude = options.excludeDependencies
  if (exclude !== undefined && exclude !== 'all' && !names(exclude))
    refuse('excludeDependencies', exclude, "'all' or an array of task names")
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    refuse('signal', options.signal, 'an AbortSignal')
  const { concurrency, retries, timeout } = options
  if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency > 0))
    refuse('concurrency', concurrency, 'a positive integer')
  for (const field of ['downloadConcurrency', 'uploadConcurrency', 'restoreConcurrency'] as const) {
    const v = options[field]
    if (v !== undefined && !(Number.isInteger(v) && v > 0)) refuse(field, v, 'a positive integer')
  }
  if (retries !== undefined && !(Number.isInteger(retries) && retries >= 0))
    refuse('retries', retries, 'a non-negative integer')
  if (
    timeout !== undefined &&
    !(Number.isInteger(timeout) && timeout > 0 && timeout <= MAX_TIMEOUT_MS)
  )
    refuse('timeout', timeout, `a positive integer of ms, at most ${MAX_TIMEOUT_MS}`)
}

export async function run(options: RunOptions): Promise<RunSummary> {
  return runCore(options)
}

/** `run` as vx's CLI calls it, with its hand-off. */
export async function runCore(options: CoreRunOptions): Promise<RunSummary> {
  refuseRunOptions(options)
  // A custom logger formats its own output and asserts on plain strings, so
  // only the default logger gets colour, gated by NO_COLOR / FORCE_COLOR /
  // isTTY.
  const colors = options.log ? { enabled: false } : detectColors()
  // The renderer subscribes to the run event bus like any surface: every
  // `log.X(...)` emits a RunEvent through `busLogger`. The fan-out is
  // synchronous and order-preserving, so terminal output is unchanged. See
  // docs/design/event-stream-2026-06.md.
  const terminal =
    options.log === undefined
      ? defaultLogger(colors, resolveOutputView(options), process.stdout, {
          coalesce: true,
          ...(options.tty === true ? { tty: true } : {}),
          ...(options.forwardArgs !== undefined ? { forwardArgs: options.forwardArgs } : {}),
          ...(options.footer === false ? { footer: false } : {}),
        })
      : null
  const sink = options.log ?? terminal!
  // An injected bus outlives the run: the terminal renderer is added for this
  // run and taken off on every way out, or it reported the next run twice.
  const bus = options.bus ?? createEventBus()
  // Tasks run with colour forced (exec/env.ts); where the terminal prints
  // plain, their escapes are stripped. A custom logger gets the task's
  // bytes as written, as the cache holds them: it formats its own output.
  const render = terminalSubscriber(terminal === null || colors.enabled ? sink : plainOutput(sink))
  let unsubscribeTerminal = bus.subscribe(render)
  // What the run warned of, no task's: the footer repeats it (`warn`).
  const warned: string[] = []
  const unsubscribeWarned = bus.subscribe((e) => {
    if (e.kind === 'run:status' && 'warn' in e) warned.push(e.line)
  })
  const detach = (): void => {
    unsubscribeTerminal()
    unsubscribeWarned()
    // A run refused or thrown before its tasks never reached the end that takes
    // the live region down: a slow load left `vx:load running` on screen and
    // the refusal was written over it.
    terminal?.runDone?.()
    terminal?.settle()
  }
  // A plugin's `output` renders the run from its start; core's renderer
  // stays the fallback. Only core's own renderer is replaceable: an
  // embedder's `log` is never consulted away.
  const takeOutput =
    terminal === null
      ? undefined
      : (claimed: { logger: Logger; owner: string }): void => {
          terminal.settle()
          unsubscribeTerminal()
          unsubscribeTerminal = bus.subscribe(guardedOutput(claimed, render))
        }
  let held = false
  const signals: { held?: HeldSignals } = {}
  try {
    // vx's own steps are timed only where something renders them.
    const showsSteps =
      terminal !== null ? terminal.showsSteps : options.log?.stepStart !== undefined
    const summary = await runOnBus(
      options,
      bus,
      warned,
      colors,
      terminal,
      showsSteps,
      signals,
      takeOutput,
    )
    if (summary.persistent === undefined) return summary
    // Servers handed back still running still write: the renderer stays until
    // the caller stops them, or `vx watch dev` printed none of its server's
    // log.
    held = true
    return { ...summary, persistent: detachOnStop(summary.persistent, detach) }
  } finally {
    if (!held) detach()
    // A signal heard before the run's stop took over: the run left before
    // its tasks (a refusal, a setup that threw), its plugins torn down and
    // its lock released, and vx leaves as that signal says.
    const heard = signals.held?.takeOver()
    if (heard !== undefined) await exitOfSignal(heard)
  }
}

/**
 * The hand-back whose stop also takes the renderer off the bus. Once stopped it
 * lets go of the run, or `vx watch dev` held every cycle's run through its
 * closures.
 */
function detachOnStop(held: HeldPersistent, detach: () => void): HeldPersistent {
  let live: { stop: HeldPersistent['stop']; detach: () => void } | undefined = {
    stop: held.stop,
    detach,
  }
  return {
    ids: held.ids,
    servers: held.servers,
    stop: (signal) => {
      const run = live
      if (run === undefined) return Promise.resolve()
      live = undefined
      return run.stop(signal).finally(run.detach)
    },
  }
}

async function runOnBus(
  options: CoreRunOptions,
  bus: EventBus,
  warned: readonly string[],
  colors: ColorSupport,
  terminal: DefaultLogger | null,
  showsSteps: boolean,
  signals: { held?: HeldSignals },
  takeOutput?: (claimed: { logger: Logger; owner: string }) => void,
): Promise<RunSummary> {
  const log = busLogger(bus)
  const steps = createSteps(log, showsSteps)
  const { step, stepSync } = steps
  // A server's output goes through a cell of its own: a later watch cycle
  // that keeps the server points it at that cycle's bus (`RunHandoff.keep`).
  const serverOuts = new Map<string, { bus: EventBus }>()
  // What a server writes between ready and its logged outcome: renderers keep
  // pre-outcome output for a frame a ready server never prints, so its first
  // lines were lost.
  const sinceReady = new Map<string, RunEvent[]>()
  const serverLog = (id: string): Logger => {
    const out = { bus }
    serverOuts.set(id, out)
    const emit = (event: RunEvent): void => {
      const held = sinceReady.get(id)
      if (held === undefined) out.bus.emit(event)
      else held.push(event)
    }
    return {
      ...log,
      taskStdout: (node, chunk) => emit({ kind: 'task:stdout', node, chunk }),
      taskStderr: (node, chunk) => emit({ kind: 'task:stderr', node, chunk }),
    }
  }
  const releaseSinceReady = (id: string): void => {
    const held = sinceReady.get(id)
    if (held === undefined) return
    sinceReady.delete(id)
    const out = serverOuts.get(id) ?? { bus }
    for (const event of held) out.bus.emit(event)
  }

  // Taken before the cache opens: a run holding the store while waiting here,
  // and a `vx cache clean` holding this lock while waiting for open stores,
  // deadlocked; a clear also deleted the store under a run opening it.
  let heldLock: RunLockRelease | undefined
  const takeRunLock = async (root: string, sharedCacheDir: string | undefined): Promise<void> => {
    // A nested run is refused below with its own reason, holding nothing.
    const outer = process.env[VX_RUN_WORKSPACE_ENV] || undefined
    if (outer !== undefined && canonical(outer) === canonical(root)) return
    // Heard from here, not only from the stop below: a signal between the
    // lock and that stop killed vx with the lock held (`holdSignals`).
    if (options.handleSignals ?? true) signals.held = holdSignals()
    const held = signals.held?.signal
    const signal =
      held !== undefined && options.signal !== undefined
        ? AbortSignal.any([options.signal, held])
        : (held ?? options.signal)
    // Waiting is taking turns, a status line; only a lock vx could not take warns.
    const wait = (line: string): void => log.status(line)
    const lock = await step('vx:run-lock', () =>
      acquireRunLock(root, { log: warnOf(log), wait, signal }),
    )
    heldLock = lock
    // Another workspace's clean of a shared cache directory takes no lock of
    // this one's: it waits for this hold, and this for it. Released with the
    // run lock.
    if (sharedCacheDir !== undefined) {
      const dir = await holdCacheDir(sharedCacheDir, 'shared', wait, signal, root)
      heldLock = Object.assign(
        async (): Promise<void> => {
          dir()
          await lock()
        },
        { path: lock.path },
      )
    }
    // A wait the signal ended holds no lock: opening the store now could
    // meet a `vx cache clean` deleting it. run() exits of the signal.
    if (held?.aborted === true) throw new Error(`stopped by ${String(held.reason)}`)
  }
  let prepared: PreparedRun
  try {
    prepared = await step('vx:load', () => prepareRunLocked(options, log, takeRunLock, true))
  } catch (err) {
    await heldLock?.()
    throw err
  }
  const releaseRunLock: RunLockRelease =
    heldLock ?? Object.assign(async () => {}, { path: runLockPath(prepared.workspaceRoot) })
  // The cache and the lock go together on every exit before the run's own.
  const closeUnrun = async (): Promise<void> => {
    prepared.cache.close()
    await releaseRunLock()
  }
  mark('plugin stages')
  // Every exit from here tears the plugins down: their capability factories ran
  // in prepareRun, and teardown releases what they opened. A plugin whose own
  // setup threw set up nothing and is left out.
  let tornDown = false
  // A hook that never settles strands the run with no exit of its own:
  // bin.ts tears the plugins down before the process ends.
  let unowe = (): void => {}
  const teardown = async (except?: unknown, report?: RunReport): Promise<void> => {
    if (tornDown) return
    tornDown = true
    unowe()
    const plugins = prepared.plugins.filter((p) => p !== except)
    await teardownPlugins(plugins, warnOf(log), report, step)
  }
  unowe = owedIfStranded(() => teardown())
  // Setting variables are read before any task, so a bad value is refused here,
  // not mid-run, and never throws past the teardown and cache close.
  let inputStability: { run: InputStability; workspace?: InputStability }
  let cleanOutputs: boolean | undefined
  try {
    options = withRunSettings(options, prepared.workspaceConfig)
    inputStability = {
      run: inputStabilityEnv(),
      ...(prepared.workspaceConfig?.inputs?.stability !== undefined
        ? { workspace: prepared.workspaceConfig.inputs.stability }
        : {}),
    }
    // Resolved once, beside the keys that fold it (prepare.ts).
    cleanOutputs = workspaceCleanOf(prepared.hashCache)
  } catch (err) {
    await teardown()
    await closeUnrun()
    throw err
  }
  // A task whose command re-enters `vx run` in this workspace is refused:
  // reaching the same task again forks runs until the machine gives out, and
  // otherwise (`ci` shelling out to `vx run lint`) the nested run escapes the
  // schedule, the concurrency budget and the task's key. The markers `taskEnv`
  // sets on every child name the task. Roots compare canonical (symlinked cwd,
  // macOS /var/folders); empty is unset.
  const outerRoot = process.env[VX_RUN_WORKSPACE_ENV] || undefined
  if (outerRoot !== undefined && canonical(outerRoot) === canonical(prepared.workspaceRoot)) {
    await teardown()
    await closeUnrun()
    throw new UserError(
      `task ${process.env[VX_RUN_TASK_ENV] ?? '<unknown>'} runs \`vx run\` inside its own workspace: a nested run is invisible to the outer graph (its tasks escape the schedule, the concurrency budget and the cache key) and a loop back to this task forks without bound. Declare what it needs with dependsOn instead.`,
    )
  }
  // A requested name that matched no project fails the whole run, even when
  // others resolved: a CI job that renames a task must go red, not silently
  // stop running it. The caller prints the refusal on stderr; as a status line
  // it reached stdout and whatever a script piped there.
  if (prepared.unresolvedTasks.length > 0) {
    const refused = `no projects declare task(s): ${prepared.unresolvedTasks.join(', ')}.${await unresolvedHint(prepared, options.projects)}`
    await teardown()
    await closeUnrun()
    return { ok: false, outcomes: [], refused }
  }
  if (prepared.empty === 'none-affected') {
    log.status(noneAffected(prepared, options))
    await teardown()
    await closeUnrun()
    return { ok: true, outcomes: [] }
  }
  if (prepared.empty !== null) {
    // `no-tasks-declared` is almost always a CI typo: a clear message and exit
    // 1. `empty-graph` is defensive, unreachable today.
    const refused =
      prepared.empty === 'no-tasks-declared'
        ? `no projects declare task(s): ${options.tasks.join(', ')}.${elsewhereHint(prepared.declaredElsewhere, true, options.projects, prepared.projects)}${await initHint(prepared)}`
        : 'no tasks to run.'
    await teardown()
    await closeUnrun()
    return { ok: false, outcomes: [], refused }
  }
  // Plugins subscribe before the run emits. A throwing `setup` fails fast with
  // a UserError naming the plugin.
  let disposePlugins: (() => void) | undefined
  let telemetry: TelemetryHandle | undefined
  // One run id per invocation, on every task, so analytics can group by run.
  const runId = ulid()
  prepared.localCache.runId = runId
  // A killed run's restore staging (`.vx/tmp/<pid>-0`), once per run.
  sweepStaging(prepared.workspaceRoot)
  const head = captureGitContext(prepared.workspaceRoot)
  const ciContext = detectCi(process.env)
  const keepRun =
    prepared.keepRunEntry === undefined
      ? undefined
      : {
          failures: keepsFailures(
            resolveSetting('cache.upload.failures', prepared.workspaceConfig).value,
            ciContext.ci,
          ),
        }
  const keeper =
    prepared.keepRunEntry === undefined || keepRun === undefined
      ? undefined
      : new RunKeeper({
          runId,
          workspaceRoot: prepared.workspaceRoot,
          nestedDirsByProject: outputWallsOf(prepared.nestedDirsByProject),
          keep: prepared.keepRunEntry,
          failures: keepRun.failures,
          traffic: prepared.localCache.traffic,
        })
  // Before setup and the status line: a remote's `open` may ask on the terminal.
  const secrets = new SecretBroker(
    ciContext.ci,
    warnOf(log),
    undefined,
    undefined,
    terminal === null ? undefined : () => terminal.holdStatus(),
  )
  const remotesClosed = await openRemotes(prepared.remotes, ciContext.ci, secrets)
  // Each plugin measure's last (`ctx.measure`), kept with the run's history.
  const measured = new Map<string, Measure>()
  signals.held?.arm()
  try {
    disposePlugins = await installPlugins({
      plugins: prepared.plugins,
      bus,
      workspaceRoot: prepared.workspaceRoot,
      cacheDir: prepared.cacheDir,
      warn: warnOf(log),
      cache: prepared.cacheFor,
      ci: ciContext.ci,
      branch: prepared.branch(),
      secrets,
      step,
      signal: signals.held?.signal,
      measured,
    })
  } catch (err) {
    disposePlugins?.()
    await teardown(err instanceof PluginSetupError ? err.plugin : undefined)
    await closeUnrun()
    throw err
  }
  // Until the run's own try below, a throw leaves through here.
  const abandoning = async <T>(step: () => T | Promise<T>): Promise<T> => {
    try {
      return await step()
    } catch (err) {
      disposePlugins?.()
      await teardown()
      await closeUnrun()
      throw err
    }
  }
  const {
    workspaceRoot,
    cacheDir,
    cache,
    nodes,
    fingerprintWatch,
    nestedDirsByProject,
    gitFilesCache,
    hashCache,
    workspaceProjectCount,
  } = prepared
  const maskInvocation = invocationMask(nodes.values())
  const concurrency = options.concurrency ?? machineParallelism()
  // An earlier cycle's servers: those this graph starts again unchanged stay
  // up; the rest go now, before anything binds their ports. A stop meanwhile
  // ends the run here, having run nothing.
  const heldBefore = takeHeldServers(options.handoff?.keep?.servers, nodes, options.forwardArgs)
  const keyedHeld: ReadonlySet<string> =
    options.handoff?.holdPersistent === true ? keyedServers(nodes) : new Set()
  for (const server of heldBefore.kept.values()) server.out.bus = bus
  if (heldBefore.stale.length > 0) {
    await terminateChildren(() => heldBefore.stale)
    if (options.signal?.aborted === true) {
      disposePlugins?.()
      await teardown()
      await closeUnrun()
      return { ok: true, outcomes: [] }
    }
  }

  // Resolved once per run, in declaration order, the local executor last. A
  // broken factory aborts before any task; a held signal ends the wait on one
  // that never settles.
  const executors: readonly TaskExecutor[] = await abandoning(() =>
    unlessStopped(
      resolveExecutors(prepared.plugins, {
        workspaceRoot: prepared.workspaceRoot,
        cacheDir: prepared.cacheDir,
        warn: warnOf(log),
        concurrency,
        artifacts: taskArtifacts(prepared.cache, prepared.workspaceRoot),
        cacheFacts: () => cacheFacts(prepared.remotes, prepared.cacheRefs),
      }),
      signals.held?.signal,
    ),
  )
  // Placement, decided once per task before scheduling, so a remote-pooled task
  // is admitted against its pool, not a local slot. Groups and persistent tasks
  // stay off the map.
  const placements = await abandoning(() => placeTasks(nodes, executors))
  const holders = await abandoning(() => terminalHolders(nodes, options.tty === true))
  // A `remote: 'only'` task nobody takes succeeds without running (with no
  // remote pool the ambient state is its result), but not silently: a no-op
  // success looks like one that worked, and the usual cause (no `cache: true`,
  // so no executor can describe its inputs) is invisible in the outcome.
  if (placements.remoteOnlyNoop.size > 0) {
    const anyRemote = executors.some((e) => e.capabilities?.remote === true)
    for (const id of placements.remoteOnlyNoop) {
      const why = !anyRemote
        ? 'no remote executor is declared'
        : nodes.get(id)?.config.cache !== true
          ? 'no remote executor accepted it — the task has no `cache: true`, so there is no input set to ship'
          : 'no remote executor accepted it'
      warnOf(log)(`[vx] ${id}: exec.remote is 'only' and ${why} — nothing ran`)
    }
  }
  const platforms = platformVerdict(placements, ciContext.ci)
  if (platforms !== undefined && 'refuse' in platforms) {
    await abandoning(() => {
      throw new UserError(platforms.refuse)
    })
  }
  if (platforms !== undefined && 'warn' in platforms) warnOf(log)(platforms.warn)
  /** A task its `exec.platforms` skip here: it never starts, and nor does what depends on it. */
  const platformSkip = (node: TaskNode): TaskOutcome | undefined => {
    const needs = placements.otherPlatform.get(node.id)
    return needs === undefined
      ? undefined
      : {
          node,
          status: 'skipped',
          durationMs: 0,
          otherPlatform: { needs, host: hostPlatform() },
          platform: true,
        }
  }
  // Demand: what each executor still has left to run (`executorDemand`),
  // told once the cache has said what it answers.
  const demand = executorDemand(placements.executors, warnOf(log))

  // `cache.download` (default `all`) decides ONCE per task, here, whether a
  // remote execution's outputs come home.
  const downloadPolicy = options.download ?? 'all'
  const localPlaced = locallyPlaced(placements)
  // `all` keeps every task eager: no per-task map to say so, as `--dry`'s.
  const download =
    downloadPolicy === 'all'
      ? undefined
      : resolveDownloadModes({
          nodes,
          policy: downloadPolicy,
          localPlaced,
          remoteOnly: placements.remoteOnly,
        })

  // `run.timeout` (ms), for any task WITHOUT its own `exec.timeout`.
  const taskTimeoutDefault = options.timeout

  const stop = runStop({
    log,
    cache,
    external: options.signal,
    handleSignals: options.handleSignals ?? true,
    handsTerminal: holders.size > 0,
    held: signals.held,
    teardowns: prepared.plugins.filter((p) => p.teardown).length,
    onStop: () => {
      log.runStop?.()
      stopRuntimeProbes(hashCache.runtime, hashCache.workspaceRuntime)
      cache.stopUploads?.()
      keeper?.stop()
    },
  })
  const { liveChildren, persistentRegistry } = stop
  // The cache handle closes on every exit: `close()` also flushes the run's
  // deferred `accessed_at` bumps, so a throw leaked the SQLite handle and lost
  // the touch record, and LRU `vx cache clean` could evict entries the run just
  // hit. Once only: the normal path closes before a persistent task's wait.
  let live: ReturnType<typeof serveLive> | undefined
  let unfold = (): void => {}
  let cacheClosed = false
  const closeCache = async (): Promise<void> => {
    if (cacheClosed) return
    cacheClosed = true
    await prepared.localCache.stopCheckpoints()
    cache.close()
    live?.unlisten()
    // Released with the handle, on every exit (see run-lock.ts). Awaited:
    // fire-and-forget lost the race with the CLI's exit and left a lock
    // directory per run in the temp dir.
    await releaseRunLock()
  }
  // Answers `vx last --live` while the lock is held (run-live.ts).
  live = serveLive({
    socketPath: liveSocketOf(releaseRunLock.path),
    bus,
    runId,
    command: maskInvocation(invocationCommand(options.command ?? process.argv.slice(1))),
    startedAt: Date.now(),
    nodes: () => nodes.values(),
    warnings: () => warned,
  })
  try {
    const runStartHrTimeNs = process.hrtime.bigint()
    const endedAtMsAtStart = Date.now()
    // Every remote turned off by its `open` is no remote: a task must not clean
    // its outputs for a save that goes nowhere.
    const remoteCacheEnabled = prepared.hasRemoteLayer && !remotesClosed
    // Normalised once, so every consumer reads the policy that governed the
    // run: the raw request made tasks clean outputs for a save that never
    // happened.
    const policy: CachePolicy = effectiveCachePolicy(prepared.cachePolicy, remoteCacheEnabled)
    warnNoRemote(prepared, options, log)
    const windows = options.handoff?.commandWindows ?? commandWindows()
    const trailing = new TrailingOutputs()
    const deferredOutputs = new DeferredOutputs({
      nodes,
      cache,
      workspaceRoot,
      nestedDirsByProject: outputWallsOf(nestedDirsByProject),
      ...(gitFilesCache !== undefined ? { gitFilesCache } : {}),
      localWrite: policy.localWrite,
      log,
      commandWindows: windows,
    })

    // Context for the `invocations` header row, captured once: one git spawn
    // for commit and branch, never failing the run; `dirty` reuses the
    // populate's `git status`. `run.branch` overrides git's.
    const gitContext = {
      ...head,
      dirty: gitFilesCache.worktreeDirty,
      branch: prepared.branch(),
    }
    const hostContext = captureHostContext()

    // The run-context record shaped as the telemetry contract, built only when
    // a plugin contributes `telemetry`, before run:start so a sink sees the
    // whole stream. No sink: no record, no subscriber, no summary.
    let runContextRecord: RunContextRecord | undefined
    // Gated on a plugin that can contribute a sink, not on any plugin: a
    // cache-only plugin has nothing to consult, and the record costs two git
    // spawns and a workspace-id write. A plugin with the hook that declines
    // still pays: only asking tells.
    const hasTelemetryPlugin = prepared.plugins.some((p) => p.telemetry !== undefined)
    if (hasTelemetryPlugin || options.telemetrySinks !== undefined) {
      runContextRecord = telemetryRunContext({
        runId,
        // An embedder's `command` is redacted and masked as the argv is: a
        // flag's secret value can sit before the `--`.
        command: maskInvocation(invocationCommand(options.command ?? process.argv.slice(1))),
        requestedTasks: options.tasks,
        cachePolicy: formatCachePolicy(policy),
        concurrency,
        flow: options.flow ?? null,
        git: gitContext,
        ci: ciContext,
        host: hostContext,
        workspaceRoot,
        originUrl: gitFilesCache.configValue('remote.origin.url'),
      })
      telemetry = await subscribeTelemetry(
        prepared.plugins,
        bus,
        { workspaceRoot, cacheDir, warn: warnOf(log) },
        runContextRecord,
        options.telemetrySinks,
        nodes,
      )
    }

    const sandboxArmer = prepareSandbox(nodes.values())
    // The sandbox probe is ~220 ms of spawns, paid by the first sandboxed task.
    // A task no cache can answer is sure to run, so start the probe now, under
    // the classify. The task's `arm()` rethrows a refusal, and the run's end
    // awaits it: one landing after the reset left SRT's proxies holding the
    // process open.
    const surelyRuns = (n: TaskNode): boolean =>
      n.config.exec?.persistent !== undefined ||
      n.config.cache !== true ||
      !(policy.localRead || policy.remoteRead)
    // Only what runs here arms this machine's sandbox: a `sandbox` executor
    // enforces it where it runs.
    const sandboxed =
      sandboxArmer === null
        ? []
        : [...nodes.values()].filter(
            (n) =>
              n.config.exec?.sandbox !== undefined &&
              (n.config.exec.persistent === undefined
                ? localPlaced(n.id)
                : !placements.carried.has(n.id)),
          )
    let prewarming: Promise<void> | undefined
    const prewarm = (): void => {
      prewarming ??= sandboxArmer?.arm().catch(() => {})
    }
    if (sandboxed.some(surelyRuns)) prewarm()
    const keyed = keyedProjects(nodes, prepared.keyOnly)
    const readable = readableDeps(nodes, prepared.keyOnly)
    const outputDirSnapshots: OutputDirSnapshot[] = []
    // Saves run off the execution slot, at twice the cap (each pack holds an
    // artifact's bytes). A failed save is said once, with its task (the work
    // ran); a full disk fails every save after, named once the graph ends.
    const unsaved: string[] = []
    const saveLane = createSaveLane(2 * concurrency, (err, taskId) => {
      if (unsaved.push(taskId) > 1) return
      const msg = err instanceof Error ? err.message : String(err)
      // The artifact ceiling's refusal names its task itself.
      warnOf(log)(
        `[vx] cache save failed: ${msg.startsWith(`${taskId} `) ? msg : `${taskId}: ${msg}`}`,
      )
    })
    const deferredSaves = new Map<string, Promise<SaveFacts>>()
    // A server held from an earlier run (`vx watch`) runs through this one
    // too, so it may write a mutable input while it is described.
    for (const id of heldBefore.kept.keys()) {
      const node = nodes.get(id)!
      windows.open(id, node.projectDir, commandWriteReach(node, workspaceRoot))
    }

    // A requested group has no output of its own: surface its same-project
    // non-group tasks (one level) for display, marking `node.surfaced` without
    // touching `requested`.
    markSurfacedDeps(nodes)

    // Header counts: projects with a real task in the graph (deps included; a
    // `^build` placeholder is not one), and real task executions, matching the
    // summary's total. Surfaced nodes count as requested for the
    // live-vs-buffered choice: they display alike.
    const packagesInScope = new Set<string>()
    let taskCount = 0
    let requestedCount = 0
    for (const node of nodes.values()) {
      if (!isGroupTask(node)) {
        packagesInScope.add(node.projectName)
        taskCount++
        if (node.requested || node.surfaced === true) requestedCount++
      }
    }
    // Admission over the worker count is a plugin's (`admit`), built once into
    // the predicate the scheduler asks at each local dispatch. No plugin: count
    // only.
    const admit = buildAdmission(prepared.plugins, nodes, concurrency, warnOf(log))

    // Run context for the footer. The top-of-run header is gone — the
    // banner now lives in the summary, where the eye lands at the end.
    const fault = executorFaults(warnOf(log))
    const footers = executors.filter((e) => e.distribution?.footer !== undefined)
    const placers = executors.filter((e) => e.distribution?.running !== undefined)
    // The scheduler's dependents count, and every row's `blocks` (the live
    // list's and the results'): one closure over the graph, counted by
    // `prepareRun` beside git when it could, else on the first that asks.
    let counted: ReadonlyMap<string, number> | undefined = prepared.dependents
    const blocksNow = (): ReadonlyMap<string, number> =>
      (counted ??= graphCounts(nodes, hashCache.folds, hashCache.graph))
    // Every row's `usual` and the forecast's timings: history read once, on the
    // first row that asks, so a run that executes nothing never reads it, and
    // early rows are not left without one.
    let p50s: ReadonlyMap<string, number> | undefined
    const p50sNow = (): ReadonlyMap<string, number> => {
      if (p50s !== undefined) return p50s
      const ids: string[] = []
      for (const n of nodes.values()) if (!isGroupTask(n)) ids.push(n.id)
      try {
        p50s = new LocalHistoryProvider(
          indexDb(prepared.localCache),
          undefined,
          prepared.branch(),
          taskDefinitions(nodes.values()),
        ).p50sNow(ids)
      } catch {
        // History is observability: an unreadable one knows no task.
        p50s = new Map()
      }
      return p50s
    }
    // The live rows' `cpu` and `mem`; it looks only once the live list asks.
    const liveUsage = createLiveUsage()
    const runContext = {
      blocks: blocksNow,
      usual: (id: string) => p50sNow().get(id),
      usage: liveUsage.usage,
      ...(footers.length > 0
        ? { executorRows: () => footers.flatMap((e) => executorFooter(e, fault)) }
        : {}),
      ...(placers.length > 0
        ? {
            whereRunning: (id: string) =>
              placers.map((e) => executorWhere(e, id, fault)).find((w) => w !== undefined),
          }
        : {}),
      version: VERSION,
      packageCount: packagesInScope.size,
      remoteCacheEnabled,
      cacheScope: prepared.cacheScope,
      cache: {
        local: policy.localRead || policy.localWrite,
        localWrite: policy.localWrite,
        remote: remoteCacheEnabled && (policy.remoteRead || policy.remoteWrite),
        traffic: prepared.localCache.traffic,
        downloads: prepared.localCache.downloads,
        uploads: prepared.localCache.uploads,
        notDownloaded: () => deferredOutputs.pending().length,
      },
      concurrency,
      workspaceProjectCount,
      // Live too: a long run is read while it runs.
      runId,
      warnings: () => warned,
    }

    // Asked only when a plugin declares `output`: a plain run pays nothing.
    if (takeOutput !== undefined && prepared.plugins.some((p) => p.output !== undefined)) {
      const claimed = await claimOutput(prepared.plugins, {
        workspaceRoot,
        cacheDir,
        warn: warnOf(log),
        isTTY: process.stdout.isTTY === true,
        ci: ciContext.ci,
      })
      if (claimed !== undefined) takeOutput(claimed)
    }

    // Lifecycle hooks drive the default logger's TTY status line; it starts
    // here, so a prompt now would be drawn over.
    secrets.closePrompts()
    log.runStart?.({
      total: taskCount,
      concurrency,
      requestedCount,
      context: runContext,
      startedAtMs: endedAtMsAtStart,
    })
    // The live forecast: the graph's from the first free row, history's only if
    // the region is still up a second in, so a warm run never reads history.
    terminal?.forecast(
      () => createForecast(nodes, new Map(), concurrency, blocksNow()),
      async () => createForecast(nodes, p50sNow(), concurrency, blocksNow()),
    )

    // Remote only: background prefetches overlap remote-GET latency with
    // execution. The layer ingests hits locally and dedups, so execute-task's
    // `cache.get` awaits the in-flight promise (one GET per key).
    let prefetchDone: Promise<void> = Promise.resolve()
    /** `--profile`'s run events beside the tasks: the cache probe's. */
    const runSpans: Record<string, unknown>[] = []
    // A remote that is read answers which tasks it holds: demand settles
    // on that answer, a failed prefetch settling it on none.
    const prefetchSettles = prepared.hasRemoteLayer && policy.remoteRead
    if (prepared.hasRemoteLayer) {
      prefetchDone = steps.background('vx:prefetch', () =>
        startRemotePrefetch({
          ...(demand.any
            ? {
                held: (ids: readonly string[], missed: readonly string[]) =>
                  demand.settle(ids, missed),
              }
            : {}),
          nodes,
          cache,
          workspaceRoot,
          claimedFiles: fingerprintWatch.names,
          forwardArgs: options.forwardArgs,
          nestedDirsByProject,
          gitFilesCache,
          hashCache,
          concurrency: options.downloadConcurrency ?? networkConcurrency(),
          remoteRead: policy.remoteRead,
          remoteWrite: policy.remoteWrite,
          spans: options.profile === undefined ? undefined : runSpans,
        }),
      )
    }

    // Local short-circuit: derive every stable, cacheable, locally-read task's
    // key and probe local once. Confirmed hits become the restore tier, run
    // ahead of their deps as slot backfill; execute reuses each probe. Off:
    // both maps are empty.
    let shortCircuit: ShortCircuit = emptyShortCircuit()
    // An empty local cache misses every probe: each task derives its key as it
    // starts instead (~100 ms before a cold 1,090-package run's first spawn).
    const remote = cache.hasRemote === true
    const coldLocal =
      shouldShortCircuit(nodes, policy) && (remote || cache === prepared.localCache)
        ? prepared.localCache.holdsNothing()
        : false
    // Behind a remote, a server's dependants need their keys up front even
    // on an empty store: the remote may hold them all, and then the server
    // never starts (`held-servers.ts`).
    const askForServers =
      remote &&
      policy.remoteRead &&
      [...nodes.values()].some(
        (n) => n.config.exec?.persistent !== undefined && !n.requested && n.surfaced !== true,
      )
    // A remote may still hold what an empty local store does not: the
    // prefetch asks it, and no confirmed miss warms the sandbox early.
    if (coldLocal && !remote && sandboxed.length > 0) prewarm()
    else if ((!coldLocal || askForServers) && shouldShortCircuit(nodes, policy)) {
      shortCircuit = await step('vx:keys', () =>
        startLocalShortCircuit({
          nodes,
          // Behind a remote, the local store alone: its hits are certain
          // now, and a local miss may still be a remote hit.
          cache: remote ? prepared.localCache : cache,
          localOnly: remote,
          remoteOnly: placements.remoteOnly,
          workspaceRoot,
          claimedFiles: fingerprintWatch.names,
          forwardArgs: options.forwardArgs,
          nestedDirsByProject,
          gitFilesCache,
          hashCache,
          concurrency,
        }),
      )
      // A confirmed miss runs too.
      if (!remote && sandboxed.some((n) => shortCircuit.preProbed.get(n.id)?.hit === null))
        prewarm()
    }
    if (demand.any) {
      if (prefetchSettles) void prefetchDone.finally(() => demand.settle([]))
      else {
        const hits: string[] = []
        const missed: string[] = []
        for (const [id, probe] of shortCircuit.preProbed)
          (probe.hit !== null ? hits : missed).push(id)
        // An empty store was not asked: it holds none of them.
        if (coldLocal && !remote)
          for (const [id, n] of nodes) if (n.config.cache === true) missed.push(id)
        demand.settle(hits, missed)
      }
    }

    // Whether this task runs behind a failure (`continueMode: 'always'`) or on
    // the key of a dep `--exclude-dependencies` kept from running: its save is
    // withheld and the taint propagates (admission.ts).
    const excluded = excludedTaint(nodes)
    if (excluded.unsaved > 0) {
      warnOf(log)(
        `[vx] --exclude-dependencies: ${excluded.unsaved} cached task(s) build on a skipped dependency; what they build is not saved`,
      )
    }
    // A server that ended on its own is failed (the end of the run says so);
    // what has not yet started hears it before it dispatches.
    const serverDied = (id: string): boolean => {
      const child = persistentRegistry.get(id)
      return child !== undefined && hasEnded(child) && child.exitCode !== 0
    }
    // Under `always`, a task starting while a server it depends on is dead runs
    // on a failure the outcomes do not hold yet (the server's says `success`
    // until the end), so it is seeded at dispatch. `serverDiedUnder` seeds a
    // death during the task, as does a leftover process (`leftRunning`).
    const taintSeeds = new Set(excluded.seeds)
    const hasServers = [...nodes.values()].some((n) => n.config.exec?.persistent !== undefined)
    const continueAlways = options.continueMode === 'always'
    let taint = taintTracker(continueAlways, taintSeeds, nodes, hasServers)
    let taintOn = continueAlways || taintSeeds.size > 0 || hasServers
    // Each task that ran tainted, and the task at the root of it: its
    // outcome's `taintedBy` once it finishes.
    const taintedRan = new Map<string, string>()
    const depended = dependedOn(nodes.values())

    // Why a task missed, for a sink: a read of the history per miss, so only
    // when a sink exists.
    const explainMiss =
      telemetry === undefined ? undefined : createMissExplainer(indexDb(prepared.localCache))
    const lateProbes = probesAfterWrites(nodes, workspaceRoot)
    // The scheduler's fail-fast stop, as the retry loop of a task already
    // in flight sees it.
    const failFast = new AbortController()
    // Tasks a plugin's shared record names flaky (`ctx.flaky`).
    const sharedFlaky = new Set<string>()
    const scope: RunContext = {
      workspaceRoot,
      cache,
      cachePolicy: policy,
      forwardArgs: options.forwardArgs,
      deferred: deferredOutputs,
      trailing,
      cacheDir,
      runStartHrTimeNs,
      persistentRegistry,
      liveChildren,
      gitFilesCache,
      hashCache,
      probesAfterWrites: lateProbes,
      fingerprintWatch,
      keyedProjects: keyed,
      readableDeps: readable,
      nestedDirsOf: nestedDirsOf(nodes, prepared.keyOnly, nestedDirsByProject),
      projectAt: (rel) => projectAtDir(rel, workspaceRoot, prepared.projects.values()),
      outputDirSnapshots,
      deferSave: saveLane.defer,
      deferredSaves,
      commandWindows: windows,
      projectTasks: projectTasksOf(prepared.projects),
      stopSignal: stop.signal,
      failFast: failFast.signal,
      inputStability,
      serverReady: (id) => void sinceReady.set(id, []),
    }
    if (hasServers)
      scope.serverDiedUnder = async (node) => {
        const behind = (pick: (id: string) => boolean): string | undefined => {
          for (const d of node.deps) {
            const s = deadServerBehind(nodes, pick, d)
            if (s !== undefined) return s
          }
          return undefined
        }
        let dead = behind(serverDied)
        // A server that died just before the task ended may be heard after it:
        // both exits can land in one event-loop turn, the task's first. The
        // next turn has handled the rest.
        if (dead === undefined && behind((id) => persistentRegistry.has(id)) !== undefined) {
          await new Promise<void>((resolve) => setImmediate(resolve))
          dead = behind(serverDied)
        }
        if (dead === undefined) return false
        taintSeeds.add(node.id)
        taintedRan.set(node.id, dead)
        return true
      }
    scope.leftRunning = (node) => {
      // The check stays off until the first leftover: it is seeded before
      // the task settles, so every outcome a dependent's judge reads is
      // recorded by the tracker made here.
      if (!taintOn) {
        taint = taintTracker(continueAlways, taintSeeds, nodes, true)
        taintOn = true
      }
      taintSeeds.add(node.id)
    }
    if (options.retries !== undefined) scope.retries = options.retries
    scope.knownFlaky = (node, hash) => {
      if (sharedFlaky.has(node.id)) return true
      try {
        return knownFlaky(indexDb(prepared.localCache), node.projectName, node.taskName, hash)
      } catch {
        // History is observability: an unreadable one retries nothing.
        return false
      }
    }
    if (taskTimeoutDefault !== undefined) scope.timeout = taskTimeoutDefault
    if (cleanOutputs !== undefined) scope.cleanOutputs = cleanOutputs
    const sinkTrack = telemetry?.track
    scope.track = (taskId, pid) => {
      const untrack = liveUsage.track(taskId, pid)
      const sunk = sinkTrack?.(taskId, pid)
      return () => {
        untrack()
        return sunk?.()
      }
    }
    if (explainMiss !== undefined) scope.explainMiss = explainMiss
    if (keepRun !== undefined) scope.keepRun = keepRun
    if (options.handoff?.watch === true) scope.watch = true
    if (sandboxArmer !== null) scope.armSandbox = () => sandboxArmer.arm()
    if (demand.any) scope.executing = demand.executing
    const argsOf = executeArgsOf(scope, {
      log: (node) => (node.config.exec?.persistent !== undefined ? serverLog(node.id) : log),
      placements,
      nestedDirsByProject,
      downloadModeOf: download?.modeOf,
      shortCircuit,
      // Under a download policy the run's outputs stay where the policy says.
      ...(download === undefined
        ? {
            trailable: trailable(
              nodes,
              (id) => shortCircuit.preProbed.has(id) || shortCircuit.uncachedKeys.has(id),
              (id) => placements.executors.get(id)?.capabilities?.remote === true,
            ),
          }
        : {}),
      dependedOn: depended,
      holders,
    })
    const buildExecuteArgs = (
      node: TaskNode,
      upstream: TaskOutcome[],
      reuseProbe = true,
    ): ExecuteArgs => {
      let deadServer: string | undefined
      if (options.continueMode === 'always') {
        for (const d of node.deps) {
          deadServer = deadServerBehind(nodes, serverDied, d)
          if (deadServer !== undefined) break
        }
        if (deadServer !== undefined) taintSeeds.add(node.id)
      }
      const tainted = taint.judge(node, upstream)
      if (tainted) taintedRan.set(node.id, deadServer ?? taint.cause(node, upstream))
      return argsOf(node, upstream, reuseProbe, tainted)
    }

    const executeWithDedup = admitTasks({
      inflight: options.inflight,
      policy,
      shortCircuit,
      hashArgs: {
        workspaceRoot,
        cache,
        forwardArgs: options.forwardArgs,
        nestedDirsByProject,
        gitFilesCache,
        hashCache,
        probesAfterWrites: lateProbes,
      },
      buildExecuteArgs,
    })

    mark('classify + probe')
    // A run of only confirmed local hits dispatches only restores, which no
    // weight orders, so the `schedule` stage is not asked. A plugin's later
    // weights (`ctx.refine`) re-rank the queues while the graph runs.
    let reprioritize: ((weights: ReadonlyMap<string, number>) => void) | undefined
    let refinedEarly: ReadonlyMap<string, number> | undefined
    let graphOver = false
    const priorities = [...nodes.values()].every(
      (n) => n.config.exec?.command === undefined || shortCircuit.restoreTier.has(n.id),
    )
      ? new Map<string, number>()
      : await prepared.priorities({
          step,
          refined: (merged) => {
            if (reprioritize !== undefined) reprioritize(merged)
            else if (!graphOver) refinedEarly = merged
          },
          flaky: (ids) => {
            for (const id of ids) if (nodes.has(id)) sharedFlaky.add(id)
          },
        })
    mark('schedule')
    // Judged as each task finishes, against history before this run's rows
    // land, so the row carries the verdict and nothing prints below the footer.
    // A hit or skip asks nothing; a green miss is one probe of the failed-row
    // index.
    const historyDb = indexDb(prepared.localCache)
    const cacheOff = cachesNothing(policy)
    const judgeFlaky = (o: TaskOutcome): void => {
      const candidates = flakyCandidates([o])
      if (candidates.length === 0) return
      try {
        const found = detectFlaky(historyDb, candidates)[0]
        if (found === undefined) return
        ;(o.attempts ??= {}).flaky = { passes: found.passes, failures: found.failures }
      } catch {
        // History is observability: an unreadable one judges nothing.
      }
    }
    const keepServer = (node: TaskNode): SucceededOutcome | undefined => {
      const server = heldBefore.kept.get(node.id)
      if (server === undefined) return undefined
      heldBefore.kept.delete(node.id)
      if (hasEnded(server.child)) return undefined
      server.handOver()
      server.out.bus = bus
      serverOuts.set(node.id, server.out)
      persistentRegistry.set(node.id, server.child)
      const at = process.hrtime.bigint() - runStartHrTimeNs
      return {
        node,
        status: 'success',
        exitCode: 0,
        durationMs: 0,
        timing: { startNs: at, endNs: at },
      }
    }
    let lockBroken: boolean | undefined
    prepared.localCache.memo.storeHeldBlobSizes()
    prepared.localCache.checkpointOffThread()
    // A hit's row is whole when it finishes, so it is written while the graph
    // runs (history-stream.ts); other rows, and any with forward args (only the
    // bundle digests them), wait for the bundle.
    const historyAt = historyFiles(prepared.localCache)
    let expectedHits = 0
    for (const probe of shortCircuit.preProbed.values()) if (probe.hit !== null) expectedHits++
    const stream =
      historyAt === undefined ? undefined : new HistoryStream<TaskOutcome>(historyAt, expectedHits)
    const forwards = (options.forwardArgs?.length ?? 0) > 0
    const streamHit = (o: TaskOutcome): void => {
      if (stream === undefined || isGroupTask(o.node)) return
      if (!isCacheHit(o.status)) return
      if (o.timing?.startNs === undefined || o.timing?.endNs === undefined) return
      if (forwards && o.node.requested) return
      stream.add(
        o,
        runRecordOf(o as RecordedOutcome, {
          runId,
          startedAtMs: endedAtMsAtStart,
          endedAtMs: endedAtMsAtStart,
          blocks: blocksNow(),
          remoteTraffic: prepared.localCache.traffic.keys,
        }),
      )
    }
    // History, the kept bytes and the report read the graph's outcomes
    // from the stream, as every other surface does.
    const fold = foldOutcomes(
      nodes,
      keeper === undefined && stream === undefined
        ? undefined
        : (o) => {
            keeper?.taskDone(o)
            streamHit(o)
          },
    )
    unfold = bus.subscribe(fold.subscriber)
    // A dependency-only server stops once no task left uses it, freeing its
    // cores; not under a hold, whose next cycle may reuse it.
    const unneeded =
      options.handoff?.holdPersistent === true
        ? undefined
        : unneededServers(nodes, options.log === undefined && (options.handleSignals ?? true))
    const serving = executors.filter(
      (e) => e.capabilities?.servers === true && e.distribution?.unneeded !== undefined,
    )
    const released = new Set<string>()
    const stopping: Promise<void>[] = []
    // A server stops after the servers using it (`serverUsers`), which this
    // same release reached first.
    const usersOf = unneeded === undefined ? undefined : serverUsers(nodes)
    const stops = new Map<string, Promise<void>>()
    const release = (id: string): void => {
      // A stop signals every server once and waits out its grace: a second
      // signal here cut a server's cleanup short.
      if (stop.signal.aborted) return
      for (const s of unneeded?.(id) ?? []) {
        // Copies an executor started beside the dependants it ran.
        for (const e of serving)
          try {
            e.distribution!.unneeded!(s)
          } catch {
            // Its copies stop at its teardown, as before.
          }
        const child = persistentRegistry.get(s)
        // One that died on its own stays: the end of the graph reports it.
        if (child === undefined || hasEnded(child)) continue
        released.add(s)
        persistentRegistry.delete(s)
        const users: Promise<void>[] = []
        for (const u of usersOf?.get(s) ?? []) {
          const p = stops.get(u)
          if (p !== undefined) users.push(p)
        }
        const p =
          users.length === 0
            ? stopServer(child)
            : Promise.allSettled(users).then(() => stopServer(child))
        stops.set(s, p)
        stopping.push(p)
      }
    }
    // Tasks a plugin's executor threw on, and its name: the throw left no `where`.
    const thrownOn = new Map<string, string>()
    const outcomes = await runGraph({
      nodes,
      concurrency,
      restoreConcurrency: options.restoreConcurrency ?? 2 * concurrency,
      reverseDeps: blocksNow,
      settledOf: (o) => deferredSaves.get(o.node.id)?.then((facts) => withSaveFacts(o, facts)),
      ...(hasPooledExecutor(executors) ? { poolOf: poolOfPlacement(placements) } : {}),
      ...(admit !== undefined ? { admit } : {}),
      ...(holders.size > 0 ? { exclusive: holders } : {}),
      ...(options.continueMode !== undefined ? { continueMode: options.continueMode } : {}),
      serverDied,
      onFailFast: () => failFast.abort(),
      signal: stop.signal,
      onStart: (node) => {
        // A platform skip never starts, like a skip blocked upstream: its
        // start opened a single task's frame that nothing closed.
        if (placements.otherPlatform.has(node.id)) return
        log.taskStart?.(node)
      },
      onFinish: (o) => {
        if (thrownOn.size > 0 && o.placement?.where === undefined) {
          const where = thrownOn.get(o.node.id)
          if (where !== undefined) (o.placement ??= {}).where = where
        }
        if (cacheOff) (o.cache ??= {}).off = true
        const root = taintedRan.get(o.node.id)
        if (root !== undefined && o.blockedBy === undefined) o.taintedBy = root
        taint.settled(o)
        judgeFlaky(o)
        log.taskComplete(o.node, o)
        if (sinceReady.size > 0) releaseSinceReady(o.node.id)
        demand.finished(o.node.id)
        release(o.node.id)
        // A server that dies while the graph runs is no longer running:
        // its pin stayed `running` under the line naming its exit.
        const server = o.status === 'success' ? persistentRegistry.get(o.node.id) : undefined
        if (server !== undefined && o.serverExit === undefined)
          onServerExit(server, 'outcome', (code) => {
            if (code !== 0 && !graphOver && !stop.signal.aborted && !released.has(o.node.id))
              o.serverExit = code
          })
      },
      // A crash a hand-broken lock entry caused is named as that; asked
      // only here, so a run that does not crash pays nothing.
      onError: (node, line, err) => {
        const on = executorFailedOn(err)
        if (on !== undefined) thrownOn.set(node.id, on)
        log.taskStderr(
          node,
          !isUserError(err) && !isFsRefusal(err) && (lockBroken ??= lockEntryBroken(workspaceRoot))
            ? `[vx] ${node.id}: ${LOCK_INVALID}\n`
            : line,
        )
      },
      execute: (node, upstream) => {
        const skip = platformSkip(node)
        if (skip !== undefined) return Promise.resolve(skip)
        const held = heldBefore.kept.get(node.id)
        const up = keyUpstream(node, upstream)
        if (held === undefined) return executeWithDedup(node, up)
        // Keyed as a started server is: a cached dependant folds its key,
        // and without it an edit to the server's sources hit stale.
        return Promise.resolve(serverKey(argsOf(node, up, true, false))).then(async (hash) => {
          // A dependency-only server whose key moved is replaced, the old
          // one gone first so the two never hold one port.
          if (keyedHeld.has(node.id) && (hash === undefined || hash !== held.key)) {
            heldBefore.kept.delete(node.id)
            held.handOver()
            await stopServer(held.child)
          }
          const kept = keepServer(node)
          if (kept !== undefined) return hash === undefined ? kept : { ...kept, hash }
          // Computed once: the spawn reads it back.
          if (hash !== undefined) shortCircuit.uncachedKeys.set(node.id, hash)
          return executeWithDedup(node, up)
        })
      },
      // An unkeyed group runs nothing, and a restore-tier hit whose tree is
      // current restores nothing: settled in place, unless a taint may ride it.
      ...(options.continueMode !== 'always' && taintSeeds.size === 0
        ? {
            settleNow: (node: TaskNode, upstream: TaskOutcome[]) => {
              const skip = platformSkip(node)
              if (skip !== undefined) return () => skip
              if (isGroupTask(node) && node.config.inputs === undefined)
                return () =>
                  unkeyedGroupOutcome(
                    node,
                    keyUpstream(node, upstream),
                    shortCircuit.groupKeys.get(node.id),
                    runStartHrTimeNs,
                  )
              if (!shortCircuit.restoreTier.has(node.id) || heldBefore.kept.has(node.id))
                return undefined
              return settleProbedHit(buildExecuteArgs(node, keyUpstream(node, upstream)))
            },
          }
        : {}),
      // A `schedule` plugin's weights; the scheduler keeps its structural
      // baseline as the tie-break. Empty map → baseline only.
      ...(priorities.size > 0 ? { priorities } : {}),
      reprioritize: (apply) => {
        if (refinedEarly !== undefined) apply(refinedEarly)
        reprioritize = apply
      },
      // The baseline under them; `most-work` when the workspace names none.
      ...(options.schedule !== undefined ? { strategy: options.schedule } : {}),
      // Confirmed stable local hits the scheduler runs ahead of their deps as
      // slot backfill. Empty when the short-circuit did not fire.
      restoreTier: shortCircuit.restoreTier,
      ...(askForServers
        ? {
            heldServers: askRemote(
              serversToHold(nodes, shortCircuit.restoreTier, shortCircuit.remoteAsk),
              nodes,
              shortCircuit,
              cache,
            ),
          }
        : {}),
    })
    // What is still coming to this machine is the run's too: it ends with
    // every file here, as a run that waited for each did.
    await trailing.settle()
    for (const l of trailing.lost)
      warnOf(log)(`[vx] ${l.id} ran, and its files did not come back to this machine: ${l.message}`)
    stop.graphDone()
    reprioritize = undefined
    graphOver = true
    // Each task finishes once its save settles (`settledOf`): the list is whole.
    if (unsaved.length > 1) {
      const more = unsaved.slice(1)
      const named = more.slice(0, 5).join(', ') + (more.length > 5 ? ', …' : '')
      warnOf(log)(
        `[vx] cache save failed for ${more.length} more task${more.length === 1 ? '' : 's'}: ${named}`,
      )
    }

    // Which persistent children outlive the graph, and the bounded SIGTERM of
    // the rest, before the summary. Only in the CLI foreground (`options.log
    // === undefined`, signals handled): watch mode and embedders expect run()
    // to return.
    const foreground = options.log === undefined && (options.handleSignals ?? true)
    // An aborted run's children are already being torn down: nothing to
    // hold, but the servers a `CYCLE_INTERRUPT` spared.
    const hold =
      options.handoff?.holdPersistent === true &&
      (!stop.signal.aborted || stop.signal.reason === CYCLE_INTERRUPT)
    // A stop already signalled every server once and waits out its grace:
    // a SIGTERM here, while a server ran its cleanup, cut it short.
    if (stop.signal.aborted) await stop.aborting?.catch(() => {})
    await Promise.all(stopping)
    const { keepAlive, crashed: crashedPersistent } = await disposeServers({
      registry: persistentRegistry,
      nodes,
      outcomes,
      keep: foreground || hold,
      hold,
      keyed: keyedHeld,
      continueAlways: options.continueMode === 'always',
      endedBeforeStop: stop.endedBeforeStop,
    })

    // Every batch the stream sent has answered: what landed is not written again.
    unfold()
    const streamed = await stream?.finish()
    const landed = new Set(streamed?.landed.map((s) => s.item))
    mark('run graph')

    // Clear the status line for good before the summary prints.
    log.runEnd?.()
    const list = fold.outcomes
    // A platform skip, and a skip it blocked, is no failure: the task is not this machine's.
    const ok =
      list.every(
        (o) =>
          isPassStatus(o.status) ||
          (o.status === 'skipped' &&
            (o.otherPlatform !== undefined ||
              (o.blockedBy !== undefined && placements.otherPlatform.has(o.blockedBy)))),
      ) && trailing.lost.length === 0

    // The summary, artifacts and history all exclude groups through
    // `tallyOutcomes`, so each gets the full list.
    const endedAtMs = Date.now()
    const totalMs = Number(process.hrtime.bigint() - runStartHrTimeNs) / 1_000_000
    // Foreground dev mode: list the persistent tasks still up between the task
    // frames and the footer. A requested server that crashed meanwhile is dead,
    // and the wait below says so.
    const stillUp = keepAlive.nodes.filter((_, i) => !hasEnded(keepAlive.children[i]!))
    if (stillUp.length > 0) {
      for (const line of formatPersistentList(stillUp, colors)) log.status(line)
    }
    // A dependency-only server that died before the graph's end stopped it: the
    // footer counts it failed, this says why. A signal death is named as its
    // exit code, as the keep-alive wait names it.
    for (const c of crashedPersistent) {
      const code = typeof c.code === 'number' ? c.code : signalExitCode(c.code)
      warnOf(log)(`vx: ${c.id} exited with code ${code} before the run stopped it`)
      for (const line of takeExitNotes(persistentRegistry.get(c.id), code)) warnOf(log)(line)
    }
    // Outputs that never came home are not an error, but a silently empty or
    // stale `dist/` would be: name every task whose bytes are still remote.
    const stillDeferred = deferredOutputs.pending()
    if (stillDeferred.length > 0) {
      log.status(
        `  Deferred: left outputs remote${downloadPolicy === 'all' ? '' : ` (--cache-download=${downloadPolicy})`}: ${stillDeferred.join(', ')}`,
      )
    }

    // Optional artifacts: errors are shown but never change the exit code.
    // Written again after the keep-alive wait, whose crash or Ctrl-C is the
    // process's real exit.
    const profile = options.profile
    if (profile !== undefined) {
      try {
        const wrote = await step('vx:profile', () =>
          writeRunProfile({
            target: profile,
            cwd: options.cwd,
            outcomes: list,
            runStartNs: runStartHrTimeNs,
            executors: executors.map((e) => executorProfile(e, fault)),
            spans: runSpans,
          }),
        )
        log.status(`vx: profile written to ${wrote}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        warnOf(log)(`vx: failed to write profile: ${msg}`)
      }
    }
    // Record the run in one SQLite transaction (one fsync), with the invocation
    // header (`recordRunBundle`). The input-fingerprint rows are saved inside
    // each miss's save transaction, so an all-hit run records nothing extra.
    // The telemetry mirror is built in the same pass, only with a sink.
    const recordsOf = (final: TaskOutcome[], runOk: boolean) =>
      assembleRunRecords({
        outcomes: final,
        runId,
        startedAtMs: endedAtMsAtStart,
        endedAtMs,
        totalMs,
        ok: runOk,
        // `vx last` prints the stored invocation: a secret after `--` is masked
        // here as task output masks it, so cache.db holds no plaintext.
        command: maskInvocation(options.command ?? process.argv.slice(1).join(' ')),
        requestedTasks: options.tasks,
        cachePolicy: formatCachePolicy(policy),
        concurrency,
        flow: options.flow ?? null,
        forwardArgs: options.forwardArgs,
        git: gitContext,
        ci: ciContext,
        host: hostContext,
        withTelemetry: telemetry !== undefined,
        blocks: blocksNow(),
        remoteTraffic: prepared.localCache.traffic.keys,
        landed,
      })
    const records = recordsOf(list, ok)
    const recordHistory = (write: () => void): void => {
      try {
        write()
      } catch (err) {
        // History is observability: a full disk at the very end must not turn a
        // finished run into a stack trace and exit 1.
        const message = err instanceof Error ? err.message : String(err)
        warnOf(log)(`[vx] run history not recorded: ${message} — the verdict above stands`)
      }
    }
    // A foreground server can still fail the run after the cache closes: its
    // history is written once the wait decides, or it recorded `ok` over exit 1
    // and fed the flaky list a pass.
    const historyAfterWait = keepAlive.children.length > 0 && !hold && stop.stoppedBy === undefined
    // The servers this run is done with end now; the kept ones once the wait decides.
    telemetry?.endServers(
      list,
      historyAfterWait ? new Set(keepAlive.nodes.map((n) => n.id)) : undefined,
    )
    // A failed task's output, for `vx last` and an agent (run-failures.ts).
    // A cache directory this user cannot write keeps none of the run's
    // records: the run's one notice said so.
    const keeps = prepared.localCache.readOnlyNotice() === null
    const recordFailures = (
      final: readonly TaskOutcome[],
      into: Cache = prepared.localCache,
    ): void => {
      if (keeps) writeRunFailures(into, runId, final, warnOf(log))
    }
    if (stop.stoppedBy === undefined && !historyAfterWait) {
      stepSync('vx:history', () => {
        recordHistory(() => runHistory(prepared.localCache).recordRunBundle(records))
        recordHistory(() =>
          runHistory(prepared.localCache).recordMeasures([...measured.values()], head),
        )
        recordFailures(list)
      })
    } else if (stop.stoppedBy !== undefined) {
      // Stopped: not a run `vx last` lists, but what finished is measured, or
      // the next run knows none of it.
      const ended = list.filter((o) => o.status !== 'aborted' && o.status !== 'skipped')
      stepSync('vx:history', () => {
        recordHistory(() =>
          runHistory(prepared.localCache).recordRuns(recordsOf(ended, false).runs, head),
        )
        recordHistory(() =>
          runHistory(prepared.localCache).recordMeasures([...measured.values()], head),
        )
        recordFailures(ended)
      })
    }
    mark('record history')
    // Drain in-flight prefetches and write-through uploads before closing the
    // cache: a prefetch ingesting into a closed database throws, and local hits
    // never awaited theirs.
    //
    // Before teardownPlugins: the drain pushes bytes through a plugin's layer,
    // and a plugin releasing its client in `teardown()` would silently lose
    // every remote write. A cache layer stays usable until the run's uploads
    // settle. Deferred saves have all settled: the scheduler finishes a task
    // only once its save landed.
    await step('vx:uploads', async () => {
      await prefetchDone
      await Promise.all([cache.drainUploads?.(), keeper?.settled()])
    })
    if (keeps) {
      // Beside the run's rows (cache/run-notes.ts); a refused write costs only them.
      try {
        keepRunNotes(indexDb(prepared.localCache), runId, {
          steps: steps.ended,
          warnings: warned.map((w) => Bun.stripANSI(w)),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warnOf(log)(
          `[vx] background steps and warnings not kept: ${message} — the verdict above stands`,
        )
      }
    }
    // An upload that failed after the rows went in: its row says so too.
    if (prepared.localCache.uploads.failed > 0 && stop.stoppedBy === undefined && !historyAfterWait)
      recordHistory(() =>
        recordLateRemoteErrors(
          prepared.localCache,
          [...records.runs, ...(streamed?.landed.map((s) => s.record) ?? [])],
          runId,
        ),
      )
    // A stop passes none (`VxPlugin.teardown`): the run did not reach its end.
    // Built and frozen only for a teardown that reads it.
    const report =
      stop.stoppedBy === undefined && prepared.plugins.some((p) => p.teardown !== undefined)
        ? freezeDeep(
            reportOf(list, { runId, commit: head.commitSha, ciRun: ciContext, ok }, keeper),
          )
        : undefined
    // Hand the summary to the telemetry sinks and drain them, only with a sink.
    // Crash-isolated, so a faulty sink cannot fail the run. After the upload
    // drain, so the summary says what uploads moved.
    const sinks = telemetry
    // At the graph's end, or with `after` once a kept server's wait has
    // decided: its outcome changed in place, so its records are built again.
    const summarize = async (
      final: TaskOutcome[],
      runOk: boolean,
      after?: { at: number; totalMs: number },
    ): Promise<void> => {
      if (sinks === undefined || runContextRecord === undefined) return
      sinks.endServers(final)
      const ended = after ?? { at: endedAtMs, totalMs }
      const timed = after === undefined ? step : undefined
      const tasks =
        after === undefined ? records.telemetryTasks : recordsOf(final, runOk).telemetryTasks
      const summary = assembleRunSummary(runContextRecord, tasks, {
        startedAt: endedAtMsAtStart,
        endedAt: ended.at,
        totalDurationMs: Math.round(ended.totalMs),
        exitOk: runOk,
        // As the terminal counts them: `1 aborted · 1 not run`.
        abortedCount: tasks.filter((t) => t.status === 'aborted').length,
        notRunCount: final.filter((o) => neverStarted(o) && !isGroupTask(o.node)).length,
        stages: stageTimes(),
        uploads: prepared.localCache.uploads,
        machines: executors.flatMap((e) => executorMachines(e, fault)),
        idealMs: executors.map((e) => executorIdeal(e, fault)).find((ms) => ms !== undefined),
        advice: executors.flatMap((e) => executorAdvice(e, fault)),
      })
      sinks.emitSummary(summary)
      await sinks.flush(timed)
    }
    // A kept server can still fail the run in the wait below: its summary goes
    // out once the wait decides, or sinks read a pass over exit 1.
    if (!historyAfterWait) await summarize(list, ok)
    // Each plugin's teardown, crash-isolated and time-bounded, after the drains
    // above; other exits reach it through `teardown`. Output-directory
    // snapshots first (miss-save.ts).
    await step('vx:snapshots', () => recordOutputDirSnapshots(cache, outputDirSnapshots))
    mark('output dir snapshots')
    // A plugin hears the run until its teardown and nothing after, or its
    // handlers heard a kept server through the whole wait. Idempotent.
    disposePlugins?.()
    telemetry?.dispose()
    await teardown(undefined, report)
    await step('vx:close', closeCache)
    mark('close')
    printTimings()

    // Tear down SRT's network bridge and (macOS) log monitor, or the next run
    // inits on stale proxies. No-op with no sandboxed task.
    await step('vx:sandbox', async () => {
      await prewarming
      if (sandboxArmer?.armed) {
        try {
          await resetSandbox()
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          warnOf(log)(`vx: sandbox cleanup failed: ${msg}`)
        }
      }
    })

    // The footer is the run's last word, printed once history, uploads,
    // teardown and the sandbox reset are done, so their warnings land above it.
    // Only a kept server's output follows. It replaces the live region in
    // place.
    log.runDone?.()
    if (options.handoff?.summaryTable === true)
      for (const line of formatOutcomeTable(list, colors)) log.status(line)
    // A run a signal stopped records nothing `vx last` opens: no id to copy.
    const footerContext =
      stop.stoppedBy === undefined ? runContext : { ...runContext, runId: undefined }
    if (options.footer !== false)
      for (const line of formatRunSummary(list, totalMs, colors, footerContext)) log.status(line)

    // A requested persistent task (dev server, watcher): the run is done in
    // every bookkeeping sense but the server is the point, so stay in the
    // foreground until one of them exits. Ctrl-C hits the process group; a
    // crash ends the session, the others are torn down (SIGTERM, grace,
    // SIGKILL), and a non-zero exit fails the run, so `vx run dev` in a script
    // fails when its server fell over. One line names the server that ended it
    // and its code: the summary said `success`.
    if (keepAlive.children.length > 0 && hold) {
      return {
        ok,
        outcomes: list,
        persistent: holdServers(keepAlive, {
          forwardArgs: options.forwardArgs,
          outOf: (id) => serverOuts.get(id) ?? { bus },
          keyOf: (id) => (keyedHeld.has(id) ? outcomes.get(id)?.hash : undefined),
        }),
      }
    }
    if (keepAlive.children.length > 0) {
      const first = await sessionEnd(keepAlive)
      const node = keepAlive.nodes[first.i]!
      // Only the ones still up are stopped: a kept server already dead was
      // counted as one.
      const others = keepAlive.children.filter((c, j) => j !== first.i && !hasEnded(c)).length
      // Not when the run was stopped: the user ended the server, and "exited
      // with code 130" read as a crash.
      if (!stop.signal.aborted) {
        warnOf(log)(
          `vx: ${node.id} exited with code ${first.code}` +
            (others > 0
              ? `; stopping ${others} other persistent task${others === 1 ? '' : 's'}`
              : ''),
        )
        for (const line of takeExitNotes(keepAlive.children[first.i], first.code)) warnOf(log)(line)
      }
      // Under a stop the abort is already sending its signal: a second SIGTERM
      // in the grace cut short a graceful shutdown.
      if (stop.signal.aborted) await stop.aborting?.catch(() => {})
      else await terminateChildren(() => keepAlive.children)
      // The server that ended the session on its own, not cleanly, failed.
      // A stop's own kill is no crash: the user ended the session.
      const crashed = !stop.signal.aborted && first.code !== 0
      if (crashed) failServer(outcomes, node.id, first.code)
      if (historyAfterWait) {
        recordHistory(() => {
          // A writer's open: another vx version may have reset the index
          // to its schema during the session, and a mismatch resets silently.
          const local = new Cache(prepared.cacheDir, undefined, prepared.workspaceRoot)
          try {
            runHistory(local).recordRunBundle(recordsOf(list, ok && !crashed))
            runHistory(local).recordMeasures([...measured.values()], head)
            recordFailures(list, local)
          } finally {
            local.close()
          }
        })
        // After the footer and teardown: no step line. A stop reads as one
        // anywhere: the servers it took down are aborted; history keeps them as
        // a dev session's usual end.
        const stopped = stop.signal.aborted
        const told = stopped
          ? list.map((o) =>
              keepAlive.nodes.some((n) => n.id === o.node.id) && isPassStatus(o.status)
                ? ({
                    ...o,
                    status: 'aborted',
                    exitCode:
                      typeof first.code === 'number' ? first.code : signalExitCode(first.code),
                  } as AbortedOutcome)
                : o,
            )
          : list
        await summarize(told, ok && !crashed && !stopped, {
          at: Date.now(),
          totalMs: Number(process.hrtime.bigint() - runStartHrTimeNs) / 1_000_000,
        })
      }
      return { ok: ok && !crashed, outcomes: list }
    }

    return { ok, outcomes: list }
  } finally {
    // Idempotent. Every call between the ticker's start and runEnd is
    // crash-isolated today, so this is the floor for a throw a later change
    // adds.
    log.runEnd?.()
    log.runDone?.()
    unfold()
    live?.dispose()
    stop.detach()
    // Plugins installed at the top of run() get their bus subscriptions
    // released here. Idempotent; safe even if installPlugins threw.
    disposePlugins?.()
    telemetry?.dispose()
    // No-op after the normal path's teardown; on a throw, the only one.
    await teardown()
    // No-op after the normal close. On a throw this is the only close, and it
    // must not throw itself, or it replaces the real error. Uploads are not
    // drained: they hold no database state, and a wedged remote would turn a
    // failing run into a hanging one.
    try {
      await closeCache()
    } catch {
      // teardown must not throw on the way out
    }
    await stop.aborting?.catch(() => {})
    // Last: a process signal waits for this before it exits.
    stop.left()
  }
}

/** Why an `--affected` run has nothing to run, said alike by the run and its `--dry` plan. */
function noneAffected(prepared: PreparedRun, options: CoreRunOptions): string {
  // A changed project declares the task, so `--affected`'s task walk is
  // what left nothing (affected-tasks.ts), not the scope.
  const inScope = new Set(options.projects ?? [])
  const reachedNone =
    options.affected !== undefined &&
    [...prepared.projects.values()].some(
      (p) =>
        inScope.has(p.name) && options.tasks.some((t) => declaredTask(p.config, t) !== undefined),
    )
  return reachedNone
    ? `Nothing affected: the change reaches no ${options.tasks.join(', ')} task.`
    : `No affected project declares task(s): ${options.tasks.join(', ')}.`
}

/**
 * One line when a policy (flag or workspace `cache.policy`) names the remote
 * cache and no plugin supplies one; `--dry` gets it too.
 */
function warnNoRemote(prepared: PreparedRun, options: CoreRunOptions, log: Logger): void {
  if (prepared.hasRemoteLayer) return
  const remoteNamed =
    options.handoff?.remoteRequested ??
    (options.cache === undefined &&
    options.cacheFlags?.noCache !== true &&
    namesRemote(prepared.workspaceConfig?.cache?.policy)
      ? 'cache.policy'
      : undefined)
  if (remoteNamed === undefined) return
  warnOf(log)(
    `vx: ${remoteNamed} named the remote cache, but no cache plugin in .vx/workspace.* supplies one — the remote axes are off for this run`,
  )
}

/**
 * Planning mode (`--dry`): the same setup as `run()`, stopping short of
 * execution, returning a `RunPlan` predicting each task's hit or miss.
 *
 * Side effects: only `inputs.runtime` probes, which keys need. With no remote
 * the cache opens read-only; with one, remote hits found are kept for the next
 * run. Probing is the byte-free `cache.has()`: no download, ingest or
 * `accessed_at` bump.
 */
export async function planRun(options: RunOptions): Promise<RunPlan> {
  return planCore(options)
}

/** `planRun` as vx's CLI calls it, with its hand-off. */
export async function planCore(options: CoreRunOptions): Promise<RunPlan> {
  refuseRunOptions(options)
  // The plan is the product and goes to stdout (`--dry=json` is parsed): what a
  // stage says on the way goes to stderr.
  const log = options.log ?? defaultLogger(undefined, undefined, process.stderr)
  const reasons = new Map<string, AffectedReason>()
  const prepared = await prepareRunLocked(
    { ...options, handoff: { ...options.handoff, affectedReasons: reasons } },
    log,
    undefined,
    false,
    true,
  )
  try {
    options = withRunSettings(options, prepared.workspaceConfig)
    if (prepared.unresolvedTasks.length > 0) {
      return {
        tasks: [],
        unresolvedTasks: prepared.unresolvedTasks,
        unresolvedHint: await unresolvedHint(prepared, options.projects),
      }
    }
    if (prepared.empty === 'no-tasks-declared' && prepared.declaredElsewhere.length > 0) {
      return {
        tasks: [],
        unresolvedTasks: prepared.declaredElsewhere,
        unresolvedHint: elsewhereHint(
          prepared.declaredElsewhere,
          true,
          options.projects,
          prepared.projects,
        ),
      }
    }
    if (prepared.empty === 'none-affected')
      return { tasks: [], noneAffected: noneAffected(prepared, options) }
    if (prepared.empty !== null) return { tasks: [] }
    warnNoRemote(prepared, options, log)
    // The plan orders nothing, but it refuses what the run would refuse.
    await prepared.priorities()
    terminalHolders(prepared.nodes, options.tty === true)
    // Its own mark: the plan's work was booked under `close` and read as 105 ms
    // of closing a cache.
    const policy = effectiveCachePolicy(prepared.cachePolicy, prepared.hasRemoteLayer)
    const planned = await plan({
      nodes: prepared.nodes,
      workspaceRoot: prepared.workspaceRoot,
      cache: prepared.cache,
      cachePolicy: policy,
      forwardArgs: options.forwardArgs,
      nestedDirsByProject: prepared.nestedDirsByProject,
      gitFilesCache: prepared.gitFilesCache,
      hashCache: prepared.hashCache,
      // The same history p50s the predictive scheduler reads, folded into the
      // plan with a predicted wall clock. `--dry` is an explicit inspection, so
      // the read is fine here.
      history: new LocalHistoryProvider(
        indexDb(prepared.localCache),
        undefined,
        prepared.branch(),
        taskDefinitions(prepared.nodes.values()),
      ),
      // Placement by the run's rules, shown only with more than one executor.
      // Resolving executors is the factory call `prepareRun` already makes, so
      // planning gains no new side effect.
      ...(await planExecutorOf(prepared, log, options.download ?? 'all', detectCi(process.env).ci)),
      ...(await planRestorable(prepared, policy, options.forwardArgs)),
    })
    mark('plan')
    for (const t of planned.tasks) {
      const why = reasons.get(t.node.id)
      if (why !== undefined) t.affected = why
    }
    return planned
  } finally {
    // The plan called the cache and executor factories; teardown releases what
    // they opened, as a run's end does.
    await teardownPlugins(prepared.plugins, warnOf(log))
    prepared.cache.close()
    // The same table a run prints: a dry run profiles the prepare stages on a
    // repo with no install or cache.
    mark('close')
    printTimings()
  }
}

/**
 * What the run's short-circuit would restore, so the plan can tell a server
 * nobody needs (every dependant a local hit, never spawned) from one that
 * starts. The run's own gates, asked only when a server could idle.
 */
async function planRestorable(
  prepared: PreparedRun,
  policy: CachePolicy,
  forwardArgs: readonly string[] | undefined,
): Promise<{ restorable?: Set<string> }> {
  const { nodes } = prepared
  const serves = [...nodes.values()].some(
    (n) => n.config.exec?.persistent !== undefined && !n.requested && n.surfaced !== true,
  )
  if (!serves || !shouldShortCircuit(nodes, policy)) return {}
  const keptOut = restoreTierExclusions(nodes, prepared.workspaceRoot)
  const stable = await deriveStableKeys({
    nodes,
    cache: prepared.cache,
    workspaceRoot: prepared.workspaceRoot,
    claimedFiles: prepared.fingerprintWatch.names,
    forwardArgs,
    nestedDirsByProject: prepared.nestedDirsByProject,
    gitFilesCache: prepared.gitFilesCache,
    hashCache: prepared.hashCache,
  })
  return {
    restorable: new Set(stable.map((k) => k.node.id).filter((id) => !keptOut.has(id))),
  }
}

const LOCK_HINT = ' A run reads the lock: after editing a vx.config, run `vx lock`.'

/**
 * The names a project outside the run's selection declares, and how to
 * reach them; `lock` adds that a task just added to a selected project's
 * config is declared only outside the selection until `vx lock`.
 */
function elsewhereHint(
  names: readonly string[],
  lock: boolean,
  selected: readonly string[] | undefined,
  projects: ReadonlyMap<string, ProjectEntry>,
): string {
  if (names.length === 0) return ''
  const own = ownDefaultBuild(names, selected, projects)
  return ` Only projects outside the selection declare ${names.join(', ')} — pass --all, or a --filter that includes them.${own}${lock && own === '' ? LOCK_HINT : ''}`
}

/**
 * Why a selected project with a build does not run it: the build is the default
 * one, which no bare name takes.
 */
function ownDefaultBuild(
  names: readonly string[],
  selected: readonly string[] | undefined,
  projects: ReadonlyMap<string, ProjectEntry>,
): string {
  if (selected === undefined || !names.includes('build')) return ''
  const own = selected.filter((p) => isDefaultBuild(projects.get(p)?.config.tasks?.['build']))
  if (own.length === 0) return ''
  const one = own.length === 1
  return ` ${own.join(', ')} declare${one ? 's' : ''} no build of ${one ? 'its' : 'their'} own: \`vx show\` counts ${one ? 'its' : 'their'} default build, which a bare name does not run.`
}

/**
 * What follows "no projects declare task(s): …": where the name is, its
 * nearest spelling, and, with neither, the lock a run reads its configs
 * from: a task just added to a vx.config is not in it until `vx lock`.
 */
async function unresolvedHint(
  prepared: {
    workspaceRoot: string
    unresolvedTasks: readonly string[]
    hintProjects: ReadonlyMap<string, ProjectEntry>
    declaredElsewhere: readonly string[]
    anyProjectConfig: boolean
    taskless: (name: string) => boolean
    unlockedConfig: () => string | undefined
    projects: ReadonlyMap<string, ProjectEntry>
  },
  selected: readonly string[] | undefined,
): Promise<string> {
  const elsewhere = elsewhereHint(prepared.declaredElsewhere, false, selected, prepared.projects)
  const near = didYouMean(
    prepared.unresolvedTasks,
    prepared.hintProjects,
    prepared.declaredElsewhere,
    prepared.taskless,
    prepared.workspaceRoot,
  )
  const init = await initHint(prepared)
  // "No project declares a task yet" beside configs that declare one: the
  // lock holds none of them (a `vx lock` that failed), so say that.
  if (near.includes(NO_TASK)) {
    const unlocked = await unlockedAnywhere(prepared.workspaceRoot)
    if (unlocked !== undefined)
      return `${elsewhere}${near.replace(NO_TASK, `The lock holds no project for ${unlocked}: run \`vx lock\` (did it fail?).`)}${init}`
  }
  // Beside `--all` too: a task just added to the selected project's config
  // is declared only outside the selection until `vx lock`.
  const lock =
    init === '' &&
    !near.startsWith(' Did you mean') &&
    !near.includes(NO_TASK) &&
    ownDefaultBuild(prepared.declaredElsewhere, selected, prepared.projects) === ''
      ? LOCK_HINT
      : ''
  return `${elsewhere}${near}${init}${lock}`
}

/**
 * The first run, told apart from a typo: the lock holds no project. Said of the
 * lock, the one thing a run reads; a config written after the lock is no first
 * run, its fix is `vx lock`. Error path only.
 */
async function initHint(prepared: {
  anyProjectConfig: boolean
  unlockedConfig: () => string | undefined
}): Promise<string> {
  if (prepared.anyProjectConfig) return ''
  const unlocked = prepared.unlockedConfig()
  if (unlocked !== undefined) return ` ${unlocked} is not in the lock yet — run \`vx lock\`.`
  return ` ${EMPTY_LOCK}.`
}

/** A project config the lock holds no project for, found by the walk `vx lock` makes. */
async function unlockedAnywhere(root: string): Promise<string | undefined> {
  const [{ configs }, lock] = await Promise.all([findProjectConfigs(root), readLockfile(root)])
  const held = new Set(Object.keys(lock?.projects ?? {}))
  const c = configs.find((x) => !held.has(lockKey(root, x.dir)))
  return c === undefined ? undefined : relPosix(root, c.configPath)
}

// The state right after `vx init`: the lock is current, so the lock hint
// alone sent a new user to a command that changed nothing.
const NO_TASK =
  'No project declares a task yet: add one under `tasks` in a vx.config, then run `vx lock`.'

/**
 * A typo's nearest declared name within two edits, so the message names the
 * fix. A bare name matches every declared task; `pkg#task` matches project
 * names first, then that project's tasks, so the hint runs.
 */
function didYouMean(
  unresolved: readonly string[],
  projects: ReadonlyMap<string, ProjectEntry>,
  elsewhere: readonly string[],
  taskless: (name: string) => boolean,
  root: string,
): string {
  // A default `build` is no declared task: no match, menu item or hint
  // (`p#build` would be refused).
  const tasksOf = (p: ProjectEntry | undefined): string[] =>
    Object.entries(p?.config.tasks ?? {})
      .filter(([, c]) => !isDefaultBuild(c))
      .map(([t]) => t)
  const allTasks = new Set<string>()
  for (const p of projects.values()) for (const t of tasksOf(p)) allTasks.add(t)
  // A Set: two typos of the same task hint it once, not once per typo.
  const hints = new Set<string>()
  // A typo past two edits named nothing to pick from: with no near name, say
  // what exists instead.
  const lists = new Set<string>()
  for (const spec of unresolved) {
    const at = spec.indexOf('#')
    const nx = nxProjectTarget(spec, projects)
    if (nx !== undefined) {
      hints.add(nx)
      continue
    }
    if (at < 0) {
      const t = nearest(spec, allTasks)
      if (t !== undefined) hints.add(t)
      // A name outside the selection is already said, with `--all`.
      else if (allTasks.size > 0 && !elsewhere.includes(spec)) {
        lists.add(`Tasks: ${listed(allTasks)}.`)
      } else if (allTasks.size === 0 && elsewhere.length === 0) lists.add(NO_TASK)
      continue
    }
    const [proj, task] = [spec.slice(0, at), spec.slice(at + 1)]
    // `//` is two edits from any two-letter name: it hinted `ui#build`.
    if (proj === '//') {
      lists.add(
        '`//` is the workspace root, which is no project here: add a vx.config there with that task and run `vx lock`.',
      )
      continue
    }
    // `*` is one edit from any one-letter name and two from `ui`: `*#lint`
    // hinted `ui#lint`, though the user meant every project.
    if (!isLiteralPattern(proj) && !projects.has(proj)) {
      lists.add(
        `\`${spec}\` names one project, not a pattern: run \`${task}\` with --filter '${proj}' instead.`,
      )
      continue
    }
    if (taskless(proj)) {
      lists.add(
        `${proj} has no vx config, and no configured project depends on it: it has no tasks.`,
      )
      continue
    }
    if (!projects.has(proj)) {
      // NFC typed, NFD on disk (or back): two edits apart, so no hint, and
      // the list named the project exactly as typed.
      const form = [...projects.keys()].find((n) => n.normalize('NFC') === proj.normalize('NFC'))
      if (form !== undefined) {
        lists.add(
          `${proj} is not the project ${form}, though they look the same: the two are written in different Unicode forms (NFC and NFD). Set \`name\` in its vx.config to the form you type.`,
        )
        continue
      }
      // A project's directory first: by edit distance, `p/a` hinted `p/b`.
      const p =
        projectNamed(proj, projects) ??
        projectAtDir(proj, root, projects.values()) ??
        nearest(proj, projects.keys())
      if (p !== undefined) {
        const tasks = tasksOf(projects.get(p))
        const t = tasks.includes(task) ? task : nearest(task, tasks)
        if (t !== undefined) hints.add(`${p}#${t}`)
        else lists.add(`No project is named ${proj}; ${p}'s tasks: ${listed(tasks)}.`)
      } else if (projects.size > 0) {
        lists.add(`No project is named ${proj}; projects: ${listed(projects.keys())}.`)
      }
      continue
    }
    const t = nearest(task, tasksOf(projects.get(proj)))
    if (t !== undefined) hints.add(`${proj}#${t}`)
    else if (tasksOf(projects.get(proj)).length > 0) {
      lists.add(`${proj}'s tasks: ${listed(tasksOf(projects.get(proj)))}.`)
    }
  }
  return (
    (hints.size === 0 ? '' : ` Did you mean ${[...hints].join(', ')}?`) +
    [...lists].map((l) => ` ${l}`).join('')
  )
}

/**
 * Nx's `project:target` (`nx run web:build`) as vx spells it, `web#build`,
 * when that project declares that task; a name with a colon is otherwise
 * a task of its own (`build:prod`).
 */
export function nxProjectTarget(
  spec: string,
  projects: ReadonlyMap<string, ProjectEntry>,
): string | undefined {
  const colon = spec.indexOf(':')
  if (colon <= 0 || spec.includes('#')) return undefined
  const [typed, task] = [spec.slice(0, colon), spec.slice(colon + 1)]
  const project = projectNamed(typed, projects)
  return project === undefined || declaredTask(projects.get(project)?.config, task) === undefined
    ? undefined
    : `${project}#${task}`
}

/**
 * The project a typed name means: itself, else the one project whose scoped
 * name ends in it (`nx run cart:build` for `@nx-example/cart`).
 */
export function projectNamed(
  typed: string,
  projects: ReadonlyMap<string, ProjectEntry>,
): string | undefined {
  if (projects.has(typed)) return typed
  if (typed.includes('/')) return undefined
  const scoped = [...projects.keys()].filter((n) => n.startsWith('@') && n.endsWith(`/${typed}`))
  return scoped.length === 1 ? scoped[0] : undefined
}

/** Each project's tasks by its directory, built on the first ask: a miss beside an ignored file. */
function projectTasksOf(
  projects: ReadonlyMap<string, ProjectEntry>,
): (projectDir: string) => readonly TaskConfig[] {
  let byDir: Map<string, readonly TaskConfig[]> | undefined
  return (dir) => {
    if (byDir === undefined) {
      byDir = new Map()
      for (const p of projects.values()) byDir.set(p.dir, Object.values(p.config.tasks ?? {}))
    }
    return byDir.get(dir) ?? []
  }
}

/**
 * The project whose directory a typed name is, relative to the workspace
 * root, as `--filter p/a` reads it: `alpha` for `p/a`.
 */
export function projectAtDir(
  typed: string,
  root: string,
  projects: Iterable<{ name: string; dir: string }>,
): string | undefined {
  const dir = path.resolve(root, typed)
  for (const p of projects) if (path.resolve(p.dir) === dir) return p.name
  return undefined
}

/** The executed, keyed outcomes of a run — what flakiness is judged on. */
function flakyCandidates(outcomes: readonly TaskOutcome[]): FlakyCandidate[] {
  const out: FlakyCandidate[] = []
  for (const o of outcomes) {
    if (o.status !== 'success' && o.status !== 'failed') continue
    // "Same inputs, failed after passing" needs declared inputs: a task without
    // `cache: true` runs every time, and one bad network day would read as a
    // flake for thirty days. Groups do no work.
    if (o.hash === undefined || o.node.config.cache !== true || isGroupTask(o.node)) continue
    // Behind a failed dependency the outcome is not the key's: a later failure
    // relapsing from it would read as a flake.
    if (o.taintedBy !== undefined) continue
    out.push({
      project: o.node.projectName,
      task: o.node.taskName,
      hash: o.hash,
      status: o.status,
      attempts: o.attempts?.count ?? 1,
    })
  }
  return out
}

/** `dir` with its links resolved; as written when it is gone (a stale marker). */
function canonical(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

/** What an executor's report threw: said once by `executorFaults`, the report left out. */
type ExecutorFault = (e: TaskExecutor, what: string, err: unknown) => void

/**
 * Each executor report that throws is said once and left out: isolated,
 * it was dropped with nothing said, a summary short its machines.
 */
function executorFaults(warn: (line: string) => void): ExecutorFault {
  const said = new Set<string>()
  return (e, what, err) => {
    const k = `${e.name}\0${what}`
    if (said.has(k)) return
    said.add(k)
    warn(`[vx] ${executorLabel(e)}: ${what}() threw: ${thrownMessage(err)} — left out`)
  }
}

/** An executor's footer rows; a plugin's throw or bad shape shows none. */
function executorFooter(e: TaskExecutor, fault: ExecutorFault): (readonly [string, ui.Inline])[] {
  try {
    const rows = e.distribution?.footer?.()
    if (!Array.isArray(rows)) return []
    return rows.filter(
      (r): r is readonly [string, ui.Inline] =>
        Array.isArray(r) &&
        typeof r[0] === 'string' &&
        (typeof r[1] === 'string' || (typeof r[1] === 'object' && r[1] !== null)),
    )
  } catch (err) {
    fault(e, 'footer', err)
    return []
  }
}

/** An executor's `--profile` events; a throw or a bad shape adds none. */
function executorProfile(
  e: TaskExecutor,
  fault: ExecutorFault,
): readonly Record<string, unknown>[] {
  try {
    const events = e.distribution?.profile?.()
    return Array.isArray(events)
      ? events.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      : []
  } catch (err) {
    fault(e, 'profile', err)
    return []
  }
}

function executorMachines(e: TaskExecutor, fault: ExecutorFault): readonly MachineReport[] {
  try {
    const m = e.distribution?.machines?.()
    return Array.isArray(m) ? m : []
  } catch (err) {
    fault(e, 'machines', err)
    return []
  }
}

function executorAdvice(e: TaskExecutor, fault: ExecutorFault): readonly WorkerAdvice[] {
  try {
    const a = e.distribution?.advice?.()
    return Array.isArray(a) ? a : []
  } catch (err) {
    fault(e, 'advice', err)
    return []
  }
}

function executorIdeal(e: TaskExecutor, fault: ExecutorFault): number | undefined {
  try {
    const ms = e.distribution?.idealMs?.()
    return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : undefined
  } catch (err) {
    fault(e, 'idealMs', err)
    return undefined
  }
}

/** Where `e` says a task runs, or `null` while it waits; a throw or anything else says nothing. */
function executorWhere(
  e: TaskExecutor,
  id: string,
  fault: ExecutorFault,
): string | null | undefined {
  try {
    const w = e.distribution?.running?.(id)
    if (w === null) return null
    return typeof w === 'string' && w !== '' ? w : undefined
  } catch (err) {
    fault(e, 'running', err)
    return undefined
  }
}
