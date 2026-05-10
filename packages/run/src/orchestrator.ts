// End-to-end wiring: discover workspace -> load configs -> build graph ->
// run with caching. Each step delegates to a single-purpose module so the
// layer can be swapped without touching the others.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ExecConfig, ProjectConfig, TaskConfig, CacheConfig, TaskDependsOn } from './config.js'
import { Cache } from './cache.js'
import { buildIsolatedEnv } from './env.js'
import { resolveInputs, resolveOutputs } from './inputs.js'
import { buildPackageGraph } from './package-graph.js'
import { loadProjectConfig } from './project-loader.js'
import { runCommand } from './runner.js'
import { runGraph, type TaskOutcome } from './scheduler.js'
import { buildTaskGraph, taskId, type ProjectEntry, type TaskNode } from './task-graph.js'
import { findWorkspaceRoot, listProjects, loadWorkspace } from './workspace.js'

export interface RunOptions {
  cwd: string
  task: string
  projects?: string[]
  concurrency?: number
  /** Ignore cache hits and re-run; writes still update the cache. */
  force?: boolean
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
    return { ok: true, outcomes: [] }
  }

  const nodes = buildTaskGraph({ projects, packageGraph, requested })
  if (nodes.size === 0) {
    log.status(`No tasks to run.`)
    return { ok: true, outcomes: [] }
  }

  const cache = new Cache(path.join(workspaceRoot, '.nxt', 'cache'))
  const concurrency = options.concurrency ?? Math.max(1, os.cpus().length)
  const workspaceFingerprint = await computeWorkspaceFingerprint(workspaceRoot)

  log.status(`nxt: ${nodes.size} task(s), concurrency ${concurrency}`)

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
        force: options.force ?? false,
        log,
        nestedProjectDirs: nestedDirsByProject.get(node.projectName) ?? [],
      }),
  })

  const list = [...outcomes.values()]
  const ok = list.every((o) => o.status === 'success' || o.status === 'cache-hit')
  return { ok, outcomes: list }
}

interface ExecuteArgs {
  node: TaskNode
  upstream: TaskOutcome[]
  workspaceRoot: string
  workspaceFingerprint: string
  cache: Cache
  force: boolean
  log: Logger
  nestedProjectDirs: string[]
}

async function executeTask(args: ExecuteArgs): Promise<TaskOutcome> {
  const { node, upstream, workspaceRoot, cache, force, log } = args
  const cfg: TaskConfig = node.config
  const exec: ExecConfig = cfg.exec
  const cacheCfg: CacheConfig | undefined = cfg.cache
  const cacheEnabled = cacheCfg !== undefined

  const outputs = cacheCfg?.outputs.files ?? []
  const passThrough = exec.env?.passThrough ?? []
  const define = exec.env?.define ?? {}

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

  const hash = await cache.key({
    taskId: node.id,
    taskConfigHash,
    envValues: resolved.envValues,
    inputFiles: resolved.files,
    workspaceRoot,
    upstreamHashes,
    workspaceFingerprint: args.workspaceFingerprint,
  })

  if (cacheEnabled && !force) {
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
    passThrough,
    define,
    source: process.env,
  })

  const result = await runCommand({
    command: exec.command,
    cwd: node.projectDir,
    env,
    onStdout: (chunk) => log.taskStdout(node, chunk),
    onStderr: (chunk) => log.taskStderr(node, chunk),
  })

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
        command: exec.command,
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
  // Default (omitted): every upstream task that ran for me contributes.
  if (filter === undefined) {
    return upstream.flatMap((u) => (u.hash ? [u.hash] : []))
  }
  const selfNames = new Set(filter.self ?? [])
  const depNames = new Set(filter.dependencies ?? [])
  const out: string[] = []
  for (const u of upstream) {
    if (!u.hash) continue
    const isSameProject = u.node.projectName === selfProjectName
    const allowed = isSameProject ? selfNames.has(u.node.taskName) : depNames.has(u.node.taskName)
    if (allowed) out.push(u.hash)
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
