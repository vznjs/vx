import { existsSync, lstatSync, statSync } from 'node:fs'
import path from 'node:path'
import type { ExecConfig, TaskConfig, InputsConfig, InputStability } from '../config.js'
import {
  ABSENT_INPUT,
  ArtifactVanishedError,
  type CacheEntry,
  type CacheLayer,
  type CachePolicy,
  cleanOutputs,
  cleanOutputPaths,
  committedFiles,
  cleanWorkspaceOutputs,
  type OutputFileRow,
  type OutputStamp,
  ownOutputsSince,
  ownWorkspaceOutputsSince,
  resolveOutputs,
  resolveWorkspaceOutputs,
  stampOutputs,
  stampWorkspaceOutputs,
  stampCommitted,
  committedMoved,
  FULL_CACHE_POLICY,
  type GitFilesCache,
  racyWindowMs,
  stampGrainMs,
  type TaskInputComponent,
  declaresInput,
  fsClockNow,
  taskEntryHashes,
  WORKSPACE_OUTPUT_PREFIX,
} from '../cache/index.js'
import {
  signalExitCode,
  isLocalExecutor,
  isExecutorFallback,
  localExecutor,
  type CaptureConfig,
  type ExecuteRequest,
  assertExecuteResult,
  type ExecuteResult,
  type SandboxViolation,
  type TaskExecutor,
  type TaskInputs,
  sandboxReads,
  maskCaptured,
  BoundedCapture,
  keyedOutsideGrants,
  atOrUnder,
  MOUNT_WILDCARDS,
  toRealPath,
} from '../exec/index.js'
import {
  encodeOutputLog,
  FAILED_OUTPUT_HEAD_CHARS,
  FAILED_OUTPUT_TAIL_CHARS,
  failedOutputLog,
} from './output-log.js'
import {
  isGroupTask,
  OutputsFailed,
  RestoreDemoted,
  RestoreFailed,
  standInsOf,
  type TaskNode,
  type TaskOutcome,
} from '../graph/index.js'
import {
  anyTaskGlob,
  heldSecrets,
  ignoredByGlobs,
  ignoredInputLine,
  isLiteralPattern,
  killGraceMs,
  MASKED,
  maskedStreams,
  outputMatcher,
  printable,
  relPosix,
  secretMask,
  type SecretMask,
  secretNamed,
  span,
  taskGlobOf,
  UserError,
} from '../util/index.js'
import { forwardedSignal, SIGNAL_SHUTDOWN_GRACE_MS } from './signals.js'
import { executorLabel, nameExecutorFailure } from './plugin-host.js'
import type { CommandWindows } from './command-windows.js'
import {
  commandWriteReach,
  dependencyReads,
  mayWriteFingerprint,
  type Placeholder,
  reachedWithheld,
  sandboxRequestFor,
  sweepPlaceholders,
  undeclaredWriteReach,
  untouchedPlaceholderLine,
  type WithheldLink,
  withheldLinkLine,
} from './sandbox-request.js'
import {
  bracketLiteralHint,
  markUnsaved,
  saveMiss,
  unsavedOutputBytes,
  type OutputDirSnapshot,
  type SaveFacts,
} from './miss-save.js'
import type { FingerprintWatch } from './fingerprint-watch.js'
import { currentHit, restoreHit } from './hit-restore.js'
import type { MissExplainer } from '../history/index.js'
import { shellVerdict } from './shell-verdict.js'
import { lockedDirGone } from './projects.js'
import { perRunWriteHint, sandboxFix } from './sandbox-fix.js'
// The hit path's entry stays importable from here (tests).
export { restoreHit, type RestoreHitArgs } from './hit-restore.js'
import type { DeferredOutputs } from './deferred-outputs.js'
import { taskLogMasks, type TreeLoad } from './telemetry.js'
import { type Logger, warnOf } from '../report/index.js'
import {
  computeGroupHash,
  computeTaskHash,
  describeTaskInputs,
  type HashCache,
  type InputFact,
  isKeyless,
  keyOf,
  movedInput,
  type UpfrontGroupKey,
} from './task-hash.js'
import { getContext } from './remote-prefetch.js'
import { expandGroupUpstream, filterUpstreamHashes } from './upstream.js'
import { executePersistentTask } from './persistent-task.js'
import {
  forgetUndeclaredWrites,
  isAborted,
  taskBinDirs,
  serverSpec,
  taskEnv,
  taskTimeoutMs,
} from './task-process.js'

export interface ExecuteArgs {
  node: TaskNode
  upstream: TaskOutcome[]
  workspaceRoot: string
  cache: CacheLayer
  /** Granular cache read/write policy. Undefined → everything on. */
  cachePolicy?: CachePolicy
  forwardArgs?: readonly string[] | undefined
  log: Logger
  /** The executor this task was PLACED on (run.ts, before scheduling). */
  executor: TaskExecutor
  /** Told the task executes, so the executor's demand counts it again (`ExecutorDemand.executing`). */
  executing?: ((id: string) => void) | undefined
  /**
   * `exec.remote: 'only'` with no remote executor to take it: succeed
   * WITHOUT executing, cleaning, restoring or saving anything on this
   * machine. The hash is still computed — dependents fold it.
   */
  remoteOnlyNoop?: boolean
  /**
   * The task depends on a `remoteOnlyNoop` one, directly or through others
   * (`Placements.belowNoop`): it saves nothing, since its key names the
   * no-op's outputs, which never landed.
   */
  belowNoop?: boolean
  /**
   * `exec.remote: 'only'` placed on a remote executor: execute remotely,
   * but this machine's disk is untouched — no output clean, no vx cache
   * probe/restore/save. The task's outputs live in the REMOTE store and
   * reach dependents' input trees by reference (the executor's job).
   */
  remoteOnly?: boolean
  /**
   * Plan-time `--cache-download` decision for THIS task (run.ts). `'deferred'`
   * means: do not clean, do not save — the executor is expected to leave
   * the outputs in the remote store and hand back a closure. An executor
   * that ignores it and materialises anyway simply gets no local entry;
   * the outputs are on disk but unindexed, which is its contract to keep.
   */
  download?: 'eager' | 'deferred'
  /** Run-scoped deferral registry — where deferred closures land, and
   *  where a locally-placed consumer fetches its producers from. */
  deferred?: DeferredOutputs
  nestedProjectDirs: string[]
  /**
   * Where its outputs stop when that is more than `nestedProjectDirs`: the
   * nested workspaces under it too (prepare.ts `outputWallsOf`).
   */
  outputNestedDirs?: string[]
  /** The run's cache directory: walled off from a sandboxed task's grants. */
  cacheDir?: string
  /** Anchor for hrtime spans across all tasks in this run. */
  runStartHrTimeNs: bigint
  /**
   * The run's stop (a process signal or the embedder's abort). An attempt
   * that ends while it is aborted is `aborted`, whatever its exit: a task
   * that traps the forwarded SIGINT and exits 0 did not finish on its own
   * terms (item 962).
   */
  stopSignal?: AbortSignal
  /** `continueMode: 'never'` stopped dispatch: no further attempt starts. */
  failFast?: AbortSignal
  /**
   * Registry the orchestrator owns. For each persistent task we
   * spawn, we stash the subprocess handle here so the orchestrator
   * can SIGTERM it once the rest of the graph finishes.
   */
  persistentRegistry?: Map<string, ReturnType<typeof Bun.spawn>>
  /**
   * Run-scoped set of in-flight subprocesses (one-shot and
   * not-yet-ready persistent). The runner adds/removes children
   * around each spawn; the orchestrator's SIGINT/SIGTERM handler
   * SIGTERMs whatever is in here.
   */
  liveChildren?: Set<ReturnType<typeof Bun.spawn>>
  /** Sample a spawned task's process tree (`TelemetrySource.track`); absent when nobody samples. */
  track?: (taskId: string, pid: number) => () => TreeLoad | undefined
  /** Name what a missed key changed (`createMissExplainer`); absent when nobody listens. */
  explainMiss?: MissExplainer
  /**
   * Run-level retry default (`--retries <n>` / `RunOptions.retries`).
   * Explicit `exec.retries` wins, including an explicit 0. Threaded as
   * an option only — never folded into any hash, so cache keys are
   * byte-identical with and without it.
   */
  retries?: number
  /**
   * Whether the run history knows the task as flaky (`knownFlaky`): a keyed
   * task with no `retries` of its own or of the run that fails gets ONE more
   * attempt when it does. Decided at run time, so never in the key.
   */
  knownFlaky?: (node: TaskNode, hash: string) => boolean
  /**
   * `run.timeout` (ms), already resolved from flag, variable and
   * workspace. Per-task `exec.timeout` wins. Never hashed.
   */
  timeout?: number
  /**
   * The run's `inputs.stability` layers around the task's own: `run` from
   * the env vars (above the task), `workspace` from `.vx/workspace` (below).
   */
  inputStability?: { run: InputStability; workspace?: InputStability }
  /** `outputs.clean` for tasks without their own: `.vx/workspace`. */
  cleanOutputs?: boolean
  /** Per-run memo for `git ls-files` (one entry per project dir). */
  gitFilesCache?: GitFilesCache
  /** Per-run memo for derived hashes (task config, file lists). */
  hashCache?: HashCache
  /** The run's `probesAfterWrites`, handed to every key this task takes. */
  probesAfterWrites?: ReadonlySet<string>
  /**
   * Up-front probe result from the local short-circuit classify, when
   * this task was stable + cacheable + local-read. Reused here so there
   * is NO second `cache.get`:
   *   - `hit` present  → restore that entry directly (restore-tier; may
   *     run before deps, so the up-front `hash` is used verbatim rather
   *     than recomputed against an incomplete upstream).
   *   - `hit` null     → a confirmed stable miss; skip the probe, go to
   *     the run path.
   * Absent → probe lazily, exactly as today (unstable / unclassified).
   */
  preProbed?: { hash: string; hit: CacheEntry | null }
  /**
   * An uncached task's key as the up-front pass derived it, present only
   * when no upstream can change it (`deriveStableKeys`' `uncachedKeys`):
   * used verbatim instead of deriving the same key again.
   */
  upfrontKey?: string
  /**
   * An unkeyed group's up-front key (`deriveStableKeys`' `groupKeys`): used
   * verbatim when the live upstream folds the same ids and keys.
   */
  upfrontGroupKey?: UpfrontGroupKey
  /**
   * Start the sandbox runtime, on the first task that executes inside one
   * (run.ts, `prepareSandbox`). Absent when no task in the run declares a
   * sandbox. A cache hit never calls it: a hit needs no sandbox.
   */
  armSandbox?: () => Promise<void>
  /**
   * The run's keyed-set lookup (keyed-projects.ts): the project directories
   * a task's key answers for. A sandboxed task that declares `cache` is
   * granted a linked workspace package only when it is in this set.
   */
  keyedProjects: (node: TaskNode) => ReadonlySet<string>
  /**
   * The run's lookup of the tasks whose outputs a sandboxed task may read
   * (keyed-projects.ts `readableDeps`). Absent: none.
   */
  readableDeps?: (node: TaskNode) => readonly TaskNode[]
  /**
   * The projects nested in a keyed one, by its dir (keyed-projects.ts
   * `nestedDirsOf`): walled from a task granted that linked package.
   * Absent: none.
   */
  nestedDirsOf?: (projectDir: string) => readonly string[]
  /**
   * The id of the project whose directory a workspace-relative path is
   * (run.ts `projectAtDir`): what a withheld link's hint names for its
   * `dependsOn` edge. Absent: none is one.
   */
  projectAt?: (rel: string) => string | undefined
  /**
   * Run-scoped list the miss path appends its output-directory snapshot
   * request to, taken at run end (run.ts) instead of right after the save:
   * a directory written milliseconds ago is inside the snapshot's racy
   * window and would be refused, and the next hit would walk the tree.
   */
  outputDirSnapshots?: OutputDirSnapshot[]
  /** The run's save lane: a miss's cache save runs off the execution slot (save-lane.ts). */
  deferSave?: (save: () => Promise<void>, taskId: string) => Promise<boolean>
  /**
   * Where a deferred save's `landed` promise is parked by task id, for the
   * in-flight join (admission.ts): a duplicate of this task in another run
   * must not probe the cache before the entry is there.
   */
  deferredSaves?: Map<string, Promise<SaveFacts>>
  /**
   * `continueMode: 'always'` let this task run although an upstream —
   * directly or through a chain of successes — failed or aborted. It still
   * cleans its outputs and runs, and a cache HIT still restores (a hit is a
   * healthy run's bytes), but its own result is never saved: the key it
   * derives is the one a healthy run derives (pure-input hashing), while
   * the bytes were built on a partial tree, so a save here is the next
   * clean run's stale hit.
   */
  taintedUpstream?: boolean
  /**
   * The run keeps its bytes in a remote (run-store.ts): an attempt captures
   * its output at the entry's bounds, and an outcome that saves no entry
   * carries it as `runLog`; a failure's only when `failures`
   * (`cache.upload.failures`).
   */
  keepRun?: { failures: boolean }
  /**
   * Whether a task has rewritten a root file a plugin claims (whose bytes
   * the claimant folded) since the run read it (fingerprint-watch.ts): past that, no key taken
   * on the old digest is probed or saved.
   */
  fingerprintWatch?: FingerprintWatch
  /**
   * No task in the run depends on this one, so none is ordered after it to
   * read what it wrote: a miss that saves nothing marks nothing (the output
   * walk cost 1,000 read-only misses 1.62 → 1.78 s, item 750).
   */
  noDependants?: true
  /** The task holds vx's terminal (`terminalHolders`): its stdio is vx's own. */
  terminal?: true
  /** A persistent task every dependant of which starts it where it runs: never spawned here. */
  carried?: true
  /** The persistent tasks its `servers` executor starts where it runs it. */
  servers?: readonly TaskNode[]
  /** Each of `servers`' nested project dirs, in its order. */
  serversNested?: readonly (readonly string[])[]
  /** When each command of the run ran and where it may write (command-windows.ts). */
  commandWindows?: CommandWindows
  /**
   * A persistent task matched `readyWhen` (or spawned, with none): what it
   * writes from here on is its since-ready output (run.ts holds it until
   * the task's outcome has been logged).
   */
  serverReady?: (id: string) => void
  /**
   * Asked just before a miss is saved: whether a server it depends on
   * (through groups too) died while it ran, which then holds the save. Its
   * key is a healthy run's; its bytes were built against a dead server.
   */
  serverDiedUnder?: (node: TaskNode) => Promise<boolean>
  /**
   * Told once when an attempt's shell left a process running: it may still
   * write the outputs a dependent reads, so run.ts seeds the run's taint
   * with this task and nothing built on it is saved.
   */
  leftRunning?: (node: TaskNode) => void
  /** A `vx watch` cycle (`RunOptions.watch`): an input edited mid-run is the next cycle's. */
  watch?: true
}

/**
 * Dispatch a single task to one of three execution paths. Each path
 * owns its own outcome shape; the dispatcher just picks based on the
 * task's config shape (group vs persistent vs cached). The persistent
 * path is persistent-task.ts; what both spawning paths share is
 * task-process.ts.
 */
export async function executeTask(args: ExecuteArgs): Promise<TaskOutcome> {
  if (isGroupTask(args.node)) return executeGroupTask(args)
  if (args.node.config.exec?.persistent !== undefined) return executePersistentTask(args)
  // A probed hit needs none of the run path's set-up: the upstream folding,
  // timers and closures `executeCachedTask` builds on entry were ~15 µs of
  // each of a warm run's hits (X-193). The same branch there handles it
  // when this one does not apply.
  const probed = args.preProbed
  if (probed?.hit != null && readsCache(args) && args.remoteOnlyNoop !== true) {
    return restoreProbed(
      args,
      probed.hash,
      probed.hit,
      process.hrtime.bigint() - args.runStartHrTimeNs,
    )
  }
  return executeCachedTask(args)
}

/**
 * A probed hit `executeTask` would restore, settled now when its tree is
 * already current (`currentHit`): the thunk replays its output and returns
 * the outcome. Undefined dispatches it as usual. A dispatch, a slot and the
 * promises around it were ~10 µs of each of a warm run's hits.
 */
export function settleProbedHit(args: ExecuteArgs): (() => TaskOutcome) | undefined {
  const probed = args.preProbed
  if (probed?.hit == null || !readsCache(args) || args.remoteOnlyNoop === true) return undefined
  if (isGroupTask(args.node) || args.node.config.exec?.persistent !== undefined) return undefined
  // A moved fingerprint is said, and demotes the hit, on the dispatch.
  if (args.fingerprintWatch?.moved() !== undefined) return undefined
  const restore = {
    args,
    hash: probed.hash,
    hit: probed.hit,
    cacheOpStart: performance.now(),
    taskStartNs: process.hrtime.bigint() - args.runStartHrTimeNs,
  }
  return currentHit(restore)
}

/** Whether this task reads the cache: a cached, not remote-only task with a read axis on. */
function readsCache(args: ExecuteArgs): boolean {
  const policy = args.cachePolicy ?? FULL_CACHE_POLICY
  return (
    args.remoteOnly !== true &&
    args.node.config.cache === true &&
    (policy.localRead || policy.remoteRead)
  )
}

/**
 * Restore the up-front probe's hit, or demote it. A key taken before a task
 * rewrote the lockfile names an install the tree no longer holds, and the
 * lazy path never probes one (X-124): demoted like a vanished hit, it runs
 * dep-gated. The hit may be restoring AHEAD of this task's deps, and a
 * command run now would build from outputs they have not written yet and
 * save that under the good key: the scheduler runs it again once they are
 * done (admission drops the probe).
 */
async function restoreProbed(
  args: ExecuteArgs,
  hash: string,
  hit: CacheEntry,
  taskStartNs: bigint,
): Promise<TaskOutcome> {
  const cacheOpStart = performance.now()
  const restored = fingerprintMoved(args)
    ? null
    : await restoreOrMiss(args, hash, hit, cacheOpStart, taskStartNs)
  if (restored !== null) return restored
  throw new RestoreDemoted(args.node.id)
}

/**
 * A hit restored, or null when its artifact was removed after the probe (a
 * `vx cache clean`, here or for a workspace sharing the cache directory): a
 * miss. The restore has wiped the declared outputs by then; the run path
 * cleans them again and the task writes them. Any other throw fails the
 * task as a failed restore (`RestoreFailed`), never as a miss.
 */
async function restoreOrMiss(
  args: ExecuteArgs,
  hash: string,
  hit: CacheEntry,
  cacheOpStart: number,
  taskStartNs: bigint,
): Promise<TaskOutcome | null> {
  try {
    return await restoreHit({ args, hash, hit, cacheOpStart, taskStartNs })
  } catch (err) {
    if (!(err instanceof ArtifactVanishedError)) throw new RestoreFailed(err)
    warnOf(args.log)(`[vx] ${args.node.id}: ${err.message} — running it`)
    return null
  }
}

/**
 * What a write to an input during the command means, each field highest
 * first: the env var (`layers.run`), the task's `inputs.stability`,
 * the workspace's, then `'immutable'` and `'warn'` (2026-10-12), so
 * by default any such write withholds the save, on CI too, since a
 * concurrent task can change an input and put it back.
 */
function inputStabilityOf(
  inputs: InputsConfig | undefined,
  layers: ExecuteArgs['inputStability'],
): Required<InputStability> {
  const task = inputs?.stability
  return {
    strategy: layers?.run.strategy ?? task?.strategy ?? layers?.workspace?.strategy ?? 'immutable',
    severity: layers?.run.severity ?? task?.severity ?? layers?.workspace?.severity ?? 'warn',
  }
}

/** The root files the plugins claim, as the run's watch holds them. */
function claimedFiles(args: ExecuteArgs): readonly string[] {
  return args.fingerprintWatch?.names ?? []
}

/**
 * A claimed file every key here folded through its claimant has moved (a
 * task rewrote the lockfile), said once per run.
 */
function fingerprintMoved(args: ExecuteArgs): boolean {
  if (args.fingerprintWatch?.moved() === undefined) return false
  args.fingerprintWatch.say(args.log)
  return true
}

/**
 * Group task: no `exec`. The scheduler has already ensured every
 * dependency completed; we just return success with a hash rolled up
 * from upstream outcomes so downstream cache keys still cascade
 * through us.
 */
async function executeGroupTask(args: ExecuteArgs): Promise<TaskOutcome> {
  if (args.node.config.inputs === undefined) {
    return unkeyedGroupOutcome(
      args.node,
      args.upstream,
      args.upfrontGroupKey,
      args.runStartHrTimeNs,
    )
  }
  const wallclockNs = process.hrtime.bigint() - args.runStartHrTimeNs
  const hash = await keyOf(
    computeTaskHash({
      node: args.node,
      upstream: args.upstream,
      workspaceRoot: args.workspaceRoot,
      cache: args.cache,
      forwardArgs: args.forwardArgs,
      nestedProjectDirs: args.nestedProjectDirs,
      ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
      ...(args.hashCache !== undefined ? { hashCache: args.hashCache } : {}),
    }),
  )
  return groupOutcome(args.node, args.upstream, hash, wallclockNs)
}

/**
 * An unkeyed group's outcome (no `inputs`, no key of its own): its key is
 * its upstream's alone (`computeGroupKey`), so the up-front one stands when
 * that upstream is unchanged. Synchronous: the scheduler settles such a
 * group in place (`ScheduleOptions.settleNow`), and `upstream` is the key's
 * (`keyUpstream`).
 */
export function unkeyedGroupOutcome(
  node: TaskNode,
  upstream: TaskOutcome[],
  upfront: UpfrontGroupKey | undefined,
  runStartHrTimeNs: bigint,
): TaskOutcome {
  const wallclockNs = process.hrtime.bigint() - runStartHrTimeNs
  const hash =
    upfront !== undefined && sameUpstream(upstream, upfront.upstream)
      ? upfront.key
      : computeGroupHash(upstream)
  return groupOutcome(node, upstream, hash, wallclockNs)
}

function groupOutcome(
  node: TaskNode,
  upstream: TaskOutcome[],
  hash: string,
  wallclockNs: bigint,
): TaskOutcome {
  return {
    node,
    status: 'success',
    exitCode: 0,
    durationMs: 0,
    hash,
    // What this group stands for. A dependent expands it to describe the
    // real tasks in its input closure — see `TaskOutcome.groupUpstream`.
    groupUpstream: upstream,
    wallclockStartNs: wallclockNs,
    wallclockEndNs: wallclockNs,
  }
}

/** The same ids with the same keys, in order: what `computeGroupHash` reads. */
function sameUpstream(live: TaskOutcome[], upfront: TaskOutcome[]): boolean {
  if (live.length !== upfront.length) return false
  for (let i = 0; i < live.length; i++) {
    const a = live[i]
    const b = upfront[i]!
    if (a === undefined || a.node.id !== b.node.id || a.hash !== b.hash) return false
  }
  return true
}

/**
 * Cached task: the common case. Hash inputs, try cache.get; on hit,
 * clean+restore+replay logs; on miss (or --no-cache), clean outputs,
 * spawn the command, save on success.
 */
async function executeCachedTask(args: ExecuteArgs): Promise<TaskOutcome> {
  const { node, upstream, cache, log } = args
  const cfg: TaskConfig = node.config
  const step = cfg.exec as ExecConfig // dispatcher guarantees exec is present
  const cfgOut = cfg.outputs
  const policy = args.cachePolicy ?? FULL_CACHE_POLICY
  const cfgCacheable = cfg.cache === true
  // We may READ when at least one read axis is on (the cache layer
  // refines local vs remote), and WRITE when at least one write axis is
  // on. Output management (clean before exec) keys off writes — so
  // `--no-cache` (all off) leaves the user's tree alone, while `--force`
  // (reads off, writes on) still wipes + repopulates a clean snapshot.
  // A remote-only task never touches this machine's disk: no probe/restore
  // (restoring node_modules onto a dev machine is exactly what the field
  // exists to prevent), no output clean, no local artifact save. Its result
  // lives in the remote executor's own store.
  const remoteOnly = args.remoteOnly === true
  // A key that folds a task with no inputs is this run's alone (`isKeyless`):
  // nothing to read under it, and nothing a later run could find.
  const present = upstream.filter((u): u is TaskOutcome => u !== undefined)
  const folded = new Set(
    filterUpstreamHashes(
      present,
      cfg.inputs?.tasks,
      node.projectName,
      node.id,
      standInsOf(node),
    ).map(([id]) => id),
  )
  const foldedTasks = expandGroupUpstream(present.filter((u) => folded.has(u.node.id)))
  const keylessBy = isKeyless(cfg)
    ? node.id
    : foldedTasks
        .map((u) => u.keylessBy ?? (isKeyless(u.node.config) ? u.node.id : undefined))
        .find((id) => id !== undefined)
  const keyless = keylessBy !== undefined
  const reads = policy.localRead || policy.remoteRead
  const willRead = !remoteOnly && cfgCacheable && !keyless && reads
  const willWrite = !remoteOnly && cfgCacheable && (policy.localWrite || policy.remoteWrite)
  // `willWrite` governs output hygiene (clean before exec); the save itself
  // is also withheld from a task downstream of a failure (see `taintedUpstream`),
  // and from one downstream of a task that ran over inputs its key no longer
  // describes: this key folds that upstream's key, while the bytes on disk
  // are not the ones that key names. With `a.txt` edited while `gen` ran,
  // `gen` withheld its save, `use` saved over the edit under a key folding
  // `gen`'s, and once `a.txt` was put back `use` hit the edit's output (A-12).
  // Only an upstream whose key this one folds: one read by content
  // (`tasks: []` and a file input) is judged by its bytes. `upstream` holds
  // a hole where a dependency did not run (a skipped one, a restore-tier
  // task's unfinished deps).
  const unkeyedUpstream = foldedTasks.find((u) => u.unkeyed === true)
  let unkeyed = unkeyedUpstream !== undefined
  /** The input `keyStillTrue` found moved under the command (`TaskOutcome.driftedInput`). */
  let driftedInput: string | null | undefined
  const willSave =
    willWrite && args.taintedUpstream !== true && !unkeyed && !keyless && args.belowNoop !== true

  // An executor's own record of executions is a remote store: a run whose
  // policy turns the remote's read or write off keeps it off that record
  // too. A `--cache-policy=remote:` run replayed one, and a run off CI wrote
  // one a CI run on a fresh cache then replayed and uploaded. Only with a
  // remote layer: without one the remote axes read off, and a worker that
  // shares this machine's store (`@vzn/vx-dte`'s `local()`) is no remote.
  const remoteOff = (axis: 'remoteRead' | 'remoteWrite'): boolean =>
    cache.hasRemote === true && !policy[axis]

  // The executor retains nothing: the entry's output is the attempt's
  // `output` log, both streams in the order they reached the logger, kept
  // only when this task will WRITE an entry. Both streams are still drained
  // and still stream chunk-by-chunk to the logger.
  // Deferral is decided at plan time and only ever set for a remote-placed,
  // eligibility-cleared task; it suppresses this machine's clean AND save.
  const deferralRequested = args.download === 'deferred'
  const capture: CaptureConfig = { stdout: false, stderr: false }

  const outputs = cfgOut?.files ?? []
  const wsOutputs = cfgOut?.workspaceFiles ?? []
  const effectiveForwardArgs = node.requested ? (args.forwardArgs ?? []) : []
  // Per-task `exec.timeout` beats `run.timeout` (flag, variable,
  // workspace; resolved into `args.timeout` by run.ts).
  const effectiveTimeout = taskTimeoutMs(step) ?? args.timeout
  // `signal` stops a plugin executor on the run's stop AND on
  // `exec.timeout`: core cannot kill a process an executor spawned, so a
  // declared timeout meant nothing on one that kept its own clock (H-12).
  // The local executor keeps its own timer from the spawn (it signals the
  // process group), so its request carries no clock: armed here, it also
  // timed the sandbox's wrap, and a wrap slower than the timeout aborted
  // the request before the spawn — a task reported killed, never run. So
  // does an executor that declares `timeouts`.
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let timeoutFired = false
  // Fail-fast withdrew the attempt while its executor still held it for a
  // machine to begin (`running` answered `null`): it never started.
  let unbegun = false
  let withdrawUnbegun: (() => void) | undefined
  // The attempt's listener on the run's stop signal, taken off once the
  // attempt settles. Left on, every task of the run added one: the list
  // grew to the task count, and each add scans it for a duplicate, ~100 ms
  // of a 1,000-task cold run.
  let unlistenStop: (() => void) | undefined
  function requestSignal(local: boolean): AbortSignal {
    const stop = new AbortController()
    const abort = (): void => stop.abort(args.stopSignal?.reason)
    unlistenStop?.()
    unlistenStop = undefined
    unbegun = false
    withdrawUnbegun = undefined
    if (args.stopSignal?.aborted === true) abort()
    else if (args.stopSignal !== undefined) {
      const run = args.stopSignal
      run.addEventListener('abort', abort, { once: true })
      unlistenStop = () => run.removeEventListener('abort', abort)
    }
    // `--continue=never` starts nothing after a failure: a task a plugin
    // executor still holds for a machine is not yet started, and was sent
    // to one after the failure (2026-11-06).
    const failFast = args.failFast
    if (!local && failFast !== undefined && args.executor.running !== undefined) {
      const withdraw = (): void => {
        if (stop.signal.aborted || args.executor.running?.(node.id) !== null) return
        unbegun = true
        stop.abort(new Error('fail-fast'))
      }
      withdrawUnbegun = withdraw
      failFast.addEventListener('abort', withdraw, { once: true })
      const unlisten = unlistenStop
      unlistenStop = () => {
        unlisten?.()
        failFast.removeEventListener('abort', withdraw)
      }
    }
    clearTimeout(timeoutTimer)
    timeoutFired = false
    if (effectiveTimeout !== undefined && !local && args.executor.timeouts !== true) {
      timeoutTimer = setTimeout(() => {
        timeoutFired = true
        stop.abort(new Error(`timed out after ${effectiveTimeout}ms`))
      }, effectiveTimeout)
    }
    return stop.signal
  }
  // An executor that ignores `signal` held its task, and so the run, past
  // the stop and past `exec.timeout` (H-14). Once the signal aborts it has
  // the kill grace the local executor gives a process group; then core
  // settles the attempt without it and says so. Its work is abandoned: core
  // cannot reach what it started.
  function boundAfterAbort(
    running: Promise<unknown>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    if (signal === undefined || isLocalExecutor(args.executor)) return running
    const started = performance.now()
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const abandoned = new Promise<ExecuteResult>((resolve) => {
      onAbort = (): void => {
        const graceMs = killGraceMs(SIGNAL_SHUTDOWN_GRACE_MS)
        graceTimer = setTimeout(() => {
          const why = timeoutFired ? `timeout (${effectiveTimeout}ms)` : 'stop'
          log.taskStderr(
            node,
            `${midLine ? '\n' : ''}vx: ${executorLabel(args.executor)} did not return within ${graceMs}ms of the ${why}; abandoned\n`,
          )
          const reason: unknown = signal.reason
          resolve({
            exitCode: signalExitCode(reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM'),
            durationMs: Math.round(performance.now() - started),
            stdout: '',
            stderr: '',
            violations: [],
            // What it started may still run and write the retry's outputs.
            leftRunning: true,
            // Its row named this machine: the task was placed on the executor.
            where: args.executor.name,
            ...(timeoutFired ? { timedOut: true } : {}),
          })
        }, graceMs)
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    // The abandoned call may still settle, or reject, later: nobody awaits it.
    running.catch(() => {})
    return Promise.race([running, abandoned]).finally(() => {
      clearTimeout(graceTimer)
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    })
  }

  // When the task started, as a ns offset from run start — captured for
  // EVERY outcome (hits included) so the run-detail timeline reflects when
  // each task actually ran, not a fabricated `runEnd - duration` window.
  const taskStartNs = process.hrtime.bigint() - args.runStartHrTimeNs

  // Hash is computed mid-run, not at prepareRun time. Tasks whose
  // `inputs.files` matches sibling outputs (e.g. `'**/*'` after
  // a `codegen` step has written `generated.txt`) need the upstream
  // outputs ALREADY on disk when their hash is computed — so we
  // can't lift this into prepareRun. Same model as Turbo / Nx.
  //
  // The PROBE hash is computed WITHOUT capture — a warm all-cache-hit
  // run allocates no component array and pushes nothing (the warm path
  // does zero extra Tier-3 work). The cache-key components for the
  // Tier-3 input fingerprint are captured only on a MISS, by
  // `describeTaskInputs` just before the command spawns (with
  // `captureInto` set) — the HashCache memos plus the gitFilesCache OID
  // map make that pass a fold + array pushes, no re-stat / re-hash I/O.
  //
  // Local short-circuit reuse: when the classify phase already derived
  // this task's stable key + probed it, reuse the up-front hash verbatim
  // (no recompute — a restore-tier task may run before its deps finish,
  // so its live `upstream` is incomplete; the up-front hash is the
  // authoritative stable key) and skip the probe below.
  const preProbed = args.preProbed
  const hash =
    preProbed?.hash ??
    args.upfrontKey ??
    (await keyOf(
      computeTaskHash({
        node,
        upstream,
        workspaceRoot: args.workspaceRoot,
        cache,
        forwardArgs: args.forwardArgs,
        nestedProjectDirs: args.nestedProjectDirs,
        ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
        ...(args.hashCache !== undefined ? { hashCache: args.hashCache } : {}),
        ...(args.probesAfterWrites !== undefined
          ? { probesAfterWrites: args.probesAfterWrites }
          : {}),
      }),
    ))

  // The local no-op half of `exec.remote: 'only'`: no remote executor took
  // the task, so it succeeds without running. The hash was still computed —
  // dependents fold it — and the machine's ambient state (node_modules as
  // installed by the dev) serves dependents exactly as before the field.
  if (args.remoteOnlyNoop === true) {
    return {
      node,
      status: 'success',
      exitCode: 0,
      durationMs: 0,
      hash,
      wallclockStartNs: taskStartNs,
      wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
    }
  }

  const ownInputs = {
    projectDir: node.projectDir,
    workspaceRoot: args.workspaceRoot,
    declared: node.config.inputs,
  }
  const cleanArgs = {
    projectDir: node.projectDir,
    outputs,
    nestedProjectDirs: args.outputNestedDirs ?? args.nestedProjectDirs,
    inputs: ownInputs,
    committed: committedFiles(args.gitFilesCache, node.projectDir),
  }
  const wsCleanArgs = {
    workspaceRoot: args.workspaceRoot,
    outputs: wsOutputs,
    inputs: ownInputs,
    committed: committedFiles(args.gitFilesCache, args.workspaceRoot),
  }
  // An ADDITIVE task (its outputs overlap an upstream's, with the edge that
  // orders them; item 588) does not clean by glob — the glob selects the
  // upstream's files it adds beside. Its outputs are stamped once before
  // the first attempt, and after a 0 exit its own set is what the run
  // added or changed against that stamp, or found as a save or restore of
  // its own left it (`leftByOwnEntries`); a retry first removes what the
  // failed attempt added (`dropFailedAdditions`). Stale files of its own from an
  // earlier run are its command's to clean, as they are under Turbo.
  const additive = (node.addsToOutputsOf?.length ?? 0) > 0
  let stampedBefore: ReadonlyMap<string, OutputStamp> | undefined
  let wsStampedBefore: ReadonlyMap<string, OutputStamp> | undefined
  // A failed attempt changed or removed a file the stamp found, or a
  // committed file under the outputs (no clean deletes one): no retry can
  // put it back, so no entry holds only the passing attempt's work.
  let failedTouchedFound = false
  // The committed files under the outputs as the first attempt found them,
  // stamped only when a retry can follow.
  let committedBefore: ReadonlyMap<string, OutputStamp> | undefined
  let wsCommittedBefore: ReadonlyMap<string, OutputStamp> | undefined
  // The committed files the last attempt's clean found and left (absolute).
  // One its run removed cannot be replayed by a hit, whose restore leaves
  // it too: that run saves nothing (`ownOutputs`).
  let committedKept: string[] = []
  // `outputs.clean: false` leaves the outputs to the first attempt's
  // command, and the save stores whatever they hold after it, a leftover
  // included: the user opted out of the clean-tree guarantee
  // (2026-10-15). A retry still starts clean. An additive task never cleans
  // by glob anyway.
  const keepOutputs = !additive && (cfgOut?.clean ?? args.cleanOutputs ?? true) === false

  // Cache lookup. On hit, time the user-perceived restore op
  // (clean+restore+log-replay) — that's what the framed-block footer
  // shows, not the original exec time stored in the entry. The
  // short-circuit's up-front probe is reused: a `preProbed` entry means
  // the probe already ran — restore its hit, or (null hit) fall straight
  // to the run path as a known stable miss. No second cache.get.
  if (willRead) {
    if (preProbed !== undefined) {
      if (preProbed.hit !== null) return restoreProbed(args, hash, preProbed.hit, taskStartNs)
      // Confirmed stable miss — skip the probe, fall through to run.
    } else if (!fingerprintMoved(args)) {
      const cacheOpStart = performance.now()
      const endProbe = span('cache.get')
      const hit = await cache.get(hash, getContext(node, step.command))
      endProbe()
      if (hit) {
        const restored = await restoreOrMiss(args, hash, hit, cacheOpStart, taskStartNs)
        if (restored !== null) return restored
      }
    }
  }

  const env = taskEnv(node, step, args.workspaceRoot)
  const wallclockStartNs = process.hrtime.bigint() - args.runStartHrTimeNs

  // Miss path: describe the input set ONCE — the executor gets the values
  // (what a remote worker must reproduce) and the save below reuses the
  // captured digest rows for the Tier-3 `entry_inputs` fingerprint, so the
  // fold runs once here instead of once after the subprocess. The HashCache
  // memos + gitFilesCache OID map make this a fold + array pushes, no I/O.
  // A non-cacheable task folds nothing and ships no inputs.
  const captured: TaskInputComponent[] = []
  const described = cfgCacheable
    ? await describeTaskInputs({
        node,
        upstream,
        workspaceRoot: args.workspaceRoot,
        cache,
        forwardArgs: args.forwardArgs,
        nestedProjectDirs: args.nestedProjectDirs,
        captureInto: captured,
        ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
        ...(args.hashCache !== undefined ? { hashCache: args.hashCache } : {}),
        ...(args.probesAfterWrites !== undefined
          ? { probesAfterWrites: args.probesAfterWrites }
          : {}),
      })
    : undefined
  // The command's start for the re-check (`movedInput`), on the clock that
  // stamps its writes: off `Date.now()`, a coarse kernel tick dated an edit
  // in the command's first tick before it, and an edit undone by the end
  // read as an upstream's write of the key's bytes. After the describe, so
  // the stats that tell an upstream's write in its tick apart come first.
  const commandFrom = cfgCacheable
    ? fsClockNow(args.cacheDir ?? path.join(args.workspaceRoot, '.vx'))
    : 0
  /** The other command that may have put a moved input back (`ownRewrite`). */
  let rewroteBy: string | undefined
  /**
   * Under `'mutable'`, a write during the command that left the key's bytes
   * is the task's own identical rewrite only if no other command that may
   * write the file ran between the describe and that write: one that did
   * may have changed it and put it back while this command read it.
   */
  const ownRewrite = (file: string, ctimeMs: number): boolean => {
    rewroteBy = args.commandWindows?.writerDuring(
      node.id,
      file,
      described!.describedAt,
      ctimeMs + racyWindowMs(ctimeMs, 0),
    )
    return rewroteBy === undefined
  }

  /**
   * A committed file under the task's own outputs is keyed (`committedFiles`)
   * and the task may rewrite it (TanStack Router's `routeTree.gen.ts`): the
   * bytes it leaves are an output the entry saves and a restore writes, and
   * they follow from the key, so their change is no moved input.
   */
  const ownOutput = outputs.length === 0 ? undefined : outputMatcher(outputs)
  const ownWsOutput = wsOutputs.length === 0 ? undefined : outputMatcher(wsOutputs)
  const keyedInputs = (facts: readonly InputFact[]): readonly InputFact[] =>
    ownOutput === undefined && ownWsOutput === undefined
      ? facts
      : facts.filter(
          (f) =>
            ownOutput?.(relPosix(node.projectDir, f.path)) !== true &&
            ownWsOutput?.(relPosix(args.workspaceRoot, f.path)) !== true,
        )

  // A name only `exec.env.secret` makes secret is not one the name rule
  // sees later: its row carries the mark, so `vx why` hides its hash (M-63).
  const named = node.config.exec?.env?.secret
  if (named !== undefined)
    for (const c of captured)
      if (c.kind === 'env' && named.includes(c.name) && !secretNamed(c.name))
        c.hash = MASKED + c.hash
  // The values of secret-named variables, masked in what the task prints
  // and what the cache keeps of it (L-11); null when there are none.
  // Built again once the sandbox starts: its proxy token joins them.
  const taskMask = (): SecretMask | null =>
    secretMask([process.env, env, step.env?.define], step.env?.secret)
  let secrets = taskMask()
  let maskHeld = heldSecrets()
  // A runtime probe's row is named by its command, which a TS config may
  // build from `process.env`: the run history stored it and `vx why`
  // printed it (L-11).
  const nameSecrets = captured.length > 0 ? secrets : null
  if (nameSecrets !== null) {
    // Two probes that differ only by a secret mask to one name, and a row
    // is stored once per name: numbered, the second's change still shows.
    const seen = new Set(captured.map((c) => `${c.kind}\0${c.name}`))
    for (const c of captured) {
      const masked = nameSecrets.mask(c.name)
      if (masked === c.name) continue
      let name = masked
      for (let n = 2; seen.has(`${c.kind}\0${name}`); n++) name = `${masked} (${n})`
      seen.add(`${c.kind}\0${name}`)
      c.name = name
    }
  }
  const inputs: TaskInputs | undefined = described?.inputs
  const inputChanges = described !== undefined ? args.explainMiss?.(node.id, captured) : undefined
  // A plugin may keep the request past the run (the cache closed): it gets
  // the upstream outputs read now. Only the local floor leaves them unread.
  if (inputs !== undefined && !isLocalExecutor(args.executor)) await described!.readUpstream()
  // A declared input set that resolves to NOTHING is the quiet stale hit:
  // the key stops moving with this project's source and every later run
  // is a hit. Almost always a glob written against the wrong directory
  // (`lib/**` in a package that builds `src/`). Said once per miss, on the
  // run's status line — the task itself succeeds.
  const declaredInputs = [...(cfg.inputs?.files ?? []), ...(cfg.inputs?.workspaceFiles ?? [])]
  const unmatched =
    inputs === undefined || declaredInputs.length === 0
      ? []
      : inputs.files.length === 0
        ? declaredInputs
        : deadSourceGlobs(
            cfg.inputs,
            inputs.files,
            args.workspaceRoot,
            relPosix(args.workspaceRoot, node.projectDir),
          )
  if (unmatched.length > 0) {
    warnOf(log)(
      `[vx] ${node.id}: inputs matched no files (${unmatched.join(', ')}) — ` +
        `the key will not change when this project's source does` +
        bracketLiteralHint([
          ...(cfg.inputs?.files ?? []).map((g) => [node.projectDir, g] as const),
          ...(cfg.inputs?.workspaceFiles ?? []).map((g) => [args.workspaceRoot, g] as const),
        ]),
    )
  }

  if (inputs !== undefined) {
    const isOwnOutput = (abs: string): boolean =>
      ownOutput?.(relPosix(node.projectDir, abs)) === true ||
      ownWsOutput?.(relPosix(args.workspaceRoot, abs)) === true
    const left = [
      ...ignoredByGlobs(cfg.inputs?.files, node.projectDir, args.workspaceRoot, inputs.files),
      ...ignoredByGlobs(
        cfg.inputs?.workspaceFiles,
        args.workspaceRoot,
        args.workspaceRoot,
        inputs.files,
      ),
    ].filter(([abs]) => !isOwnOutput(abs))
    for (const [, rel, glob] of left) warnOf(log)(`[vx] ${ignoredInputLine(node.id, rel, glob)}`)
  }

  // Sandbox is opt-in per task via `exec.sandbox: {}` (or `{...}`) in the
  // task config. No CLI flag, no workspace inheritance — the task config is
  // the single source of truth, and a violation fails the task (below).
  const userSandbox = cfg.exec?.sandbox !== undefined
  let violations: SandboxViolation[] = []
  // The empty files the sandbox request created for a literal write grant;
  // swept after the attempt (`sweepPlaceholders`).
  let placeholders: Placeholder[] = []
  // The linked workspace packages the request withheld: the key does not
  // answer for them.
  let withheld: WithheldLink[] = []
  // The dependencies' outputs: a write refused there is granted no fix.
  let upstreamOutputs: string[] = []
  // Where this machine's sandbox let the task write (absolute, globs kept):
  // an input changed outside them was not the task's doing. Undefined when
  // unsandboxed or run elsewhere.
  let sandboxWrites: readonly string[] | undefined

  // Cache miss path (or caching disabled), up to `1 + retries` attempts.
  // Explicit config wins over the run-level `--retries` default, including
  // an explicit `retries: 0`.
  const retriesSet = step.retries !== undefined || args.retries !== undefined
  let maxAttempts = 1 + (step.retries ?? args.retries ?? 0)
  let attempt = 0
  let result: ExecuteResult
  let effectiveExitCode: number
  // What THIS run spent on the task, every attempt (`TaskOutcome.durationMs`):
  // the last attempt alone read `max 407ms` beside a footer of 837 (item
  // 1101). A saved entry keeps the attempt that produced it, what a hit saves.
  let spentMs = 0
  // A known flake gets a retry its config did not ask for (below).
  const retryCanFollow =
    maxAttempts > 1 || (!retriesSet && cfgCacheable && !keyless && args.knownFlaky !== undefined)
  // Stamps the committed files a clean found before the first attempt, and
  // before a retry taints the save if a failed attempt moved one.
  const checkCommitted = (
    root: string,
    rels: readonly string[],
    committed: (abs: string) => boolean,
    before: ReadonlyMap<string, OutputStamp> | undefined,
  ): ReadonlyMap<string, OutputStamp> | undefined => {
    if (!retryCanFollow) return undefined
    const files = rels.map((r) => path.resolve(root, r))
    if (before === undefined) return stampCommitted(files, committed)
    if (committedMoved(files, committed, before)) failedTouchedFound = true
    return before
  }

  // vx's own work on the outputs, around a command that exited `exitCode`.
  async function outputsStep<T>(
    step: 'clean' | 'save',
    exitCode: number,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work()
    } catch (err) {
      throw new OutputsFailed(err, step, exitCode, spentMs)
    }
  }

  // One task attempt: clean the declared outputs (before EVERY attempt — so a
  // stale prior-build artifact can't survive into a fresh run, and a failed
  // attempt's partial outputs can't leak into the next; gated on WRITES so a
  // `--no-cache` run leaves the user's tree alone), spawn, and classify the
  // exit (a sandbox violation on a 0 exit → fail; a timeout SIGTERM → the
  // streamed notice). Shared by every attempt of the retry loop, so they
  // can never drift on the spawn/clean/classify path.
  async function runAttempt(): Promise<{
    result: ExecuteResult
    exitCode: number
    withdrawn?: true
    unbegun?: true
  }> {
    // The first attempt under `clean: false` finds its last outputs (tsc's `.tsbuildinfo`).
    const clean = willWrite && !deferralRequested && !(keepOutputs && attempt === 1)
    // A deferred task's outputs are deliberately NOT coming, so wiping the
    // tree would replace a stale build with nothing at all. The eligibility
    // gate guarantees no key in this run can see what stays behind, and the
    // summary names every deferred task so `dist/` is not silently stale.
    // Its throw (a name vx cannot clear) fails the task before this
    // attempt's command: no exit of its own to name.
    await outputsStep('clean', attempt > 1 ? effectiveExitCode : 1, async () => {
      committedKept = []
      if (additive && willWrite && !deferralRequested && outputs.length > 0) {
        const endStamp = span('miss: stamp outputs')
        if (stampedBefore === undefined) stampedBefore = await stampOutputs(cleanArgs)
        else {
          const rels = await dropFailedAdditions(
            node.projectDir,
            outputs,
            stampedBefore,
            cleanArgs.committed,
            await ownOutputsSince(cleanArgs, stampedBefore),
            () => resolveOutputs(cleanArgs),
          )
          args.gitFilesCache?.markOutputsChanged(node.projectDir, rels)
        }
        endStamp()
      } else if (clean && outputs.length > 0) {
        // Mark the wiped paths, exactly as the workspace twin below does. The
        // git snapshot still lists them with their committed index OIDs, and
        // resolveFiles SKIPS its existence probe for any path carrying a
        // trusted OID — so a declared output the producer deletes and does not
        // re-create would stay in a same-project consumer's input set, keeping
        // that consumer's key unchanged while the file is gone from disk.
        const endClean = span('miss: clean outputs')
        const cleanedRels = await cleanOutputs({
          ...cleanArgs,
          beforeRun: true,
          kept: committedKept,
        })
        endClean()
        args.gitFilesCache?.markOutputsChanged(node.projectDir, cleanedRels)
        committedBefore = checkCommitted(
          node.projectDir,
          cleanedRels,
          cleanArgs.committed,
          committedBefore,
        )
      } else if (keepOutputs && willWrite && !deferralRequested && outputs.length > 0) {
        committedBefore = checkCommitted(
          node.projectDir,
          retryCanFollow
            ? (await resolveOutputs(cleanArgs)).map((f) => relPosix(node.projectDir, f))
            : [],
          cleanArgs.committed,
          committedBefore,
        )
      }
      if (additive && willWrite && !deferralRequested && wsOutputs.length > 0) {
        // A root-anchored addition is stamped as the project one above: a
        // glob clean deleted the upstream's files before this task, which
        // reads them, ran (A-43).
        if (wsStampedBefore === undefined)
          wsStampedBefore = await stampWorkspaceOutputs(wsCleanArgs)
        else {
          const rels = await dropFailedAdditions(
            args.workspaceRoot,
            wsOutputs,
            wsStampedBefore,
            wsCleanArgs.committed,
            await ownWorkspaceOutputsSince(wsCleanArgs, wsStampedBefore),
            () => resolveWorkspaceOutputs(wsCleanArgs),
          )
          args.gitFilesCache?.markWorkspaceOutputsChanged(args.workspaceRoot, rels)
        }
      } else if (clean && wsOutputs.length > 0) {
        // Root-anchored deletions can land in other projects' dirs; mark
        // them so stale per-project git snapshots can't survive the wipe.
        const cleanedWsRels = await cleanWorkspaceOutputs({
          ...wsCleanArgs,
          beforeRun: true,
          kept: committedKept,
        })
        args.gitFilesCache?.markWorkspaceOutputsChanged(args.workspaceRoot, cleanedWsRels)
        wsCommittedBefore = checkCommitted(
          args.workspaceRoot,
          cleanedWsRels,
          wsCleanArgs.committed,
          wsCommittedBefore,
        )
      } else if (keepOutputs && willWrite && !deferralRequested && wsOutputs.length > 0) {
        wsCommittedBefore = checkCommitted(
          args.workspaceRoot,
          retryCanFollow
            ? (await resolveWorkspaceOutputs(wsCleanArgs)).map((f) =>
                relPosix(args.workspaceRoot, f),
              )
            : [],
          wsCleanArgs.committed,
          wsCommittedBefore,
        )
      }
    })
    // What the attempt before this one left, put back if this one is
    // withdrawn: it stands, with its output and its refusals.
    const standing = { output, violations, flushMasked }
    violations = []
    const endReq = span('miss: build request')
    const req = await buildRequest(isLocalExecutor(args.executor))
    endReq()
    // A sibling's failure under --continue=never can land while a retry
    // cleans or builds its request, after the loop's own check: the retry
    // is withdrawn and the attempt before it stands.
    if (attempt > 1 && args.failFast?.aborted === true) {
      output = standing.output
      violations = standing.violations
      flushMasked = standing.flushMasked
      clearTimeout(timeoutTimer)
      unlistenStop?.()
      unlistenStop = undefined
      await sweepPlaceholders(placeholders)
      return { result, exitCode: effectiveExitCode, withdrawn: true }
    }
    // An executor that THROWS produces no captured output. Rethrown: the
    // scheduler classifies it and prints its one line into the task's own
    // stream (run()'s onError), where the frame reads it; a copy written
    // here too printed the reason twice.
    const endExec = span('miss: execute')
    // A plugin's execute may throw before returning or return a bare result:
    // the throw is its rejection, the value its resolution, so both reach
    // the naming catch and the cleanup in finally below.
    let running: Promise<unknown>
    // A file the key holds outside the project that no grant reaches is
    // not there inside the sandbox, so the run cannot see what its key says
    // (a build that falls back on a hidden root `tsconfig.base.json` emits
    // other code, and oxlint without its `.oxlintrc.json` passes). Known
    // from the request, so the command is never spawned: a stat-first tool
    // leaves no record, and a read past the wall is no violation. One in
    // the project is a violation when opened, and a key may hold one the
    // task never reads.
    const unseen =
      req.sandbox !== undefined &&
      described !== undefined &&
      (cfg.inputs?.workspaceFiles?.length ?? 0) > 0
        ? keyedOutsideGrants(
            req.sandbox,
            args.workspaceRoot,
            outsideProject(described.inputs.files, relPosix(args.workspaceRoot, node.projectDir)),
          )
        : []
    const closeWindow =
      unseen.length > 0
        ? () => {}
        : (args.commandWindows?.open(
            node.id,
            node.projectDir,
            commandWriteReach(node, args.workspaceRoot),
          ) ?? (() => {}))
    if (unseen.length === 0) args.executing?.(node.id)
    try {
      running = Promise.resolve(
        unseen.length > 0
          ? unseenResult(unseen, node.projectDir, args.workspaceRoot)
          : args.executor.execute(req),
      )
    } catch (thrown) {
      running = Promise.reject(thrown)
    }
    // A failure that landed while the request was built: the executor holds it now.
    if (args.failFast?.aborted === true) withdrawUnbegun?.()
    let res = await boundAfterAbort(running, req.signal)
      .then((r: unknown) => {
        assertExecuteResult(args.executor.name, node.id, r)
        return r
      })
      .catch(async (thrown: unknown) => {
        let raw = thrown
        // A remote that gives the task back (it never started it): run it on
        // the local floor with a request of its own, so its timeout counts
        // from now. `remote: 'only'` keeps it off this machine: refused.
        if (isExecutorFallback(raw) && args.executor.remote === true) {
          const why = secrets?.mask(raw.message) ?? raw.message
          if (remoteOnly) {
            raw = new UserError(`${why}, and remote: 'only' keeps it off this machine`)
          } else if (args.executor.exclusive === true) {
            raw = new UserError(`${why}, and ${args.executor.name} runs no task on this machine`)
          } else {
            warnOf(log)(
              `[vx] ${node.id}: ${executorLabel(args.executor)} gave it back: ${why} — running it here`,
            )
            const local = await localExecutor().execute(await buildRequest(true))
            assertExecuteResult('local', node.id, local)
            return local
          }
        }
        const err = nameExecutorFailure(args.executor, raw)
        // A remote executor's message carries the server's own text, which
        // may echo the env it was sent: masked on the error the scheduler
        // prints with its cause (L-39).
        if (secrets !== null) {
          for (const e of [err, err instanceof Error ? err.cause : undefined])
            if (e instanceof Error) e.message = secrets.mask(e.message)
        }
        await sweepPlaceholders(placeholders)
        throw err
      })
      .finally(() => {
        closeWindow()
        clearTimeout(timeoutTimer)
        unlistenStop?.()
        unlistenStop = undefined
        flushMasked()
        load = untrack?.() ?? load
        untrack = undefined
      })
      .catch((thrown: unknown) => {
        // The scheduler prints the throw's line into the task's stream,
        // after the masked tail the finally above flushed.
        if (midLine) log.taskStderr(node, '\n')
        throw thrown
      })
    endExec()
    // A locked directory moved away after `vx lock`: the spawn's "working
    // directory does not exist" named no way out (X-144). Asked only here.
    if (res.spawnFailed === true && !existsSync(node.projectDir)) {
      await sweepPlaceholders(placeholders)
      throw new UserError(
        lockedDirGone(args.workspaceRoot, node.projectName, node.projectDir),
        'VX_E_LOCK',
      )
    }
    if (unbegun) {
      await sweepPlaceholders(placeholders)
      if (attempt === 1) return { result: res, exitCode: res.exitCode, unbegun: true }
      // A retry withdrawn: the attempt before it stands, as above.
      output = standing.output
      violations = standing.violations
      flushMasked = standing.flushMasked
      return { result, exitCode: effectiveExitCode, withdrawn: true }
    }
    if (secrets !== null)
      res = {
        ...res,
        stdout: maskCaptured(res.stdout, secrets),
        stderr: maskCaptured(res.stderr, secrets),
      }
    // An executor that stopped on the timeout's abort timed out, whatever
    // its exit: a child that traps the TERM and exits 0 left partial outputs
    // a pass would save (X-125), as the local runner's own `timedOut` says.
    // A local request carries no timer, so the runner alone decides there.
    if (timeoutFired && res.timedOut !== true) res = { ...res, timedOut: true }
    violations = [...res.violations]
    // A denial under a dependency the key does not answer for says only
    // ENOENT; the line beside it names the package and how to key it. Only
    // with a denial there, so it never reddens a pass.
    for (const w of reachedWithheld(withheld, violations)) {
      violations.push({
        timestamp: new Date(),
        hint: true,
        line: withheldLinkLine(node.id, w, args.projectAt?.(w.target)),
      })
    }
    // A placeholder the task never wrote is not its output: take it back
    // before the outputs are collected. On a failure it is also the one
    // clue to a grant that meant a directory — say so beside the failure.
    const untouched = await sweepPlaceholders(placeholders)
    if (res.exitCode !== 0 && violations.length === 0) {
      for (const p of untouched) {
        violations.push({
          timestamp: new Date(),
          hint: true,
          line: untouchedPlaceholderLine(node.projectDir, p),
        })
      }
    }
    // Fail-on-violation, on BOTH platforms: macOS reads SRT's structured
    // violation store, Linux parses the strace log the sandboxed spawn
    // writes. (This comment used to claim Linux violations are "always 0"
    // and that enforcement there rests on the child failing naturally — true
    // before the strace pass shipped, false since, and the branch below is
    // live on Linux.) Violations surface via `TaskOutcome.sandboxViolationLines`.
    let code = res.exitCode
    // ANY violation fails the task (2026-09-05). A sandboxed task
    // declares what it touches; a denial means it touched something else,
    // and an artifact built while reading — or failing to read — something
    // the cache key never folded is not a safe thing to replay. A task that
    // survives the denial is the dangerous case, not the harmless one:
    // that is precisely the run that succeeds and caches a wrong result.
    if (userSandbox && violations.some((v) => v.hint !== true) && code === 0) code = 1
    // A declared sandbox fails the task on any violation — that is its
    // whole contract. `userSandbox` is the only way a task is sandboxed,
    // so this reads as "sandboxed and it tripped".
    // A child we SIGTERMed for exceeding the timeout is a genuine failure —
    // stream a clear line so the 143 exit reads as a timeout. One that outlived
    // the grace died of the SIGKILL, and the line said SIGTERM over an exit
    // 137 (item 1063); so did a shell dead of the SIGTERM whose leftover the
    // SIGKILL took.
    if (res.timedOut) {
      // A plugin executor's child is its own: core only aborted its request,
      // or, on the executor's own clock, aborted nothing.
      const how = !isLocalExecutor(args.executor)
        ? timeoutFired
          ? 'its executor was aborted'
          : 'as its executor reported'
        : res.signal === 'SIGKILL' || res.killedAfterGrace === true
          ? 'killed (SIGKILL after the SIGTERM grace)'
          : 'killed (SIGTERM)'
      const after = effectiveTimeout === undefined ? '' : ` after ${effectiveTimeout}ms`
      log.taskStderr(node, `${midLine ? '\n' : ''}[vx] timed out${after} — ${how}\n`)
      // Force a non-zero classification even if the child TRAPPED SIGTERM and
      // still exited 0 (`trap 'exit 0' TERM`, a common graceful-shutdown
      // pattern). Without this a timed-out task is classified `success` and its
      // PARTIAL outputs are cached + replayed forever — the run even reports
      // green. The timeout is a real, retryable failure; a genuinely-killed
      // child already reports 143, so this only rewrites the trap-exit-0 case.
      if (code === 0) code = signalExitCode('SIGTERM')
    }
    // The shell's 127 and 126 name the word and nothing about why — the
    // PATH vx built, or a `#!` line the file itself carries (items 257,
    // 258) — and an exit above 128 is a signal's number and nothing
    // about what sent it (259). One frame line names the rule. A spawn that
    // threw ran no shell: its 127 is vx's, and the line would send the
    // reader after a command that exists (A-41). A run's stop killed it
    // itself: the SIGKILL past the grace read as the OOM killer's. A
    // SIGINT/SIGTERM death waits a turn for a pending handler first, as the
    // shutdown check below does: a Ctrl-C reaches the child and vx together.
    if (
      !res.timedOut &&
      (res.signal === 'SIGINT' || res.signal === 'SIGTERM') &&
      args.stopSignal?.aborted !== true
    )
      await new Promise((resolve) => setTimeout(resolve, 0))
    if (!res.timedOut && res.spawnFailed !== true && args.stopSignal?.aborted !== true) {
      const verdict = shellVerdict({
        code,
        command: step.command,
        cwd: node.projectDir,
        bins: taskBinDirs(node, args.workspaceRoot),
        signal: res.signal,
        hidden: req.sandbox && ((f: string) => !sandboxReads(req.sandbox!, f)),
        stderr: errTail,
      })
      // The line quotes the command's first word, which a config may have
      // built from a secret: masked as the task's own output is (L-37).
      if (verdict !== undefined)
        log.taskStderr(node, `${midLine ? '\n' : ''}${secrets?.mask(verdict) ?? verdict}\n`)
    }
    return { result: res, exitCode: code }
  }

  // This task is about to run a command HERE, and it missed the cache, so
  // whatever its dependency closure produced has to actually be on disk.
  // Producers left deferred are fetched now — once per run, concurrently,
  // on this task's own worker slot, because they are its real critical
  // path. A remote-placed task needs nothing: its worker grafts the
  // upstream bytes by reference. A cache HIT reads no inputs at all.
  if (args.executor.remote !== true && args.deferred !== undefined) {
    try {
      await args.deferred.materializeFor(node)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Nothing ran: the note is the frame's first line.
      log.taskStderr(node, `[vx] ${msg}\n`)
      return {
        node,
        status: 'failed',
        exitCode: 1,
        durationMs: 0,
        hash,
        wallclockStartNs: taskStartNs,
        wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
      }
    }
  }

  let flushMasked = (): void => {}
  // The attempt's output, both streams, last ended mid-line: vx's own line
  // (a retry, a timeout, the shell's verdict, an abandoned or thrown
  // executor) starts its own, and only then: a newline always before it
  // printed a blank line under the OUTPUT rule or the task's last line. Glued, a frame read
  // `partialvx: retrying …`.
  let midLine = false
  /** The attempt's last stderr: the shell's "not found" line names the word a compound command missed (shell-verdict.ts). */
  let errTail = ''
  // The attempt's output as the logger got it (masked): the entry's when
  // the task saves, else only what a failure reports (`failedOutput`).
  let output: BoundedCapture | undefined
  // Masked again whole: the live stream lets a held piece go after a pause.
  const storedOutput = (): string => encodeOutputLog(output?.chunks() ?? [], secrets ?? undefined)
  const failedAttempts: { endedAt: number; exitCode: number; timedOut?: true }[] = []
  // Each failed attempt's output, beside `failedAttempts`: kept for `vx last --log`.
  const attemptOutputs: string[] = []
  // Any attempt's shell left a process running, not only the last one's.
  let leftRunning = false
  // The sampling of the attempt's process tree, stopped once it settles.
  let untrack: (() => TreeLoad | undefined) | undefined
  // What the last attempt's samples saw, for the run history.
  let load: TreeLoad | undefined
  // The entry's command is shown by `vx why` and sent with the entry to a
  // remote cache: a value a config interpolated stays out of both.
  const storedCommand = secrets?.mask(step.command) ?? step.command

  // Pass or fail, the command may have written where its project's
  // run-start facts describe; a remote executor wrote on its own disk.
  const writeReach =
    args.executor.remote === true ? 'none' : undeclaredWriteReach(node, args.workspaceRoot)
  const writesFingerprint =
    args.executor.remote !== true &&
    mayWriteFingerprint(node, args.workspaceRoot, claimedFiles(args))
  // A stop that landed during the awaits above (the key, the probe, the
  // input description): the first attempt would wipe the last build and
  // hand the executor a request after the run had stopped. Through a call,
  // so the loop's own reads of the stop are not narrowed to false.
  if (isAborted(args.stopSignal)) {
    return {
      node,
      status: 'aborted',
      exitCode: signalExitCode(forwardedSignal(args.stopSignal?.reason)),
      durationMs: 0,
      hash,
      wallclockStartNs,
      wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
    }
  }
  for (;;) {
    attempt++
    const a = await runAttempt()
    // Never started: skipped, as fail-fast skips a task not yet dispatched.
    if (a.unbegun) {
      return {
        node,
        status: 'skipped',
        exitCode: 1,
        durationMs: 0,
        hash,
        wallclockStartNs,
        wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
      }
    }
    result = a.result
    effectiveExitCode = a.exitCode
    if (a.withdrawn) {
      attempt--
      failedAttempts.pop()
      attemptOutputs.pop()
      break
    }
    // A failed attempt's leftover may write into the retry's outputs too.
    // It is not killed, as a passing attempt's is not: only the save is
    // withheld (`nothingLeftRunning`), and its dependents' (`args.leftRunning`).
    if (result.leftRunning === true && !leftRunning) {
      leftRunning = true
      args.leftRunning?.(node)
    }
    forgetUndeclaredWrites(args, writeReach)
    if (writesFingerprint) args.fingerprintWatch?.wrote()
    spentMs += result.durationMs

    // An attempt that ended in a shutdown never finished on its own terms —
    // it is aborted, so it is neither cached, counted, shown, nor RETRIED.
    // The RUN stopping is what says so. A child that traps the forwarded
    // SIGINT and exits 0 was cached as a success with its partial outputs,
    // one that exits 1 was retried after Ctrl-C, and one SIGKILLed at the
    // end of the grace read as an OOM failure (item 962). A child that died
    // of SIGINT / SIGTERM while the run was NOT stopping (a supervisor, a
    // `kill` from another shell) is a failure: it was labelled a shutdown
    // abort, never retried, its output hidden, and fail-fast never tripped
    // (item 1100). A terminal's Ctrl-C reaches the child and vx together,
    // and the child's exit can be seen before vx's own handler has run, so
    // a signal death waits one event-loop turn for a pending handler before
    // it is judged; a timeout's SIGTERM is our own deadline and judged now.
    let shutdown = args.stopSignal?.aborted === true
    if (
      !shutdown &&
      (result.signal === 'SIGINT' || result.signal === 'SIGTERM') &&
      !result.timedOut
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      shutdown = args.stopSignal?.aborted === true
    }
    if (shutdown) {
      return {
        node,
        status: 'aborted',
        exitCode: effectiveExitCode,
        durationMs: spentMs,
        hash,
        wallclockStartNs,
        wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
        ...(result.where !== undefined ? { where: result.where } : {}),
      }
    }

    // A known flake gets the one retry its config did not ask for; a
    // timeout always fails, and a task whose key names nothing (no cache
    // block, or keyed on a keyless upstream) has no record to know it by.
    if (
      effectiveExitCode !== 0 &&
      attempt === 1 &&
      !retriesSet &&
      result.timedOut !== true &&
      cfgCacheable &&
      !keyless &&
      args.failFast?.aborted !== true &&
      args.knownFlaky?.(node, hash) === true
    )
      maxAttempts = 2
    if (effectiveExitCode === 0 || attempt >= maxAttempts || args.failFast?.aborted === true) break
    failedAttempts.push({
      endedAt: Date.now(),
      exitCode: effectiveExitCode,
      ...(result.timedOut === true ? { timedOut: true as const } : {}),
    })
    // The outcome's SANDBOX VIOLATIONS section is the last attempt's: a
    // retried attempt's refusals go into its own output, kept for
    // `vx last --log`, as the section prints them.
    const refused = new Set<string>()
    let denials = 0
    for (const v of violations) {
      const line = printable(secrets?.mask(v.line) ?? v.line)
      if (!refused.has(line) && v.hint !== true) denials++
      refused.add(line)
    }
    if (refused.size > 0 && output !== undefined) {
      const section = `${midLine ? '\n' : ''}${denials > 0 ? `SANDBOX VIOLATIONS (${denials})` : 'SANDBOX'}\n${[...refused].join('\n')}\n`
      output.push(section, true)
      log.taskStderr(node, section)
      midLine = false
    }
    attemptOutputs.push(
      output === undefined ? '' : failedOutputLog(output, true, secrets ?? undefined),
    )
    // The shell's own exit 0 failed only on the refusal: `exit 1` named
    // nothing that happened.
    const why =
      result.timedOut === true
        ? 'a timeout'
        : result.exitCode === 0 && denials > 0
          ? `${denials} sandbox violation${denials === 1 ? '' : 's'}`
          : `exit ${effectiveExitCode}`
    log.taskStderr(
      node,
      `${midLine ? '\n' : ''}vx: retrying ${node.id} (attempt ${attempt + 1}/${maxAttempts}) after ${why}\n`,
    )
  }

  async function buildRequest(local: boolean): Promise<ExecuteRequest> {
    // A remote executor enforces it where it runs the task. Armed before
    // the streams' mask: its start holds the proxy's token, which the
    // task's env carries (`initSandbox`).
    if (userSandbox && args.executor.remote !== true) {
      await args.armSandbox?.()
      if (maskHeld !== heldSecrets()) {
        maskHeld = heldSecrets()
        secrets = taskMask()
      }
    }
    const kept =
      willSave || args.keepRun !== undefined
        ? new BoundedCapture()
        : new BoundedCapture(FAILED_OUTPUT_HEAD_CHARS, FAILED_OUTPUT_TAIL_CHARS)
    output = kept
    midLine = false
    errTail = ''
    const toOut = (t: string): void => {
      kept.push(t)
      if (t.length > 0) midLine = !t.endsWith('\n')
      log.taskStdout(node, t)
    }
    const toErr = (t: string): void => {
      kept.push(t, true)
      if (t.length > 0) midLine = !t.endsWith('\n')
      errTail = (errTail + t).slice(-2048)
      log.taskStderr(node, t)
    }
    if (secrets) taskLogMasks.set(node, secrets)
    const masked = secrets && maskedStreams(secrets, toOut, toErr)
    flushMasked = () => masked?.end()
    // A plugin executor gets frozen copies of what core goes on reading:
    // the outputs it saves, the config two tasks declared alike share, the
    // run's args. One that emptied its outputs saved an empty artifact a
    // later hit restored; one that set its define ran the next task with it.
    const own = <T extends object>(v: T): T =>
      local ? v : Object.freeze(Array.isArray(v) ? ([...v] as T) : { ...v })
    const base: ExecuteRequest = {
      taskId: node.id,
      ...(attempt > 1 ? { attempt } : {}),
      workspaceRoot: args.workspaceRoot,
      command: step.command,
      forwardArgs: own(effectiveForwardArgs),
      cwd: node.projectDir,
      env,
      envDefine: own(step.env?.define ?? {}),
      capture,
      onStdout: masked ? masked.out : toOut,
      onStderr: masked ? masked.err : toErr,
      ...(args.liveChildren !== undefined ? { liveChildren: args.liveChildren } : {}),
      ...(args.track !== undefined
        ? {
            onSpawn: (pid: number) => {
              untrack?.()
              untrack = args.track!(node.id, pid)
            },
          }
        : {}),
      ...(effectiveTimeout !== undefined ? { timeoutMs: effectiveTimeout } : {}),
      ...(inputs !== undefined ? { inputs } : {}),
      ...(cfgCacheable ? { cacheKey: hash } : {}),
      ...(cfgCacheable && ((!remoteOnly && !willSave) || remoteOff('remoteWrite'))
        ? { unsaved: true }
        : {}),
      ...(remoteOnly ? { remoteOnly: true } : {}),
      ...(node.platform !== undefined ? { platform: node.platform } : {}),
      ...(node.worker !== undefined ? { worker: node.worker } : {}),
      ...(deferralRequested ? { download: 'deferred' as const } : {}),
      // `--force`/`--no-cache` reach a remote executor's private record
      // through this flag — the policy gates above only cover vx's OWN cache.
      ...(cfgCacheable && (!(policy.localRead || policy.remoteRead) || remoteOff('remoteRead'))
        ? { refresh: true }
        : {}),
      outputs: { files: own(outputs), workspaceFiles: own(wsOutputs) },
      ...(args.terminal === true ? { terminal: true as const } : {}),
      ...(args.servers === undefined
        ? {}
        : {
            servers: args.servers.map((s, i) =>
              serverSpec(s, args.workspaceRoot, args.serversNested?.[i] ?? []),
            ),
          }),
    }
    // The signal last: it arms a plugin's `exec.timeout`, and the sandbox's arming
    // above is vx's work, not the task's. Armed first, a 60 ms timeout
    // expired before the spawn and failed `echo` as timed out, unrun.
    if (!userSandbox) return { ...base, signal: requestSignal(local) }
    const deps = await dependencyReads(args.readableDeps?.(node) ?? [], args.workspaceRoot)
    const sb = await sandboxRequestFor(
      node,
      step.sandbox!,
      args.workspaceRoot,
      cfgCacheable ? args.keyedProjects(node) : undefined,
      args.nestedProjectDirs,
      args.cacheDir,
      deps.reads,
      deps.reported,
      args.nestedDirsOf,
    )
    placeholders = sb.placeholders
    withheld = sb.withheld
    upstreamOutputs = [...deps.reads, ...deps.reported]
    const c = sb.sandbox.config
    sandboxWrites = local
      ? [
          ...c.allowWrite,
          ...(c.pendingWrites ?? []),
          ...(c.linkedWrites ?? []).flatMap((l) => [l.link, l.target]),
        ]
      : undefined
    return { ...base, sandbox: sb.sandbox, signal: requestSignal(local) }
  }

  const wallclockEndNs = process.hrtime.bigint() - args.runStartHrTimeNs

  const stability = inputStabilityOf(args.node.config.inputs, args.inputStability)
  let movedFails: string | undefined
  let own: Awaited<ReturnType<typeof ownOutputs>>
  let saved = false
  // An unsaved miss's outputs, as a save's are counted: its row's `outputs`.
  let unsavedBytes: number | undefined
  if (
    effectiveExitCode === 0 &&
    willSave &&
    (deferralRequested || result.outputs?.kind === 'deferred')
  ) {
    // The outputs never landed here: no artifact, no rows. A partial local
    // record (a row with no artifact) is exactly the corrupt-entry shape
    // `restoreOutputs` refuses, so writing none is the only clean answer.
    // The closure is what a later local consumer — or a later eager run —
    // pulls the bytes with. Its fetch saves them under `hash` only past the
    // eager save's check: an input edited before the describe filed the
    // edit's bytes under the old key (X-123).
    const materialize = result.outputs?.kind === 'deferred' ? result.outputs.materialize : undefined
    if (materialize !== undefined) {
      const keyed = (await keyStillTrue()) && (await args.serverDiedUnder?.(node)) !== true
      args.deferred?.register(node.id, {
        materialize,
        ...(keyed ? { hash } : {}),
        entry: {
          taskId: node.id,
          command: storedCommand,
          durationMs: result.durationMs,
          stdout: storedOutput(),
          ...(result.cpuMs !== undefined ? { cpuMs: result.cpuMs } : {}),
          ...(result.peakRssBytes !== undefined ? { peakRssBytes: result.peakRssBytes } : {}),
        },
      })
    }
  } else if (
    effectiveExitCode === 0 &&
    willSave &&
    nothingLeftRunning() &&
    (await keyStillTrue()) &&
    (await args.serverDiedUnder?.(node)) !== true &&
    (own = await ownOutputs()) !== undefined
  ) {
    const { landed } = await outputsStep('save', effectiveExitCode, () =>
      saveMiss({
        ...own,
        node,
        hash,
        cache,
        log,
        workspaceRoot: args.workspaceRoot,
        nestedProjectDirs: args.outputNestedDirs ?? args.nestedProjectDirs,
        gitFilesCache: args.gitFilesCache,
        outputs,
        wsOutputs,
        captured,
        command: storedCommand,
        durationMs: result.durationMs,
        stdout: storedOutput(),
        ...(result.cpuMs !== undefined ? { cpuMs: result.cpuMs } : {}),
        ...(result.peakRssBytes !== undefined ? { peakRssBytes: result.peakRssBytes } : {}),
        outputDirSnapshots: args.outputDirSnapshots,
        deferSave: args.deferSave,
        // A sink listens: say what the save cost.
        measure: args.explainMiss !== undefined,
      }),
    )
    // A run that settles the outcome on `landed` learns there whether the
    // entry is in; without one, the save is done (a `--force` save may have kept the entry it found).
    if (args.deferredSaves !== undefined) args.deferredSaves.set(node.id, landed)
    else saved = (await landed).saved === true
  } else if (cfgCacheable && !remoteOnly && !deferralRequested && args.noDependants === true) {
    // Nothing reads after it, so nothing to mark: only its row's `outputs`.
    if (effectiveExitCode === 0)
      unsavedBytes = await unsavedOutputBytes({
        node,
        workspaceRoot: args.workspaceRoot,
        nestedProjectDirs: args.outputNestedDirs ?? args.nestedProjectDirs,
        outputs,
        wsOutputs,
      })
  } else if (cfgCacheable && !remoteOnly && !deferralRequested) {
    // Ran here and saves nothing — failed, a read-only policy, a tainted
    // upstream, a server that died under it, a key that no longer held —
    // yet it wrote what a save would have marked, and may have rewritten an
    // input the re-check before a save catches. A same-run reader keyed
    // from the snapshot's OIDs for either replayed the bytes from before the command (item 750). A
    // withheld save already dropped the project; this finds the same move
    // again and drops it again.
    const endCheck = span('miss: recheck inputs')
    const moved = await movedSinceKey()
    endCheck()
    if (moved !== undefined) {
      forgetUndeclaredWrites(args, wsOutputs.length > 0 ? 'workspace' : 'project')
    } else {
      unsavedBytes = await markUnsaved({
        node,
        workspaceRoot: args.workspaceRoot,
        nestedProjectDirs: args.outputNestedDirs ?? args.nestedProjectDirs,
        gitFilesCache: args.gitFilesCache,
        outputs,
        wsOutputs,
      })
    }
  }

  /**
   * What an additive run saves as its own, or undefined when it removed a
   * file it found: no entry replays a removal (`ownOutputsSince`), so the
   * task saves nothing and runs again. Undefined too for any task when a
   * failed attempt moved a file no clean removed (`failedTouchedFound`),
   * or the run removed a committed file its clean left (`committedKept`).
   */
  async function ownOutputs(): Promise<
    { ownOutputFiles?: string[]; ownWsOutputFiles?: string[] } | undefined
  > {
    if (failedTouchedFound) return undefined
    if (committedKept.some((f) => lstatSync(f, { throwIfNoEntry: false }) === undefined))
      return undefined
    const mine: { ownOutputFiles?: string[]; ownWsOutputFiles?: string[] } = {}
    const left = leftByOwnEntries()
    if (stampedBefore !== undefined) {
      const files = await ownOutputsSince(cleanArgs, stampedBefore, left)
      if (files === undefined) return undefined
      mine.ownOutputFiles = files
    }
    if (wsStampedBefore !== undefined) {
      const files = await ownWorkspaceOutputsSince(wsCleanArgs, wsStampedBefore, left)
      if (files === undefined) return undefined
      mine.ownWsOutputFiles = files
    }
    return mine
  }

  /**
   * Whether a file the additive run found and left alone is one a save or
   * restore of this task left there: the proof a hit trusts
   * (`isOutputsCurrent`) against the rows of any of its entries. Read on
   * the first such file only; the upstream's files and what nobody saved
   * have no row of this task's and stay the upstream's.
   */
  function leftByOwnEntries(): (abs: string) => boolean {
    let byPath: Map<string, Array<[root: string, row: OutputFileRow]>> | undefined
    return (abs) => {
      if (byPath === undefined) {
        byPath = new Map()
        const hashes = taskEntryHashes(args.cache, node.id)
        for (const rows of args.cache.loadOutputFilesBatch(hashes).values()) {
          for (const row of rows) {
            if (row.ino === undefined) continue
            const ws = row.path.startsWith(WORKSPACE_OUTPUT_PREFIX)
            const root = ws ? args.workspaceRoot : node.projectDir
            const rel = ws ? row.path.slice(WORKSPACE_OUTPUT_PREFIX.length) : row.path
            const at = path.join(root, rel)
            const list = byPath.get(at)
            const entry: [string, OutputFileRow] = [root, { ...row, path: rel }]
            if (list === undefined) byPath.set(at, [entry])
            else list.push(entry)
          }
        }
      }
      return (byPath.get(abs) ?? []).some(([root, row]) => args.cache.isOutputsCurrent(root, [row]))
    }
  }

  /**
   * Before an additive task's retry: remove what the failed attempt added
   * against the first stamp, as an exclusive task's clean removes it, so
   * the stamp still tells the retry's work from what the task found. A
   * found file it changed or removed stays as it is and taints the save.
   * Returns the removed paths, `root`-relative.
   */
  async function dropFailedAdditions(
    root: string,
    outs: readonly string[],
    before: ReadonlyMap<string, OutputStamp>,
    committed: (abs: string) => boolean,
    changed: string[] | undefined,
    walk: () => Promise<string[]>,
  ): Promise<string[]> {
    const added = (changed ?? (await walk())).filter((f) => !before.has(f))
    if (changed === undefined || added.length < changed.length) failedTouchedFound = true
    const rels = added.map((f) => relPosix(root, f))
    if (rels.length > 0)
      await cleanOutputPaths({ projectDir: root, rels, outputs: outs, committed })
    return rels
  }

  /**
   * A process the shell left behind still held its output when the drain
   * bound cut it, so it may still write outputs: a save now would file a
   * tree the run does not leave, and a hit elsewhere would replay it.
   */
  function nothingLeftRunning(): boolean {
    if (!leftRunning) return true
    warnOf(log)(
      `[vx] ${node.id}: a process it left running may still write its outputs — ` +
        `the result stands, but is not saved; wait for it in the command (\`wait\`)`,
    )
    return false
  }

  /**
   * The input that no longer holds what the key folded, or one the key did
   * not fold that is there now: `null` when the key re-derived just before
   * the command already differed (the file unnamed), undefined when none
   * moved.
   */
  async function movedSinceKey(): Promise<string | null | undefined> {
    if (described!.hash !== hash) return null
    // Changed where an executor ran it: this disk never shows it.
    if (result.changed !== undefined && result.changed.length > 0) {
      const changed = new Set(result.changed.map((f) => path.join(args.workspaceRoot, f)))
      const there = keyedInputs(described!.facts).find((f) => changed.has(f.path))
      if (there !== undefined) return there.path
      // One the key never folded, as this disk lacks it (untracked there),
      // that the declaration matches: the command read it, and its entry
      // here was every later run's hit (2026-11-07).
      const dir = relPosix(args.workspaceRoot, node.projectDir)
      for (const f of result.changed) {
        const own = relPosix(node.projectDir, path.join(args.workspaceRoot, f))
        const projectRel = own.startsWith('../') ? null : own
        if (declaresInput(cfg, projectRel, f, false, true, dir))
          return path.join(args.workspaceRoot, f)
      }
    }
    return (
      (await movedInput(
        keyedInputs(described!.facts),
        cache,
        commandFrom,
        stability.strategy === 'mutable' ? ownRewrite : undefined,
      )) ?? described!.added()
    )
  }

  /**
   * Does the key still describe the inputs the command ran over? It was
   * taken before the command — up front, or before `describeTaskInputs` —
   * and a save files the outputs under it. A user's edit mid-run, or a
   * task rewriting its own input (a formatter), saved bytes built from one
   * state under the key of another: restore the old state and the next run
   * replayed them as up-to-date (turborepo#10111, #1146, item 743). The
   * result stands; only the entry is withheld, and the facts about the
   * project go, since something wrote there. A lockfile a task rewrote
   * withholds it too: the key folded the old one.
   */
  async function keyStillTrue(): Promise<boolean> {
    if (fingerprintMoved(args)) {
      unkeyed = true
      return false
    }
    // `'unchecked'` skips the check of the command's own window; a key the
    // re-derive before the command already disagreed with still withholds,
    // since it never described the bytes the command read.
    // Unchecked, the command may still have rewritten an input in place: a
    // later reader keyed after it (stable-keys.ts) must not read the
    // project's run-start facts.
    if (stability.strategy === 'unchecked' && described!.hash === hash) {
      if (args.executor.remote !== true)
        forgetUndeclaredWrites(
          args,
          wsOutputs.length > 0 ? 'workspace' : commandWriteReach(node, args.workspaceRoot),
        )
      return true
    }
    const endCheck = span('miss: recheck inputs')
    const moved = await movedSinceKey()
    endCheck()
    if (moved === undefined) return true
    const name =
      moved === null ? 'its inputs' : `\`${printable(relPosix(args.workspaceRoot, moved))}\``
    // Only its ctime moved: a hard link (`cp -al src dist`), chmod or chown.
    // The line called that a change and offered a rewrite's way out. It is
    // still withheld: an edit undone with its mtime put back reads the same.
    // Not said of a change an executor reported from where it ran.
    const fact =
      moved === null || rewroteBy !== undefined || (result.changed?.length ?? 0) > 0
        ? undefined
        : keyedInputs(described!.facts).find((f) => f.path === moved)
    const ctimeOnly = fact !== undefined && (await onlyCtimeMoved(fact, commandFrom, cache))
    const what = ctimeOnly
      ? `${name}'s ctime moved while the task ran, but not its bytes or mtime (a hard link, chmod or chown)`
      : `${name} changed after its key was taken` +
        (rewroteBy === undefined ? '' : ` while ${rewroteBy} ran`)
    // A task that regenerates its own input (TanStack Router's committed
    // `routeTree.gen.ts`, rewritten to the same bytes by every build) is
    // never saved (item 1015), and the line said so without the way out.
    // A file the key read may instead be one the task rewrites in place (a
    // formatter's temp + rename), whose sources cannot be its outputs: vx
    // deletes outputs before the command. Its way out is judging the write
    // by its bytes. Neither is said of a file this disk lacks: one the task
    // deleted, or one only where an executor ran it.
    const read =
      moved !== null &&
      keyedInputs(described!.facts).some((f) => f.path === moved && f.digest !== ABSENT_INPUT)
    // One that appeared is not an output to declare: vx deletes an
    // uncommitted output before each run, so a snapshot vitest writes on
    // its first run was written anew every run and a changed value passed.
    // A file the task checks against is committed; a generated one leaves
    // the inputs before it joins the outputs.
    const appeared = (rel: string): string => {
      const own = relPosix(node.projectDir, rel)
      const [field, at] = own.startsWith('../')
        ? ['inputs.workspaceFiles', relPosix(args.workspaceRoot, rel)]
        : ['inputs.files', own]
      return (
        '; it appeared during the run: if the task checks against it (a test snapshot), ' +
        `commit it; if the task generates it, exclude it from ${field} ` +
        `('!${printable(taskGlobOf(at)).replace(/[\\']/g, '\\$&')}') and declare it in outputs`
      )
    }
    // A sandboxed task none of whose write grants reach the file could not
    // have written it: the outputs and 'mutable' advice read as if it had.
    const notTheTask =
      moved !== null &&
      sandboxWrites !== undefined &&
      !sandboxWrites.some((w) => mayWrite(toRealPath(moved), w))
    // Under watch the edit starts the next cycle, which runs on it: said
    // first, or the way out read as the fix for the user's own edit.
    const hint =
      (args.watch === true && rewroteBy === undefined ? '; the next cycle runs on it' : '') +
      (ctimeOnly
        ? "; if the task hard-links it, copy it instead, or set inputs.stability: { strategy: 'mutable' }"
        : moved === null || rewroteBy !== undefined || !existsSync(moved)
          ? ''
          : notTheTask
            ? '; the sandbox let the task write none of it, so another process changed it during the run (an editor, a checkout)' +
              (args.watch === true ? '' : '; the next run runs on it')
            : !read
              ? appeared(moved)
              : '; if the task generates it, declare it in outputs' +
                (stability.strategy !== 'mutable'
                  ? "; if it rewrites it in place, set inputs.stability: { strategy: 'mutable' }"
                  : ''))
    if (stability.severity === 'error') {
      warnOf(log)(
        `[vx] ${node.id}: ${what} — the result is not saved, ` +
          `and inputs.stability.severity is 'error', so the task fails${hint}`,
      )
      movedFails = moved === null ? '' : printable(relPosix(args.workspaceRoot, moved))
    } else {
      warnOf(log)(
        `[vx] ${node.id}: ${what} — ` +
          (ctimeOnly
            ? 'vx cannot tell that from an edit undone, so the result stands but is not saved'
            : 'the result stands, but is not saved under a key that no longer describes it') +
          hint,
      )
    }
    forgetUndeclaredWrites(args, wsOutputs.length > 0 ? 'workspace' : 'project')
    unkeyed = true
    driftedInput = moved
    return false
  }

  if (movedFails !== undefined) effectiveExitCode = 1

  if (unkeyedUpstream !== undefined && willWrite && effectiveExitCode === 0) {
    warnOf(log)(
      `[vx] ${node.id}: ran over ${unkeyedUpstream.node.id}'s outputs, which its key no longer ` +
        `describes — the result stands, but is not saved`,
    )
  }
  // The footer counted it `not saved` and nothing said why (`vx why` did).
  if (keylessBy !== undefined && willWrite && effectiveExitCode === 0) {
    warnOf(log)(
      `[vx] ${node.id}: not saved — its key folds ${keylessBy}, which declares no \`inputs\`, ` +
        `so no later run derives it; declare inputs on ${keylessBy}`,
    )
  }

  const perRun =
    violations.length === 0
      ? undefined
      : perRunWriteHint(violations, node.projectDir, args.workspaceRoot)
  const finalViolations = perRun === undefined ? violations : [...violations, perRun]
  const fixOf = (fix: TaskOutcome['sandboxFix']) => (fix === undefined ? {} : { sandboxFix: fix })

  return {
    node,
    status: effectiveExitCode === 0 ? 'success' : 'failed',
    exitCode: effectiveExitCode,
    durationMs: spentMs,
    hash,
    ...(attempt > 1 ? { attempts: attempt } : {}),
    ...(failedAttempts.length > 0 ? { failedAttempts, attemptOutputs } : {}),
    ...(described !== undefined
      ? { inputFiles: captured.reduce((n, c) => (c.kind === 'file' ? n + 1 : n), 0) }
      : {}),
    ...(inputChanges !== undefined ? { inputChanges } : {}),
    ...(unkeyed ? { unkeyed: true as const } : {}),
    ...(driftedInput !== undefined ? { driftedInput } : {}),
    ...(keylessBy !== undefined ? { keylessBy } : {}),
    ...(saved ? { saved: true as const } : {}),
    ...(unsavedBytes !== undefined ? { outputBytes: unsavedBytes } : {}),
    ...(effectiveExitCode !== 0 && output !== undefined
      ? {
          failedOutput: failedOutputLog(
            output,
            willSave || args.keepRun !== undefined,
            secrets ?? undefined,
          ),
        }
      : {}),
    ...(args.keepRun !== undefined &&
    (effectiveExitCode !== 0 ? args.keepRun.failures : !willSave) &&
    output !== undefined
      ? { runLog: storedOutput() }
      : {}),
    ...(result.timedOut === true && effectiveExitCode !== 0 ? { timedOut: true as const } : {}),
    ...(movedFails !== undefined ? { inputMoved: movedFails } : {}),
    ...(result.cpuMs !== undefined ? { cpuMs: result.cpuMs } : {}),
    ...(result.peakRssBytes !== undefined ? { peakRssBytes: result.peakRssBytes } : {}),
    ...(load !== undefined ? { peakCores: load.peakCores, avgRssBytes: load.avgRssBytes } : {}),
    ...(result.where !== undefined ? { where: result.where } : {}),
    ...(result.where !== undefined && result.machine !== undefined
      ? {
          whereCores: result.machine.cores,
          whereMemoryBytes: result.machine.memoryBytes,
          ...(result.machine.cpuShare === undefined ? {} : { cpuShare: result.machine.cpuShare }),
        }
      : {}),
    ...(result.outputs?.kind === 'deferred' ? { outputs: 'deferred' as const } : {}),
    wallclockStartNs,
    wallclockEndNs,
    ...(finalViolations.length > 0
      ? {
          // vx's own notes ride with the lines and are no denial (B-20).
          sandboxViolations: finalViolations.filter((v) => v.hint !== true).length,
          // A denied path is the task's own spelling, a secret in it too.
          sandboxViolationLines: finalViolations.map((v) => secrets?.mask(v.line) ?? v.line),
          ...fixOf(
            sandboxFix(
              finalViolations,
              node.projectDir,
              args.workspaceRoot,
              (t) => secrets?.mask(t) ?? t,
              cfg.inputs,
              upstreamOutputs,
              cfg.outputs,
            ),
          ),
        }
      : {}),
  }
}

/** Whether write grant `grant` (absolute) may reach `abs`: a glob by its whole directory, to err toward "it could". */
function mayWrite(abs: string, grant: string): boolean {
  const at = grant.search(MOUNT_WILDCARDS)
  return atOrUnder(abs, at === -1 ? grant : path.dirname(grant.slice(0, at + 1)))
}

/** The workspace-relative paths of `files` outside project `project` (workspace-relative). */
function outsideProject(files: readonly { readonly path: string }[], project: string): string[] {
  if (project === '') return []
  const under = `${project}/`
  return files.flatMap((f) => (f.path === project || f.path.startsWith(under) ? [] : [f.path]))
}

/**
 * The result of a task not run because the sandbox hides files its key
 * holds (`keyedOutsideGrants`): one read violation per file, which
 * `sandboxFix` turns into its grant, and the line that says why.
 */
function unseenResult(
  unseen: readonly string[],
  projectDir: string,
  workspaceRoot: string,
): ExecuteResult {
  const timestamp = new Date()
  const denied: SandboxViolation[] = unseen.map((p) => ({
    line: `vx: hidden by the sandbox, held by the key: ${p}`,
    timestamp,
    target: p,
    path: p,
    ignorable: ['read'],
  }))
  const shown = unseen.slice(0, 5).join(', ')
  const more = unseen.length > 5 ? ` and ${unseen.length - 5} more` : ''
  const grants = (sandboxFix(denied, projectDir, workspaceRoot)?.read ?? []).map((g) =>
    g.includes("'") ? JSON.stringify(g) : `'${g.replaceAll('\\', '\\\\')}'`,
  )
  const said = `vx: the sandbox hides a file this task's key holds, so it was not run: ${shown}${more}.`
  // A credential store is walled on purpose and never suggested (sandbox-fix.ts).
  const line =
    grants.length === 0
      ? `${said} It is walled on purpose, so vx suggests no grant for it.`
      : `${said} Grant it, e.g. \`allow: { read: [${grants.join(', ')}] }\`.`
  return {
    exitCode: 0,
    durationMs: 0,
    stdout: '',
    stderr: '',
    violations: [...denied, { timestamp, hint: true, line }],
  }
}

/**
 * Whether `abs` leads to a directory. A link that leads nowhere is no
 * directory: under a file (ENOTDIR) or in a loop (ELOOP) as well as
 * dangling, where the stat's throw failed the run (2026-11-10).
 */
function linksToDir(abs: string): boolean {
  try {
    return statSync(abs, { throwIfNoEntry: false })?.isDirectory() === true
  } catch {
    return false
  }
}

/**
 * The wildcard input globs, when not one of them matched a file: the
 * literal files beside them did. A lockfile plugin appends `package.json`
 * to every task's inputs, so `scr/**` for `src/**` kept a non-empty set
 * and its warning went unsaid: an edit to `src/` then replayed a stale hit.
 * On the miss path only; stops at the first matched file.
 */
function deadSourceGlobs(
  declared: InputsConfig | undefined,
  files: readonly { readonly path: string }[],
  root: string,
  projectRel: string,
): string[] {
  const wild = (globs: readonly string[] | undefined): string[] =>
    (globs ?? []).filter((g) => !g.startsWith('!') && !isLiteralPattern(g))
  const own = wild(declared?.files)
  const ws = wild(declared?.workspaceFiles)
  if (own.length === 0 && ws.length === 0) return []
  const ownMatch = anyTaskGlob(own)
  const wsMatch = anyTaskGlob(ws)
  const prefix = projectRel === '' ? '' : `${projectRel}/`
  for (const { path: p } of files) {
    if (wsMatch(p)) return []
    if (p.startsWith(prefix) && ownMatch(p.slice(prefix.length))) return []
  }
  // A link to a directory a glob reaches below is listed by its own name,
  // which the glob does not match: `src/**` over `src -> ../shared` was
  // called dead though an edit through it moved the key.
  for (const { path: p } of files) if (linksToDir(path.join(root, p))) return []
  return [...own, ...ws]
}

/**
 * Whether a moved input kept the bytes and the mtime its key folded, so only
 * its ctime moved. Asked once, of the file a re-check named: the common
 * path pays nothing.
 */
async function onlyCtimeMoved(fact: InputFact, from: number, cache: CacheLayer): Promise<boolean> {
  if (fact.digest === ABSENT_INPUT || fact.behind !== undefined) return false
  let st
  try {
    st = lstatSync(fact.path)
  } catch {
    return false
  }
  if (st.ctimeMs < from - stampGrainMs(st.ctimeMs)) return false
  if (st.mtimeMs >= from - stampGrainMs(st.mtimeMs)) return false
  return (await cache.hashFile(fact.path).catch(() => undefined)) === fact.digest
}
