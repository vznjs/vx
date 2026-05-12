// End-to-end wiring: discover workspace -> load configs -> build graph ->
// run with caching. Each step delegates to a single-purpose module so the
// layer can be swapped without touching the others.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ExecConfig, ProjectConfig, TaskConfig, CacheConfig, TaskDependsOn } from './config.js'
import { Cache, type CacheLayer } from './cache.js'
import { LayeredCache } from './layered-cache.js'
import { RemoteCache } from './remote-cache.js'
import { buildIsolatedEnv } from './env.js'
import { resolveInputs, resolveOutputs } from './inputs.js'
import { buildPackageGraph } from './package-graph.js'
import { loadProjectConfig } from './project-loader.js'
import { runCommand } from './runner.js'
import { runSandboxed } from './sandbox.js'
import { runGraph, type TaskOutcome } from './scheduler.js'
import { buildTaskGraph, taskId, type ProjectEntry, type TaskNode } from './task-graph.js'
import { ulid } from './ulid.js'
import { findWorkspaceRoot, listProjects, loadWorkspace, resolveCacheDir } from './workspace.js'
import { loadWorkspaceConfig } from './project-loader.js'

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
  /**
   * Run each task inside a sandbox enforcing declared `cache.inputs.files`.
   * Linux uses bwrap; macOS uses sandbox-exec; other platforms throw.
   * Off by default. See `docs/design/sandbox.md`.
   */
  sandbox?: boolean
  log?: Logger
}

export interface RunSummary {
  ok: boolean
  outcomes: TaskOutcome[]
}

export interface Logger {
  status(line: string): void
  taskStdout(node: TaskNode, chunk: string): void
  taskStderr(node: TaskNode, chunk: string): void
}

export async function run(options: RunOptions): Promise<RunSummary> {
  const log = options.log ?? defaultLogger()

  const workspaceRoot = findWorkspaceRoot(options.cwd)
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
    .filter((name) => projects.get(name)?.config.run?.tasks?.[options.task])
    .map((name) => ({ project: name, task: options.task }))

  if (requested.length === 0) {
    log.status(`No projects declare task "${options.task}".`)
    // Treat "nothing matched" as a failure. A typo'd task name silently
    // exiting 0 in CI is a real footgun (Agent A's real-world test, B3).
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

  const localCache = new Cache(resolveCacheDir(workspaceRoot, workspaceConfig))
  const cache = wrapWithRemoteCache(localCache, log)
  const concurrency =
    options.concurrency ?? workspaceConfig?.concurrency ?? Math.max(1, os.cpus().length)
  const workspaceFingerprint = await computeWorkspaceFingerprint(workspaceRoot)

  // One run-id per `vzn run` invocation. Every task in the resulting
  // graph carries it so analytics queries can group by invocation.
  const runId = ulid()
  const runStartHrTimeNs = process.hrtime.bigint()

  log.status(`vzn: ${nodes.size} task(s), concurrency ${concurrency} [run ${runId}]`)

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
        sandbox: options.sandbox ?? false,
        forwardArgs: options.forwardArgs,
        log,
        nestedProjectDirs: nestedDirsByProject.get(node.projectName) ?? [],
        runStartHrTimeNs,
      }),
  })

  const list = [...outcomes.values()]
  const ok = list.every((o) => o.status === 'success' || o.status === 'cache-hit')

  // Record each task to the run history. Timestamps are approximate
  // (we don't have per-task wall-clock start times exposed by the
  // scheduler), but durations are real. Good enough for stats; if we
  // ever need precise span tracking we'd add start/end to TaskOutcome.
  const now = Date.now()
  for (const o of list) {
    if (!o.hash) continue
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
      cacheHit: o.status === 'cache-hit',
    })
  }
  cache.close()

  return { ok, outcomes: list }
}

interface ExecuteArgs {
  node: TaskNode
  upstream: TaskOutcome[]
  workspaceRoot: string
  workspaceFingerprint: string
  cache: CacheLayer
  noCache: boolean
  sandbox: boolean
  forwardArgs?: readonly string[] | undefined
  log: Logger
  nestedProjectDirs: string[]
  /** Anchor for hrtime spans across all tasks in this run. */
  runStartHrTimeNs: bigint
}

async function executeTask(args: ExecuteArgs): Promise<TaskOutcome> {
  const { node, upstream, workspaceRoot, cache, noCache, log } = args
  const cfg: TaskConfig = node.config
  const step: ExecConfig = cfg.exec
  const cacheCfg: CacheConfig | undefined = cfg.cache
  const cacheEnabled = cacheCfg !== undefined && !noCache

  const outputs = cacheCfg?.outputs.files ?? []

  const resolved = await resolveInputs({
    projectDir: node.projectDir,
    workspaceRoot,
    envSource: process.env,
    inputs: cacheCfg?.inputs,
    ownOutputs: outputs,
    nestedProjectDirs: args.nestedProjectDirs,
  })

  const upstreamHashes = filterUpstreamHashes(upstream, cacheCfg?.inputs?.tasks, node.projectName)
  const taskConfigHash = hashTaskConfig(cfg)

  // forwardArgs apply only to the tasks the user explicitly asked for —
  // not to dependsOn-expanded upstream tasks. This keeps `vzn run build --
  // --watch` from forwarding `--watch` into every dependency's build, and
  // it stops the upstream cache keys from being uselessly partitioned by
  // CLI args that don't change their behavior.
  const effectiveForwardArgs = node.requested ? (args.forwardArgs ?? []) : []

  const hash = await cache.key({
    taskId: node.id,
    taskConfigHash,
    envValues: resolved.envValues,
    inputFiles: resolved.files,
    workspaceRoot,
    upstreamHashes,
    workspaceFingerprint: args.workspaceFingerprint,
    forwardArgs: effectiveForwardArgs,
  })

  if (cacheEnabled) {
    const hit = await cache.get(hash)
    if (hit) {
      await cache.restoreOutputs(hash, node.projectDir)
      if (hit.stdout) log.taskStdout(node, hit.stdout)
      if (hit.stderr) log.taskStderr(node, hit.stderr)
      return {
        node,
        status: hit.exitCode === 0 ? 'cache-hit' : 'failed',
        exitCode: hit.exitCode,
        durationMs: 0,
        hash,
      }
    }
  }

  const env = buildIsolatedEnv({
    passThrough: step.env?.passThrough ?? [],
    define: step.env?.define ?? {},
    source: process.env,
  })
  // Per-task wallclock span relative to the run's t=0. Monotonic ns
  // ticks so analytics can reconstruct the parallel timeline (overlaps,
  // idle gaps) immune to wall-clock skew.
  const wallclockStartNs = process.hrtime.bigint() - args.runStartHrTimeNs
  const result = args.sandbox
    ? await runSandboxed({
        command: step.command,
        cwd: node.projectDir,
        env,
        forwardArgs: effectiveForwardArgs,
        projectDir: node.projectDir,
        inputFiles: resolved.files,
        onStdout: (chunk) => log.taskStdout(node, chunk),
        onStderr: (chunk) => log.taskStderr(node, chunk),
      })
    : await runCommand({
        command: step.command,
        cwd: node.projectDir,
        env,
        forwardArgs: effectiveForwardArgs,
        onStdout: (chunk) => log.taskStdout(node, chunk),
        onStderr: (chunk) => log.taskStderr(node, chunk),
      })
  const wallclockEndNs = process.hrtime.bigint() - args.runStartHrTimeNs

  if (result.exitCode === 0 && cacheEnabled) {
    const outputFiles = await resolveOutputs({
      projectDir: node.projectDir,
      outputs,
      nestedProjectDirs: args.nestedProjectDirs,
    })
    await cache.save({
      hash,
      projectDir: node.projectDir,
      outputFiles,
      entry: {
        taskId: node.id,
        command: step.command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    })
  }

  return {
    node,
    status: result.exitCode === 0 ? 'success' : 'failed',
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    hash,
    ...(result.cpuMs !== undefined ? { cpuMs: result.cpuMs } : {}),
    ...(result.peakRssBytes !== undefined ? { peakRssBytes: result.peakRssBytes } : {}),
    wallclockStartNs,
    wallclockEndNs,
  }
}

/**
 * For each project, the absolute dirs of other projects that live underneath
 * it. Used to enforce project-boundary isolation: a project's task cannot
 * see files inside another project, even if its globs would otherwise match.
 */
function computeNestedProjectDirs(entries: ProjectEntry[]): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const p of entries) {
    const prefix = p.dir + path.sep
    const nested = entries
      .filter((o) => o.dir !== p.dir && o.dir.startsWith(prefix))
      .map((o) => o.dir)
    result.set(p.name, nested)
  }
  return result
}

/**
 * Hash the resolved task config. Folds every config-time decision (command,
 * env names, dependsOn, cache directives, outputs, passThroughEnv list, etc.)
 * into the cache key. Imported values are included because jiti has already
 * baked them into the loaded object before we serialize.
 *
 * The schema is JSON-serializable by construction (no functions in fields).
 */
function hashTaskConfig(cfg: TaskConfig): string {
  return createHash('sha256').update(JSON.stringify(cfg)).digest('hex')
}

const WORKSPACE_FINGERPRINT_FILES = ['pnpm-lock.yaml', 'pnpm-workspace.yaml']

/**
 * One hash for the workspace as a whole, derived from `pnpm-lock.yaml` and
 * `pnpm-workspace.yaml`. Folded into every task's cache key so a `pnpm
 * update` (lockfile change) or a workspace-shape change invalidates every
 * cached entry. Coarse but correct.
 */
async function computeWorkspaceFingerprint(workspaceRoot: string): Promise<string> {
  const h = createHash('sha256')
  for (const f of WORKSPACE_FINGERPRINT_FILES) {
    const full = path.join(workspaceRoot, f)
    if (!existsSync(full)) continue
    h.update(`${f}\0`)
    h.update(await readFile(full))
    h.update('\n')
  }
  return h.digest('hex')
}

function filterUpstreamHashes(
  upstream: TaskOutcome[],
  filter: TaskDependsOn | undefined,
  selfProjectName: string,
): string[] {
  // Per-bucket default: omitted bucket → all upstream from that source.
  // Explicit array supports three pattern kinds, applied in order:
  //   '*'      include all from this bucket
  //   'name'   include the literal task name
  //   '!name'  exclude the literal task name
  // Last write wins, so `['*', '!noisy']` reads as "all minus noisy".
  const out: string[] = []
  for (const u of upstream) {
    if (!u.hash) continue
    const isSameProject = u.node.projectName === selfProjectName
    const bucket = isSameProject ? filter?.self : filter?.dependencies

    if (bucket === undefined) {
      out.push(u.hash)
      continue
    }

    let included = false
    for (const pattern of bucket) {
      if (pattern === '*') included = true
      else if (pattern.startsWith('!')) {
        if (pattern.slice(1) === u.node.taskName) included = false
      } else if (pattern === u.node.taskName) included = true
    }
    if (included) out.push(u.hash)
  }
  return out
}

function formatOutcome(o: TaskOutcome): string {
  const tag =
    o.status === 'cache-hit'
      ? '◉  cache'
      : o.status === 'success'
        ? '✓'
        : o.status === 'failed'
          ? '✗'
          : '·  skip'
  return `${tag} ${o.node.id}  (${o.durationMs}ms)`
}

function defaultLogger(): Logger {
  return {
    status(line) {
      process.stdout.write(`${line}\n`)
    },
    taskStdout(node, chunk) {
      process.stdout.write(prefix(node.id, chunk))
    },
    taskStderr(node, chunk) {
      process.stderr.write(prefix(node.id, chunk))
    },
  }
}

function prefix(id: string, chunk: string): string {
  const pad = `${id} │ `
  return (
    chunk
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => `${pad}${line}`)
      .join('\n') + (chunk.endsWith('\n') ? '\n' : '')
  )
}

export { taskId }

/**
 * If VZN_REMOTE_CACHE_URL + VZN_REMOTE_CACHE_TOKEN are both set, wrap the
 * local cache in a LayeredCache so cache reads/writes also hit the remote
 * over the Turbo /v8/artifacts wire. Otherwise return local unchanged.
 *
 * Optional env: VZN_REMOTE_CACHE_TEAM_ID, VZN_REMOTE_CACHE_SLUG (tenancy
 * query params), VZN_REMOTE_CACHE_TIMEOUT_MS.
 */
function wrapWithRemoteCache(local: Cache, log: Logger): CacheLayer {
  const url = process.env.VZN_REMOTE_CACHE_URL
  const token = process.env.VZN_REMOTE_CACHE_TOKEN
  if (!url || !token) return local

  const config: ConstructorParameters<typeof RemoteCache>[0] = { baseUrl: url, token }
  const teamId = process.env.VZN_REMOTE_CACHE_TEAM_ID
  if (teamId) config.teamId = teamId
  const slug = process.env.VZN_REMOTE_CACHE_SLUG
  if (slug) config.slug = slug
  const timeoutMs = process.env.VZN_REMOTE_CACHE_TIMEOUT_MS
  if (timeoutMs) {
    const n = Number(timeoutMs)
    if (Number.isFinite(n) && n > 0) config.timeoutMs = n
  }

  log.status(`remote cache: ${url}`)
  return new LayeredCache(local, new RemoteCache(config), {
    onRemoteError: (err) => log.status(`[vzn] remote cache: ${err.message}`),
  })
}
