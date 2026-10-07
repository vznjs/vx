import path from 'node:path'
import type { ExecConfig, TaskConfig, CacheConfig } from '../config.js'
import {
  ArtifactVanishedError,
  type CacheEntry,
  type CacheLayer,
  type CachePolicy,
  cleanOutputs,
  cleanWorkspaceOutputs,
  type OutputStamp,
  ownOutputsSince,
  ownWorkspaceOutputsSince,
  stampOutputs,
  stampWorkspaceOutputs,
  FULL_CACHE_POLICY,
  type GitFilesCache,
} from '../cache/index.js'
import {
  buildIsolatedEnv,
  packageManagerPath,
  PM_EXEC_ENV,
  VX_RUN_TASK_ENV,
  VX_RUN_WORKSPACE_ENV,
  runPersistent,
  withForwardArgs,
  releaseBridges,
  wrapSandboxedCommand,
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
  PersistentReadyError,
  sandboxReads,
} from '../exec/index.js'
import { isGroupTask, RestoreDemoted, type TaskNode, type TaskOutcome } from '../graph/index.js'
import {
  killGraceMs,
  MASKED,
  maskedEmitter,
  printable,
  relPosix,
  secretMask,
  secretNamed,
  span,
  UserError,
} from '../util/index.js'
import { forwardedSignal, SIGNAL_SHUTDOWN_GRACE_MS } from './signals.js'
import { executorLabel, nameExecutorFailure } from './plugin-host.js'
import {
  mayWriteFingerprint,
  type Placeholder,
  placeholderSweeper,
  reachedWithheld,
  sandboxRequestFor,
  sweepPlaceholders,
  undeclaredWriteReach,
  untouchedPlaceholderLine,
  type WithheldLink,
  withheldLinkLine,
} from './sandbox-request.js'
import { markUnsaved, saveMiss, type OutputDirSnapshot, type SaveFacts } from './miss-save.js'
import type { FingerprintWatch } from './fingerprint-watch.js'
import { restoreHit } from './hit-restore.js'
import type { MissExplainer } from './miss-reason.js'
import { shellVerdict } from './shell-verdict.js'
// The hit path's entry stays importable from here (tests).
export { restoreHit, type RestoreHitArgs } from './hit-restore.js'
import type { DeferredOutputs } from './deferred-outputs.js'
import type { Logger } from './logger.js'
import {
  computeGroupKey,
  computeTaskHash,
  describeTaskInputs,
  type HashCache,
  movedInput,
  type TaskInputComponent,
} from './task-hash.js'
import { getContext } from './remote-prefetch.js'
import { expandGroupUpstream, filterUpstreamHashes } from './upstream.js'

export interface ExecuteArgs {
  node: TaskNode
  upstream: TaskOutcome[]
  workspaceRoot: string
  workspaceFingerprint: string
  cache: CacheLayer
  /** Granular cache read/write policy. Undefined → everything on. */
  cachePolicy?: CachePolicy
  forwardArgs?: readonly string[] | undefined
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
   * `exec.remote: 'only'` placed on a remote executor: execute remotely,
   * but this machine's disk is untouched — no output clean, no vx cache
   * probe/restore/save. The task's outputs live in the REMOTE store and
   * reach dependents' input trees by reference (the executor's job).
   */
  remoteOnly?: boolean
  /**
   * Plan-time `--download` decision for THIS task (run.ts). `'deferred'`
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
  track?: (taskId: string, pid: number) => () => void
  /** Name what a missed key changed (`createMissExplainer`); absent when nobody listens. */
  explainMiss?: MissExplainer
  /**
   * Run-level retry default (`--retry <n>` / `RunOptions.retries`).
   * Explicit `exec.retries` wins, including an explicit 0. Threaded as
   * an option only — never folded into any hash, so cache keys are
   * byte-identical with and without it.
   */
  retries?: number
  /**
   * Run-level default task timeout (ms) — the already-resolved
   * `VX_TASK_TIMEOUT`/workspace/`--timeout` fallback. Per-task
   * `exec.timeout` wins. Threaded as an option only — never hashed.
   */
  timeout?: number
  /** Per-run memo for `git ls-files` (one entry per project dir). */
  gitFilesCache?: GitFilesCache
  /** Per-run memo for derived hashes (package.json bytes + task config). */
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
   * Run-scoped list the miss path appends its output-directory snapshot
   * request to, taken at run end (run.ts) instead of right after the save:
   * a directory written milliseconds ago is inside the snapshot's racy
   * window and would be refused, and the next hit would walk the tree.
   */
  outputDirSnapshots?: OutputDirSnapshot[]
  /** The run's save lane: a miss's cache save runs off the execution slot (save-lane.ts). */
  deferSave?: (save: () => Promise<void>) => Promise<void>
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
   * Whether a task has rewritten a file the workspace fingerprint folded
   * since the run read it (fingerprint-watch.ts): past that, no key taken
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
}

/**
 * Dispatch a single task to one of three execution paths. Each path
 * owns its own outcome shape; the dispatcher just picks based on the
 * task's config shape (group vs persistent vs cached). Sharing
 * helpers (`taskEnv`, `effectiveForwardArgs`) live below.
 */
export async function executeTask(args: ExecuteArgs): Promise<TaskOutcome> {
  if (isGroupTask(args.node)) return executeGroupTask(args)
  if (args.node.config.exec?.persistent !== undefined) return executePersistentTask(args)
  return executeCachedTask(args)
}

/**
 * Group task: no `exec`. The scheduler has already ensured every
 * dependency completed; we just return success with a hash rolled up
 * from upstream outcomes so downstream cache keys still cascade
 * through us.
 */
async function executeGroupTask(args: ExecuteArgs): Promise<TaskOutcome> {
  const wallclockNs = process.hrtime.bigint() - args.runStartHrTimeNs
  const hash = await computeGroupKey({
    node: args.node,
    upstream: args.upstream,
    workspaceRoot: args.workspaceRoot,
    workspaceFingerprint: args.workspaceFingerprint,
    cache: args.cache,
    forwardArgs: args.forwardArgs,
    nestedProjectDirs: args.nestedProjectDirs,
    ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
    ...(args.hashCache !== undefined ? { hashCache: args.hashCache } : {}),
  })
  return {
    node: args.node,
    status: 'success',
    exitCode: 0,
    durationMs: 0,
    hash,
    // What this group stands for. A dependent expands it to describe the
    // real tasks in its input closure — see `TaskOutcome.groupUpstream`.
    groupUpstream: args.upstream,
    wallclockStartNs: wallclockNs,
    wallclockEndNs: wallclockNs,
  }
}

/**
 * Persistent task: dev server / file watcher / daemon. Spawn, wait
 * for ready (regex match or immediate), stash the subprocess in the
 * orchestrator-owned registry, return success. The orchestrator
 * SIGTERMs the registry at end-of-run.
 *
 * Never reads or writes the cache — the project loader rejects
 * `cache + persistent` at config-load time, so by the time we get
 * here, `cache` is guaranteed undefined.
 *
 * Never routed through an executor: a persistent task is local by
 * construction (its port lives on this machine).
 */
async function executePersistentTask(args: ExecuteArgs): Promise<TaskOutcome> {
  const { node, log } = args
  // Type narrowing: the dispatcher checks `exec.persistent` before
  // calling us, so `exec` and `exec.persistent` are both present.
  const step = node.config.exec as ExecConfig & {
    persistent: NonNullable<ExecConfig['persistent']>
  }
  const effectiveForwardArgs = node.requested ? (args.forwardArgs ?? []) : []
  const env = taskEnv(node, step, args.workspaceRoot)
  const wallclockStartNs = process.hrtime.bigint() - args.runStartHrTimeNs
  // Keyed like an uncached task (its whole project), so a cached dependant
  // behind a dev server re-runs when the server's sources change; with no
  // key the dependant folded nothing of it and replayed a stale e2e (A-17).
  const hash =
    args.noDependants === true
      ? undefined
      : (args.upfrontKey ??
        (await computeTaskHash({
          node,
          upstream: args.upstream,
          workspaceRoot: args.workspaceRoot,
          workspaceFingerprint: args.workspaceFingerprint,
          cache: args.cache,
          forwardArgs: args.forwardArgs,
          nestedProjectDirs: args.nestedProjectDirs,
          ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
          ...(args.hashCache !== undefined ? { hashCache: args.hashCache } : {}),
        })))

  // The args after `--` reach a server as they reach any task. A readyWhen
  // server once got none — "so the matcher sees the unmodified output",
  // though the args change the command, not what the matcher reads — and
  // `vx run dev -- --port 4000` on the documented Vite task dropped the
  // port in silence (item 1060).
  const plainCommand = withForwardArgs(step.command, effectiveForwardArgs)
  // A persistent task declaring `exec.sandbox` runs inside it like any
  // other: the same grants, the same walls. What it cannot have is the
  // violation REPORT — that reads the trace after the child exits, and a
  // server exits when the run tears it down. Enforced, not reported.
  // (Until 2026-09-09 the block was accepted and silently ignored.)
  let command = plainCommand
  let bridgeTag: string | undefined
  let signalChannel = false
  // The empty files the request pre-created for a literal write grant; a
  // server that never writes one gets it taken back when it exits, and a
  // server that dies before readiness is told the directory spelling — the
  // same trap and the same answer as a one-shot task's (sandbox-request.ts).
  let placeholders: Placeholder[] = []
  if (step.sandbox !== undefined) {
    await args.armSandbox?.()
    // A persistent task never declares `cache` (the loader refuses it), so
    // it keeps the whole linked grant: no key of its can be stale.
    const sb = await sandboxRequestFor(
      node,
      step.sandbox,
      args.workspaceRoot,
      undefined,
      args.nestedProjectDirs,
      args.cacheDir,
    )
    placeholders = sb.placeholders
    const wrapped = await wrapSandboxedCommand({
      command: plainCommand,
      cwd: node.projectDir,
      env,
      ...sb.sandbox,
      server: true,
    })
    command = wrapped.wrapped
    bridgeTag = wrapped.tag
    signalChannel = wrapped.forwardsSignals
  }
  // A server's output masked as a one-shot task's is (L-11); `readyWhen`
  // is matched on the raw chunks, before this. Its held tail is flushed by
  // the idle timer: a server never ends on the way to a flush.
  const serverSecrets = secretMask([process.env, env, step.env?.define], step.env?.secret)
  const serverOut = serverSecrets && maskedEmitter(serverSecrets, (t) => log.taskStdout(node, t))
  const serverErr = serverSecrets && maskedEmitter(serverSecrets, (t) => log.taskStderr(node, t))
  const persistentOpts: Parameters<typeof runPersistent>[0] = {
    command,
    cwd: node.projectDir,
    env,
    onStdout: serverOut ? (chunk) => serverOut.push(chunk) : (chunk) => log.taskStdout(node, chunk),
    onStderr: serverErr ? (chunk) => serverErr.push(chunk) : (chunk) => log.taskStderr(node, chunk),
    ...(args.liveChildren !== undefined ? { liveChildren: args.liveChildren } : {}),
    ...(args.track !== undefined
      ? { onSpawn: (pid: number) => void args.track!(node.id, pid) }
      : {}),
    ...(signalChannel ? { signalChannel } : {}),
    ...(args.terminal === true ? { terminal: true } : {}),
  }
  if (step.persistent.readyWhen !== undefined) {
    persistentOpts.readyWhen = step.persistent.readyWhen
  }
  // For a persistent task the timeout bounds the readiness wait. Per-task
  // `exec.timeout` wins; else the run-level default (env/workspace/--timeout).
  const effectiveTimeout = step.timeout ?? args.timeout
  if (effectiveTimeout !== undefined) {
    persistentOpts.timeoutMs = effectiveTimeout
  }

  // A stop that landed during the awaits above (the key, the sandbox's
  // arming, request and wrap) leaves nothing to kill yet: spawned now, the
  // server came up after the teardown and held the run's exit 7 s.
  if (args.stopSignal?.aborted === true) {
    if (bridgeTag !== undefined) releaseBridges(bridgeTag)
    await placeholderSweeper(placeholders)()
    return {
      node,
      status: 'aborted',
      // The signal a spawned server would have been sent (a hang-up forwards SIGTERM).
      exitCode: signalExitCode(forwardedSignal(args.stopSignal.reason)),
      durationMs: 0,
      wallclockStartNs,
      wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
    }
  }
  const spawn = runPersistent(persistentOpts)
  // The host side of a port bridge lives exactly as long as the server:
  // released on the child's exit, whether the run tore it down or it died.
  // A placeholder the server never wrote goes back the same way.
  // ONE sweep, shared by the exit handler and the readiness failure below
  // — whichever asks second must get the SAME list. A second sweep cannot
  // produce it: the first one's `rm` already happened, so the file is gone
  // and `sweepPlaceholders` skips it. Collecting both lists and unioning
  // them does not close that, because the union only covers an exit
  // handler that FINISHED; one still between its `rm` and its return has
  // published nothing yet, and the readiness path then reports no
  // placeholder at all. The failure then says only "File exists", which is
  // the message the hint exists to explain (seen under the gate's parallel
  // load, and reproduced deterministically by delaying each side, item 450).
  const sweptUntouched = placeholderSweeper(placeholders)
  if (bridgeTag !== undefined || placeholders.length > 0) {
    const tag = bridgeTag
    const onExit = async (): Promise<void> => {
      if (tag !== undefined) releaseBridges(tag)
      await sweptUntouched()
    }
    // A spawn that failed has no child to wait on: release now, or the
    // tag would hold the sandbox's reset for the rest of the process.
    if (spawn.child === undefined) void onExit()
    else void spawn.child.exited.then(onExit, onExit)
  }
  // Said once if readiness is slow: a dependency's output is hidden unless
  // it fails, and with no `exec.timeout` the wait never ends, so a run
  // whose `readyWhen` never matched showed nothing at all.
  const readyWhen = step.persistent.readyWhen
  const noticeMs = readyNoticeMs()
  const notice =
    readyWhen === undefined
      ? undefined
      : setTimeout(() => {
          if (isAborted(args.stopSignal)) return
          const after = noticeMs < 1000 ? `${noticeMs} ms` : `${noticeMs / 1000} s`
          const unbounded = effectiveTimeout === undefined ? ', with no exec.timeout' : ''
          log.status(
            `vx: ${node.id} not ready after ${after}: waiting for a line matching /${readyWhen}/ (readyWhen)${unbounded}`,
          )
        }, noticeMs)
  if (notice !== undefined) {
    const quiet = (): void => clearTimeout(notice)
    void spawn.ready.then(quiet, quiet)
  }
  try {
    await spawn.ready
  } catch (err) {
    // A server the run's stop killed while it started is aborted, as any
    // task the stop kills (item 962): it read `failed (never ready:
    // exited, exit 130)` with a recap after every Ctrl-C (C-62). The stop
    // aborts before it kills, so it is set by the time the child is gone.
    // Read through a call: the early return above narrows `aborted` to
    // false, but the stop can land during `spawn.ready`.
    if (isAborted(args.stopSignal)) {
      return {
        node,
        status: 'aborted',
        exitCode: err instanceof PersistentReadyError ? (err.exitCode ?? 1) : 1,
        durationMs: spawn.readyMs(),
        wallclockStartNs,
        wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
      }
    }
    const message = err instanceof Error ? err.message : String(err)
    // The task's OWN stream, not the process's: the frame is where a
    // reader looks for why a task failed, and a run with a custom logger
    // (an embedder, the MCP server) never saw a bare stderr write at all.
    log.taskStderr(node, `\n[vx] ${node.id}: persistent task failed to become ready: ${message}\n`)
    // A server is never traced, so the sandbox's refusals reach no report:
    // a dev server that died on a file outside its grants read only as the
    // tool's own "not found" (2026-10-03). Said for a sandboxed server that
    // exited failing, which is the shape a refusal takes.
    if (
      step.sandbox !== undefined &&
      err instanceof PersistentReadyError &&
      err.reason === 'exited' &&
      err.exitCode !== 0
    ) {
      log.taskStderr(
        node,
        `[vx] ${node.id} ran in the sandbox, which reports nothing for a server: a path outside ` +
          `its grants reads as missing (ENOENT), a refused write as read-only (EROFS). Check ` +
          `exec.sandbox.allow, or run the command as a one-shot sandboxed task to see what it was refused.\n`,
      )
    }
    // The server is dead or being torn down, so the sweep on its exit may
    // already be running: ask the shared one rather than starting a second.
    for (const p of await sweptUntouched()) {
      log.taskStderr(node, `${untouchedPlaceholderLine(node.projectDir, p)}\n`)
    }
    // The reason rides the outcome (every label reads it), and a child that
    // exited before ready keeps its own exit code rather than a made-up 1.
    // One the readiness timeout is killing reports the signal's, as an
    // ordinary timeout does (X-24).
    const ready = err instanceof PersistentReadyError ? err : undefined
    return {
      node,
      status: 'failed',
      exitCode: ready?.reason === 'timeout' ? await spawn.child.exited : (ready?.exitCode ?? 1),
      durationMs: spawn.readyMs(),
      ...(ready !== undefined ? { notReady: ready.reason } : {}),
      wallclockStartNs,
      wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
    }
  }

  args.persistentRegistry?.set(node.id, spawn.child)
  forgetUndeclaredWrites(args, undeclaredWriteReach(node, args.workspaceRoot))
  if (mayWriteFingerprint(node, args.workspaceRoot)) args.fingerprintWatch?.wrote()
  return {
    node,
    status: 'success',
    exitCode: 0,
    durationMs: spawn.readyMs(),
    ...(hash !== undefined ? { hash } : {}),
    wallclockStartNs,
    wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
  }
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
  const cacheCfg: CacheConfig | undefined = cfg.cache
  const policy = args.cachePolicy ?? FULL_CACHE_POLICY
  const cfgCacheable = cacheCfg !== undefined
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
  const willRead = !remoteOnly && cfgCacheable && (policy.localRead || policy.remoteRead)
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
  const present = upstream.filter((u): u is TaskOutcome => u !== undefined)
  const folded = new Set(
    filterUpstreamHashes(present, cacheCfg?.inputs?.tasks, node.projectName, node.id).map(
      ([id]) => id,
    ),
  )
  const unkeyedUpstream = expandGroupUpstream(present.filter((u) => folded.has(u.node.id))).find(
    (u) => u.unkeyed === true,
  )
  let unkeyed = unkeyedUpstream !== undefined
  const willSave = willWrite && args.taintedUpstream !== true && !unkeyed

  // Retain only what is read back. `cache.save` below is the single consumer
  // of `result.stdout`, and it runs only when this task will WRITE an entry;
  // `result.stderr` has no consumer at all (a failing task's stderr reaches
  // the user through the live `onStderr` callback, and the cache has never
  // stored stderr — see the v17 artifact format). Both streams are still
  // drained and still stream chunk-by-chunk to the logger; only the retained
  // copy is dropped, which for a chatty task is its full byte size in heap.
  // Deferral is decided at plan time and only ever set for a remote-placed,
  // eligibility-cleared task; it suppresses this machine's clean AND save.
  const deferralRequested = args.download === 'deferred'
  const capture: CaptureConfig = { stdout: willSave, stderr: false }

  const outputs = cacheCfg?.outputs.files ?? []
  const wsOutputs = cacheCfg?.outputs.workspaceFiles ?? []
  const effectiveForwardArgs = node.requested ? (args.forwardArgs ?? []) : []
  // Timeout precedence: per-task `exec.timeout` → run-level default
  // (`--timeout`/`RunOptions.timeout` → `VX_TASK_TIMEOUT` → workspace
  // `timeout`, already collapsed into `args.timeout` by run.ts).
  const effectiveTimeout = step.timeout ?? args.timeout
  // `signal` stops a plugin executor on the run's stop AND on
  // `exec.timeout`: core cannot kill a process an executor spawned, so a
  // declared timeout meant nothing on one that kept its own clock (H-12).
  // The local executor keeps its own timer (it signals the process group).
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let timeoutFired = false
  // The attempt's listener on the run's stop signal, taken off once the
  // attempt settles. Left on, every task of the run added one: the list
  // grew to the task count, and each add scans it for a duplicate, ~100 ms
  // of a 1,000-task cold run.
  let unlistenStop: (() => void) | undefined
  function requestSignal(): AbortSignal {
    const stop = new AbortController()
    const abort = (): void => stop.abort(args.stopSignal?.reason)
    unlistenStop?.()
    unlistenStop = undefined
    if (args.stopSignal?.aborted === true) abort()
    else if (args.stopSignal !== undefined) {
      const run = args.stopSignal
      run.addEventListener('abort', abort, { once: true })
      unlistenStop = () => run.removeEventListener('abort', abort)
    }
    if (effectiveTimeout !== undefined) {
      clearTimeout(timeoutTimer)
      timeoutFired = false
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
    const started = Date.now()
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const abandoned = new Promise<ExecuteResult>((resolve) => {
      onAbort = (): void => {
        const graceMs = killGraceMs(SIGNAL_SHUTDOWN_GRACE_MS)
        graceTimer = setTimeout(() => {
          const why = timeoutFired ? `timeout (${effectiveTimeout}ms)` : 'stop'
          log.taskStderr(
            node,
            `vx: ${executorLabel(args.executor)} did not return within ${graceMs}ms of the ${why}; abandoned\n`,
          )
          const reason: unknown = signal.reason
          resolve({
            exitCode: signalExitCode(reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM'),
            durationMs: Date.now() - started,
            stdout: '',
            stderr: '',
            violations: [],
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
  // `cache.inputs.files` matches sibling outputs (e.g. `'**/*'` after
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
    (await computeTaskHash({
      node,
      upstream,
      workspaceRoot: args.workspaceRoot,
      workspaceFingerprint: args.workspaceFingerprint,
      cache,
      forwardArgs: args.forwardArgs,
      nestedProjectDirs: args.nestedProjectDirs,
      ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
      ...(args.hashCache !== undefined ? { hashCache: args.hashCache } : {}),
      ...(args.probesAfterWrites !== undefined
        ? { probesAfterWrites: args.probesAfterWrites }
        : {}),
    }))

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

  const cleanArgs = {
    projectDir: node.projectDir,
    outputs,
    nestedProjectDirs: args.nestedProjectDirs,
  }
  const wsCleanArgs = { workspaceRoot: args.workspaceRoot, outputs: wsOutputs }
  // An ADDITIVE task (its outputs overlap an upstream's, with the edge that
  // orders them; item 588) does not clean by glob — the glob selects the
  // upstream's files it adds beside. Its outputs are stamped once before
  // the first attempt, and after a 0 exit its own set is what the run
  // added or changed against that stamp. Stale files of its own from an
  // earlier run are its command's to clean, as they are under Turbo.
  const additive = (node.addsToOutputsOf?.length ?? 0) > 0
  let stampedBefore: ReadonlyMap<string, OutputStamp> | undefined
  let wsStampedBefore: ReadonlyMap<string, OutputStamp> | undefined

  // Cache lookup. On hit, time the user-perceived restore op
  // (clean+restore+log-replay) — that's what the framed-block footer
  // shows, not the original exec time stored in the entry. The
  // short-circuit's up-front probe is reused: a `preProbed` entry means
  // the probe already ran — restore its hit, or (null hit) fall straight
  // to the run path as a known stable miss. No second cache.get.
  if (willRead) {
    const cacheOpStart = performance.now()
    // A hit whose artifact was removed after the probe (a prune, another
    // workspace's retention on a shared cache directory) is a miss. The
    // restore has wiped the declared outputs by then; the run path cleans
    // them again and the task writes them.
    const restoreOrMiss = async (hit: CacheEntry): Promise<TaskOutcome | null> => {
      try {
        return await restoreHit({ args, hash, hit, cacheOpStart, taskStartNs })
      } catch (err) {
        if (!(err instanceof ArtifactVanishedError)) throw err
        log.status(`[vx] ${node.id}: ${err.message} — running it`)
        return null
      }
    }
    if (preProbed !== undefined) {
      if (preProbed.hit !== null) {
        const restored = await restoreOrMiss(preProbed.hit)
        if (restored !== null) return restored
        // The up-front probe's hit may be restoring AHEAD of this task's
        // deps, and a command run now would build from outputs they have
        // not written yet and save that under the good key. The scheduler
        // runs it again once they are done (admission drops the probe).
        throw new RestoreDemoted(node.id)
      }
      // Confirmed stable miss — skip the probe, fall through to run.
    } else if (!fingerprintMoved()) {
      const endProbe = span('cache.get')
      const hit = await cache.get(hash, getContext(node, step.command))
      endProbe()
      if (hit) {
        const restored = await restoreOrMiss(hit)
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
        workspaceFingerprint: args.workspaceFingerprint,
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
  // A name only `exec.env.secret` makes secret is not one the name rule
  // sees later: its row carries the mark, so `vx why` hides its hash (M-63).
  const named = node.config.exec?.env?.secret
  if (named !== undefined)
    for (const c of captured)
      if (c.kind === 'env' && named.includes(c.name) && !secretNamed(c.name))
        c.hash = MASKED + c.hash
  const inputs: TaskInputs | undefined = described?.inputs
  const inputChanges = described !== undefined ? args.explainMiss?.(node.id, captured) : undefined
  // A plugin may keep the request past the run (the cache closed): it gets
  // the upstream outputs read now. Only the local floor leaves them unread.
  if (inputs !== undefined && !isLocalExecutor(args.executor)) void inputs.upstream
  // A declared input set that resolves to NOTHING is the quiet stale hit:
  // the key stops moving with this project's source and every later run
  // is a hit. Almost always a glob written against the wrong directory
  // (`lib/**` in a package that builds `src/`). Said once per miss, on the
  // run's status line — the task itself succeeds.
  const declaredInputs = [
    ...(cacheCfg?.inputs.files ?? []),
    ...(cacheCfg?.inputs.workspaceFiles ?? []),
  ]
  if (inputs !== undefined && declaredInputs.length > 0 && inputs.files.length === 0) {
    log.status(
      `[vx] ${node.id}: cache.inputs matched no files (${declaredInputs.join(', ')}) — ` +
        `the key will not change when this project's source does`,
    )
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

  // Cache miss path (or caching disabled), up to `1 + retries` attempts.
  // Explicit config wins over the run-level `--retry` default, including
  // an explicit `retries: 0`.
  const maxAttempts = 1 + (step.retries ?? args.retries ?? 0)
  let attempt = 0
  let result: ExecuteResult
  let effectiveExitCode: number
  // What THIS run spent on the task, every attempt (`TaskOutcome.durationMs`):
  // the last attempt alone read `max 407ms` beside a footer of 837 (item
  // 1101). A saved entry keeps the attempt that produced it, what a hit saves.
  let spentMs = 0

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
  }> {
    // A deferred task's outputs are deliberately NOT coming, so wiping the
    // tree would replace a stale build with nothing at all. The eligibility
    // gate guarantees no key in this run can see what stays behind, and the
    // summary names every deferred task so `dist/` is not silently stale.
    if (additive && willWrite && !deferralRequested && outputs.length > 0) {
      const endStamp = span('miss: stamp outputs')
      stampedBefore ??= await stampOutputs(cleanArgs)
      endStamp()
    } else if (willWrite && !deferralRequested && outputs.length > 0) {
      // Mark the wiped paths, exactly as the workspace twin below does. The
      // git snapshot still lists them with their committed index OIDs, and
      // resolveFiles SKIPS its existence probe for any path carrying a
      // trusted OID — so a declared output the producer deletes and does not
      // re-create would stay in a same-project consumer's input set, keeping
      // that consumer's key unchanged while the file is gone from disk.
      const endClean = span('miss: clean outputs')
      const cleanedRels = await cleanOutputs({ ...cleanArgs, keepGlobRoots: true })
      endClean()
      args.gitFilesCache?.noteClean(node.id, node.projectDir, cleanedRels)
      args.gitFilesCache?.markOutputsChanged(node.projectDir, cleanedRels)
    }
    if (additive && willWrite && !deferralRequested && wsOutputs.length > 0) {
      // A root-anchored addition is stamped as the project one above: a
      // glob clean deleted the upstream's files before this task, which
      // reads them, ran (A-43).
      wsStampedBefore ??= await stampWorkspaceOutputs(wsCleanArgs)
    } else if (willWrite && !deferralRequested && wsOutputs.length > 0) {
      // Root-anchored deletions can land in other projects' dirs; mark
      // them so stale per-project git snapshots can't survive the wipe.
      const cleanedWsRels = await cleanWorkspaceOutputs(wsCleanArgs)
      args.gitFilesCache?.markWorkspaceOutputsChanged(args.workspaceRoot, cleanedWsRels)
    }
    violations = []
    const endReq = span('miss: build request')
    const req = await buildRequest()
    endReq()
    // An executor that THROWS produces no captured output. Rethrown: the
    // scheduler classifies it and prints its one line into the task's own
    // stream (run()'s onError), where the frame reads it; a copy written
    // here too printed the reason twice.
    const endExec = span('miss: execute')
    let res = await boundAfterAbort(args.executor.execute(req), req.signal)
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
          } else {
            log.status(`[vx] ${node.id}: ${why} — running it here`)
            clearTimeout(timeoutTimer)
            const local = await localExecutor().execute(await buildRequest())
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
        clearTimeout(timeoutTimer)
        unlistenStop?.()
        unlistenStop = undefined
        flushMasked()
        untrack?.()
        untrack = undefined
      })
    endExec()
    if (secrets !== null)
      res = { ...res, stdout: secrets.mask(res.stdout), stderr: secrets.mask(res.stderr) }
    // An executor that stopped on the timeout's abort exits non-zero; say
    // why, so the frame, the retry line and `timedOut` read as a timeout.
    if (timeoutFired && res.exitCode !== 0 && res.timedOut !== true) {
      res = { ...res, timedOut: true }
    }
    violations = [...res.violations]
    // A denial under a dependency the key does not answer for says only
    // ENOENT; the line beside it names the package and how to key it. Only
    // with a denial there, so it never reddens a pass.
    for (const w of reachedWithheld(withheld, violations)) {
      violations.push({ timestamp: new Date(), hint: true, line: withheldLinkLine(node.id, w) })
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
    // ANY violation fails the task (owner, 2026-09-05). A sandboxed task
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
    // 137 (item 1063).
    if (res.timedOut) {
      const how = res.signal === 'SIGKILL' ? 'SIGKILL after the SIGTERM grace' : 'SIGTERM'
      log.taskStderr(node, `\n[vx] timed out after ${effectiveTimeout}ms — killed (${how})\n`)
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
    // reader after a command that exists (A-41).
    if (!res.timedOut && res.spawnFailed !== true) {
      const verdict = shellVerdict({
        code,
        command: step.command,
        cwd: node.projectDir,
        bins: taskBinDirs(node, args.workspaceRoot),
        signal: res.signal,
        hidden: req.sandbox && ((f: string) => !sandboxReads(req.sandbox!, f)),
      })
      // The line quotes the command's first word, which a config may have
      // built from a secret: masked as the task's own output is (L-37).
      if (verdict !== undefined) log.taskStderr(node, `\n${secrets?.mask(verdict) ?? verdict}\n`)
      // A committed file another task's clean removed, still gone: vx
      // cleans outputs before a run where Turbo does not, so a reader with
      // no edge to the producer fails naming only the file (A-48).
      if (code !== 0) {
        for (const c of (args.gitFilesCache?.trackedCleansMissing(node.id) ?? []).slice(0, 3)) {
          const rel = path.relative(args.workspaceRoot, c.path).split(path.sep).join('/')
          log.taskStderr(
            node,
            `\n[vx] ${rel} is tracked by git, and ${c.by} removed it as an output before its run; it is still missing. A task that reads it needs dependsOn on ${c.by}.\n`,
          )
        }
      }
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
      log.taskStderr(node, `\n[vx] ${msg}\n`)
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

  // The values of secret-named variables, masked in what the task prints
  // and what the cache keeps of it (L-11); null when there are none.
  const secrets = secretMask([process.env, env, step.env?.define], step.env?.secret)
  let flushMasked = (): void => {}
  const failedAttempts: { endedAt: number; exitCode: number; timedOut?: true }[] = []
  // The sampling of the attempt's process tree, stopped once it settles.
  let untrack: (() => void) | undefined
  // The entry's command is shown by `vx why` and sent with the entry to a
  // remote cache: a value a config interpolated stays out of both.
  const storedCommand = secrets?.mask(step.command) ?? step.command

  // Pass or fail, the command may have written where its project's
  // run-start facts describe; a remote executor wrote on its own disk.
  const writeReach =
    args.executor.remote === true ? 'none' : undeclaredWriteReach(node, args.workspaceRoot)
  const writesFingerprint =
    args.executor.remote !== true && mayWriteFingerprint(node, args.workspaceRoot)
  for (;;) {
    attempt++
    const a = await runAttempt()
    forgetUndeclaredWrites(args, writeReach)
    if (writesFingerprint) args.fingerprintWatch?.wrote()
    result = a.result
    effectiveExitCode = a.exitCode
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
      }
    }

    if (effectiveExitCode === 0 || attempt >= maxAttempts) break
    failedAttempts.push({
      endedAt: Date.now(),
      exitCode: effectiveExitCode,
      ...(result.timedOut === true ? { timedOut: true as const } : {}),
    })
    log.taskStderr(
      node,
      `vx: retrying ${node.id} (attempt ${attempt + 1}/${maxAttempts}) after ${result.timedOut === true ? 'a timeout' : `exit ${effectiveExitCode}`}\n`,
    )
  }

  async function buildRequest(): Promise<ExecuteRequest> {
    const out = secrets && maskedEmitter(secrets, (t) => log.taskStdout(node, t))
    const err = secrets && maskedEmitter(secrets, (t) => log.taskStderr(node, t))
    flushMasked = () => {
      out?.end()
      err?.end()
    }
    const base: ExecuteRequest = {
      taskId: node.id,
      workspaceRoot: args.workspaceRoot,
      command: step.command,
      forwardArgs: effectiveForwardArgs,
      cwd: node.projectDir,
      env,
      envDefine: step.env?.define ?? {},
      capture,
      onStdout: out ? (chunk) => out.push(chunk) : (chunk) => log.taskStdout(node, chunk),
      onStderr: err ? (chunk) => err.push(chunk) : (chunk) => log.taskStderr(node, chunk),
      ...(args.liveChildren !== undefined ? { liveChildren: args.liveChildren } : {}),
      ...(args.track !== undefined
        ? {
            onSpawn: (pid: number) => {
              untrack?.()
              untrack = args.track!(node.id, pid)
            },
          }
        : {}),
      signal: requestSignal(),
      ...(effectiveTimeout !== undefined ? { timeoutMs: effectiveTimeout } : {}),
      ...(inputs !== undefined ? { inputs } : {}),
      ...(cfgCacheable ? { cacheKey: hash } : {}),
      ...(remoteOnly ? { remoteOnly: true } : {}),
      ...(deferralRequested ? { download: 'deferred' as const } : {}),
      // `--force`/`--no-cache` reach a remote executor's private record
      // through this flag — the policy gates above only cover vx's OWN cache.
      ...(cfgCacheable && !(policy.localRead || policy.remoteRead) ? { refresh: true } : {}),
      outputs: { files: outputs, workspaceFiles: wsOutputs },
      ...(args.terminal === true ? { terminal: true as const } : {}),
    }
    if (!userSandbox) return base
    await args.armSandbox?.()
    const sb = await sandboxRequestFor(
      node,
      step.sandbox!,
      args.workspaceRoot,
      cfgCacheable ? args.keyedProjects(node) : undefined,
      args.nestedProjectDirs,
      args.cacheDir,
    )
    placeholders = sb.placeholders
    withheld = sb.withheld
    return { ...base, sandbox: sb.sandbox }
  }

  const wallclockEndNs = process.hrtime.bigint() - args.runStartHrTimeNs

  let own: Awaited<ReturnType<typeof ownOutputs>>
  if (effectiveExitCode === 0 && willSave && deferralRequested) {
    // The outputs never landed here: no artifact, no rows. A partial local
    // record (a row with no artifact) is exactly the corrupt-entry shape
    // `restoreOutputs` refuses, so writing none is the only clean answer.
    // The closure is what a later local consumer — or a later eager run —
    // pulls the bytes with.
    const materialize = result.outputs?.kind === 'deferred' ? result.outputs.materialize : undefined
    if (materialize !== undefined) {
      args.deferred?.register(node.id, {
        materialize,
        hash,
        entry: {
          taskId: node.id,
          command: storedCommand,
          durationMs: result.durationMs,
          stdout: result.stdout,
          ...(result.cpuMs !== undefined ? { cpuMs: result.cpuMs } : {}),
          ...(result.peakRssBytes !== undefined ? { peakRssBytes: result.peakRssBytes } : {}),
        },
      })
    }
  } else if (
    effectiveExitCode === 0 &&
    willSave &&
    (await keyStillTrue()) &&
    (own = await ownOutputs()) !== undefined
  ) {
    const { landed } = await saveMiss({
      ...own,
      node,
      hash,
      cache,
      log,
      workspaceRoot: args.workspaceRoot,
      nestedProjectDirs: args.nestedProjectDirs,
      gitFilesCache: args.gitFilesCache,
      outputs,
      wsOutputs,
      captured,
      command: storedCommand,
      durationMs: result.durationMs,
      stdout: result.stdout,
      ...(result.cpuMs !== undefined ? { cpuMs: result.cpuMs } : {}),
      ...(result.peakRssBytes !== undefined ? { peakRssBytes: result.peakRssBytes } : {}),
      outputDirSnapshots: args.outputDirSnapshots,
      deferSave: args.deferSave,
      // A sink listens: say what the save cost.
      measure: args.explainMiss !== undefined,
    })
    args.deferredSaves?.set(node.id, landed)
  } else if (cfgCacheable && !remoteOnly && !deferralRequested && args.noDependants !== true) {
    // Ran here and saves nothing — failed, a read-only policy, a tainted
    // upstream, a key that no longer held — yet it wrote what a save would
    // have marked, and may have rewritten an input the re-check before a
    // save catches. A same-run reader keyed from the snapshot's OIDs for
    // either replayed the bytes from before the command (item 750). A
    // withheld save already dropped the project; this finds the same move
    // again and drops it again.
    const endCheck = span('miss: recheck inputs')
    const moved = await movedSinceKey()
    endCheck()
    if (moved !== undefined) {
      forgetUndeclaredWrites(args, wsOutputs.length > 0 ? 'workspace' : 'project')
    } else {
      await markUnsaved({
        node,
        workspaceRoot: args.workspaceRoot,
        nestedProjectDirs: args.nestedProjectDirs,
        gitFilesCache: args.gitFilesCache,
        outputs,
        wsOutputs,
      })
    }
  }

  /**
   * The workspace fingerprint every key here folded has moved (a task
   * rewrote the lockfile), said once per run.
   */
  function fingerprintMoved(): boolean {
    if (args.fingerprintWatch?.moved() === undefined) return false
    args.fingerprintWatch.say(log)
    return true
  }

  /**
   * What an additive run saves as its own, or undefined when it removed a
   * file it found: no entry replays a removal (`ownOutputsSince`), so the
   * task saves nothing and runs again.
   */
  async function ownOutputs(): Promise<
    { ownOutputFiles?: string[]; ownWsOutputFiles?: string[] } | undefined
  > {
    const mine: { ownOutputFiles?: string[]; ownWsOutputFiles?: string[] } = {}
    if (stampedBefore !== undefined) {
      const files = await ownOutputsSince(cleanArgs, stampedBefore)
      if (files === undefined) return undefined
      mine.ownOutputFiles = files
    }
    if (wsStampedBefore !== undefined) {
      const files = await ownWorkspaceOutputsSince(wsCleanArgs, wsStampedBefore)
      if (files === undefined) return undefined
      mine.ownWsOutputFiles = files
    }
    return mine
  }

  /**
   * The input that no longer holds what the key folded, or one the key did
   * not fold that is there now: `null` when the key re-derived just before
   * the command already differed (the file unnamed), undefined when none
   * moved.
   */
  async function movedSinceKey(): Promise<string | null | undefined> {
    if (described!.hash !== hash) return null
    return (await movedInput(described!.facts, cache, described!.describedAt)) ?? described!.added()
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
    if (fingerprintMoved()) {
      unkeyed = true
      return false
    }
    const endCheck = span('miss: recheck inputs')
    const moved = await movedSinceKey()
    endCheck()
    if (moved === undefined) return true
    const what =
      moved === null ? 'its inputs' : `\`${printable(relPosix(args.workspaceRoot, moved))}\``
    // A task that regenerates its own input (TanStack Router's committed
    // `routeTree.gen.ts`, rewritten to the same bytes by every build) is
    // never saved (item 1015), and the line said so without the way out.
    // Not for `package.json`, which an output may not cover.
    const hint =
      moved === null || path.basename(moved) === 'package.json'
        ? ''
        : '; if the task writes it, declare it in cache.outputs'
    log.status(
      `[vx] ${node.id}: ${what} changed after its key was taken — the result stands, ` +
        `but is not saved under a key that no longer describes it${hint}`,
    )
    forgetUndeclaredWrites(args, wsOutputs.length > 0 ? 'workspace' : 'project')
    unkeyed = true
    return false
  }

  if (unkeyedUpstream !== undefined && willWrite && effectiveExitCode === 0) {
    log.status(
      `[vx] ${node.id}: ran over ${unkeyedUpstream.node.id}'s outputs, which its key no longer ` +
        `describes — the result stands, but is not saved`,
    )
  }

  const finalViolations = violations

  return {
    node,
    status: effectiveExitCode === 0 ? 'success' : 'failed',
    exitCode: effectiveExitCode,
    durationMs: spentMs,
    hash,
    ...(attempt > 1 ? { attempts: attempt } : {}),
    ...(failedAttempts.length > 0 ? { failedAttempts } : {}),
    ...(described !== undefined
      ? { inputFiles: captured.reduce((n, c) => (c.kind === 'file' ? n + 1 : n), 0) }
      : {}),
    ...(inputChanges !== undefined ? { inputChanges } : {}),
    ...(unkeyed ? { unkeyed: true as const } : {}),
    ...(result.timedOut === true && effectiveExitCode !== 0 ? { timedOut: true as const } : {}),
    ...(result.cpuMs !== undefined ? { cpuMs: result.cpuMs } : {}),
    ...(result.peakRssBytes !== undefined ? { peakRssBytes: result.peakRssBytes } : {}),
    ...(result.where !== undefined ? { where: result.where } : {}),
    ...(deferralRequested && result.outputs?.kind === 'deferred'
      ? { outputs: 'deferred' as const }
      : {}),
    wallclockStartNs,
    wallclockEndNs,
    ...(finalViolations.length > 0
      ? {
          // vx's own notes ride with the lines and are no denial (B-20).
          sandboxViolations: finalViolations.filter((v) => v.hint !== true).length,
          sandboxViolationLines: finalViolations.map((v) => v.line),
        }
      : {}),
  }
}

/**
 * Drop the run's facts about files a task may have written without
 * declaring them (`undeclaredWriteReach`): the project's git snapshot and
 * its index OIDs, and its `package.json` digest. The next reader
 * re-enumerates the project (one `git ls-files`) and hashes its files by
 * content; the per-declaration file-list memos are keyed on the snapshot
 * array, so they miss with it (item 743).
 */
function forgetUndeclaredWrites(args: ExecuteArgs, reach: 'none' | 'project' | 'workspace'): void {
  if (reach === 'none') return
  if (reach === 'workspace') {
    args.gitFilesCache?.clear()
    args.hashCache?.packageJson.clear()
    return
  }
  args.gitFilesCache?.delete(args.node.projectDir)
  args.gitFilesCache?.invalidateWorkspacePartition()
  args.hashCache?.packageJson.delete(args.node.projectDir)
}

/** The two bin directories a task's PATH starts with: its own, then the root's (once when they coincide). */
function taskBinDirs(node: TaskNode, workspaceRoot: string): string[] {
  const bins = [path.join(node.projectDir, 'node_modules', '.bin')]
  const rootBin = path.join(workspaceRoot, 'node_modules', '.bin')
  // Identical when the root is itself a project — dedupe rather than list it
  // twice, so PATH reads the same either way.
  if (rootBin !== bins[0]) bins.push(rootBin)
  return bins
}

/**
 * Build the child-process env for one task. Same arguments at every call site
 * (persistent + cached). Two `node_modules/.bin` directories are prepended to
 * PATH: the project's own, then the WORKSPACE ROOT's. Never a sibling
 * project's, and never an arbitrary ancestor — that is the project-isolation
 * rule, and the root is not a sibling.
 *
 * The root entry is where a monorepo's shared tooling actually lives: declare
 * `oxlint` once as a root devDependency and every member's `.bin` is empty of
 * it. Without the root on PATH such a task exits 127, which is what this
 * repo's own gate did the moment core stopped BEING the root and the two
 * paths stopped coinciding. It also removes a divergence that mattered more:
 * the REAPI executor already rebuilds both entries in the action's command,
 * so a task that resolved on a worker failed on the machine that submitted
 * it. npm/pnpm/yarn all put the ancestor chain on PATH for the same reason.
 */
function taskEnv(node: TaskNode, step: ExecConfig, workspaceRoot: string): NodeJS.ProcessEnv {
  const bins = taskBinDirs(node, workspaceRoot)
  const env = buildIsolatedEnv({
    passThrough: step.env?.passThrough ?? [],
    define: step.env?.define ?? {},
    source: process.env,
    binPaths: bins,
  })
  env[VX_RUN_WORKSPACE_ENV] = workspaceRoot
  env[VX_RUN_TASK_ENV] = node.id
  // A task's own passThrough or define wins.
  if (env[PM_EXEC_ENV] === undefined) {
    const manager = packageManagerPath(workspaceRoot)
    if (manager !== null) env[PM_EXEC_ENV] = manager
  }
  return env
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * How long a server may take to match `readyWhen` before vx says it waits.
 * `VX_READY_NOTICE_MS` overrides it, as `VX_KILL_GRACE_MS` does the grace.
 */
function readyNoticeMs(): number {
  const raw = process.env['VX_READY_NOTICE_MS']
  if (raw !== undefined && /^[0-9]+$/.test(raw) && Number(raw) > 0) return Number(raw)
  return 10_000
}
