// End-to-end wiring: discover workspace -> load configs -> build graph ->
// run with caching. Each step delegates to a single-purpose module under
// ./orchestrator/ so the layers can be swapped without touching the others.

import path from 'node:path'
import type { ProjectConfig } from './config.js'
import { Cache } from './cache/cache.js'
import { LayeredCache } from './cache/layered-cache.js'
import { VERSION } from './index.js'
import { buildPackageGraph } from './workspace/package-graph.js'
import { loadProjectConfig, loadWorkspaceConfig } from './workspace/project-loader.js'
import { runGraph, type TaskOutcome } from './graph/scheduler.js'
import { buildTaskGraph, taskId, type ProjectEntry } from './graph/task-graph.js'
import { ulid } from './util/ulid.js'
import {
  findWorkspaceRoot,
  listProjects,
  loadWorkspace,
  resolveCacheDir,
} from './workspace/workspace.js'
import { executeTask } from './orchestrator/execute-task.ts'
import { computeWorkspaceFingerprint } from './orchestrator/fingerprint.ts'
import { computeNestedProjectDirs } from './orchestrator/nested-dirs.ts'
import { persistTaskLogs } from './orchestrator/task-logs.ts'
import { wrapWithRemoteCache } from './orchestrator/remote-cache-setup.ts'
import { defaultLogger, type Logger } from './orchestrator/logger.ts'
import { detectColors } from './orchestrator/colors.ts'
import { formatHeader } from './orchestrator/framed-output.ts'
import { plan, type RunPlan } from './orchestrator/plan.ts'
import { formatRunSummary } from './orchestrator/summary.ts'

export type { Logger } from './orchestrator/logger.ts'

export interface RunOptions {
  cwd: string
  task: string
  projects?: string[]
  concurrency?: number
  /** Skip cache reads AND writes. Every task runs and nothing is persisted. */
  noCache?: boolean
  /** Build the graph from only the requested tasks; skip `dependsOn` expansion. */
  ignoreDependsOn?: boolean
  /** Forwarded to the last step of each task's exec array (shell-quoted). */
  forwardArgs?: readonly string[]
  log?: Logger
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

  const workspaceRoot = await findWorkspaceRoot(options.cwd)
  const workspace = await loadWorkspace(workspaceRoot)
  const workspaceConfig = await loadWorkspaceConfig(workspaceRoot)
  const projectMetas = await listProjects(workspace)

  const projects = new Map<string, ProjectEntry>()
  for (const meta of projectMetas) {
    if (!meta.configPath) continue
    const config: ProjectConfig = await loadProjectConfig(meta.configPath)
    projects.set(meta.name, { name: meta.name, dir: meta.dir, config })
  }

  const packageGraph = buildPackageGraph(projectMetas)
  const nestedDirsByProject = computeNestedProjectDirs([...projects.values()])

  const candidateProjects = options.projects
    ? options.projects.filter((p) => projects.has(p))
    : [...projects.keys()]

  const requested = candidateProjects
    .filter((name) => projects.get(name)?.config.tasks?.[options.task])
    .map((name) => ({ project: name, task: options.task }))

  if (requested.length === 0) {
    log.status(`No projects declare task "${options.task}".`)
    // Treat "nothing matched" as a failure. A typo'd task name silently
    // exiting 0 in CI is a real footgun.
    return { ok: false, outcomes: [] }
  }

  const nodes = buildTaskGraph({
    projects,
    packageGraph,
    requested,
    ignoreDependsOn: options.ignoreDependsOn ?? false,
  })
  if (nodes.size === 0) {
    log.status(`No tasks to run.`)
    return { ok: false, outcomes: [] }
  }

  const cacheDir = resolveCacheDir(workspaceRoot, workspaceConfig)
  const localCache = new Cache(cacheDir)
  const cache = wrapWithRemoteCache(localCache, log)
  const concurrency =
    options.concurrency ??
    workspaceConfig?.concurrency ??
    Math.max(1, navigator.hardwareConcurrency)
  const workspaceFingerprint = await computeWorkspaceFingerprint(workspaceRoot)

  // One run-id per `vx run` invocation. Every task in the resulting
  // graph carries it so analytics queries can group by invocation.
  const runId = ulid()
  const runStartHrTimeNs = process.hrtime.bigint()

  // Packages-in-scope for the header: the unique projects covered by
  // the graph (including dependsOn-pulled deps), not just the
  // user-requested set.
  const packagesInScope = new Set<string>()
  for (const node of nodes.values()) packagesInScope.add(node.projectName)
  for (const line of formatHeader(
    {
      version: VERSION,
      packages: [...packagesInScope],
      task: options.task,
      remoteCacheEnabled: cache instanceof LayeredCache,
    },
    colors,
  ))
    log.status(line)

  const outcomes = await runGraph({
    nodes,
    concurrency,
    onStart: () => {
      // No per-task start line — the framed block renders on completion.
    },
    onFinish: (o) => log.taskComplete(o.node, o),
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
      }),
  })

  const list = [...outcomes.values()]
  const ok = list.every((o) => o.status === 'success' || o.status === 'cache-hit')

  // Persist task logs to disk so users can inspect after the fact —
  // especially failures (we don't cache failed exec output). Output was
  // already streamed live during the run; we deliberately do not replay
  // it here. Path: <cacheDir>/logs/<run_id>/<project>__<task>.{stdout,stderr}
  const logsDir = path.join(cacheDir, 'logs', runId)
  await persistTaskLogs({ logsDir, outcomes: list })

  // Summary counts only real tasks (those with `exec`). Group tasks
  // do no work — they're just dependency aggregators — so including
  // them in totals makes "3 cached, 4 total" read as if something
  // wasn't cached when in fact every executable task was. Same
  // exclusion as the analytics `recordRun` pass below.
  const realTasks = list.filter((o) => o.node.config.exec !== undefined)
  const totalMs = Number(process.hrtime.bigint() - runStartHrTimeNs) / 1_000_000
  for (const line of formatRunSummary(realTasks, totalMs, colors)) log.status(line)

  // Record each task to the run history. Group tasks (no `exec`) are
  // skipped — they aren't real runs and showing them in `vx stats` as
  // zero-duration successes is noise.
  const now = Date.now()
  for (const o of list) {
    if (!o.hash) continue
    if (o.node.config.exec === undefined) continue
    cache.recordRun({
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
  cache.close()

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
  const workspaceRoot = await findWorkspaceRoot(options.cwd)
  const workspace = await loadWorkspace(workspaceRoot)
  const workspaceConfig = await loadWorkspaceConfig(workspaceRoot)
  const projectMetas = await listProjects(workspace)

  const projects = new Map<string, ProjectEntry>()
  for (const meta of projectMetas) {
    if (!meta.configPath) continue
    const config: ProjectConfig = await loadProjectConfig(meta.configPath)
    projects.set(meta.name, { name: meta.name, dir: meta.dir, config })
  }

  const packageGraph = buildPackageGraph(projectMetas)
  const nestedDirsByProject = computeNestedProjectDirs([...projects.values()])

  const candidateProjects = options.projects
    ? options.projects.filter((p) => projects.has(p))
    : [...projects.keys()]

  const requested = candidateProjects
    .filter((name) => projects.get(name)?.config.tasks?.[options.task])
    .map((name) => ({ project: name, task: options.task }))

  if (requested.length === 0) return { tasks: [] }

  const nodes = buildTaskGraph({
    projects,
    packageGraph,
    requested,
    ignoreDependsOn: options.ignoreDependsOn ?? false,
  })
  if (nodes.size === 0) return { tasks: [] }

  const cacheDir = resolveCacheDir(workspaceRoot, workspaceConfig)
  const localCache = new Cache(cacheDir)
  const cache = wrapWithRemoteCache(localCache, options.log ?? defaultLogger())
  const workspaceFingerprint = await computeWorkspaceFingerprint(workspaceRoot)

  try {
    return await plan({
      nodes,
      workspaceRoot,
      workspaceFingerprint,
      cache,
      noCache: options.noCache ?? false,
      forwardArgs: options.forwardArgs,
      nestedDirsByProject,
    })
  } finally {
    cache.close()
  }
}

export type { RunPlan, PlannedTask, CacheStatus } from './orchestrator/plan.ts'
export { taskId }
