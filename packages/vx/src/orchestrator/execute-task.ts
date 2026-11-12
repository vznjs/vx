import type { TaskConfig, InputStability } from '../config.js'
import {
  type CacheEntry,
  type CacheLayer,
  type CachePolicy,
  type GitFilesCache,
} from '../cache/index.js'
import { type TaskExecutor } from '../exec/index.js'
import { isGroupTask, type TaskNode, type TaskOutcome } from '../graph/index.js'
import type { CommandWindows } from './command-windows.js'
import { type OutputDirSnapshot, type SaveFacts } from './miss-save.js'
import type { FingerprintWatch } from './fingerprint-watch.js'
import { currentHit } from './hit-restore.js'
import type { MissExplainer } from '../history/index.js'
// The hit path's entry stays importable from here (tests).
export { restoreHit, type RestoreHitArgs } from './hit-restore.js'
import type { DeferredOutputs } from './deferred-outputs.js'
import { type TreeLoad } from './telemetry.js'
import { type Logger } from '../report/index.js'
import {
  computeGroupHash,
  computeTaskHash,
  type HashCache,
  keyOf,
  type UpfrontGroupKey,
} from './task-hash.js'
import { executePersistentTask } from './persistent-task.js'
import { executeCachedTask, readsCache, restoreProbed } from './cached-task.js'

/** What every task of a run shares: built once per run. */
export interface RunContext {
  workspaceRoot: string
  cache: CacheLayer
  /** Granular cache read/write policy. Undefined → everything on. */
  cachePolicy?: CachePolicy
  forwardArgs?: readonly string[] | undefined
  /** Told the task executes, so the executor's demand counts it again (`ExecutorDemand.executing`). */
  executing?: ((id: string) => void) | undefined
  /** Run-scoped deferral registry — where deferred closures land, and
   *  where a locally-placed consumer fetches its producers from. */
  deferred?: DeferredOutputs
  /** The run's cache directory: walled off from a sandboxed task's grants. */
  cacheDir?: string
  /** Anchor for hrtime spans across all tasks in this run. */
  runStartHrTimeNs: bigint
  /**
   * The run's stop (a process signal or the embedder's abort). An attempt
   * that ends while it is aborted is `aborted`, whatever its exit: a task
   * that traps the forwarded SIGINT and exits 0 did not finish on its own
   * terms.
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
  /** When each command of the run ran and where it may write (command-windows.ts). */
  commandWindows?: CommandWindows
  /** Every task of the project at a directory, as its config declares them (undeclared-state.ts). Absent: none. */
  projectTasks?: (projectDir: string) => readonly TaskConfig[]
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
  /** A `vx watch` cycle (`RunHandoff.watch`): an input edited mid-run is the next cycle's. */
  watch?: true
}

/** One dispatch: the run it belongs to, plus this task's own facts. */
export interface ExecuteArgs {
  run: RunContext
  node: TaskNode
  upstream: TaskOutcome[]
  log: Logger
  /** The executor this task was PLACED on (run.ts, before scheduling). */
  executor: TaskExecutor
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
  nestedProjectDirs: string[]
  /**
   * Where its outputs stop when that is more than `nestedProjectDirs`: the
   * nested workspaces under it too (prepare.ts `outputWallsOf`).
   */
  outputNestedDirs?: string[]
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
   * No task in the run depends on this one, so none is ordered after it to
   * read what it wrote: a miss that saves nothing marks nothing (the output
   * walk cost 1,000 read-only misses 1.62 → 1.78 s).
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
  // each of a warm run's hits. The same branch there handles it
  // when this one does not apply.
  const probed = args.preProbed
  if (probed?.hit != null && readsCache(args) && args.remoteOnlyNoop !== true) {
    return restoreProbed(
      args,
      probed.hash,
      probed.hit,
      process.hrtime.bigint() - args.run.runStartHrTimeNs,
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
  if (args.run.fingerprintWatch?.moved() !== undefined) return undefined
  const restore = {
    args,
    hash: probed.hash,
    hit: probed.hit,
    cacheOpStart: performance.now(),
    taskStartNs: process.hrtime.bigint() - args.run.runStartHrTimeNs,
  }
  return currentHit(restore)
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
      args.run.runStartHrTimeNs,
    )
  }
  const wallclockNs = process.hrtime.bigint() - args.run.runStartHrTimeNs
  const hash = await keyOf(
    computeTaskHash({
      node: args.node,
      upstream: args.upstream,
      workspaceRoot: args.run.workspaceRoot,
      cache: args.run.cache,
      forwardArgs: args.run.forwardArgs,
      nestedProjectDirs: args.nestedProjectDirs,
      ...(args.run.gitFilesCache !== undefined ? { gitFilesCache: args.run.gitFilesCache } : {}),
      ...(args.run.hashCache !== undefined ? { hashCache: args.run.hashCache } : {}),
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
    timing: { startNs: wallclockNs, endNs: wallclockNs },
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
