// End-to-end wiring: discover workspace -> load configs -> build graph ->
// run with caching. Each step delegates to a single-purpose module under
// ./orchestrator/ so the layers can be swapped without touching the others.

import type { RunRecord } from './cache/cache.js'
import { LayeredCache } from './cache/layered-cache.js'
import { VERSION } from './index.js'
import { runGraph, type TaskOutcome } from './graph/scheduler.js'
import { isGroupTask } from './graph/task-graph.js'
import { ulid } from './util/ulid.js'
import { executeTask } from './orchestrator/execute-task.ts'
import { initSandbox, probeSandbox, resetSandbox } from './exec/sandbox-runtime.ts'
import { UserError } from './util/errors.ts'
import { defaultLogger, type Logger } from './orchestrator/logger.ts'
import { detectColors } from './orchestrator/colors.ts'
import { formatHeader } from './orchestrator/framed-output.ts'
import { makeSafeObserver, type Observer } from './orchestrator/observer.ts'
import { plan, type RunPlan } from './orchestrator/plan.ts'
import { prepareRun } from './orchestrator/prepare.ts'
import { writeRunProfile, writeRunSummary } from './orchestrator/run-artifacts.ts'
import { formatRunSummary } from './orchestrator/summary.ts'

export type { Logger } from './orchestrator/logger.ts'
export type { Observer, ObserverEvent, HistoryTable, TaskHistory } from './orchestrator/observer.ts'

export interface RunOptions {
  cwd: string
  /**
   * Task specs to run. Each may be a bare task name (`'build'`) —
   * applied across `projects` to every project that declares it —
   * or an anchored `'pkg#task'` — added directly to the requested
   * set regardless of `projects`.
   */
  tasks: readonly string[]
  projects?: string[]
  concurrency?: number
  /** Skip cache reads AND writes. Every task runs and nothing is persisted. */
  noCache?: boolean
  /**
   * Filter `dependsOn` expansion. `'all'` drops every edge (just the
   * requested task runs). A string array drops only those task names
   * from both `self` and `dependencies` buckets.
   */
  excludeDependencies?: 'all' | readonly string[]
  /** Forwarded to the last step of each task's exec array (shell-quoted). */
  forwardArgs?: readonly string[]
  /**
   * If set, write a per-run JSON summary at end of run. Empty string
   * picks the default path `<cacheDir>/runs/<run_id>.json`; anything
   * else is treated as the literal file path (cwd-relative).
   */
  summarize?: string
  /**
   * If set, write a Chrome-trace JSON profile of the run's wallclock
   * spans. Path is cwd-relative. Default `profile.json` is selected
   * by the CLI parser, not here.
   */
  profile?: string
  /**
   * Enable sandbox-runtime wrapping for cached tasks. When set, each
   * task's exec runs inside a filesystem sandbox that denies reads
   * outside the task's declared `cache.inputs.files` and the project
   * directory. Detected violations DON'T fail the task — they just
   * cause `cache.save()` to be skipped, so a tainted run can't be
   * replayed from cache. Disabled by default; opt-in via `--sandbox`.
   */
  sandbox?: boolean
  log?: Logger
  /**
   * Optional structural event sink. Independent of `log` — the Logger
   * owns terminal output (framed blocks); the Observer is a tagged-
   * union event stream the TUI / dashboards / tests consume. Errors
   * thrown from `observer.emit` are swallowed and logged to stderr.
   */
  observer?: Observer
}

export interface RunSummary {
  ok: boolean
  outcomes: TaskOutcome[]
}

export async function run(options: RunOptions): Promise<RunSummary> {
  // Color decision: a custom logger (tests, embedders) handles its
  // own formatting and asserts on plain strings, so we suppress
  // ANSI escapes for them. Only the defaultLogger (real terminal
  // output) gets colors, gated by NO_COLOR / FORCE_COLOR / isTTY.
  const colors = options.log ? { enabled: false } : detectColors()
  const log = options.log ?? defaultLogger(colors)

  // Wrap once so emit sites are unconditional. Throws from a buggy
  // observer never fail the run.
  const observer = makeSafeObserver(options.observer)

  const prepared = await prepareRun(options, log, observer)
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
    historyTable,
    gitFilesCache,
    hashCache,
  } = prepared
  const concurrency =
    options.concurrency ??
    workspaceConfig?.concurrency ??
    Math.max(1, navigator.hardwareConcurrency)

  // One run-id per `vx run` invocation. Every task in the resulting
  // graph carries it so analytics queries can group by invocation.
  const runId = ulid()
  const runStartHrTimeNs = process.hrtime.bigint()
  const startedAtMs = Date.now()
  const remoteCacheEnabled = cache instanceof LayeredCache

  // If the user asked for --sandbox, fail fast when the platform
  // can't support it. We don't fall back to running unsandboxed —
  // the user explicitly opted in expecting the safety net.
  if (options.sandbox) {
    const avail = await probeSandbox()
    if (!avail.available) {
      prepared.cache.close()
      throw new UserError(`--sandbox not available: ${avail.reason}`)
    }
    await initSandbox({ workspaceRoot })
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

  observer.emit({
    kind: 'runStart',
    runId,
    nodes: [...nodes.values()],
    concurrency,
    remoteCacheEnabled,
    startedAtMs,
    historyTable,
  })

  // Persistent (long-running) subprocesses — dev servers, watchers.
  // executeTask spawns them but does NOT await their exit; ownership
  // moves to this registry. Once the rest of the graph finishes we
  // SIGTERM each one so the runner returns cleanly.
  const persistentRegistry = new Map<string, ReturnType<typeof Bun.spawn>>()

  const outcomes = await runGraph({
    nodes,
    concurrency,
    onStart: (node, slot) => {
      // No per-task start line — the framed block renders on
      // completion. The Observer gets the start event for live UIs.
      observer.emit({
        kind: 'taskStart',
        nodeId: node.id,
        startNs: process.hrtime.bigint() - runStartHrTimeNs,
        slot,
      })
    },
    onFinish: (o) => {
      log.taskComplete(o.node, o)
      observer.emit({ kind: 'taskComplete', outcome: o })
    },
    execute: (node, upstream) =>
      executeTask({
        node,
        upstream,
        workspaceRoot,
        workspaceFingerprint,
        cache,
        noCache: options.noCache ?? false,
        sandbox: options.sandbox ?? false,
        forwardArgs: options.forwardArgs,
        log,
        observer,
        nestedProjectDirs: nestedDirsByProject.get(node.projectName) ?? [],
        runStartHrTimeNs,
        persistentRegistry,
        gitFilesCache,
        hashCache,
      }),
  })

  // Shut down every persistent task before reporting the final
  // summary. SIGTERM gives well-behaved servers (vite, next, esbuild
  // --watch) a moment to clean up; we don't escalate to SIGKILL —
  // process-group propagation on Ctrl-C handles the unhappy case.
  for (const [id, child] of persistentRegistry) {
    try {
      child.kill('SIGTERM')
    } catch {
      // already exited — fine.
    }
    void id
  }
  await Promise.allSettled([...persistentRegistry.values()].map((c) => c.exited))

  const list = [...outcomes.values()]
  const ok = list.every((o) => o.status === 'success' || o.status === 'cache-hit')

  // The summary + artifact writers + recordRun pass all exclude group
  // tasks via the shared tallyOutcomes helper. We pass the full
  // outcome list and let each consumer apply the same filter.
  const endedAtMs = Date.now()
  const totalMs = Number(process.hrtime.bigint() - runStartHrTimeNs) / 1_000_000
  for (const line of formatRunSummary(list, totalMs, colors)) log.status(line)
  observer.emit({ kind: 'runEnd', ok, outcomes: list, totalMs, endedAtMs })

  // Optional artifacts. Errors are surfaced to the user but don't
  // change the run's exit code — the run already happened.
  if (options.summarize !== undefined) {
    try {
      const wrote = await writeRunSummary({
        target: options.summarize,
        cacheDir,
        cwd: options.cwd,
        runId,
        startedAtMs: endedAtMs - totalMs,
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

  // Tear down SRT's network bridge + (on macOS) log monitor. No-op
  // if --sandbox wasn't set; otherwise SRT keeps proxy servers alive
  // and the next vx run would init on top of stale state.
  if (options.sandbox) {
    try {
      await resetSandbox()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.status(`vx: sandbox cleanup failed: ${msg}`)
    }
  }

  return { ok, outcomes: list }
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
  // planRun doesn't run tasks — no events to emit. But prepareRun
  // wants an observer; use the no-op one so callsites don't branch.
  const observer = makeSafeObserver(undefined)
  const prepared = await prepareRun(options, log, observer)
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

export type { RunPlan, PlannedTask, CacheStatus } from './orchestrator/plan.ts'
