import path from 'node:path'
import type { ExecConfig, TaskConfig, CacheConfig } from '../config.js'
import {
  type CacheEntry,
  type CacheLayer,
  type CachePolicy,
  cleanOutputs,
  cleanWorkspaceOutputs,
  FULL_CACHE_POLICY,
  type GitFilesCache,
} from '../cache/index.js'
import {
  buildIsolatedEnv,
  VX_RUN_TASK_ENV,
  VX_RUN_WORKSPACE_ENV,
  runPersistent,
  shellQuote,
  releaseBridges,
  wrapSandboxedCommand,
  signalExitCode,
  type CaptureConfig,
  type ExecuteRequest,
  type ExecuteResult,
  type SandboxViolation,
  type TaskExecutor,
  type TaskInputs,
} from '../exec/index.js'
import { isGroupTask, type TaskNode, type TaskOutcome } from '../graph/index.js'
import { span } from '../util/index.js'
import { sandboxRequestFor } from './sandbox-request.js'
import { saveMiss, type OutputDirSnapshot } from './miss-save.js'
import { restoreHit } from './hit-restore.js'
// The hit path's entry stays importable from here (tests).
export { restoreHit, type RestoreHitArgs } from './hit-restore.js'
import type { DeferredOutputs } from './deferred-outputs.js'
import type { Logger } from './logger.js'
import {
  computeGroupHash,
  computeTaskHash,
  describeTaskInputs,
  type HashCache,
  type TaskInputComponent,
} from './task-hash.js'

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
  /** Anchor for hrtime spans across all tasks in this run. */
  runStartHrTimeNs: bigint
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
   * Start the sandbox runtime, on the first task that executes inside one
   * (run.ts, `prepareSandbox`). Absent when no task in the run declares a
   * sandbox. A cache hit never calls it: a hit needs no sandbox.
   */
  armSandbox?: () => Promise<void>
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
  deferredSaves?: Map<string, Promise<void>>
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
function executeGroupTask(args: ExecuteArgs): TaskOutcome {
  const wallclockNs = process.hrtime.bigint() - args.runStartHrTimeNs
  return {
    node: args.node,
    status: 'success',
    exitCode: 0,
    durationMs: 0,
    hash: computeGroupHash(args.upstream),
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

  // When readyWhen is set we leave the command untouched so the
  // regex matcher sees the unmodified output. When it's absent the
  // task is "ready on spawn" — we can safely append forwardArgs in
  // the same way runCommand does.
  const plainCommand =
    step.persistent.readyWhen !== undefined
      ? step.command
      : effectiveForwardArgs.length > 0
        ? step.command + ' ' + effectiveForwardArgs.map(shellQuote).join(' ')
        : step.command
  // A persistent task declaring `exec.sandbox` runs inside it like any
  // other: the same grants, the same walls. What it cannot have is the
  // violation REPORT — that reads the trace after the child exits, and a
  // server exits when the run tears it down. Enforced, not reported.
  // (Until 2026-09-09 the block was accepted and silently ignored.)
  let command = plainCommand
  let bridgeTag: string | undefined
  if (step.sandbox !== undefined) {
    await args.armSandbox?.()
    const sb = await sandboxRequestFor(node, step.sandbox, args.workspaceRoot)
    const wrapped = await wrapSandboxedCommand({
      command: plainCommand,
      cwd: node.projectDir,
      ...sb,
    })
    command = wrapped.wrapped
    bridgeTag = wrapped.tag
  }
  const persistentOpts: Parameters<typeof runPersistent>[0] = {
    command,
    cwd: node.projectDir,
    env,
    onStdout: (chunk) => log.taskStdout(node, chunk),
    onStderr: (chunk) => log.taskStderr(node, chunk),
    ...(args.liveChildren !== undefined ? { liveChildren: args.liveChildren } : {}),
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

  const spawn = runPersistent(persistentOpts)
  // The host side of a port bridge lives exactly as long as the server:
  // released on the child's exit, whether the run tore it down or it died.
  if (bridgeTag !== undefined) {
    const tag = bridgeTag
    void spawn.child?.exited?.then(
      () => releaseBridges(tag),
      () => releaseBridges(tag),
    )
  }
  try {
    await spawn.ready
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // The task's OWN stream, not the process's: the frame is where a
    // reader looks for why a task failed, and a run with a custom logger
    // (an embedder, the MCP server) never saw a bare stderr write at all.
    log.taskStderr(node, `\n[vx] ${node.id}: persistent task failed to become ready: ${message}\n`)
    return {
      node,
      status: 'failed',
      exitCode: 1,
      durationMs: spawn.readyMs(),
      wallclockStartNs,
      wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
    }
  }

  args.persistentRegistry?.set(node.id, spawn.child)
  return {
    node,
    status: 'success',
    exitCode: 0,
    durationMs: spawn.readyMs(),
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
  // is also withheld from a task downstream of a failure (see `taintedUpstream`).
  const willSave = willWrite && args.taintedUpstream !== true

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
  // Tier-3 input fingerprint are captured only on a MISS, right before
  // `cache.save`, by a second `computeTaskHash` with `captureInto` set
  // — the HashCache memos (package.json bytes, task config, runtime
  // command output) plus the gitFilesCache OID map make that second
  // pass a fold + array pushes, no re-stat / re-hash I/O. It runs on
  // the miss path only, where the task is about to spawn a subprocess
  // anyway, so its cost is in the noise.
  //
  // Local short-circuit reuse: when the classify phase already derived
  // this task's stable key + probed it, reuse the up-front hash verbatim
  // (no recompute — a restore-tier task may run before its deps finish,
  // so its live `upstream` is incomplete; the up-front hash is the
  // authoritative stable key) and skip the probe below.
  const preProbed = args.preProbed
  const hash =
    preProbed !== undefined
      ? preProbed.hash
      : await computeTaskHash({
          node,
          upstream,
          workspaceRoot: args.workspaceRoot,
          workspaceFingerprint: args.workspaceFingerprint,
          cache,
          forwardArgs: args.forwardArgs,
          nestedProjectDirs: args.nestedProjectDirs,
          ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
          ...(args.hashCache !== undefined ? { hashCache: args.hashCache } : {}),
        })

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

  // Cache lookup. On hit, time the user-perceived restore op
  // (clean+restore+log-replay) — that's what the framed-block footer
  // shows, not the original exec time stored in the entry. The
  // short-circuit's up-front probe is reused: a `preProbed` entry means
  // the probe already ran — restore its hit, or (null hit) fall straight
  // to the run path as a known stable miss. No second cache.get.
  if (willRead) {
    const cacheOpStart = performance.now()
    if (preProbed !== undefined) {
      if (preProbed.hit !== null) {
        return restoreHit({ args, hash, hit: preProbed.hit, cacheOpStart, taskStartNs })
      }
      // Confirmed stable miss — skip the probe, fall through to run.
    } else {
      const endProbe = span('cache.get')
      const hit = await cache.get(hash, { taskId: node.id, command: step.command })
      endProbe()
      if (hit) {
        return restoreHit({ args, hash, hit, cacheOpStart, taskStartNs })
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
      })
    : undefined
  const inputs: TaskInputs | undefined = described?.inputs
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

  // Cache miss path (or caching disabled), up to `1 + retries` attempts.
  // Explicit config wins over the run-level `--retry` default, including
  // an explicit `retries: 0`.
  const maxAttempts = 1 + (step.retries ?? args.retries ?? 0)
  let attempt = 0
  let result: ExecuteResult
  let effectiveExitCode: number

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
    if (willWrite && !deferralRequested && outputs.length > 0) {
      // Mark the wiped paths, exactly as the workspace twin below does. The
      // git snapshot still lists them with their committed index OIDs, and
      // resolveFiles SKIPS its existence probe for any path carrying a
      // trusted OID — so a declared output the producer deletes and does not
      // re-create would stay in a same-project consumer's input set, keeping
      // that consumer's key unchanged while the file is gone from disk.
      const endClean = span('miss: clean outputs')
      const cleanedRels = await cleanOutputs(cleanArgs)
      endClean()
      args.gitFilesCache?.markOutputsChanged(node.projectDir, cleanedRels)
    }
    if (willWrite && !deferralRequested && wsOutputs.length > 0) {
      // Root-anchored deletions can land in other projects' dirs; mark
      // them so stale per-project git snapshots can't survive the wipe.
      const cleanedWsRels = await cleanWorkspaceOutputs(wsCleanArgs)
      args.gitFilesCache?.markWorkspaceOutputsChanged(args.workspaceRoot, cleanedWsRels)
    }
    violations = []
    const endReq = span('miss: build request')
    const req = await buildRequest()
    endReq()
    // An executor that THROWS produces no captured output, so the task's
    // frame would print the command and nothing else while the reason went
    // straight to stderr and scrolled away in a broad run. Put it in the
    // task's own stream first: the frame is where a reader looks for why a
    // task failed, and a remote executor's failures are exactly the ones with
    // no other trace. Rethrown unchanged — the scheduler still classifies it,
    // and still prints it plainly for a UserError.
    const endExec = span('miss: execute')
    const res = await args.executor.execute(req).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      log.taskStderr(node, `${message}\n`)
      throw err
    })
    endExec()
    violations = [...res.violations]
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
    if (userSandbox && violations.length > 0 && code === 0) code = 1
    // A declared sandbox fails the task on any violation — that is its
    // whole contract. `userSandbox` is the only way a task is sandboxed,
    // so this reads as "sandboxed and it tripped".
    // A child we SIGTERMed for exceeding the timeout is a genuine failure —
    // stream a clear line so the 143 exit reads as a timeout.
    if (res.timedOut) {
      log.taskStderr(node, `\n[vx] timed out after ${effectiveTimeout}ms — killed (SIGTERM)\n`)
      // Force a non-zero classification even if the child TRAPPED SIGTERM and
      // still exited 0 (`trap 'exit 0' TERM`, a common graceful-shutdown
      // pattern). Without this a timed-out task is classified `success` and its
      // PARTIAL outputs are cached + replayed forever — the run even reports
      // green. The timeout is a real, retryable failure; a genuinely-killed
      // child already reports 143, so this only rewrites the trap-exit-0 case.
      if (code === 0) code = signalExitCode('SIGTERM')
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

  for (;;) {
    attempt++
    const a = await runAttempt()
    result = a.result
    effectiveExitCode = a.exitCode

    // A child killed by a shutdown signal (Ctrl-C / SIGTERM teardown)
    // never finished on its own terms — revert it to aborted so it's
    // neither cached, counted, shown, nor RETRIED (the run is tearing
    // down). SIGKILL (OOM, forced) stays a real failure. A timeout also
    // SIGTERMs, but `timedOut` marks it as our own deadline, not a
    // shutdown — so it stays a real (retryable) failure.
    if ((result.signal === 'SIGINT' || result.signal === 'SIGTERM') && !result.timedOut) {
      return {
        node,
        status: 'aborted',
        exitCode: effectiveExitCode,
        durationMs: result.durationMs,
        hash,
        wallclockStartNs,
        wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
      }
    }

    if (effectiveExitCode === 0 || attempt >= maxAttempts) break
    log.taskStderr(
      node,
      `vx: retrying ${node.id} (attempt ${attempt + 1}/${maxAttempts}) after exit ${effectiveExitCode}\n`,
    )
  }

  async function buildRequest(): Promise<ExecuteRequest> {
    const base: ExecuteRequest = {
      taskId: node.id,
      workspaceRoot: args.workspaceRoot,
      command: step.command,
      forwardArgs: effectiveForwardArgs,
      cwd: node.projectDir,
      env,
      envDefine: step.env?.define ?? {},
      capture,
      onStdout: (chunk) => log.taskStdout(node, chunk),
      onStderr: (chunk) => log.taskStderr(node, chunk),
      ...(args.liveChildren !== undefined ? { liveChildren: args.liveChildren } : {}),
      ...(effectiveTimeout !== undefined ? { timeoutMs: effectiveTimeout } : {}),
      ...(inputs !== undefined ? { inputs } : {}),
      ...(cfgCacheable ? { cacheKey: hash } : {}),
      ...(remoteOnly ? { remoteOnly: true } : {}),
      ...(deferralRequested ? { download: 'deferred' as const } : {}),
      // `--force`/`--no-cache` reach a remote executor's private record
      // through this flag — the policy gates above only cover vx's OWN cache.
      ...(cfgCacheable && !(policy.localRead || policy.remoteRead) ? { refresh: true } : {}),
      outputs: { files: outputs, workspaceFiles: wsOutputs },
    }
    if (!userSandbox) return base
    await args.armSandbox?.()
    return { ...base, sandbox: await sandboxRequestFor(node, step.sandbox!, args.workspaceRoot) }
  }

  const wallclockEndNs = process.hrtime.bigint() - args.runStartHrTimeNs

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
          command: step.command,
          durationMs: result.durationMs,
          stdout: result.stdout,
          ...(result.cpuMs !== undefined ? { cpuMs: result.cpuMs } : {}),
          ...(result.peakRssBytes !== undefined ? { peakRssBytes: result.peakRssBytes } : {}),
        },
      })
    }
  } else if (effectiveExitCode === 0 && willSave) {
    const { landed } = await saveMiss({
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
      command: step.command,
      durationMs: result.durationMs,
      stdout: result.stdout,
      ...(result.cpuMs !== undefined ? { cpuMs: result.cpuMs } : {}),
      ...(result.peakRssBytes !== undefined ? { peakRssBytes: result.peakRssBytes } : {}),
      outputDirSnapshots: args.outputDirSnapshots,
      deferSave: args.deferSave,
    })
    args.deferredSaves?.set(node.id, landed)
  }

  const finalViolations = violations

  return {
    node,
    status: effectiveExitCode === 0 ? 'success' : 'failed',
    exitCode: effectiveExitCode,
    durationMs: result.durationMs,
    hash,
    ...(attempt > 1 ? { attempts: attempt } : {}),
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
          sandboxViolations: finalViolations.length,
          sandboxViolationLines: finalViolations.map((v) => v.line),
        }
      : {}),
  }
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
  const bins = [path.join(node.projectDir, 'node_modules', '.bin')]
  const rootBin = path.join(workspaceRoot, 'node_modules', '.bin')
  // Identical when the root is itself a project — dedupe rather than list it
  // twice, so PATH reads the same either way.
  if (rootBin !== bins[0]) bins.push(rootBin)
  const env = buildIsolatedEnv({
    passThrough: step.env?.passThrough ?? [],
    define: step.env?.define ?? {},
    source: process.env,
    binPaths: bins,
  })
  env[VX_RUN_WORKSPACE_ENV] = workspaceRoot
  env[VX_RUN_TASK_ENV] = node.id
  return env
}
