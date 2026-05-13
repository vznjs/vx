import path from 'node:path'
import type { ExecConfig, TaskConfig, CacheConfig } from '../config.js'
import type { CacheLayer } from '../cache/cache.js'
import { cleanOutputs, resolveInputs, resolveOutputs } from '../cache/inputs.js'
import { buildIsolatedEnv } from '../exec/env.js'
import { runCommand } from '../exec/runner.js'
import type { TaskOutcome } from '../graph/scheduler.js'
import type { TaskNode } from '../graph/task-graph.js'
import type { Logger } from './logger.js'
import { filterUpstreamHashes } from './upstream.js'

export interface ExecuteArgs {
  node: TaskNode
  upstream: TaskOutcome[]
  workspaceRoot: string
  workspaceFingerprint: string
  cache: CacheLayer
  noCache: boolean
  forwardArgs?: readonly string[] | undefined
  log: Logger
  nestedProjectDirs: string[]
  /** Anchor for hrtime spans across all tasks in this run. */
  runStartHrTimeNs: bigint
}

export interface ComputeHashArgs {
  node: TaskNode
  upstream: TaskOutcome[]
  workspaceRoot: string
  workspaceFingerprint: string
  cache: CacheLayer
  forwardArgs?: readonly string[] | undefined
  nestedProjectDirs: string[]
}

/**
 * Resolve every input the cache key depends on (file content, env
 * values, upstream hashes, config bytes, project package.json bytes,
 * forwardArgs) and ask the cache layer to combine them. Used by both
 * `executeTask` for the real run and `plan()` for `--dry-run` /
 * `--graph` previews.
 *
 * Caller is responsible for handling the group-task case before
 * calling this — groups have no `exec` and no `cache.inputs`, so the
 * key-derivation steps below would all fall back to defaults.
 * `computeGroupHash` is exported for that purpose.
 */
export async function computeTaskHash(args: ComputeHashArgs): Promise<string> {
  const cfg = args.node.config
  const cacheCfg: CacheConfig | undefined = cfg.cache
  const outputs = cacheCfg?.outputs.files ?? []

  const resolved = await resolveInputs({
    projectDir: args.node.projectDir,
    workspaceRoot: args.workspaceRoot,
    envSource: process.env,
    inputs: cacheCfg?.inputs,
    ownOutputs: outputs,
    nestedProjectDirs: args.nestedProjectDirs,
  })

  const upstreamHashes = filterUpstreamHashes(
    args.upstream,
    cacheCfg?.inputs?.tasks,
    args.node.projectName,
  )
  const taskConfigHash = hashTaskConfig(cfg)
  const projectPackageJsonHash = await hashProjectPackageJson(args.node.projectDir)

  const effectiveForwardArgs = args.node.requested ? (args.forwardArgs ?? []) : []

  return await args.cache.key({
    taskId: args.node.id,
    taskConfigHash,
    projectPackageJsonHash,
    envValues: resolved.envValues,
    inputFiles: resolved.files,
    workspaceRoot: args.workspaceRoot,
    upstreamHashes,
    workspaceFingerprint: args.workspaceFingerprint,
    forwardArgs: effectiveForwardArgs,
  })
}

export async function executeTask(args: ExecuteArgs): Promise<TaskOutcome> {
  const { node, upstream, cache, noCache, log } = args
  const cfg: TaskConfig = node.config

  // Group task: no `exec` means this task is just a dependency
  // aggregator. Return success immediately — no spawn, no cache
  // lookup, no I/O. The scheduler has already ensured every
  // dependency completed successfully before calling us. Derive a
  // hash from the upstream hashes so any downstream task with
  // `inputs.tasks` pointing here gets natural cache invalidation
  // when something beneath the group changes.
  if (cfg.exec === undefined) {
    const wallclockNs = process.hrtime.bigint() - args.runStartHrTimeNs
    const groupHash = computeGroupHash(upstream)
    return {
      node,
      status: 'success',
      exitCode: 0,
      durationMs: 0,
      hash: groupHash,
      wallclockStartNs: wallclockNs,
      wallclockEndNs: wallclockNs,
    }
  }

  const step: ExecConfig = cfg.exec
  const cacheCfg: CacheConfig | undefined = cfg.cache
  const cacheEnabled = cacheCfg !== undefined && !noCache

  const outputs = cacheCfg?.outputs.files ?? []

  // forwardArgs apply only to the tasks the user explicitly asked for —
  // not to dependsOn-expanded upstream tasks. This keeps `vx run build
  // -- --watch` from forwarding `--watch` into every dependency's
  // build, and it stops upstream cache keys from being uselessly
  // partitioned by CLI args that don't change their behavior.
  const effectiveForwardArgs = node.requested ? (args.forwardArgs ?? []) : []

  const hash = await computeTaskHash({
    node,
    upstream,
    workspaceRoot: args.workspaceRoot,
    workspaceFingerprint: args.workspaceFingerprint,
    cache,
    forwardArgs: args.forwardArgs,
    nestedProjectDirs: args.nestedProjectDirs,
  })

  // Cleaning the declared output paths is the same operation in both
  // cache-hit and cache-miss paths: wipe whatever's currently matching
  // the output globs so the restored snapshot (or the fresh exec) lands
  // on a clean slate. Skipped when nothing is declared as output, and
  // when caching is off (the user is debugging and managing the tree
  // themselves).
  const cleanArgs = {
    projectDir: node.projectDir,
    outputs,
    nestedProjectDirs: args.nestedProjectDirs,
  }

  if (cacheEnabled) {
    // Time the cache lookup + (if hit) clean + restore + log replay.
    // This is the "operation time" the user sees in the footer —
    // wallclock for actually doing the cache-hit work, not the
    // original exec time that produced the entry.
    const cacheOpStart = performance.now()
    const hit = await cache.get(hash)
    if (hit) {
      if (outputs.length > 0) await cleanOutputs(cleanArgs)
      await cache.restoreOutputs(hash, node.projectDir)
      if (hit.stdout) log.taskStdout(node, hit.stdout)
      if (hit.stderr) log.taskStderr(node, hit.stderr)
      const status =
        hit.exitCode !== 0 ? 'failed' : hit.source === 'remote' ? 'cache-hit-remote' : 'cache-hit'
      return {
        node,
        status,
        exitCode: hit.exitCode,
        durationMs: Math.round(performance.now() - cacheOpStart),
        hash,
      }
    }
  }

  if (cacheEnabled && outputs.length > 0) await cleanOutputs(cleanArgs)

  const env = buildIsolatedEnv({
    passThrough: step.env?.passThrough ?? [],
    define: step.env?.define ?? {},
    source: process.env,
    binPaths: [path.join(node.projectDir, 'node_modules', '.bin')],
  })
  // Per-task wallclock span relative to the run's t=0. Monotonic ns
  // ticks so analytics can reconstruct the parallel timeline (overlaps,
  // idle gaps) immune to wall-clock skew.
  const wallclockStartNs = process.hrtime.bigint() - args.runStartHrTimeNs
  const result = await runCommand({
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
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.cpuMs !== undefined ? { cpuMs: result.cpuMs } : {}),
    ...(result.peakRssBytes !== undefined ? { peakRssBytes: result.peakRssBytes } : {}),
    wallclockStartNs,
    wallclockEndNs,
  }
}

/**
 * Hash the resolved task config. Folds every config-time decision
 * (command, env names, dependsOn, cache directives, outputs,
 * passThroughEnv list, etc.) into the cache key. Imported values
 * participate because the loader has already baked them into the
 * resolved object before we serialize.
 *
 * The schema is JSON-serializable by construction (no functions in
 * fields).
 */
function hashTaskConfig(cfg: TaskConfig): string {
  return new Bun.CryptoHasher('sha256').update(JSON.stringify(cfg)).digest('hex')
}

/**
 * Derive a stable hash for a group task (no `exec`) from its upstream
 * outcomes. Lets downstream tasks that filter `inputs.tasks` to
 * include a group still invalidate naturally when anything beneath
 * the group changes. Sorted so the hash is order-independent. Empty
 * group (no upstream) yields a fixed sentinel hash.
 */
export function computeGroupHash(upstream: TaskOutcome[]): string {
  const ids = upstream
    .map((u) => `${u.node.id}:${u.hash ?? ''}`)
    .sort()
    .join('|')
  return new Bun.CryptoHasher('sha256').update(`group|${ids}`).digest('hex')
}

/**
 * Hash the project's `package.json` bytes. Folded into every task's
 * cache key in that project so dep changes (devDependencies, scripts,
 * version bumps) invalidate the project's tasks even when
 * `cache.inputs.files` is narrow and doesn't cover the file.
 *
 * Matches Turbo and Nx's "implicit dependencies" behavior. Returns
 * '' for the edge case of a project without a package.json (impossible
 * in practice — workspace discovery requires one).
 */
async function hashProjectPackageJson(projectDir: string): Promise<string> {
  const file = Bun.file(path.join(projectDir, 'package.json'))
  if (!(await file.exists())) return ''
  return new Bun.CryptoHasher('sha256').update(await file.bytes()).digest('hex')
}
