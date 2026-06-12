// End-to-end wiring: discover workspace -> load configs -> build graph ->
// run with caching. Each step delegates to a single-purpose sibling file
// so the layers can be swapped without touching the others.

import { LayeredCache, type RunRecord } from '../cache/index.js'
import { VERSION } from '../version.js'
import { initSandbox, probeSandbox, resetSandbox, signalExitCode } from '../exec/index.js'
import { isGroupTask, runGraph } from '../graph/index.js'
import { ulid, UserError } from '../util/index.js'
import { executeTask } from './execute-task.js'
import { defaultLogger, resolveOutputView } from './logger.js'
import { detectColors } from './colors.js'
import { formatHeader } from './framed-output.js'
import { plan, type RunPlan } from './plan.js'
import { prepareRun } from './prepare.js'
import { writeRunProfile, writeRunSummary } from './run-artifacts.js'
import { formatRunSummary } from './summary.js'
import type { RunOptions, RunSummary } from './options.js'

export async function run(options: RunOptions): Promise<RunSummary> {
  // Color decision: a custom logger (tests, embedders) handles its
  // own formatting and asserts on plain strings, so we suppress
  // ANSI escapes for them. Only the defaultLogger (real terminal
  // output) gets colors, gated by NO_COLOR / FORCE_COLOR / isTTY.
  const colors = options.log ? { enabled: false } : detectColors()
  const log = options.log ?? defaultLogger(colors, resolveOutputView(options))

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

    // Header counts: unique projects covered by the graph (including
    // dependsOn-pulled deps, not just the user-requested set), and the
    // total number of real (non-group) task executions. Mirrors the
    // count the end-of-run summary reports under "total".
    const packagesInScope = new Set<string>()
    let taskCount = 0
    for (const node of nodes.values()) {
      packagesInScope.add(node.projectName)
      if (!isGroupTask(node)) taskCount++
    }
    for (const line of formatHeader(
      {
        version: VERSION,
        packageCount: packagesInScope.size,
        tasks: [...new Set(options.tasks.map(unanchored))],
        taskCount,
        remoteCacheEnabled,
      },
      colors,
    ))
      log.status(line)

    // Lifecycle hooks drive the default logger's dynamic status line
    // (TTY-only); custom loggers may ignore them.
    log.runStart?.({ total: taskCount })

    const outcomes = await runGraph({
      nodes,
      concurrency,
      onStart: (node) => {
        log.taskStart?.(node)
      },
      onFinish: (o) => {
        log.taskComplete(o.node, o)
      },
      execute: (node, upstream) =>
        executeTask({
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
        }),
    })

    // Shut down every persistent task before reporting the final
    // summary. SIGTERM gives well-behaved servers (vite, next, esbuild
    // --watch) a moment to clean up; we don't escalate to SIGKILL —
    // process-group propagation on Ctrl-C handles the unhappy case.
    // Bun's Subprocess.kill is idempotent on an already-exited child.
    for (const child of persistentRegistry.values()) child.kill('SIGTERM')
    await Promise.allSettled([...persistentRegistry.values()].map((c) => c.exited))

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
    for (const line of formatRunSummary(list, totalMs, colors)) log.status(line)

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

    return { ok, outcomes: list }
  } finally {
    // Idempotent; also reached on mid-run throws, so a crashed cycle
    // can't leave a live status-line ticker behind.
    log.runEnd?.()
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
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

function unanchored(spec: string): string {
  const idx = spec.indexOf('#')
  return idx >= 0 ? spec.slice(idx + 1) : spec
}
