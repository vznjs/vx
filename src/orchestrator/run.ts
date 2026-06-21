// End-to-end wiring: discover workspace -> load configs -> build graph ->
// run with caching. Each step delegates to a single-purpose sibling file
// so the layers can be swapped without touching the others.

import { LayeredCache, type RunRecord } from '../cache/index.js'
import { VERSION } from '../version.js'
import { initSandbox, probeSandbox, resetSandbox, signalExitCode } from '../exec/index.js'
import {
  isGroupTask,
  markSurfacedDeps,
  runGraph,
  type TaskNode,
  type TaskOutcome,
} from '../graph/index.js'
import { ulid, UserError } from '../util/index.js'
import { executeTask } from './execute-task.js'
import { computeTaskHash } from './task-hash.js'
import { busLogger, createEventBus, terminalSubscriber } from './events.js'
import { installPlugins } from './plugin.js'
import { defaultLogger, resolveOutputView } from './logger.js'
import { detectColors } from './colors.js'
import { formatPersistentList } from './framed-output.js'
import { plan, type RunPlan } from './plan.js'
import { prepareRun } from './prepare.js'
import { startRemotePrefetch } from './remote-prefetch.js'
import { writeRunProfile, writeRunSummary } from './run-artifacts.js'
import { formatRunSummary } from './summary.js'
import type { RunOptions, RunSummary } from './options.js'

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
  // starts emitting events. Failure of a plugin's setup() aborts the
  // run with a clean UserError naming the plugin (per the Plugin API
  // contract in src/orchestrator/plugin.ts).
  let disposePlugins: (() => void) | undefined
  if (prepared.workspaceConfig?.plugins && prepared.workspaceConfig.plugins.length > 0) {
    try {
      disposePlugins = await installPlugins({
        plugins: prepared.workspaceConfig.plugins as never,
        bus,
        workspaceRoot: prepared.workspaceRoot,
        cacheDir: prepared.cacheDir,
        warn: (m) => log.status(m),
      })
    } catch (err) {
      prepared.cache.close()
      throw err
    }
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
  try {
    // One run-id per `vx run` invocation. Every task in the resulting
    // graph carries it so analytics queries can group by invocation.
    const runId = ulid()
    const runStartHrTimeNs = process.hrtime.bigint()
    const endedAtMsAtStart = Date.now()
    const remoteCacheEnabled = cache instanceof LayeredCache

    // Lazy SRT init: only fire it up if at least one task in the graph
    // opts into sandboxing via its `sandbox: {...}` block. Tasks that
    // need sandboxing on an unsupported platform get a hard error so
    // they don't silently run unsandboxed.
    const anySandboxed = [...nodes.values()].some((n) => n.config.sandbox !== undefined)
    if (anySandboxed) {
      const avail = await probeSandbox()
      if (!avail.available) {
        prepared.cache.close()
        throw new UserError(`sandbox not available: ${avail.reason}`)
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
    // Run context for the footer. The top-of-run header is gone — the
    // banner now lives in the summary, where the eye lands at the end.
    const runContext = {
      version: VERSION,
      packageCount: packagesInScope.size,
      remoteCacheEnabled,
      concurrency,
      workspaceProjectCount,
    }

    // Lifecycle hooks drive the default logger's dynamic status line
    // (TTY-only); custom loggers may ignore them.
    log.runStart?.({ total: taskCount, concurrency, requestedCount, context: runContext })

    // Remote-only: kick off background prefetches so remote-GET latency
    // overlaps execution. Fire-and-forget — execution starts on the next
    // line; LayeredCache ingests hits into local and de-dups so
    // execute-task's cache.get awaits the in-flight promise (one remote
    // GET per key). Gated entirely on a remote layer being configured;
    // local-only runs never reach here, so their behavior + perf is
    // unchanged (no upfront key pass, no local probing).
    let prefetchDone: Promise<void> = Promise.resolve()
    if (cache instanceof LayeredCache) {
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
        noCache: options.noCache ?? false,
      })
    }

    const buildExecuteArgs = (node: TaskNode, upstream: TaskOutcome[]) => ({
      node,
      upstream,
      workspaceRoot,
      workspaceFingerprint,
      cache,
      noCache: options.noCache ?? false,
      forwardArgs: options.forwardArgs,
      log,
      nestedProjectDirs: nestedDirsByProject.get(node.projectName) ?? [],
      runStartHrTimeNs,
      persistentRegistry,
      liveChildren,
      gitFilesCache,
      hashCache,
    })

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
      const cacheable =
        !isGroupTask(node) &&
        node.config.exec?.persistent === undefined &&
        node.config.cache !== undefined &&
        !(options.noCache ?? false)
      if (inflight === undefined || !cacheable) {
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
        // executeTask cache-hits on the artifact it just saved.
        await existing.catch(() => {})
        return executeTask(buildExecuteArgs(node, upstream))
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

    // Shut down the dependency-only persistent tasks before reporting the
    // final summary. SIGTERM gives well-behaved servers (vite, next,
    // esbuild --watch) a moment to clean up; we don't escalate to SIGKILL
    // — process-group propagation on Ctrl-C handles the unhappy case.
    // Bun's Subprocess.kill is idempotent on an already-exited child.
    for (const child of persistentRegistry.values()) {
      if (!keepAliveSet.has(child)) child.kill('SIGTERM')
    }
    await Promise.allSettled(
      [...persistentRegistry.values()].filter((c) => !keepAliveSet.has(c)).map((c) => c.exited),
    )

    // Clear the status line for good before the summary prints.
    log.runEnd?.()

    const list = [...outcomes.values()]
    const ok = list.every(
      (o) => o.status === 'success' || o.status === 'cache-hit' || o.status === 'cache-hit-remote',
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
    const now = endedAtMs
    const toRecord: RunRecord[] = []
    for (const o of list) {
      if (!o.hash) continue
      if (isGroupTask(o.node)) continue
      // aborted (killed by a shutdown signal) isn't a real run.
      if (o.status === 'aborted') continue
      toRecord.push({
        hash: o.hash,
        project: o.node.projectName,
        task: o.node.taskName,
        status: o.status,
        exitCode: o.exitCode,
        durationMs: o.durationMs,
        ...(options.forwardArgs !== undefined ? { forwardArgs: options.forwardArgs } : {}),
        startedAt: now - o.durationMs,
        endedAt: now,
        runId,
        ...(o.cpuMs !== undefined ? { cpuMs: o.cpuMs } : {}),
        ...(o.peakRssBytes !== undefined ? { peakRssBytes: o.peakRssBytes } : {}),
        ...(o.wallclockStartNs !== undefined ? { wallclockStartNs: o.wallclockStartNs } : {}),
        ...(o.wallclockEndNs !== undefined ? { wallclockEndNs: o.wallclockEndNs } : {}),
        cacheHit: o.status === 'cache-hit' || o.status === 'cache-hit-remote',
      })
    }
    cache.recordRuns(toRecord)
    // Drain any still-in-flight background prefetches before closing the
    // cache handle — a prefetch ingesting into a closed SQLite DB would
    // throw. Tasks that resolved as local hits never awaited their
    // prefetch, so some may still be running here.
    await prefetchDone
    cache.close()

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
  }
}

/**
 * Planning mode. Same setup as `run()` — workspace discovery, config
 * load, package graph, task graph — but stops short of execution.
 * Returns a `RunPlan` predicting the cache hit/miss outcome of every
 * task. Used by `--dry-run` and `--graph`.
 *
 * Side-effects are limited to:
 *   - SQLite `accessed_at` bumps on cache.get() probes (read-only
 *     from the user's perspective).
 *   - Opening + closing the local Cache handle.
 */
export async function planRun(options: RunOptions): Promise<RunPlan> {
  const log = options.log ?? defaultLogger()
  const prepared = await prepareRun(options, log)
  try {
    if (prepared.empty !== null) return { tasks: [] }
    return await plan({
      nodes: prepared.nodes,
      workspaceRoot: prepared.workspaceRoot,
      workspaceFingerprint: prepared.workspaceFingerprint,
      cache: prepared.cache,
      noCache: options.noCache ?? false,
      forwardArgs: options.forwardArgs,
      nestedDirsByProject: prepared.nestedDirsByProject,
      gitFilesCache: prepared.gitFilesCache,
      hashCache: prepared.hashCache,
    })
  } finally {
    prepared.cache.close()
  }
}
