import os from 'node:os'
import path from 'node:path'
import type { Input, ProjectConfig, TaskConfig } from '@nxt/config'
import { Cache } from './cache.js'
import { resolveInputs, resolveOutputs } from './inputs.js'
import { buildPackageGraph } from './package-graph.js'
import { loadProjectConfig } from './project-loader.js'
import { runCommand } from './runner.js'
import { runGraph, type TaskOutcome } from './scheduler.js'
import { buildTaskGraph, taskId, type ProjectEntry, type TaskNode } from './task-graph.js'
import { findWorkspaceRoot, listProjects, loadWorkspace } from './workspace.js'

export interface RunOptions {
  /** Working directory; workspace root is discovered from here upward. */
  cwd: string
  /** Task name to run (e.g. `build`). */
  task: string
  /** Restrict to specific projects (and their task-graph dependencies). */
  projects?: string[]
  /** Maximum concurrent tasks. Defaults to CPU count. */
  concurrency?: number
  /** When true, ignore the cache: every task runs and the result overwrites. */
  force?: boolean
  /** Logger; defaults to writing to process.stdout/stderr. */
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
    execute: async (node, upstream) => {
      return executeTask({
        node,
        upstream,
        workspaceRoot,
        cache,
        force: options.force ?? false,
        log,
      })
    },
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
}

async function executeTask(args: ExecuteArgs): Promise<TaskOutcome> {
  const { node, upstream, workspaceRoot, cache, force, log } = args
  const taskCfg = node.config

  const cacheCfg = normalizeCache(taskCfg.cache)
  const start = Date.now()

  if (!cacheCfg) {
    // Caching disabled: just run.
    const result = await runCommand({
      command: taskCfg.command,
      cwd: node.projectDir,
      env: process.env,
      onStdout: (chunk) => log.taskStdout(node, chunk),
      onStderr: (chunk) => log.taskStderr(node, chunk),
    })
    return {
      node,
      status: result.exitCode === 0 ? 'success' : 'failed',
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    }
  }

  const inputFiles = await resolveInputs({
    projectDir: node.projectDir,
    workspaceRoot,
    inputs: cacheCfg.inputs,
  })

  const upstreamHashes = upstream.map((u) => u.hash).filter((h): h is string => Boolean(h))

  const hash = await cache.key({
    taskId: node.id,
    command: taskCfg.command,
    envNames: taskCfg.env ?? [],
    processEnv: process.env,
    inputs: inputFiles,
    workspaceRoot,
    upstreamHashes,
  })

  if (!force) {
    const hit = await cache.get(hash)
    if (hit) {
      await cache.restoreOutputs(hash, node.projectDir)
      if (hit.stdout) log.taskStdout(node, hit.stdout)
      if (hit.stderr) log.taskStderr(node, hit.stderr)
      return {
        node,
        status: hit.exitCode === 0 ? 'cache-hit' : 'failed',
        exitCode: hit.exitCode,
        durationMs: Date.now() - start,
        hash,
      }
    }
  }

  const result = await runCommand({
    command: taskCfg.command,
    cwd: node.projectDir,
    env: process.env,
    onStdout: (chunk) => log.taskStdout(node, chunk),
    onStderr: (chunk) => log.taskStderr(node, chunk),
  })

  if (result.exitCode === 0) {
    const outputFiles = await resolveOutputs({
      projectDir: node.projectDir,
      outputs: cacheCfg.outputs,
    })
    await cache.save({
      hash,
      projectDir: node.projectDir,
      outputFiles,
      entry: {
        taskId: node.id,
        command: taskCfg.command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        outputFiles: [],
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

interface NormalizedCache {
  inputs: Input[] | undefined
  outputs: string[]
}

function normalizeCache(cache: TaskConfig['cache']): NormalizedCache | null {
  if (cache === false) return null
  if (cache === undefined || cache === true) {
    return { inputs: undefined, outputs: [] }
  }
  return { inputs: cache.inputs, outputs: cache.outputs ?? [] }
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
  return chunk
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => `${pad}${line}`)
    .join('\n') + (chunk.endsWith('\n') ? '\n' : '')
}

export { taskId }
