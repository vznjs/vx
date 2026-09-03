import { mkdir } from 'node:fs/promises'
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
  resolveInputs,
  resolveOutputs,
  resolveWorkspaceOutputs,
  WORKSPACE_OUTPUT_PREFIX,
} from '../cache/index.js'
import {
  buildIsolatedEnv,
  runPersistent,
  resolveSandboxConfig,
  shellQuote,
  signalExitCode,
  type CaptureConfig,
  type ExecuteRequest,
  type ExecuteResult,
  type SandboxViolation,
  type TaskExecutor,
  type TaskInputs,
} from '../exec/index.js'
import { isGroupTask, type TaskNode, type TaskOutcome, type VerifyVerdict } from '../graph/index.js'
import {
  classifyDeterminism,
  diffOutputTrees,
  foldFingerprint,
  hashOutputTree,
  outputRefs,
  undeclaredInputPaths,
} from './verify.js'
import { span, staticPrefix, wholeSubtreePrefixes } from '../util/index.js'
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
  /**
   * Cache-correctness verification (`vx run --verify`). When
   * `determinism` is set, an executed + cacheable task is re-run after its
   * save and its outputs are content-compared; a divergence flags the task
   * non-hermetic. When `inputs` is set, an executed + cacheable task is
   * forced through the declared-input baseline sandbox and any read outside
   * those inputs flags the declared `cache.inputs` as incomplete. When
   * `fingerprint` is set, the executed task's output tree is fingerprinted
   * and attached to the outcome (no re-run — the cross-machine diff feed).
   * `allow` exempts known-nondeterministic task ids from failing the run.
   * Pure side-channel — the re-run never saves, nothing is hashed.
   * Undefined = off.
   */
  verify?: {
    determinism: boolean
    inputs: boolean
    fingerprint: boolean
    allow: ReadonlySet<string>
  }
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
  const persistentOpts: Parameters<typeof runPersistent>[0] = {
    command:
      step.persistent.readyWhen !== undefined
        ? step.command
        : effectiveForwardArgs.length > 0
          ? step.command + ' ' + effectiveForwardArgs.map(shellQuote).join(' ')
          : step.command,
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
  try {
    await spawn.ready
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Surface readiness failure on stderr so the user sees what went
    // wrong; the buffered stdout/stderr already streamed live via the
    // logger callbacks during spawn.ready.
    process.stderr.write(`\n[vx] ${node.id}: persistent task failed to become ready: ${message}\n`)
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
  const capture: CaptureConfig = { stdout: willWrite, stderr: false }

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
    // Under a `--verify` proof the noop must be REPORTED, not silent: there
    // is no execution to sandbox or re-run, so the proof cannot cover this
    // task (the eleventh-wave residual — a silently unverified task reads
    // as a green proof over ground the proof never touched).
    const wantsProof =
      args.verify !== undefined &&
      (args.verify.inputs || args.verify.determinism || args.verify.fingerprint)
    return {
      node,
      status: 'success',
      exitCode: 0,
      durationMs: 0,
      hash,
      ...(wantsProof ? { verify: { kind: 'unverifiable-remote-only' as const } } : {}),
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

  // Sandbox is opt-in per task via `sandbox: {}` (or `sandbox: {...}`)
  // in the task config. No CLI flag, no workspace inheritance — the
  // task config is the single source of truth. EXCEPTION: `--verify=inputs`
  // forces the declared-input baseline sandbox onto every executed, cacheable
  // task to prove input-completeness (a read outside the declared inputs is a
  // proof failure, not a task failure — so it flags the RUN via the verdict,
  // it does not flip the task's own exit code the way a user-declared sandbox
  // violation does).
  const userSandbox = cfg.sandbox !== undefined
  const verifyInputs = args.verify?.inputs === true && willWrite
  const useSandbox = userSandbox || verifyInputs
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
  // streamed notice). Shared by the retry loop AND the `--verify` re-run so
  // the two can never drift on the spawn/clean/classify path.
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
      const cleanedRels = await cleanOutputs(cleanArgs)
      args.gitFilesCache?.markOutputsChanged(node.projectDir, cleanedRels)
    }
    if (willWrite && !deferralRequested && wsOutputs.length > 0) {
      // Root-anchored deletions can land in other projects' dirs; mark
      // them so stale per-project git snapshots can't survive the wipe.
      const cleanedWsRels = await cleanWorkspaceOutputs(wsCleanArgs)
      args.gitFilesCache?.markWorkspaceOutputsChanged(args.workspaceRoot, cleanedWsRels)
    }
    violations = []
    const req = await buildRequest()
    // An executor that THROWS produces no captured output, so the task's
    // frame would print the command and nothing else while the reason went
    // straight to stderr and scrolled away in a broad run. Put it in the
    // task's own stream first: the frame is where a reader looks for why a
    // task failed, and a remote executor's failures are exactly the ones with
    // no other trace. Rethrown unchanged — the scheduler still classifies it,
    // and still prints it plainly for a UserError.
    const res = await args.executor.execute(req).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      log.taskStderr(node, `${message}\n`)
      throw err
    })
    violations = [...res.violations]
    // Fail-on-violation, on BOTH platforms: macOS reads SRT's structured
    // violation store, Linux parses the strace log the sandboxed spawn
    // writes. (This comment used to claim Linux violations are "always 0"
    // and that enforcement there rests on the child failing naturally — true
    // before the strace pass shipped, false since, and the branch below is
    // live on Linux.) Violations surface via `TaskOutcome.sandboxViolationLines`.
    let code = res.exitCode
    // A USER-declared sandbox fails the task on any violation (that's its
    // fail-on-violation contract). A sandbox forced on ONLY by `--verify=inputs`
    // does NOT — the task ran fine; the incompleteness is surfaced as the
    // `undeclared-inputs` verdict (which reds the run) so the retry loop
    // doesn't pointlessly re-run and the task isn't mislabeled failed.
    if (userSandbox && violations.length > 0 && code === 0) code = 1
    // A child we SIGTERMed for exceeding the timeout is a genuine failure —
    // stream a clear line so the 143 exit reads as a timeout.
    if (res.timedOut) {
      log.taskStderr(node, `\n[vx] timed out after ${effectiveTimeout}ms — killed (SIGTERM)\n`)
      // Force a non-zero classification even if the child TRAPPED SIGTERM and
      // still exited 0 (`trap 'exit 0' TERM`, a common graceful-shutdown
      // pattern). Without this a timed-out task is classified `success` and its
      // PARTIAL outputs are cached + replayed forever — the run even reports
      // green. The timeout is a real, retryable failure (matches the
      // `--verify && !result.timedOut` guard); a genuinely-killed child already
      // reports 143, so this only rewrites the trap-exit-0 case.
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
    if (!useSandbox) return base
    // Baseline allowRead = resolved cache.inputs.files (absolute paths)
    // Baseline allowWrite = static prefix of every cache.outputs.files glob
    // Baseline denyRead = the workspace root, so any read outside the
    //   project's declared inputs trips the deny boundary.
    // The user's sandbox block extends each list with explicit additions.
    const resolved = await resolveInputs({
      projectDir: node.projectDir,
      workspaceRoot: args.workspaceRoot,
      envSource: process.env,
      inputs: cacheCfg?.inputs,
      ownOutputs: outputs,
      ownWorkspaceOutputs: wsOutputs,
      nestedProjectDirs: args.nestedProjectDirs,
      ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
      ...(args.hashCache !== undefined
        ? {
            runtimeCache: args.hashCache.runtime,
            workspaceRuntimeCache: args.hashCache.workspaceRuntime,
          }
        : {}),
    })
    const baseAllowWrite = [
      ...outputs.map((g) => path.join(node.projectDir, staticPrefix(g))),
      // Workspace outputs anchor their write prefixes at the root.
      ...wsOutputs.map((g) => path.join(args.workspaceRoot, staticPrefix(g))),
    ]
    // bwrap can't --bind a non-existent host path; the bind silently
    // becomes a no-op (or a tmpfs that evaporates on exit), and writes
    // to the path appear to succeed inside the sandbox but never land
    // on the host. Pre-create every output path so the binds resolve
    // to real fs entries: globbed outputs (`dist/**`) become empty
    // dirs; literal outputs (`out.txt`) become empty files.
    await prepareOutputsForBind(node.projectDir, outputs)
    await prepareOutputsForBind(args.workspaceRoot, wsOutputs)
    // Output paths are read+write — a task that declares `dist/**` as
    // output expects to read what it just wrote (e.g. `touch dist/x`
    // stats the file; `tsc --incremental` re-reads .tsbuildinfo).
    return {
      ...base,
      sandbox: {
        baseAllowRead: [...resolved.files, ...baseAllowWrite],
        baseAllowWrite,
        baseDenyRead: [args.workspaceRoot],
        config: resolveSandboxConfig(cfg.sandbox ?? {}, node.projectDir),
        settleOnCleanExit: verifyInputs,
      },
    }
  }

  const wallclockEndNs = process.hrtime.bigint() - args.runStartHrTimeNs

  // Attempt-1 output fingerprint for `--verify` (content OIDs by output key),
  // captured inside the save block while the tree is attempt-1's.
  let verifyFp1: Map<string, string> | undefined

  if (effectiveExitCode === 0 && willWrite && deferralRequested) {
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
        },
      })
    }
  } else if (effectiveExitCode === 0 && willWrite) {
    const outputFiles = await resolveOutputs({
      projectDir: node.projectDir,
      outputs,
      nestedProjectDirs: args.nestedProjectDirs,
    })
    const wsOutputFiles = await resolveWorkspaceOutputs({
      workspaceRoot: args.workspaceRoot,
      outputs: wsOutputs,
    })
    // Tier-3 input fingerprint: the digest rows captured by the pre-exec
    // describe above, persisted with the entry inside `cache.save`'s
    // transaction. Miss path only — the warm/hit path never reaches here.
    await cache.save({
      hash,
      projectDir: node.projectDir,
      outputFiles,
      ...(wsOutputFiles.length > 0
        ? { workspaceOutputFiles: wsOutputFiles, workspaceRoot: args.workspaceRoot }
        : {}),
      inputComponents: captured.map((c) => ({ entryHash: hash, ...c })),
      // No `exitCode`: the save only runs under `effectiveExitCode === 0`, and
      // the contract no longer accepts one — so the invariant is enforced by
      // the type rather than by every call site remembering the gate.
      entry: {
        taskId: node.id,
        command: step.command,
        durationMs: result.durationMs,
        stdout: result.stdout,
      },
    })
    {
      const savedDirPrefixes = wholeSubtreePrefixes(outputs)
      if (savedDirPrefixes !== null) {
        await cache.recordOutputDirs?.(hash, node.projectDir, savedDirPrefixes)
      }
    }
    // --verify: fingerprint attempt 1's outputs by CONTENT (raw bytes, never
    // the mtime+size memo). The determinism re-run below compares against it,
    // and the fingerprinting modes (`--verify`/`=all`/`=fingerprint`) fold it
    // into the shipped `outputFp` — the cross-machine diff feed.
    //
    // Gate on DECLARED outputs (`outputs`/`wsOutputs` globs), not the
    // RESOLVED file count: a task that declares `dist/**` but produces zero
    // files this run must still ship the EMPTY tree, or the cross-machine
    // diff can't pair it against a platform where the same glob DID match —
    // a platform-conditional glob producing nothing on one OS is exactly
    // the divergence Phase 4 exists to catch. The empty fold is well-defined
    // (a fixed sentinel tree), so two both-empty platforms stay silent.
    if (
      (args.verify?.fingerprint || args.verify?.determinism) &&
      outputs.length + wsOutputs.length > 0
    ) {
      verifyFp1 = await hashOutputTree(
        outputRefs(node.projectDir, outputFiles, args.workspaceRoot, wsOutputFiles),
      )
    }
    // This task just wrote outputs to the project's tree. Record the
    // exact declared-output paths as changed (same as the cache-hit
    // restore path) instead of dropping the whole snapshot: a downstream
    // same-project task then re-spawns git ONLY when its input globs can
    // actually see one of these paths. On a 1000-package cold run this
    // removes ~one synchronous `git ls-files` spawn per project (the
    // single largest cold-run cost — 22% of CPU in profiling). Contract:
    // outputs must be declared — an executed task that writes files
    // outside `cache.outputs.files` which a same-project downstream task
    // reads is undeclared behavior (the restore path already assumes it).
    if (outputFiles.length > 0) {
      args.gitFilesCache?.markOutputsChanged(
        node.projectDir,
        outputFiles.map((p) => path.relative(node.projectDir, p).split(path.sep).join('/')),
      )
    }
    // Declared workspace outputs may have landed inside OTHER
    // projects' dirs (no-boundary escape hatch) — mark the exact
    // paths against every partition that can see them.
    if (wsOutputFiles.length > 0) {
      args.gitFilesCache?.markWorkspaceOutputsChanged(
        args.workspaceRoot,
        wsOutputFiles.map((f) => path.relative(args.workspaceRoot, f).split(path.sep).join('/')),
      )
    }
    // The workspace-wide partition (when one exists) spans this
    // project's subtree, so it inherits the same "undeclared writes
    // are only visible to git" rule as the project drop above.
    if (outputFiles.length + wsOutputFiles.length > 0) {
      args.gitFilesCache?.invalidateWorkspacePartition()
    }
  }

  // Snapshot the WINNING attempt's sandbox violations before the verify re-run
  // (which reuses `runAttempt` and would clobber `violations`); the outcome
  // must report attempt 1's, not the re-run's.
  const finalViolations = violations

  let verify: VerifyVerdict | undefined

  // Input-completeness verification (`vx run --verify=inputs` / `=all`, Phase 2).
  // The task ran under the forced declared-input baseline sandbox. A read of a
  // workspace path outside the declared inputs proves `cache.inputs` is
  // incomplete — a future hit could serve stale bytes when that undeclared file
  // changes. This reds the run via the verdict (see run.ts `ok`), not the task's
  // own exit code. Checked FIRST: if the inputs are wrong, there's no point
  // re-running for determinism — fix the inputs (which changes the key) first.
  if (verifyInputs) {
    if (finalViolations.length > 0) {
      verify = {
        kind: 'undeclared-inputs',
        paths: undeclaredInputPaths(finalViolations, args.workspaceRoot),
      }
    } else if (effectiveExitCode === 0 && !args.verify?.determinism) {
      // Inputs-only run, inputs complete. (`=all` falls through to the stronger
      // determinism verdict below.)
      verify = { kind: 'proven-complete' }
    }
  }

  // Determinism verification (`vx run --verify` / `=all`). The task executed and
  // saved; re-run it fresh and content-compare its outputs against attempt 1. A
  // divergence proves the task is non-hermetic — its cache entry would replay
  // arbitrary past bytes. The re-run NEVER saves; the canonical (attempt-1)
  // bytes are restored afterward so disk == the cache regardless of verdict.
  if (
    verify === undefined &&
    args.verify?.determinism &&
    effectiveExitCode === 0 &&
    willWrite &&
    !result.timedOut
  ) {
    // Determinism verdict is keyed on RESOLVED outputs (unchanged): a task
    // that declares outputs but produced none this run has nothing to
    // content-compare, so it stays `no-outputs` with no re-run — even though
    // `verifyFp1` is now the (empty) declared-outputs fingerprint that
    // `--verify=fingerprint` ships for the cross-machine diff. `verifyFp1`
    // is keyed by resolved output file, so an empty map means "declared but
    // produced nothing" — the in-scope stand-in for the resolved-zero count.
    if (verifyFp1 === undefined || verifyFp1.size === 0) {
      verify = { kind: 'no-outputs' } // cacheable but nothing to replay (e.g. lint)
    } else {
      const rerun = await runAttempt()
      if (rerun.exitCode !== 0 || rerun.result.timedOut) {
        verify = { kind: 'rerun-failed', exitCode: rerun.exitCode }
      } else {
        const fp2 = await hashOutputTree(
          outputRefs(
            node.projectDir,
            await resolveOutputs({
              projectDir: node.projectDir,
              outputs,
              nestedProjectDirs: args.nestedProjectDirs,
            }),
            args.workspaceRoot,
            await resolveWorkspaceOutputs({
              workspaceRoot: args.workspaceRoot,
              outputs: wsOutputs,
            }),
          ),
        )
        verify = classifyDeterminism(
          diffOutputTrees(verifyFp1, fp2),
          args.verify.allow.has(node.id),
        )
      }
      // Put attempt 1's saved bytes back so disk == the cached artifact
      // REGARDLESS of the verdict. Mirror the restoreHit sequence exactly:
      // clean the declared globs FIRST (a nondeterministic re-run may have
      // written a stray filename the restore would never overwrite), then
      // restore, then record the exact changed paths so a downstream
      // same-project task's git snapshot can't go stale. fp1's keys ARE
      // attempt 1's saved rels (bare project rels + workspace-outputs/-
      // prefixed ws rels — the artifact namespace).
      let cleanedRels: string[] = []
      let cleanedWsRels: string[] = []
      if (outputs.length > 0) cleanedRels = await cleanOutputs(cleanArgs)
      if (wsOutputs.length > 0) cleanedWsRels = await cleanWorkspaceOutputs(wsCleanArgs)
      await cache.restoreOutputs(
        hash,
        node.projectDir,
        wsOutputs.length > 0 ? args.workspaceRoot : undefined,
      )
      const savedKeys = [...verifyFp1.keys()]
      if (outputs.length > 0) {
        args.gitFilesCache?.markOutputsChanged(node.projectDir, [
          ...cleanedRels,
          ...savedKeys.filter((k) => !k.startsWith(WORKSPACE_OUTPUT_PREFIX)),
        ])
      }
      if (wsOutputs.length > 0) {
        args.gitFilesCache?.markWorkspaceOutputsChanged(args.workspaceRoot, [
          ...cleanedWsRels,
          ...savedKeys
            .filter((k) => k.startsWith(WORKSPACE_OUTPUT_PREFIX))
            .map((k) => k.slice(WORKSPACE_OUTPUT_PREFIX.length)),
        ])
      }
    }
  }

  // Cross-machine diff feed: ship attempt 1's fingerprint (the SAVED bytes —
  // the determinism re-run above never clobbers verifyFp1) so a connected
  // serve can pair it with other platforms' reports for the same cache key.
  const outputFp =
    args.verify?.fingerprint && verifyFp1 !== undefined ? foldFingerprint(verifyFp1) : undefined

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
    ...(verify !== undefined ? { verify } : {}),
    ...(outputFp !== undefined ? { outputFp } : {}),
    ...(finalViolations.length > 0
      ? {
          sandboxViolations: finalViolations.length,
          sandboxViolationLines: finalViolations.map((v) => v.line),
        }
      : {}),
  }
}

export interface RestoreHitArgs {
  args: ExecuteArgs
  hash: string
  hit: CacheEntry
  /** `performance.now()` when the cache op (probe) started — the
   *  user-perceived restore duration is measured from here. */
  cacheOpStart: number
  /** ns offset from run start for the outcome's wallclock window. */
  taskStartNs: bigint
}

/**
 * Materialize a confirmed cache hit: decide skip-restore, clean +
 * restore declared outputs, mark the exact changed paths so downstream
 * same-project tasks needn't re-spawn git, replay stored stdout, and
 * build the cache-hit `TaskOutcome`. Extracted from `executeCachedTask`
 * so the local short-circuit can restore a stable-key hit ahead of the
 * schedule using the IDENTICAL logic — there is one restore path, not
 * two that could drift.
 */
export async function restoreHit(restore: RestoreHitArgs): Promise<TaskOutcome> {
  const { args, hash, hit, cacheOpStart, taskStartNs } = restore
  const { node, log } = args
  const cacheCfg: CacheConfig | undefined = node.config.cache
  const outputs = cacheCfg?.outputs.files ?? []
  const wsOutputs = cacheCfg?.outputs.workspaceFiles ?? []
  const anyOutputs = outputs.length > 0 || wsOutputs.length > 0
  const dirPrefixes = wholeSubtreePrefixes(outputs)
  const cleanArgs = {
    projectDir: node.projectDir,
    outputs,
    nestedProjectDirs: args.nestedProjectDirs,
  }
  const wsCleanArgs = { workspaceRoot: args.workspaceRoot, outputs: wsOutputs }

  // "Tree is already current" short-circuit — skip cleanOutputs
  // + restoreOutputs when the on-disk state matches what this
  // entry recorded at save time. Integrity-preserving: we
  // require BOTH that the output-glob walk yields exactly the
  // expected paths (no strays, no missing) AND that every file's
  // (size, mode, mtime) matches the stored fingerprint. Any
  // divergence falls through to a real clean + restore.
  //
  // The output-file fingerprints can't be batch-loaded at
  // prepareRun time — non-leaf task hashes depend on upstream
  // outputs that haven't been written yet, so hashes are
  // necessarily computed mid-run. We do one extra SELECT per
  // cache hit here. Still beats reading the manifest from the
  // tar (decompress + parse) at the same point.
  let skipRestore = false
  if (anyOutputs) {
    const endRows = span('output rows')
    const expected = hit.outputRows ?? args.cache.loadOutputFilesBatch([hash]).get(hash) ?? []
    endRows()
    if (expected.length > 0) {
      // Two namespaces in the rows: bare rels are project outputs,
      // `workspace-outputs/<rel>` rows anchor at the workspace root.
      const projExpected = expected.filter((e) => !e.path.startsWith(WORKSPACE_OUTPUT_PREFIX))
      const wsExpected = expected
        .filter((e) => e.path.startsWith(WORKSPACE_OUTPUT_PREFIX))
        .map((e) => ({ ...e, path: e.path.slice(WORKSPACE_OUTPUT_PREFIX.length) }))
      // The directory short-circuit: for whole-subtree globs, unchanged
      // mtimes on every directory recorded at the last save/restore prove
      // the output SET is unchanged (a file added or removed anywhere the
      // glob could see bumps a recorded directory), so the walk that cost
      // 0.36 ms per warm hit is replaced by a few stats. The per-file
      // fingerprint check below still runs; only the enumeration is skipped.
      let setKnown = false
      if (dirPrefixes !== null && wsOutputs.length === 0 && args.cache.loadOutputDirsBatch) {
        const endDirs = span('output dirs')
        const dirRows = args.cache.loadOutputDirsBatch([hash]).get(hash) ?? []
        const covers = dirPrefixes.every((pre) => dirRows.some((r) => r.path === pre))
        setKnown = covers && (await args.cache.outputDirsCurrent!(node.projectDir, dirRows))
        endDirs()
      }
      let actualAbs: string[]
      let actualWsAbs: string[]
      if (setKnown) {
        actualAbs = projExpected.map((e) => path.join(node.projectDir, e.path))
        actualWsAbs = []
      } else {
        const endGlob = span('output glob')
        actualAbs = await resolveOutputs({
          projectDir: node.projectDir,
          outputs,
          nestedProjectDirs: args.nestedProjectDirs,
        })
        actualWsAbs = await resolveWorkspaceOutputs({
          workspaceRoot: args.workspaceRoot,
          outputs: wsOutputs,
        })
        endGlob()
      }
      const setsMatch = (
        actual: readonly string[],
        exp: ReadonlyArray<{ path: string }>,
      ): boolean => {
        const expSet = new Set(exp.map((e) => e.path))
        return actual.length === expSet.size && actual.every((r) => expSet.has(r))
      }
      const actualRels = actualAbs.map((p) =>
        path.relative(node.projectDir, p).split(path.sep).join('/'),
      )
      const actualWsRels = actualWsAbs.map((p) =>
        path.relative(args.workspaceRoot, p).split(path.sep).join('/'),
      )
      if (setsMatch(actualRels, projExpected) && setsMatch(actualWsRels, wsExpected)) {
        const endStat = span('output stat')
        skipRestore =
          (await args.cache.isOutputsCurrent(node.projectDir, projExpected)) &&
          (await args.cache.isOutputsCurrent(args.workspaceRoot, wsExpected))
        endStat()
        // The walk ran and proved the tree current (rows absent, or a
        // directory had moved — a benign touch): snapshot the directories
        // so the next hit skips the walk.
        if (skipRestore && !setKnown && dirPrefixes !== null) {
          await args.cache.recordOutputDirs?.(hash, node.projectDir, dirPrefixes)
        }
      }
    }
  }
  if (!skipRestore) {
    let cleanedRels: string[] = []
    let cleanedWsRels: string[] = []
    if (outputs.length > 0) cleanedRels = await cleanOutputs(cleanArgs)
    if (wsOutputs.length > 0) cleanedWsRels = await cleanWorkspaceOutputs(wsCleanArgs)
    await args.cache.restoreOutputs(hash, node.projectDir, args.workspaceRoot)
    if (dirPrefixes !== null) {
      await args.cache.recordOutputDirs?.(hash, node.projectDir, dirPrefixes)
    }
    // Restored outputs changed the project's tree — but on this
    // path we know the EXACT changed paths (wiped declared
    // outputs + the artifact's files). Record them instead of
    // dropping the snapshot; downstream same-project tasks only
    // re-spawn git when their input globs can actually see one of
    // these paths. The cache-miss save path keeps the
    // unconditional drop (an executed task may write undeclared
    // files only git can see).
    if (outputs.length > 0) {
      args.gitFilesCache?.markOutputsChanged(node.projectDir, [
        ...cleanedRels,
        ...hit.outputFiles.filter((p) => !p.startsWith(WORKSPACE_OUTPUT_PREFIX)),
      ])
    }
    if (wsOutputs.length > 0) {
      args.gitFilesCache?.markWorkspaceOutputsChanged(args.workspaceRoot, [
        ...cleanedWsRels,
        ...hit.outputFiles
          .filter((p) => p.startsWith(WORKSPACE_OUTPUT_PREFIX))
          .map((p) => p.slice(WORKSPACE_OUTPUT_PREFIX.length)),
      ])
    }
  }
  if (hit.stdout) log.taskStdout(node, hit.stdout)
  const status =
    hit.exitCode !== 0 ? 'failed' : hit.source === 'remote' ? 'cache-hit-remote' : 'cache-hit'
  // `restored` distinguishes "we just wrote files to disk" from
  // "disk already matched the cached snapshot". Drives the
  // "up-to-date" vs "local-cache" / "remote-cache" label in the
  // framed block. Only meaningful when at least one output was
  // declared — no-outputs tasks never materialize anything, so
  // they're vacuously up-to-date.
  const restored = !skipRestore && anyOutputs
  return {
    node,
    status,
    exitCode: hit.exitCode,
    // What THIS run spent: probe + restore. NOT the stored exec time — see
    // `storedDurationMs`, which is what the hit skipped.
    durationMs: Math.round(performance.now() - cacheOpStart),
    storedDurationMs: hit.durationMs,
    hash,
    restored,
    // Under `--verify`, a cache hit didn't execute this run — so it wasn't
    // proven. Flag it `not-verified` (use `--force` to re-execute + verify).
    ...(args.verify?.determinism || args.verify?.inputs
      ? { verify: { kind: 'not-verified' as const } }
      : {}),
    wallclockStartNs: taskStartNs,
    wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
  }
}

/**
 * Ensure each declared output path exists on the host as either an
 * empty file (for literal output specs) or a directory (for globbed
 * specs) so bwrap's --bind can find a real fs entry to mount. Without
 * this, writes inside the sandbox to a non-existent allowWrite path
 * silently disappear (bwrap creates a tmpfs that evaporates on exit).
 *
 * `cleanOutputs` ran just before this in the cache-enabled path, so
 * we know any stale content was wiped; what's left is to materialize
 * the empty skeleton.
 */
async function prepareOutputsForBind(
  projectDir: string,
  outputs: readonly string[],
): Promise<void> {
  for (const g of outputs) {
    const hasWildcard = /[*?[\]]/.test(g)
    if (hasWildcard) {
      const abs = path.join(projectDir, staticPrefix(g))
      await mkdir(abs, { recursive: true })
    } else {
      const abs = path.join(projectDir, g)
      await mkdir(path.dirname(abs), { recursive: true })
      const f = Bun.file(abs)
      if (!(await f.exists())) await Bun.write(abs, '')
    }
  }
}

/**
 * Return the longest prefix of a glob that contains no wildcards. Used
 * to derive an allowWrite path from each `cache.outputs.files` entry:
 * `dist/**` → `dist`, `build/output.js` → `build/output.js`, `**` →
 * `.` (the project dir itself). bwrap binds at the directory level so
 * a file path covers writes to that file; a dir path covers writes
 * anywhere underneath.
 */
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
  return buildIsolatedEnv({
    passThrough: step.env?.passThrough ?? [],
    define: step.env?.define ?? {},
    source: process.env,
    binPaths: bins,
  })
}
