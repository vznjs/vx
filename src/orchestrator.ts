// End-to-end wiring: discover workspace -> load configs -> build graph ->
// run with caching. Each step delegates to a single-purpose module under
// ./orchestrator/ so the layers can be swapped without touching the others.

import path from 'node:path'
import type { ProjectConfig } from './config.js'
import { Cache } from './cache/cache.js'
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
import { defaultLogger, formatOutcome, type Logger } from './orchestrator/logger.ts'
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
  const log = options.log ?? defaultLogger()

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

  log.status(`vx: ${nodes.size} task(s), concurrency ${concurrency} [run ${runId}]`)

  const outcomes = await runGraph({
    nodes,
    concurrency,
    onStart: (node) => log.status(`▶  ${node.id}`),
    onFinish: (o) => log.status(formatOutcome(o)),
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

  const totalMs = Number(process.hrtime.bigint() - runStartHrTimeNs) / 1_000_000
  for (const line of formatRunSummary(list, totalMs)) log.status(line)

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

export { taskId }
