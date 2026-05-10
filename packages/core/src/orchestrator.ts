// End-to-end wiring: discover workspace -> load configs -> build graph ->
// run with caching. Each step delegates to a single-purpose module so the
// layer can be swapped without touching the others.

import os from 'node:os'
import path from 'node:path'
import type { CacheInputs, ProcessConfig, ProjectConfig, TaskConfig, CacheConfig } from '@nxt/config'
import { Cache } from './cache.js'
import { buildIsolatedEnv, explicitEnvForKey } from './env.js'
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
    if (config.name && config.name !== meta.name) {
      throw new Error(
        `Project at ${meta.dir}: nxt.config name "${config.name}" does not match package.json name "${meta.name}"`,
      )
    }
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
  cache: Cache
  force: boolean
  log: Logger
  nestedProjectDirs: string[]
}

async function executeTask(args: ExecuteArgs): Promise<TaskOutcome> {
  const { node, upstream, workspaceRoot, cache, force, log } = args
  const cfg: TaskConfig = node.config
  const proc: ProcessConfig = cfg.process
  const cacheCfg: CacheConfig = cfg.cache ?? {}
  const cacheEnabled = cacheCfg.enabled !== false

  const outputs = cacheCfg.outputs ?? []
  const passThroughEnv = proc.passThroughEnv ?? []
  const explicitEnv = proc.env ?? {}

  const resolved = await resolveInputs({
    projectDir: node.projectDir,
    workspaceRoot,
    envSource: process.env,
    inputs: cacheCfg.inputs,
    ownOutputs: outputs,
    nestedProjectDirs: args.nestedProjectDirs,
  })

  const upstreamHashes = filterUpstreamHashes(upstream, cacheCfg.inputs?.dependencies)

  const hash = await cache.key({
    taskId: node.id,
    command: proc.command,
    explicitEnv: explicitEnvForKey(explicitEnv),
    envInputs: resolved.envValues,
    inputFiles: resolved.files,
    workspaceRoot,
    upstreamHashes,
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
    passThroughEnv,
    explicitEnv,
    source: process.env,
  })

  const result = await runCommand({
    command: proc.command,
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
        command: proc.command,
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

function filterUpstreamHashes(
  upstream: TaskOutcome[],
  filter: CacheInputs['dependencies'],
): string[] {
  const patterns = filter ?? ['*']
  const candidates = upstream.map((u) => u.node.taskName)
  const selected = new Set<string>()
  for (const p of patterns) {
    if (p === '*') {
      for (const c of candidates) selected.add(c)
    } else if (p.startsWith('!')) {
      selected.delete(p.slice(1))
    } else {
      selected.add(p)
    }
  }
  const out: string[] = []
  for (const u of upstream) {
    if (!u.hash) continue
    if (selected.has(u.node.taskName)) out.push(u.hash)
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
