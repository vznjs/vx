// End-to-end wiring: discover workspace -> load configs -> build graph ->
// run with caching. Each step delegates to a single-purpose sibling file
// so the layers can be swapped without touching the others.

import type { ProjectEntry } from '../workspace/index.js'
import os from 'node:os'
import { type CacheLayer, type CachePolicy, FULL_CACHE_POLICY } from '../cache/index.js'
import { VERSION } from '../version.js'
import { resetSandbox } from '../exec/index.js'
import { DeferredOutputs } from './deferred-outputs.js'
import { resolveDownloadModes } from './download-policy.js'
import type { TaskExecutor } from '../exec/index.js'
import {
  isGroupTask,
  markSurfacedDeps,
  runGraph,
  type TaskNode,
  type TaskOutcome,
} from '../graph/index.js'
import { mark, MAX_TIMEOUT_MS, printTimings, ulid, nearest } from '../util/index.js'
import { prepareSandbox } from './sandbox-request.js'
import type { OutputDirSnapshot } from './miss-save.js'
import { admitTasks, taintTracker } from './admission.js'
import { resolveResourceCosts } from './resources.js'
import { busLogger, createEventBus, terminalSubscriber } from './events.js'
import { installPlugins } from './plugin.js'
import { resolveExecutors, teardownPlugins } from './plugin-host.js'
import { subscribeTelemetry, type TelemetryHandle } from './telemetry-host.js'
import { assembleRunSummary, isPassStatus } from './telemetry.js'
import type { RunContextRecord } from './telemetry.js'
import { defaultLogger, resolveOutputView } from './logger.js'
import { detectColors } from './colors.js'
import { formatPersistentList } from './framed-output.js'
import { LocalHistoryProvider } from './history.js'
import { plan, type RunPlan } from './plan.js'
import { prepareRun } from './prepare.js'
import { forwardSignals } from './signals.js'
import {
  hasPooledExecutor,
  placeTasks,
  planExecutorOf,
  poolOfPlacement,
  UNPLACED_EXECUTOR,
} from './placement.js'
import {
  captureDefaultBranch,
  captureGitContext,
  captureHostContext,
  captureWorkspaceIdentity,
  detectCi,
} from './run-context.js'
import { startRemotePrefetch } from './remote-prefetch.js'
import { startLocalShortCircuit, type ShortCircuit } from './local-shortcircuit.js'

import { assembleRunRecords } from './run-records.js'
import { selectKeepAlive, shutdownPersistent } from './persistent.js'
import { writeRunProfile, writeRunSummary } from './run-artifacts.js'
import { createSaveLane } from './save-lane.js'
import { formatAbortedSection, formatFlakySection, formatRunSummary } from './summary.js'
import { detectFlaky, type FlakyCandidate } from './failure-mode.js'
import type { RunOptions, RunSummary } from './options.js'

// Per run, never shared: a `vx watch` process runs many, and a shared map
// is one `preProbed.set` away from leaking a hit across cycles.
const emptyShortCircuit = (): ShortCircuit => ({ preProbed: new Map(), restoreTier: new Set() })

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
 *   - there is at least one task.
 * A flat graph has no ordering to bypass, but the classify pass is worth
 * paying for anyway: it probes every stable key through ONE batched
 * `getMany` instead of a `cache.get` per task inside the run, which
 * measured 84 → 78 ms on 100 dep-free tasks and 249 → 237 ms on 1000
 * (2026-09-03, interleaved arms). The per-task correctness gates (stable
 * key, no workspace-outputs in graph) live in `startLocalShortCircuit`.
 */
export function shouldShortCircuit(
  nodes: Map<string, TaskNode>,
  policy: CachePolicy,
  cache: CacheLayer,
): boolean {
  if (cache.hasRemote === true) return false
  if (!policy.localRead) return false
  return nodes.size > 0
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
  mark('plugin stages')
  // A requested name that matched no project is a typo (or a stray
  // positional from an `=`-only flag written with a space). Failing the
  // whole run — even when OTHER requested tasks resolved — is the point:
  // a CI job that renames a task must go red, not silently stop running
  // it. When EVERY name is unresolved this is the `no-tasks-declared`
  // case too; the message is identical, so that branch stays below.
  if (prepared.unresolvedTasks.length > 0) {
    log.status(
      `No projects declare task(s): ${prepared.unresolvedTasks.join(', ')}.${didYouMean(prepared.unresolvedTasks, prepared.projects)}${initHint(prepared)}`,
    )
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
        ? `No projects declare task(s): ${options.tasks.join(', ')}.${initHint(prepared)}`
        : 'No tasks to run.'
    log.status(msg)
    prepared.cache.close()
    return { ok: false, outcomes: [] }
  }
  // Install user plugins as additional bus subscribers BEFORE the run
  // starts emitting events. `installPlugins` runs each plugin's optional
  // `setup` hook and fails fast on a throw with a clean UserError naming
  // the plugin. A plugin without `setup` subscribes nothing.
  let disposePlugins: (() => void) | undefined
  let telemetry: TelemetryHandle | undefined
  try {
    disposePlugins = await installPlugins({
      plugins: prepared.plugins as never,
      bus,
      workspaceRoot: prepared.workspaceRoot,
      cacheDir: prepared.cacheDir,
      warn: (m) => log.status(m),
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

  // Resolved ONCE per run, in declaration order, the local executor last.
  // A broken factory aborts here, before any task starts.
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
    prepared.cache.close()
    throw err
  }
  // Placement: decided ONCE per task, before scheduling, so the scheduler
  // can admit a remote-pooled task against its pool instead of a local
  // worker slot. Group tasks run nothing; persistent tasks never reach an
  // executor (local by construction) — both stay off the map.
  const placements = placeTasks(nodes, executors, false)
  // A `remote: 'only'` task nobody takes succeeds WITHOUT running. That is
  // deliberate — on a machine with no remote pool the ambient state already
  // is what the task would have produced — but it must not be SILENT: a task
  // reporting success while doing nothing is indistinguishable from one that
  // worked, and the usual cause (no `cache` block, so no executor can
  // describe its inputs to a worker) cannot be read off the outcome.
  if (placements.remoteOnlyNoop.size > 0) {
    const anyRemote = executors.some((e) => e.remote === true)
    for (const id of placements.remoteOnlyNoop) {
      const why = !anyRemote
        ? 'no remote executor is declared'
        : nodes.get(id)?.config.cache === undefined
          ? 'no remote executor accepted it — the task declares no `cache` block, so there is no input set to ship'
          : 'no remote executor accepted it'
      log.status(`[vx] ${id}: exec.remote is 'only' and ${why} — nothing ran`)
    }
  }
  // Demand: what each executor still has left to run. An executor that
  // provisions per task (a container, an allocation, a pod) otherwise has to
  // guess from `capacity` alone and hold everything until teardown. Built
  // ONLY for executors that asked — with none declared there is no map, no
  // set, and no call in the completion path.
  const demandOf = new Map<TaskExecutor, Set<string>>()
  for (const [id, executor] of placements.executors) {
    if (executor.demand === undefined) continue
    let remaining = demandOf.get(executor)
    if (remaining === undefined) demandOf.set(executor, (remaining = new Set()))
    remaining.add(id)
  }
  // The SAME set is handed back every time, narrowed in place: a consumer
  // reading it later sees the truth rather than a stale snapshot.
  for (const [executor, remaining] of demandOf) executor.demand!(remaining)
  const narrowDemand =
    demandOf.size === 0
      ? (): void => {}
      : (id: string): void => {
          for (const [executor, remaining] of demandOf) {
            if (remaining.delete(id)) executor.demand!(remaining)
          }
        }

  // `--download` (default `all`) decides ONCE per task, here, whether a
  // remote execution's outputs come home.
  const downloadPolicy = options.download ?? 'all'
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
  // A SIGINT/SIGTERM mid-run forwards SIGTERM to everything in both
  // (`signals.ts`); the handlers are removed in the finally below so
  // repeated run() calls (test suites) never stack listeners.
  const liveChildren = new Set<ReturnType<typeof Bun.spawn>>()
  const persistentRegistry = new Map<string, ReturnType<typeof Bun.spawn>>()
  const signals = forwardSignals({
    enabled: options.handleSignals ?? true,
    log,
    cache,
    liveChildren,
    persistentRegistry,
  })
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
    // Normalised ONCE so every consumer — execute-task, the dedup
    // predicate, the recorded invocation row — reads the policy that
    // actually governed the run. Reading the raw request here made tasks
    // clean their outputs before every exec for a save that never
    // happened.
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

    const sandboxArmer = prepareSandbox(nodes.values())
    const outputDirSnapshots: OutputDirSnapshot[] = []
    // Saves run off the execution slot, twice the cap at once (memory:
    // each pack holds an artifact's bytes); a failed save is a miss next
    // time, said once — the task's work ran.
    const saveLane = createSaveLane(2 * concurrency, (err) =>
      log.status(`[vx] cache save failed: ${err instanceof Error ? err.message : String(err)}`),
    )
    const deferredSaves = new Map<string, Promise<void>>()

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
    // into absolute costs ONCE, up front, so the scheduler's inner loop is
    // a plain Map.get (percent forms were removed 2026-08-30 — see
    // resources.ts). The
    // CPU budget is the run's concurrency; the memory budget is
    // os.totalmem() unless `--memory` overrides it (pass `--memory` in
    // cgroup-limited containers — totalmem() reports the HOST's RAM).
    // Nothing declared → empty map → fields omitted from the scheduler
    // AND the footer → byte-identical legacy path.
    const memBudget = options.memory ?? os.totalmem()
    const resourceCosts = resolveResourceCosts(nodes)

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
    // shouldShortCircuit (local reads on, no remote layer); when off, both
    // maps are empty and the run is byte-identical.
    let shortCircuit: ShortCircuit = emptyShortCircuit()
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

    // Whether this task runs behind a failure (`continueMode: 'always'`
    // only) — its save is withheld and the taint propagates; see
    // admission.ts.
    const isTainted = taintTracker(options.continueMode === 'always')

    const buildExecuteArgs = (node: TaskNode, upstream: TaskOutcome[], reuseProbe = true) => {
      const probe = reuseProbe ? shortCircuit.preProbed.get(node.id) : undefined
      const taint = isTainted(node, upstream)
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
        ...(taint ? { taintedUpstream: true } : {}),
        ...(sandboxArmer !== null ? { armSandbox: () => sandboxArmer.arm() } : {}),
        outputDirSnapshots,
        deferSave: saveLane.defer,
        deferredSaves,
      }
    }

    const executeWithDedup = admitTasks({
      inflight: options.inflight,
      policy,
      shortCircuit,
      hashArgs: {
        workspaceRoot,
        workspaceFingerprint,
        cache,
        forwardArgs: options.forwardArgs,
        nestedDirsByProject,
        gitFilesCache,
        hashCache,
      },
      buildExecuteArgs,
    })

    mark('classify + probe')
    const outcomes = await runGraph({
      nodes,
      concurrency,
      settledOf: (o) => deferredSaves.get(o.node.id),
      ...(hasPooledExecutor(executors) ? { poolOf: poolOfPlacement(placements) } : {}),
      ...(resourceCosts.size > 0 ? { resourceCosts, cpuBudget: concurrency, memBudget } : {}),
      ...(options.continueMode !== undefined ? { continueMode: options.continueMode } : {}),
      onStart: (node) => {
        log.taskStart?.(node)
      },
      onFinish: (o) => {
        log.taskComplete(o.node, o)
        narrowDemand(o.node.id)
      },
      execute: executeWithDedup,
      // A `schedule` plugin's weights; the scheduler keeps its structural
      // baseline as the tie-break. Empty map → baseline only.
      ...(prepared.priorities.size > 0 ? { priorities: prepared.priorities } : {}),
      // Local short-circuit: confirmed stable local hits the scheduler
      // runs ahead of their deps as low-priority worker-slot backfill.
      // Empty when the short-circuit didn't fire → byte-identical.
      restoreTier: shortCircuit.restoreTier,
    })

    // Which persistent children outlive the graph, and the bounded SIGTERM
    // of the rest, before the summary prints. Scoped to the real CLI
    // foreground: `options.log === undefined` means the default logger (a
    // `vx run` invocation), and `handleSignals` excludes watch mode (own
    // signal loop) and embedders that manage lifecycle themselves — both
    // expect run() to return, not block on a server.
    const foreground = options.log === undefined && (options.handleSignals ?? true)
    const keepAlive = selectKeepAlive(persistentRegistry, nodes, foreground)
    await shutdownPersistent(persistentRegistry, keepAlive.children)

    mark('run graph')
    // Clear the status line for good before the summary prints.
    log.runEnd?.()

    const list = [...outcomes.values()]
    const ok = list.every((o) => isPassStatus(o.status))

    // The summary + artifact writers + recordRun pass all exclude group
    // tasks via the shared tallyOutcomes helper. We pass the full
    // outcome list and let each consumer apply the same filter.
    const endedAtMs = Date.now()
    const totalMs = Number(process.hrtime.bigint() - runStartHrTimeNs) / 1_000_000
    // Foreground dev mode: between the task frame and the footer, list
    // the persistent tasks still running (see the keep-alive block below).
    if (keepAlive.nodes.length > 0) {
      for (const line of formatPersistentList(keepAlive.nodes, colors)) log.status(line)
    }
    for (const line of formatRunSummary(list, totalMs, colors, runContext)) log.status(line)
    // A task killed by a shutdown signal is in no bucket above, yet it makes
    // `ok` false — name it, or the red exit is undiagnosable.
    for (const line of formatAbortedSection(list)) log.status(line)
    // Judged against the history BEFORE this run's rows land, so the query
    // is one scan over the executed tasks' keys and nothing at all on a run
    // that executed none (every hit, every skip).
    const flaky = detectFlaky(prepared.localCache.dbHandle(), flakyCandidates(list))
    for (const line of formatFlakySection(flaky)) log.status(line)
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
          flaky,
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
    // (one fsync instead of N), with the invocation header row alongside,
    // atomically via recordRunBundle. The Tier-3 input-fingerprint rows
    // (entry_inputs) are NOT built here — they're persisted inside each
    // entry's save transaction (miss path only), so a warm all-cache-hit
    // run does no extra recording work. The telemetry mirror is built in
    // the same pass, only when a sink is active.
    const records = assembleRunRecords({
      outcomes: list,
      runId,
      startedAtMs: endedAtMsAtStart,
      endedAtMs,
      totalMs,
      ok,
      command: options.command ?? process.argv.slice(1).join(' '),
      requestedTasks: options.tasks,
      cachePolicy: compactCachePolicy(policy),
      concurrency,
      flow: options.flow ?? null,
      forwardArgs: options.forwardArgs,
      tags: options.tags ?? {},
      git: gitContext,
      ci: ciContext,
      host: hostContext,
      withTelemetry: telemetry !== undefined,
    })
    cache.recordRunBundle(records)
    mark('record history')
    // Hand the per-run summary to the telemetry sinks + drain them. Only
    // when a sink is active (telemetry !== undefined) — otherwise this
    // whole block is skipped and the run is byte-identical to before.
    // emitSummary/flush are crash-isolated, so a faulty sink can't fail
    // the run; flush is the sink's last chance to ship buffered records.
    if (telemetry !== undefined && runContextRecord !== undefined) {
      const summary = assembleRunSummary(runContextRecord, records.telemetryTasks, {
        startedAt: endedAtMsAtStart,
        endedAt: endedAtMs,
        totalDurationMs: Math.round(totalMs),
        exitOk: ok,
      })
      telemetry.emitSummary(summary)
      await telemetry.flush()
    }
    // End-of-run plugin lifecycle: each plugin's teardown(). Crash-isolated
    // + time-bounded inside teardownPlugins, so a faulty plugin can neither
    // fail nor hang the run. Normal completion path only — the finally
    // below just unsubscribes.
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
    // Every deferred save settles first: the upload drain below carries
    // the entries the saves queued, and the snapshot loop after it reads
    // what the saves pushed.
    await saveLane.drain()
    mark('save lane')
    await cache.drainUploads?.()
    // The miss path's output-directory snapshots, taken now that the
    // directories are old enough for the snapshot's racy window (see
    // miss-save.ts). A few at a time: each is an lstat + readdir per
    // prefix and one index transaction.
    for (let i = 0; i < outputDirSnapshots.length; i += 32) {
      await Promise.all(
        outputDirSnapshots
          .slice(i, i + 32)
          .map((s) => cache.recordOutputDirs?.(s.hash, s.projectDir, s.prefixes)),
      )
    }
    mark('output dir snapshots')
    await teardownPlugins(prepared.plugins, (m) => log.status(m))
    closeCache()
    mark('close')
    printTimings()

    // Tear down SRT's network bridge + (on macOS) log monitor. No-op if
    // no task was sandboxed; otherwise SRT keeps proxy servers alive and
    // the next vx run would init on top of stale state.
    if (sandboxArmer?.armed) {
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
    if (keepAlive.children.length > 0) {
      await Promise.allSettled(keepAlive.children.map((c) => c.exited))
      for (const child of keepAlive.children) child.kill('SIGTERM')
    }

    return { ok, outcomes: list }
  } finally {
    // Idempotent; also reached on mid-run throws, so a crashed cycle
    // can't leave a live status-line ticker behind.
    log.runEnd?.()
    signals.remove()
    // Plugins installed at the top of run() get their bus subscriptions
    // released here. Idempotent; safe even if installPlugins threw.
    disposePlugins?.()
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
 * The first-run case, told apart from a typo: no package in the workspace
 * has a `vx.config.*` at all, so no name could have resolved. Reached only
 * on the error path.
 */
function initHint(prepared: { anyProjectConfig: boolean }): string {
  return prepared.anyProjectConfig
    ? ''
    : ' No package declares a vx.config — run `vx init` to write one per package from its package.json scripts.'
}

/**
 * A typo's nearest declared name, when one is within two edits — the
 * message names the fix instead of only the mistake. A bare name is
 * matched against every declared task; `pkg#task` against the project
 * names first (the task kept) and then against that project's tasks, so
 * the hint is a spec the user can run.
 */
function didYouMean(
  unresolved: readonly string[],
  projects: ReadonlyMap<string, ProjectEntry>,
): string {
  const tasksOf = (p: ProjectEntry | undefined): string[] => Object.keys(p?.config.tasks ?? {})
  const allTasks = new Set<string>()
  for (const p of projects.values()) for (const t of tasksOf(p)) allTasks.add(t)
  // A Set: two typos of the same task hint it once, not once per typo.
  const hints = new Set<string>()
  for (const spec of unresolved) {
    const at = spec.indexOf('#')
    if (at < 0) {
      const t = nearest(spec, allTasks)
      if (t !== undefined) hints.add(t)
      continue
    }
    const [proj, task] = [spec.slice(0, at), spec.slice(at + 1)]
    if (!projects.has(proj)) {
      const p = nearest(proj, projects.keys())
      if (p !== undefined && tasksOf(projects.get(p)).includes(task)) hints.add(`${p}#${task}`)
      continue
    }
    const t = nearest(task, tasksOf(projects.get(proj)))
    if (t !== undefined) hints.add(`${proj}#${t}`)
  }
  return hints.size === 0 ? '' : ` Did you mean ${[...hints].join(', ')}?`
}

/** The executed, keyed outcomes of a run — what flakiness is judged on. */
function flakyCandidates(outcomes: readonly TaskOutcome[]): FlakyCandidate[] {
  const out: FlakyCandidate[] = []
  for (const o of outcomes) {
    if (o.status !== 'success' && o.status !== 'failed') continue
    // "Same inputs, different outcome" is a claim only a task with declared
    // inputs can make: a task with no `cache` block keys on its config alone
    // and runs every time, so one bad network day would read as a flake for
    // thirty days. Groups do no work.
    if (o.hash === undefined || o.node.config.cache === undefined || isGroupTask(o.node)) continue
    out.push({
      project: o.node.projectName,
      task: o.node.taskName,
      hash: o.hash,
      status: o.status,
      attempts: o.attempts ?? 1,
    })
  }
  return out
}
