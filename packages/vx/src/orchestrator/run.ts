// End-to-end wiring: discover workspace -> load configs -> build graph ->
// run with caching. Each step delegates to a single-purpose sibling file
// so the layers can be swapped without touching the others.

import os from 'node:os'
import {
  type CacheLayer,
  type CachePolicy,
  FULL_CACHE_POLICY,
  type InvocationRecord,
  type RunRecord,
} from '../cache/index.js'
import { VERSION } from '../version.js'
import { initSandbox, probeSandbox, resetSandbox, signalExitCode } from '../exec/index.js'
import { DeferredOutputs } from './deferred-outputs.js'
import { resolveDownloadModes } from './download-policy.js'
import { selectExecutor, type TaskExecutor } from '../exec/index.js'
import {
  isGroupTask,
  markSurfacedDeps,
  runGraph,
  type TaskNode,
  type TaskOutcome,
} from '../graph/index.js'
import { MAX_TIMEOUT_MS, ulid, UserError } from '../util/index.js'
import { executeTask } from './execute-task.js'
import { resolveResourceCosts } from './resources.js'
import { computeTaskHash } from './task-hash.js'
import { busLogger, createEventBus, terminalSubscriber } from './events.js'
import { installPlugins } from './plugin.js'
import { resolveExecutors, subscribeEventSinks, teardownPlugins } from './plugin-host.js'
import type { SubscribedEventSinks } from './plugin-host.js'
import { subscribeTelemetry, type TelemetryHandle } from './telemetry-host.js'
import { assembleRunSummary, deriveCacheSource, isCacheHit, isPassStatus } from './telemetry.js'
import type { RunContextRecord, TaskTelemetry } from './telemetry.js'
import { defaultLogger, resolveOutputView, type Logger } from './logger.js'
import { detectColors } from './colors.js'
import { formatPersistentList } from './framed-output.js'
import { LocalHistoryProvider } from './history.js'
import { plan, type RunPlan } from './plan.js'
import { prepareRun } from './prepare.js'
import {
  captureDefaultBranch,
  captureGitContext,
  captureHostContext,
  captureWorkspaceIdentity,
  detectCi,
} from './run-context.js'
import { startRemotePrefetch } from './remote-prefetch.js'
import { startLocalShortCircuit, type ShortCircuit } from './local-shortcircuit.js'
import { formatVerifySection } from './verify.js'

const EMPTY_SHORT_CIRCUIT: ShortCircuit = { preProbed: new Map(), restoreTier: new Set() }

/**
 * Grace after SIGTERMing the dependency-only persistent tasks at end-of-run
 * before force-killing any that trap or ignore it — so a wedged mock server
 * can't hang a normal run at completion. Well-behaved servers exit far under
 * this, so the happy path never waits it out.
 */
const PERSISTENT_SHUTDOWN_GRACE_MS = 2000
import { writeRunProfile, writeRunSummary } from './run-artifacts.js'
import { formatAbortedSection, formatRunSummary } from './summary.js'
import type { RunOptions, RunSummary } from './options.js'

/**
 * Parse the `VX_TASK_TIMEOUT` env var (ms) — the "global" run-level task
 * timeout default. A missing/empty/non-positive-integer value yields
 * `undefined` (ignored), so a typo never silently disables a task's own
 * `exec.timeout`. A value past `MAX_TIMEOUT_MS` is clamped to it — see below.
 *
 * Exported for `tests/options-resolve.test.ts`, which pins every accepted
 * and ignored form of this rung; it has no other caller outside this file.
 */
export function readTaskTimeoutEnv(): number | undefined {
  const raw = process.env['VX_TASK_TIMEOUT']
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return undefined
  // CLAMPED, not refused — unlike `exec.timeout` and `--timeout`, this rung's
  // contract is already "unusable value → fall back", so it never throws. But
  // falling back is wrong here: someone who typed a huge number wants a long
  // timeout, and the largest expressible one IS long (~24.8 days). Handing it
  // to `setTimeout` unbounded would mean 1 ms — killing every task instantly.
  return Math.min(n, MAX_TIMEOUT_MS)
}

/**
 * Compact the 4-axis cache policy into the `invocations.cache_policy`
 * column string. Each enabled axis contributes its flag; a fully-on
 * policy reads `'lR,lW,rR,rW'`. Pure presentation — never affects the key.
 */
function compactCachePolicy(p: CachePolicy): string {
  const parts: string[] = []
  if (p.localRead) parts.push('lR')
  if (p.localWrite) parts.push('lW')
  if (p.remoteRead) parts.push('rR')
  if (p.remoteWrite) parts.push('rW')
  return parts.join(',')
}

/**
 * The policy that will actually govern the run. The remote axes are inert
 * without a remote layer to serve them: a `remote:w` policy over a bare
 * local cache writes NOWHERE, yet the write axis reads as on. Normalising
 * here — the ONE place both `run()` and `planRun()` derive it from — is
 * what keeps `--dry` describing the run you are about to get: reading the
 * raw request made the plan label `--cache=local:,remote:rw` "cache miss —
 * would exec" (a result that will be stored) for a run in which caching is
 * entirely off.
 */
function effectiveCachePolicy(requested: CachePolicy, hasRemoteLayer: boolean): CachePolicy {
  return hasRemoteLayer ? requested : { ...requested, remoteRead: false, remoteWrite: false }
}

/**
 * The perf firewall for the local short-circuit. Always-on; the only
 * gates are correctness/no-op gates:
 *   - LOCAL-ONLY cache. Behind a remote layer, `cache.get` is a remote
 *     READ-THROUGH — the up-front classify is awaited before scheduling,
 *     so N remote GETs would land on the critical path before any task
 *     starts. Remote runs are owned by `startRemotePrefetch`, which
 *     overlaps the GETs with execution instead (fire-and-forget) and
 *     ingests hits into local for execute-task's lazy probe. The gate asks
 *     the layer (`hasRemote`), not `instanceof LayeredCache` — a
 *     third-party remote layer stalls on the classify just as hard.
 *   - the policy reads locally (a `--no-cache`/`--force`/`--cache=local:`
 *     run reads nothing locally → nothing to restore → skip);
 *   - the graph has at least one dependency edge (a flat graph has no
 *     ordering to bypass — restoring is what execute() already does, so
 *     there's no upside and we avoid the upfront probe pass).
 * The per-task correctness gates (stable key, no workspace-outputs in
 * graph) live in `startLocalShortCircuit`.
 */
export function shouldShortCircuit(
  nodes: Map<string, TaskNode>,
  policy: CachePolicy,
  cache: CacheLayer,
): boolean {
  if (cache.hasRemote === true) return false
  if (!policy.localRead) return false
  for (const node of nodes.values()) if (node.deps.length > 0) return true
  return false
}

export async function run(options: RunOptions): Promise<RunSummary> {
  // Color decision: a custom logger (tests, embedders) handles its
  // own formatting and asserts on plain strings, so we suppress
  // ANSI escapes for them. Only the defaultLogger (real terminal
  // output) gets colors, gated by NO_COLOR / FORCE_COLOR / isTTY.
  const colors = options.log ? { enabled: false } : detectColors()
  // The concrete renderer (default terminal logger, or a custom embedder
  // logger) no longer receives orchestrator calls directly — it SUBSCRIBES
  // to the run event bus as the always-on, in-process terminal surface.
  // Every existing `log.X(...)` call site emits a RunEvent through
  // `busLogger`, so the same output flows through the event stream and
  // future off-thread surfaces (web devtool, TUI, MCP) attach as
  // additional subscribers. The fan-out is synchronous and order-
  // preserving, so terminal output is byte-identical to a direct call.
  // See docs/design/event-stream-2026-06.md.
  const sink = options.log ?? defaultLogger(colors, resolveOutputView(options))
  // An injected bus (e.g. from `--ui`) already has surfaces subscribed;
  // we just add the terminal renderer. Otherwise a fresh internal bus.
  const bus = options.bus ?? createEventBus()
  bus.subscribe(terminalSubscriber(sink))
  const log = busLogger(bus)

  const prepared = await prepareRun(options, log)
  // A requested name that matched no project is a typo (or a stray
  // positional from an `=`-only flag written with a space). Failing the
  // whole run — even when OTHER requested tasks resolved — is the point:
  // a CI job that renames a task must go red, not silently stop running
  // it. When EVERY name is unresolved this is the `no-tasks-declared`
  // case too; the message is identical, so that branch stays below.
  if (prepared.unresolvedTasks.length > 0) {
    log.status(`No projects declare task(s): ${prepared.unresolvedTasks.join(', ')}.`)
    prepared.cache.close()
    return { ok: false, outcomes: [] }
  }
  if (prepared.empty !== null) {
    // `no-tasks-declared` is almost always a typo in CI; we surface
    // a clear message and return NOT-ok so the script exits 1.
    // `empty-graph` is defensive — unreachable under current
    // buildTaskGraph semantics but logged just in case.
    const msg =
      prepared.empty === 'no-tasks-declared'
        ? `No projects declare task(s): ${options.tasks.join(', ')}.`
        : 'No tasks to run.'
    log.status(msg)
    prepared.cache.close()
    return { ok: false, outcomes: [] }
  }
  // Install user plugins as additional bus subscribers BEFORE the run
  // starts emitting events. `installPlugins` runs each plugin's optional
  // `setup` hook (the old observe-only path); `subscribeEventSinks` wires
  // each plugin's `eventSink` capability onto the bus via wireForwarder.
  // Both fail-fast on a setup() throw with a clean UserError naming the
  // plugin; eventSink init failures are isolated (observability never
  // breaks a run). A plugin without `setup`/`eventSink` (the local executor
  // and cache) is skipped by both loops — they subscribe nothing.
  let disposePlugins: (() => void) | undefined
  let eventSinks: SubscribedEventSinks | undefined
  let telemetry: TelemetryHandle | undefined
  try {
    disposePlugins = await installPlugins({
      plugins: prepared.plugins as never,
      bus,
      workspaceRoot: prepared.workspaceRoot,
      cacheDir: prepared.cacheDir,
      warn: (m) => log.status(m),
    })
    eventSinks = await subscribeEventSinks(prepared.plugins, bus, {
      workspaceRoot: prepared.workspaceRoot,
      cacheDir: prepared.cacheDir,
      warn: (m: string) => log.status(m),
    })
  } catch (err) {
    disposePlugins?.()
    prepared.cache.close()
    throw err
  }
  const {
    workspaceRoot,
    workspaceConfig,
    cacheDir,
    cache,
    nodes,
    workspaceFingerprint,
    nestedDirsByProject,
    gitFilesCache,
    hashCache,
    workspaceProjectCount,
  } = prepared
  const concurrency =
    options.concurrency ??
    workspaceConfig?.concurrency ??
    Math.max(1, navigator.hardwareConcurrency)

  // Resolved ONCE per run, in declaration order. A broken factory — or a
  // workspace that declared no executor — aborts here, before any task
  // starts.
  let executors: readonly TaskExecutor[]
  try {
    executors = await resolveExecutors(prepared.plugins, {
      workspaceRoot: prepared.workspaceRoot,
      cacheDir: prepared.cacheDir,
      warn: (m: string) => log.status(m),
      concurrency,
    })
  } catch (err) {
    disposePlugins?.()
    eventSinks?.dispose()
    prepared.cache.close()
    throw err
  }
  // Placement: decided ONCE per task, before scheduling, so the scheduler
  // can admit a remote-pooled task against its pool instead of a local
  // worker slot. Group tasks run nothing; persistent tasks never reach an
  // executor (local by construction) — both stay off the map.
  //
  // `--verify=inputs` pins EVERYTHING local: the input-completeness proof
  // is the OS sandbox, which is local machinery a remote executor silently
  // ignores — so a remotely-executed task would pass the verify VACUOUSLY,
  // leaky or not. A verify run is a local proof procedure by definition;
  // determinism/fingerprint modes are unaffected (no sandbox involved).
  const placements = placeTasks(nodes, executors, options.verify?.inputs === true)
  // `--download` (default `all`) decides ONCE per task, here, whether a
  // remote execution's outputs come home. `--verify` pins every task local
  // (so nothing defers under a proof) and `all` keeps today's behaviour
  // byte for byte.
  // A proof must observe what it proves. `--verify=inputs` already pins
  // every task LOCAL (so nothing could defer), but determinism and
  // fingerprint modes do NOT — and a deferred task's outputs are absent
  // when the verifier looks, which reported `no-outputs` for a task that
  // declares outputs: an n/a verdict for work the proof never examined.
  // Deferral is transfer tuning; a verify run is a rare, deliberate
  // correctness run. Eager wins, and says so when it overrides.
  const downloadPolicy = options.verify !== undefined ? 'all' : (options.download ?? 'all')
  if (
    options.verify !== undefined &&
    options.download !== undefined &&
    options.download !== 'all'
  ) {
    log.status(`vx: --verify observes outputs on disk — ignoring --download=${options.download}`)
  }
  const localPlaced = new Set(
    [...nodes.keys()].filter((id) => placements.executors.get(id)?.remote !== true),
  )
  const download = resolveDownloadModes({
    nodes,
    policy: downloadPolicy,
    localPlaced,
    remoteOnly: placements.remoteOnly,
  })

  // Run-level default task timeout (ms), applied to any task WITHOUT its own
  // `exec.timeout`. Precedence, highest first: `--timeout`/RunOptions.timeout
  // → `VX_TASK_TIMEOUT` env → workspace `timeout`. A malformed env value is
  // ignored (a bad timeout must not silently disable a task's own limit).
  const taskTimeoutDefault =
    options.timeout ?? readTaskTimeoutEnv() ?? workspaceConfig?.timeout ?? undefined

  // Run-scoped registries of live subprocesses:
  //   - `liveChildren`: in-flight children. The runner adds/removes
  //     each child around its spawn (persistent children stay until
  //     they exit).
  //   - `persistentRegistry`: ready persistent tasks (dev servers,
  //     watchers). executeTask spawns them but does NOT await their
  //     exit; ownership moves here so the orchestrator can SIGTERM
  //     them once the rest of the graph finishes.
  //
  // A SIGINT/SIGTERM mid-run forwards SIGTERM to everything live,
  // closes the cache handle, and exits 128+signo (130/143). Without
  // this, a programmatic signal to the vx process alone (CI
  // cancellation, `kill <pid>`) orphans every running child —
  // terminal Ctrl-C only worked via process-group propagation. The
  // handlers are removed in the finally below so repeated run()
  // calls (test suites) never stack listeners.
  const liveChildren = new Set<ReturnType<typeof Bun.spawn>>()
  const persistentRegistry = new Map<string, ReturnType<typeof Bun.spawn>>()
  const onSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    // Clear the live worker/status region BEFORE exiting so a TTY isn't
    // left with a frozen region frozen in the scrollback (the documented
    // KNOWN-OPEN). runEnd is idempotent and a no-op for non-TTY loggers.
    try {
      log.runEnd?.()
    } catch {
      // teardown must not throw on the way out
    }
    for (const child of liveChildren) child.kill('SIGTERM')
    for (const child of persistentRegistry.values()) child.kill('SIGTERM')
    try {
      cache.close()
    } catch {
      // double-close race with the normal path; we're exiting anyway
    }
    process.exit(signalExitCode(signal))
  }
  const onSigint = (): void => onSignal('SIGINT')
  const onSigterm = (): void => onSignal('SIGTERM')
  if (options.handleSignals ?? true) {
    process.on('SIGINT', onSigint)
    process.on('SIGTERM', onSigterm)
  }
  // The cache handle must be released on EVERY exit path, not just the
  // happy one: `close()` is also where the run's deferred `accessed_at`
  // bumps are flushed, so a throw between opening the cache and the
  // normal close leaked the SQLite handle (it matters in a long-lived
  // host) AND lost this run's touch record, after which an LRU
  // `vx cache prune` can evict entries the run just hit. Once-only
  // because the normal path closes before the persistent-task wait —
  // holding the handle open for a dev server's whole lifetime would be
  // worse — and because close() re-runs its retention DELETEs.
  let cacheClosed = false
  const closeCache = (): void => {
    if (cacheClosed) return
    cacheClosed = true
    cache.close()
  }
  try {
    // One run-id per `vx run` invocation. Every task in the resulting
    // graph carries it so analytics queries can group by invocation.
    const runId = ulid()
    const runStartHrTimeNs = process.hrtime.bigint()
    const endedAtMsAtStart = Date.now()
    const remoteCacheEnabled = prepared.hasRemoteLayer
    // Normalised ONCE so every consumer — the verify gate, execute-task,
    // the dedup predicate, the recorded invocation row — reads the policy
    // that actually governed the run. Reading the raw request here made
    // tasks clean their outputs before every exec for a save that never
    // happened, and `--verify` clean them AGAIN and restore an artifact
    // that was never written (wiping a successful build's tree and
    // reporting it failed).
    const policy: CachePolicy = effectiveCachePolicy(
      options.cache ?? FULL_CACHE_POLICY,
      prepared.hasRemoteLayer,
    )
    const deferredOutputs = new DeferredOutputs({
      nodes,
      cache,
      workspaceRoot,
      nestedDirsByProject,
      ...(gitFilesCache !== undefined ? { gitFilesCache } : {}),
      localWrite: policy.localWrite,
    })

    // `--verify` observes the miss-then-save path and then RESTORES attempt
    // 1 from the artifact that save wrote, so the tree ends byte-identical
    // to what was cached regardless of the verdict. That restore reads the
    // LOCAL artifact file — `restoreOutputs` is a local extraction on every
    // layer, by design — so without the local WRITE axis there is nothing to
    // restore from: verify cleaned a successful build's declared outputs and
    // then failed the run on the missing artifact. A remote fallback would
    // not fix that, only narrow it to "whenever the remote is reachable at
    // that instant", turning a guarantee into a coin flip with data loss on
    // the losing side. So the honest gate is the local write axis, and
    // `--no-cache` / `--cache=local:,…` / `--cache=local:r,…` are refused
    // loudly — silently verifying nothing is the one failure mode
    // verification must never have (same platform-honesty rule as the
    // sandbox-unavailable error). `--force --verify` re-verifies a warm graph.
    if (options.verify !== undefined && !policy.localWrite) {
      throw new UserError(
        '--verify needs the LOCAL cache write axis: it re-runs the task, then restores ' +
          'attempt 1 from the local artifact so the outputs on disk are the ones that were ' +
          'cached. Enable local writes (e.g. --cache=local:w,remote:rw), drop --no-cache, ' +
          'or use --force --verify to re-execute and verify a warm graph',
      )
    }

    // Per-run context for the Tier-3 `invocations` header row. Captured
    // ONCE (git is ONE spawn for commit+branch, behind try/catch; never
    // fails a run). `dirty` reuses the `git status --porcelain` the
    // GitFilesCache populate already ran for input enumeration — no
    // second status spawn.
    const gitContext = captureGitContext(workspaceRoot, gitFilesCache.worktreeDirty)
    const ciContext = detectCi(process.env)
    const hostContext = captureHostContext()

    // The canonical run-context record — the same git/CI/host data the
    // invocation header uses, shaped as the telemetry export contract.
    // Built + consulted ONLY when a plugin CONTRIBUTES `telemetry`, and
    // BEFORE run:start is emitted so a sink
    // catches the whole stream.
    // subscribeTelemetry returns undefined when no sink is contributed (no
    // telemetry plugin, or all declined — e.g. otel() with no OTLP endpoint),
    // so a plain run does ZERO extra work: no record allocation, no bus
    // subscriber, no summary building. The hot path stays off-limits.
    let runContextRecord: RunContextRecord | undefined
    // Gate on a plugin that can actually CONTRIBUTE a sink, not on declaring
    // any plugin at all: a cache-only plugin has no telemetry hook to
    // consult, so paying for the record (2 git spawns + a `.vx/workspace-id`
    // write on a remote-less repo) buys nothing. A plugin that has the hook
    // but declines still pays — its answer is only knowable by asking.
    const hasTelemetryPlugin = prepared.plugins.some((p) => p.telemetry !== undefined)
    if (hasTelemetryPlugin || options.telemetrySinks !== undefined) {
      // Workspace identity (telemetry v2): one git spawn, paid only when a
      // telemetry consumer can exist — a plain run never reaches here.
      const wsIdentity = captureWorkspaceIdentity(workspaceRoot)
      runContextRecord = {
        runId,
        vxVersion: VERSION,
        command: options.command ?? process.argv.slice(1).join(' '),
        requestedTasks: [...options.tasks],
        cachePolicy: compactCachePolicy(policy),
        concurrency,
        flow: options.flow ?? null,
        commitSha: gitContext.commitSha,
        branch: gitContext.branch,
        defaultBranch: captureDefaultBranch(process.env, workspaceRoot),
        dirty: gitContext.dirty,
        ci: ciContext.ci,
        ciProvider: ciContext.provider,
        host: hostContext.host,
        os: hostContext.os,
        arch: hostContext.arch,
        workspaceId: wsIdentity.id,
        workspaceName: wsIdentity.name,
        tags: options.tags ?? {},
      }
      telemetry = await subscribeTelemetry(
        prepared.plugins,
        bus,
        { workspaceRoot, cacheDir, warn: (m: string) => log.status(m) },
        runContextRecord,
        options.telemetrySinks,
      )
    }

    // Lazy SRT init: fire it up if at least one task opts into sandboxing
    // via its `sandbox: {...}` block, OR `--verify=inputs`/`=all` is on (it
    // forces the declared-input baseline sandbox onto every cacheable task to
    // prove input-completeness). Tasks that need sandboxing on an unsupported
    // platform get a hard error so they don't silently run unsandboxed —
    // `--verify=inputs` in particular must fail loud, never falsely "pass".
    const verifyInputs = options.verify?.inputs === true
    const anySandboxed =
      verifyInputs || [...nodes.values()].some((n) => n.config.sandbox !== undefined)
    if (anySandboxed) {
      const avail = await probeSandbox()
      if (!avail.available) {
        throw new UserError(
          verifyInputs
            ? `--verify=inputs needs the sandbox, which is not available: ${avail.reason}`
            : `sandbox not available: ${avail.reason}`,
        )
      }
      await initSandbox()
    }

    // Focused flow: a requested GROUP has no output of its own, so
    // surface the same-project, non-group tasks it chains (one level)
    // for display. Marks `node.surfaced`; never touches `requested`.
    markSurfacedDeps(nodes)

    // Header counts: unique projects covered by the graph (including
    // dependsOn-pulled deps, not just the user-requested set), and the
    // total number of real (non-group) task executions. Mirrors the
    // count the end-of-run summary reports under "total". The
    // requested count drives the focused logger's live-vs-buffered
    // decision, so surfaced nodes count toward it too — they display
    // like requested tasks.
    const packagesInScope = new Set<string>()
    let taskCount = 0
    let requestedCount = 0
    for (const node of nodes.values()) {
      packagesInScope.add(node.projectName)
      if (!isGroupTask(node)) {
        taskCount++
        if (node.requested || node.surfaced === true) requestedCount++
      }
    }
    // Resource-aware admission: resolve every task's `exec.resources`
    // into absolute costs ONCE, up front (percent forms against the
    // budgets), so the scheduler's inner loop is a plain Map.get. The
    // CPU budget is the run's concurrency; the memory budget is
    // os.totalmem() unless `--memory` overrides it (pass `--memory` in
    // cgroup-limited containers — totalmem() reports the HOST's RAM).
    // Nothing declared → empty map → fields omitted from the scheduler
    // AND the footer → byte-identical legacy path.
    const memBudget = options.memory ?? os.totalmem()
    const resourceCosts = resolveResourceCosts(nodes, concurrency, memBudget)

    // Run context for the footer. The top-of-run header is gone — the
    // banner now lives in the summary, where the eye lands at the end.
    const runContext = {
      version: VERSION,
      packageCount: packagesInScope.size,
      remoteCacheEnabled,
      concurrency,
      workspaceProjectCount,
      ...(resourceCosts.size > 0 ? { cpuBudget: concurrency, memBudget } : {}),
    }

    // Lifecycle hooks drive the default logger's dynamic status line
    // (TTY-only); custom loggers may ignore them.
    log.runStart?.({
      total: taskCount,
      concurrency,
      requestedCount,
      context: runContext,
      startedAtMs: endedAtMsAtStart,
    })

    // Remote-only: kick off background prefetches so remote-GET latency
    // overlaps execution. Fire-and-forget — execution starts on the next
    // line; the layer ingests hits into local and de-dups so
    // execute-task's cache.get awaits the in-flight promise (one remote
    // GET per key). Gated entirely on a remote layer being configured;
    // local-only runs never reach here, so their behavior + perf is
    // unchanged (no upfront key pass, no local probing).
    let prefetchDone: Promise<void> = Promise.resolve()
    if (prepared.hasRemoteLayer) {
      prefetchDone = startRemotePrefetch({
        nodes,
        cache,
        workspaceRoot,
        workspaceFingerprint,
        forwardArgs: options.forwardArgs,
        nestedDirsByProject,
        gitFilesCache,
        hashCache,
        concurrency,
        remoteRead: policy.remoteRead,
      })
    }

    // Local cache short-circuit (default-on). Up-front classify: derive
    // every stable+cacheable+local-read task's key and probe local ONCE.
    // The result drives two-tier scheduling — confirmed hits become a
    // restore-tier the scheduler runs ahead of their deps but only as
    // worker-slot backfill (misses own the pool) — and execute reuses
    // each probe, so there is no second cache.get. Gated by
    // shouldShortCircuit (localRead + has-deps); when off, both maps are
    // empty and the run is byte-identical.
    let shortCircuit: ShortCircuit = EMPTY_SHORT_CIRCUIT
    if (shouldShortCircuit(nodes, policy, cache)) {
      shortCircuit = await startLocalShortCircuit({
        nodes,
        cache,
        workspaceRoot,
        workspaceFingerprint,
        forwardArgs: options.forwardArgs,
        nestedDirsByProject,
        gitFilesCache,
        hashCache,
        concurrency,
      })
    }

    const buildExecuteArgs = (node: TaskNode, upstream: TaskOutcome[], reuseProbe = true) => {
      const probe = reuseProbe ? shortCircuit.preProbed.get(node.id) : undefined
      return {
        node,
        upstream,
        workspaceRoot,
        workspaceFingerprint,
        cache,
        cachePolicy: policy,
        forwardArgs: options.forwardArgs,
        ...(options.retries !== undefined ? { retries: options.retries } : {}),
        ...(taskTimeoutDefault !== undefined ? { timeout: taskTimeoutDefault } : {}),
        ...(options.verify !== undefined ? { verify: options.verify } : {}),
        log,
        executor: placements.executors.get(node.id) ?? UNPLACED_EXECUTOR,
        ...(download.modeOf.get(node.id) === 'deferred' ? { download: 'deferred' as const } : {}),
        deferred: deferredOutputs,
        ...(placements.remoteOnlyNoop.has(node.id) ? { remoteOnlyNoop: true } : {}),
        ...(placements.remoteOnly.has(node.id) ? { remoteOnly: true } : {}),
        nestedProjectDirs: nestedDirsByProject.get(node.projectName) ?? [],
        runStartHrTimeNs,
        persistentRegistry,
        liveChildren,
        gitFilesCache,
        hashCache,
        ...(probe !== undefined ? { preProbed: probe } : {}),
      }
    }

    // In-flight dedup. Only when a service supplies a shared `inflight`
    // registry (concurrent runs in one `vx serve`); a stateless `vx run`
    // passes none and takes the untouched path. Gated to cacheable tasks —
    // the join works by waiting for the sibling to populate the cache, then
    // letting executeTask cache-hit on it. executeTask stays unchanged.
    const inflight = options.inflight
    const executeWithDedup = async (
      node: TaskNode,
      upstream: TaskOutcome[],
    ): Promise<TaskOutcome> => {
      // Dedup only helps when the sibling will WRITE the artifact and
      // this task can READ it back — i.e. both axes effectively on.
      const canRead = policy.localRead || policy.remoteRead
      const canWrite = policy.localWrite || policy.remoteWrite
      const cacheable =
        !isGroupTask(node) &&
        node.config.exec?.persistent === undefined &&
        node.config.cache !== undefined &&
        canRead &&
        canWrite
      // A restore-tier task (confirmed local hit, may run before its
      // deps) needs no dedup — it's a restore, not an executor, and its
      // live `upstream` is incomplete, so the dedup hash recompute would
      // be wrong. Route it straight to executeTask, which reuses the
      // up-front probe.
      const restorable = shortCircuit.restoreTier.has(node.id)
      if (inflight === undefined || !cacheable || restorable) {
        return executeTask(buildExecuteArgs(node, upstream))
      }
      const hash = await computeTaskHash({
        node,
        upstream,
        workspaceRoot,
        workspaceFingerprint,
        cache,
        forwardArgs: options.forwardArgs,
        nestedProjectDirs: nestedDirsByProject.get(node.projectName) ?? [],
        gitFilesCache,
        hashCache,
      })
      const existing = inflight.get(hash)
      if (existing !== undefined) {
        // Join a sibling already computing this exact task: wait, then
        // executeTask cache-hits on the artifact it just saved. The
        // up-front probe (preProbed) predates the sibling's save — its
        // "confirmed stable miss" would skip the lazy cache.get and
        // re-execute, defeating the dedup — so the join path drops it
        // and lets executeTask probe fresh.
        await existing.catch(() => {})
        return executeTask(buildExecuteArgs(node, upstream, false))
      }
      // Become the executor: register a barrier siblings await. get→set has
      // no await between, so registration is atomic — at most one executor
      // per hash. Released on every exit (success / failure / throw).
      let release!: () => void
      inflight.set(
        hash,
        new Promise<void>((resolve) => {
          release = resolve
        }),
      )
      try {
        return await executeTask(buildExecuteArgs(node, upstream))
      } finally {
        inflight.delete(hash)
        release()
      }
    }

    const outcomes = await runGraph({
      nodes,
      concurrency,
      ...(hasPooledExecutor(executors) ? { poolOf: poolOfPlacement(placements) } : {}),
      ...(resourceCosts.size > 0 ? { resourceCosts, cpuBudget: concurrency, memBudget } : {}),
      ...(options.continueMode !== undefined ? { continueMode: options.continueMode } : {}),
      onStart: (node) => {
        log.taskStart?.(node)
      },
      onFinish: (o) => {
        log.taskComplete(o.node, o)
      },
      execute: executeWithDedup,
      // Predictive scheduling: empty map when not opted in, in which
      // case the scheduler keeps the static baseline behavior.
      priorities: prepared.priorities,
      // Local short-circuit: confirmed stable local hits the scheduler
      // runs ahead of their deps as low-priority worker-slot backfill.
      // Empty when the short-circuit didn't fire → byte-identical.
      restoreTier: shortCircuit.restoreTier,
    })

    // A persistent task the user REQUESTED (a dev server / watcher) is
    // the run's whole purpose — don't tear it down the instant it's
    // ready. We leave those running and block on them at the very end
    // (after the normal summary prints); everything else (persistent
    // tasks pulled in only as dependencies of now-finished work) is
    // SIGTERMed here as before. Scoped to the real CLI foreground:
    // `options.log === undefined` means the default logger (a `vx run`
    // invocation), and `handleSignals` excludes watch mode (own signal
    // loop) and embedders that manage lifecycle themselves — both expect
    // run() to return, not block on a server.
    const foreground = options.log === undefined && (options.handleSignals ?? true)
    const keepAliveNodes: TaskNode[] = []
    const keepAlive: ReturnType<typeof Bun.spawn>[] = []
    if (foreground) {
      for (const [id, child] of persistentRegistry) {
        const n = nodes.get(id)
        if (n !== undefined && (n.requested || n.surfaced === true)) {
          keepAliveNodes.push(n)
          keepAlive.push(child)
        }
      }
    }
    const keepAliveSet = new Set(keepAlive)

    // Shut down the dependency-only persistent tasks before reporting the final
    // summary. SIGTERM gives well-behaved servers (vite, next, esbuild --watch)
    // a moment to clean up. Bun's Subprocess.kill is idempotent on an
    // already-exited child. Bound the wait: a persistent dep that traps or
    // ignores SIGTERM (a wedged mock server) would otherwise hang the run at
    // NORMAL completion forever — after a grace, SIGKILL the stragglers and move
    // on. Well-behaved servers exit in well under the grace, so the happy path
    // pays nothing; the timer is cleared + unref'd so a fast shutdown never
    // delays CLI exit.
    const dyingChildren = [...persistentRegistry.values()].filter((c) => !keepAliveSet.has(c))
    for (const child of dyingChildren) child.kill('SIGTERM')
    const allExited = Promise.allSettled(dyingChildren.map((c) => c.exited))
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const winner = await Promise.race([
      allExited.then(() => 'exited' as const),
      new Promise<'grace'>((resolve) => {
        graceTimer = setTimeout(() => resolve('grace'), PERSISTENT_SHUTDOWN_GRACE_MS)
        graceTimer.unref?.()
      }),
    ])
    if (graceTimer !== undefined) clearTimeout(graceTimer)
    if (winner === 'grace') {
      for (const child of dyingChildren) child.kill('SIGKILL')
      await allExited
    }

    // Clear the status line for good before the summary prints.
    log.runEnd?.()

    const list = [...outcomes.values()]
    const ok =
      list.every((o) => isPassStatus(o.status)) &&
      // `--verify`: a provably-unsafe cache entry (non-deterministic outputs, a
      // re-run that failed, or a read of undeclared inputs) turns the run red so
      // CI catches it.
      !list.some(
        (o) =>
          o.verify?.kind === 'nondeterministic' ||
          o.verify?.kind === 'rerun-failed' ||
          o.verify?.kind === 'undeclared-inputs',
      )

    // The summary + artifact writers + recordRun pass all exclude group
    // tasks via the shared tallyOutcomes helper. We pass the full
    // outcome list and let each consumer apply the same filter.
    const endedAtMs = Date.now()
    const totalMs = Number(process.hrtime.bigint() - runStartHrTimeNs) / 1_000_000
    // Foreground dev mode: between the task frame and the footer, list
    // the persistent tasks still running (see the keep-alive block below).
    if (keepAliveNodes.length > 0) {
      for (const line of formatPersistentList(keepAliveNodes, colors)) log.status(line)
    }
    for (const line of formatRunSummary(list, totalMs, colors, runContext)) log.status(line)
    // A task killed by a shutdown signal is in no bucket above, yet it makes
    // `ok` false — name it, or the red exit is undiagnosable.
    for (const line of formatAbortedSection(list)) log.status(line)
    // Outputs that never came home are not an error, but a silent `dist/`
    // that is empty-or-stale would be: name every task whose bytes are
    // still remote.
    const stillDeferred = deferredOutputs.pending()
    if (stillDeferred.length > 0) {
      log.status('')
      log.status(
        `  Deferred: ${stillDeferred.length} task(s) left outputs remote (--download=none): ${stillDeferred.join(', ')}`,
      )
    }
    if (options.verify !== undefined) {
      for (const line of formatVerifySection(list)) log.status(line)
      // A fingerprint-only run attaches no verdicts, so the verdict-driven
      // section above prints nothing — report what actually happened.
      if (options.verify.fingerprint && !options.verify.determinism && !options.verify.inputs) {
        const n = list.filter((o) => o.outputFp !== undefined).length
        log.status('')
        log.status(
          `  Verify:   fingerprinted ${n} task output trees (cross-machine diff via a connected serve)`,
        )
        // Only EXECUTED tasks fingerprint — a warm all-hit run reports 0.
        // A per-platform matrix wired without `--force` produces nothing
        // forever, so name the cause instead of a bare 0.
        if (n === 0) {
          log.status('            (0 executed — cache hits do not fingerprint; pair with --force)')
        }
      }
    }

    // Optional artifacts. Errors are surfaced to the user but don't
    // change the run's exit code — the run already happened.
    if (options.summarize !== undefined) {
      try {
        const wrote = await writeRunSummary({
          target: options.summarize,
          cacheDir,
          cwd: options.cwd,
          runId,
          startedAtMs: endedAtMsAtStart,
          endedAtMs,
          totalMs,
          ok,
          outcomes: list,
        })
        log.status(`vx: summary written to ${wrote}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.status(`vx: failed to write summary: ${msg}`)
      }
    }
    if (options.profile !== undefined) {
      try {
        const wrote = await writeRunProfile({
          target: options.profile,
          cwd: options.cwd,
          outcomes: list,
        })
        log.status(`vx: profile written to ${wrote}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.status(`vx: failed to write profile: ${msg}`)
      }
    }

    // Record each task to the run history in a single SQLite transaction
    // (one fsync instead of N). Group tasks (no `exec`) are skipped —
    // they aren't real runs and the `runs` table is analytics-focused.
    // One invocation header row is written alongside, atomically via
    // recordRunBundle. The Tier-3 input-fingerprint rows (entry_inputs)
    // are NOT built here — they're persisted inside each entry's save
    // transaction (miss path only), so a warm all-cache-hit run does no
    // extra recording work.
    const now = endedAtMs
    const toRecord: RunRecord[] = []
    // Per-task telemetry mirrors `toRecord` 1:1 — built only when a
    // telemetry sink is active, so a no-telemetry run allocates nothing.
    const summaryTasks: TaskTelemetry[] = []
    let failedCount = 0
    let hitLocalCount = 0
    let hitRemoteCount = 0
    for (const o of list) {
      if (isGroupTask(o.node)) continue
      // aborted (killed by a shutdown signal) isn't a real run.
      if (o.status === 'aborted') continue
      if (telemetry !== undefined) {
        const t: TaskTelemetry = {
          taskId: o.node.id,
          project: o.node.projectName,
          task: o.node.taskName,
          status: o.status,
          cacheSource: deriveCacheSource(o.status),
          exitCode: o.exitCode,
          durationMs: o.durationMs,
        }
        if (o.hash !== undefined) t.hash = o.hash
        if (o.cpuMs !== undefined) t.cpuMs = o.cpuMs
        if (o.peakRssBytes !== undefined) t.peakRssBytes = o.peakRssBytes
        if (o.where !== undefined) t.where = o.where
        if (o.outputs !== undefined) t.outputs = o.outputs
        if (o.attempts !== undefined) t.attempts = o.attempts
        if (o.verify !== undefined) t.verify = o.verify
        if (o.outputFp !== undefined) t.outputFp = o.outputFp
        if (o.wallclockStartNs !== undefined) t.wallclockStartNs = o.wallclockStartNs.toString()
        if (o.wallclockEndNs !== undefined) t.wallclockEndNs = o.wallclockEndNs.toString()
        summaryTasks.push(t)
      }
      // Every non-group, non-aborted outcome gets a row — the same set
      // `tallyOutcomes` counts, so `invocations.task_count` equals both the
      // terminal's "N total" and `COUNT(*) FROM runs WHERE run_id = ?`.
      // An outcome with NO hash (a `skipped` task never probed the cache; a
      // `persistent` one is never cacheable) used to be dropped here because
      // `runs.hash` is NOT NULL — which made a failing persistent task record
      // `0 tasks, 0 failures` on a run the terminal called red, and a failed
      // task with a skipped dependent record 1 of 2. `bindRun` stores `''` for
      // those instead; the key-diff readers guard it.
      toRecord.push({
        ...(o.hash !== undefined ? { hash: o.hash } : {}),
        project: o.node.projectName,
        task: o.node.taskName,
        status: o.status,
        exitCode: o.exitCode,
        durationMs: o.durationMs,
        ...(options.forwardArgs !== undefined ? { forwardArgs: options.forwardArgs } : {}),
        // Anchor to the REAL per-task wall-clock window: run-start wall time +
        // the task's ns offset (captured for hits and executed tasks alike).
        // The `now - duration` fallback applies to outcomes without an offset —
        // today only `skipped`, which the scheduler finishes synchronously with
        // no span, so it collapses to a zero-width mark at the run's end. Using
        // run-end-minus-duration for EVERYTHING was the old bug that piled every
        // task at the right edge of the timeline.
        startedAt:
          o.wallclockStartNs !== undefined
            ? endedAtMsAtStart + Math.round(Number(o.wallclockStartNs) / 1e6)
            : now - o.durationMs,
        endedAt:
          o.wallclockEndNs !== undefined
            ? endedAtMsAtStart + Math.round(Number(o.wallclockEndNs) / 1e6)
            : now,
        runId,
        ...(o.cpuMs !== undefined ? { cpuMs: o.cpuMs } : {}),
        ...(o.peakRssBytes !== undefined ? { peakRssBytes: o.peakRssBytes } : {}),
        ...(o.wallclockStartNs !== undefined ? { wallclockStartNs: o.wallclockStartNs } : {}),
        ...(o.wallclockEndNs !== undefined ? { wallclockEndNs: o.wallclockEndNs } : {}),
        cacheHit: isCacheHit(o.status),
        ...(o.attempts !== undefined ? { attempts: o.attempts } : {}),
      })
      if (o.status === 'failed') failedCount++
      if (o.status === 'cache-hit') hitLocalCount++
      if (o.status === 'cache-hit-remote') hitRemoteCount++
    }
    const invocation: InvocationRecord = {
      runId,
      command: options.command ?? process.argv.slice(1).join(' '),
      requestedTasks: JSON.stringify([...options.tasks]),
      cachePolicy: compactCachePolicy(policy),
      concurrency,
      flow: options.flow ?? null,
      startedAt: endedAtMsAtStart,
      endedAt: endedAtMs,
      totalDurationMs: Math.round(totalMs),
      taskCount: toRecord.length,
      failedCount,
      hitCount: hitLocalCount + hitRemoteCount,
      hitLocalCount,
      hitRemoteCount,
      exitOk: ok,
      commitSha: gitContext.commitSha,
      branch: gitContext.branch,
      dirty: gitContext.dirty,
      ci: ciContext.ci,
      ciProvider: ciContext.provider,
      host: hostContext.host,
      os: hostContext.os,
      arch: hostContext.arch,
      vxVersion: VERSION,
      tags: JSON.stringify(options.tags ?? {}),
    }
    cache.recordRunBundle({ runs: toRecord, invocation })
    // Hand the per-run summary to the telemetry sinks + drain them. Only
    // when a sink is active (telemetry !== undefined) — otherwise this
    // whole block is skipped and the run is byte-identical to before.
    // emitSummary/flush are crash-isolated, so a faulty sink can't fail
    // the run; flush is the sink's last chance to ship buffered records.
    if (telemetry !== undefined && runContextRecord !== undefined) {
      const summary = assembleRunSummary(runContextRecord, summaryTasks, {
        startedAt: endedAtMsAtStart,
        endedAt: endedAtMs,
        totalDurationMs: Math.round(totalMs),
        exitOk: ok,
      })
      telemetry.emitSummary(summary)
      await telemetry.flush()
    }
    // End-of-run plugin lifecycle: each event sink's flush() (its last
    // chance to ship buffered records) and each plugin's teardown().
    // Crash-isolated + time-bounded inside teardownPlugins, so a faulty
    // plugin can neither fail nor hang the run. Normal completion path
    // only — the finally below just unsubscribes.
    // Drain any still-in-flight background prefetches before closing the
    // cache handle — a prefetch ingesting into a closed SQLite DB would
    // throw. Tasks that resolved as local hits never awaited their
    // prefetch, so some may still be running here. (The local
    // short-circuit's probes are awaited inside startLocalShortCircuit
    // before scheduling, so nothing of its is in flight here.) The
    // background write-through uploads queued by LayeredCache.save
    // settle here for the same reason.
    //
    // BEFORE teardownPlugins, and that order is load-bearing: the drain
    // pushes bytes through a layer a PLUGIN provided, so a plugin that
    // releases its client in `teardown()` would otherwise have the
    // channel shut from under the upload — silently losing every remote
    // write with nothing but a warning. The seam's contract is that a
    // cache layer stays usable until the run's uploads have settled.
    await prefetchDone
    await cache.drainUploads?.()
    await teardownPlugins(prepared.plugins, eventSinks?.sinks ?? [], (m) => log.status(m))
    closeCache()

    // Tear down SRT's network bridge + (on macOS) log monitor. No-op if
    // no task was sandboxed; otherwise SRT keeps proxy servers alive and
    // the next vx run would init on top of stale state.
    if (anySandboxed) {
      try {
        await resetSandbox()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.status(`vx: sandbox cleanup failed: ${msg}`)
      }
    }

    // Edge case the summary already reported: the user requested a
    // persistent task (dev server / watcher). The run is "done" in every
    // bookkeeping sense — summary printed, history recorded — but the
    // server is still up and that's the point. Stay in the foreground
    // until it exits: Ctrl-C hits the whole process group (the server
    // dies; our SIGINT handler also exits 130), and a crash resolves the
    // wait so the run returns. Nothing here prints — the UI is unchanged.
    if (keepAlive.length > 0) {
      await Promise.allSettled(keepAlive.map((c) => c.exited))
      for (const child of keepAlive) child.kill('SIGTERM')
    }

    return { ok, outcomes: list }
  } finally {
    // Idempotent; also reached on mid-run throws, so a crashed cycle
    // can't leave a live status-line ticker behind.
    log.runEnd?.()
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    // Plugins installed at the top of run() get their bus subscriptions
    // released here. Idempotent; safe even if installPlugins threw.
    disposePlugins?.()
    eventSinks?.dispose()
    telemetry?.dispose()
    // No-op after the normal path's close. On a throw this is the only
    // close there is, and it must not itself throw — that would replace
    // the run's real error with a teardown one. Background uploads are
    // NOT drained here: they hold no database state, and awaiting a
    // wedged remote would turn a failing run into a hanging one.
    try {
      closeCache()
    } catch {
      // teardown must not throw on the way out
    }
  }
}

/**
 * Planning mode. Same setup as `run()` — workspace discovery, config
 * load, package graph, task graph — but stops short of execution.
 * Returns a `RunPlan` predicting the cache hit/miss outcome of every
 * task. Used by `--dry-run` and `--graph`.
 *
 * Side-effects are limited to opening + closing the local Cache handle
 * (and running `cache.inputs.runtime` probe commands, which key
 * derivation requires). Cache probing is the byte-free `cache.has()`
 * existence check — no artifact download, no ingest, no accessed_at bump.
 */
export async function planRun(options: RunOptions): Promise<RunPlan> {
  const log = options.log ?? defaultLogger()
  const prepared = await prepareRun(options, log)
  try {
    if (prepared.unresolvedTasks.length > 0) {
      return { tasks: [], unresolvedTasks: prepared.unresolvedTasks }
    }
    if (prepared.empty !== null) return { tasks: [] }
    return await plan({
      nodes: prepared.nodes,
      workspaceRoot: prepared.workspaceRoot,
      workspaceFingerprint: prepared.workspaceFingerprint,
      cache: prepared.cache,
      cachePolicy: effectiveCachePolicy(
        options.cache ?? FULL_CACHE_POLICY,
        prepared.hasRemoteLayer,
      ),
      forwardArgs: options.forwardArgs,
      nestedDirsByProject: prepared.nestedDirsByProject,
      gitFilesCache: prepared.gitFilesCache,
      hashCache: prepared.hashCache,
      // Plan-time duration prediction (dev-scenarios S2): the same local
      // history the predictive scheduler reads, folded into the plan as
      // per-task p50s + a predicted wall-clock. `--dry` is an explicit
      // inspection command, so the history read's cost is fine here even
      // though it stays OFF the default run path.
      history: new LocalHistoryProvider(prepared.localCache.dbHandle()),
      // Placement, by the same rules the run applies. Only worth showing
      // when there is a choice to show — with one declared executor every
      // line would carry the same label. Resolving the executors here is
      // the same plugin-factory call `prepareRun` already makes for the
      // cache capability, so plan mode gains no new class of side effect.
      ...(await planExecutorOf(prepared, log, options.download ?? 'all')),
    })
  } finally {
    prepared.cache.close()
  }
}

/**
 * A task is pinned to this machine when it is persistent, transitively
 * depends on a persistent task (a worker cannot reach a port on the
 * submitter), or declares `exec.remote: false`.
 */
function pinnedLocalSet(nodes: Map<string, TaskNode>): Set<string> {
  const pinned = new Set<string>()
  const memo = new Map<string, boolean>()
  const visit = (id: string): boolean => {
    const known = memo.get(id)
    if (known !== undefined) return known
    const node = nodes.get(id)
    if (node === undefined) return false
    memo.set(id, false) // cycle guard; the graph builder already rejects cycles
    const result =
      node.config.exec?.persistent !== undefined ||
      node.config.exec?.remote === false ||
      node.deps.some((d) => visit(d))
    memo.set(id, result)
    if (result) pinned.add(id)
    return result
  }
  for (const id of nodes.keys()) visit(id)
  return pinned
}

interface Placements {
  executors: Map<string, TaskExecutor>
  /**
   * `exec.remote: 'only'` tasks that no REMOTE executor took — a NO-OP on
   * this machine: never executed, declared outputs never cleaned or
   * restored. The task exists to produce a remote input tree; without a
   * remote pool, dependents use the machine's ambient state exactly as they
   * did before the field existed.
   */
  remoteOnlyNoop: Set<string>
  /** `'only'` tasks a remote executor DID take — executed remotely, outputs stay remote. */
  remoteOnly: Set<string>
}

function placeTasks(
  nodes: Map<string, TaskNode>,
  executors: readonly TaskExecutor[],
  pinAllLocal = false,
): Placements {
  const pinned = pinnedLocalSet(nodes)
  const placements: Placements = {
    executors: new Map(),
    remoteOnlyNoop: new Set(),
    remoteOnly: new Set(),
  }
  for (const node of nodes.values()) {
    if (isGroupTask(node) || node.config.exec?.persistent !== undefined) continue
    const executor = selectExecutor(executors, {
      taskId: node.id,
      projectName: node.projectName,
      projectDir: node.projectDir,
      command: node.config.exec!.command,
      pinnedLocal: pinAllLocal || pinned.has(node.id),
      cacheable: node.config.cache !== undefined,
    })
    placements.executors.set(node.id, executor)
    if (node.config.exec?.remote === 'only') {
      // A pinned 'only' task (it transitively depends on a persistent one)
      // lands here too: pinning wins, so it noops rather than shipping.
      if (executor.remote === true) placements.remoteOnly.add(node.id)
      else placements.remoteOnlyNoop.add(node.id)
    }
  }
  return placements
}

/**
 * `executorOf` for `planRun`, or nothing. Declining plugins, a single
 * executor, or a resolution error all yield nothing: `--dry` is an
 * inspection command and must not fail over a label.
 */
async function planExecutorOf(
  prepared: Awaited<ReturnType<typeof prepareRun>>,
  log: Logger,
  policy: 'all' | 'toplevel' | 'none',
): Promise<{
  executorOf?: (id: string) => string | undefined
  downloadOf?: (id: string) => 'eager' | 'deferred' | 'never' | undefined
  downloadDowngrades?: ReadonlyArray<{ taskId: string; reason: string }>
}> {
  let executors: readonly TaskExecutor[]
  try {
    executors = await resolveExecutors(prepared.plugins, {
      workspaceRoot: prepared.workspaceRoot,
      cacheDir: prepared.cacheDir,
      warn: (m: string) => log.status(m),
      concurrency: Math.max(1, navigator.hardwareConcurrency),
    })
  } catch {
    return {}
  }
  const placements = placeTasks(prepared.nodes, executors)
  // Download modes need placement regardless of how many executors there
  // are (a single REMOTE one still defers); executor LABELS only earn their
  // column when there is a choice to report.
  const download =
    policy === 'all'
      ? undefined
      : resolveDownloadModes({
          nodes: prepared.nodes,
          policy,
          localPlaced: new Set(
            [...prepared.nodes.keys()].filter(
              (id) => placements.executors.get(id)?.remote !== true,
            ),
          ),
          remoteOnly: placements.remoteOnly,
        })
  return {
    ...(executors.length < 2
      ? {}
      : {
          executorOf: (id: string) =>
            placements.remoteOnlyNoop.has(id) ? 'noop' : placements.executors.get(id)?.name,
        }),
    ...(download === undefined
      ? {}
      : {
          downloadOf: (id: string) => download.modeOf.get(id),
          downloadDowngrades: [...download.downgrades].map(([taskId, reason]) => ({
            taskId,
            reason,
          })),
        }),
  }
}

/**
 * Stands in for the executor of a task that was never placed — a group task
 * (runs nothing) or a persistent one (`executePersistentTask` owns it and
 * never reads this field). It THROWS rather than silently picking some
 * executor from the list, so a refactor that routes such a task through the
 * exec path fails loudly instead of shipping a localhost server to a worker.
 */
const UNPLACED_EXECUTOR: TaskExecutor = {
  name: 'unplaced',
  execute: (req) => {
    throw new Error(`internal error: ${req.taskId} reached an executor without being placed`)
  },
}

function hasPooledExecutor(executors: readonly TaskExecutor[]): boolean {
  return executors.some((e) => e.capacity !== undefined)
}

function poolOfPlacement(
  placements: Placements,
): (id: string) => { name: string; capacity: number } | undefined {
  return (id) => {
    const executor = placements.executors.get(id)
    return executor?.capacity === undefined
      ? undefined
      : { name: executor.name, capacity: executor.capacity }
  }
}
