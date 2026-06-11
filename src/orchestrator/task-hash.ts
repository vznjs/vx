import path from 'node:path'
import type { TaskConfig, CacheConfig } from '../config.js'
import type { CacheLayer } from '../cache/cache.js'
import { resolveInputs } from '../cache/inputs.js'
import type { TaskOutcome } from '../graph/scheduler.js'
import type { TaskNode } from '../graph/task-graph.js'
import { xxh3hex } from '../util/hash.js'
import { filterUpstreamHashes } from './upstream.js'

/**
 * Per-run memoization caches for the two derived hashes that don't
 * change across tasks within one run:
 *   - `packageJson`: keyed by absolute projectDir. Every task in a
 *     project re-reads the same `package.json`; without this, a
 *     monorepo with N projects × M tasks per project does N×M reads
 *     of the same bytes.
 *   - `taskConfig`: keyed by the resolved-config object reference.
 *     Each task's config is created once at prepareRun time; the
 *     JSON.stringify + xxh3 of it is deterministic. WeakMap so
 *     entries free when the orchestrator is done.
 *
 * Both fields are optional — the helpers fall back to computing
 * fresh when the cache is missing.
 */
export interface HashCache {
  packageJson: Map<string, Promise<string>>
  taskConfig: WeakMap<TaskConfig, string>
}

export function createHashCache(): HashCache {
  return {
    packageJson: new Map(),
    taskConfig: new WeakMap(),
  }
}

export interface ComputeHashArgs {
  node: TaskNode
  upstream: TaskOutcome[]
  workspaceRoot: string
  workspaceFingerprint: string
  cache: CacheLayer
  forwardArgs?: readonly string[] | undefined
  nestedProjectDirs: string[]
  gitFilesCache?: Map<string, readonly string[]>
  hashCache?: HashCache
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
    ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
  })

  const upstreamHashes = filterUpstreamHashes(
    args.upstream,
    cacheCfg?.inputs?.tasks,
    args.node.projectName,
    args.node.id,
  )
  const taskConfigHash = hashTaskConfig(cfg, args.hashCache)
  const projectPackageJsonHash = await hashProjectPackageJson(
    args.node.projectDir,
    args.cache,
    args.hashCache,
  )

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

/**
 * Hash the resolved task config. Folds every config-time decision
 * (command, env names, dependsOn, cache directives, outputs,
 * passThroughEnv list, etc.) into the cache key. Imported values
 * participate because the loader has already baked them into the
 * resolved object before we serialize.
 *
 * The schema is JSON-serializable by construction (no functions in
 * fields). The `hashCache.taskConfig` WeakMap is consulted first —
 * each task's config object is created once per run, so a hit there
 * skips the JSON.stringify + xxh3 entirely.
 */
function hashTaskConfig(cfg: TaskConfig, hashCache?: HashCache): string {
  if (hashCache) {
    const cached = hashCache.taskConfig.get(cfg)
    if (cached !== undefined) return cached
    const hash = xxh3hex(JSON.stringify(cfg))
    hashCache.taskConfig.set(cfg, hash)
    return hash
  }
  return xxh3hex(JSON.stringify(cfg))
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
  return xxh3hex(`group|${ids}`)
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
 *
 * Two optimizations: routed through `Cache.hashFile` so the mtime+size
 * fast path applies (an unchanged pkg.json takes a stat + SQLite SELECT
 * instead of a full file read). And memoized within-run per projectDir
 * so a monorepo with 100 projects × 3 tasks each does 100 lookups, not
 * 300.
 */
async function hashProjectPackageJson(
  projectDir: string,
  cache: CacheLayer,
  hashCache?: HashCache,
): Promise<string> {
  const cached = hashCache?.packageJson.get(projectDir)
  if (cached !== undefined) return cached
  const promise = doHashProjectPackageJson(projectDir, cache)
  hashCache?.packageJson.set(projectDir, promise)
  return promise
}

async function doHashProjectPackageJson(projectDir: string, cache: CacheLayer): Promise<string> {
  const filePath = path.join(projectDir, 'package.json')
  if (!(await Bun.file(filePath).exists())) return ''
  // Route through the cache layer's mtime+size fast path so the
  // typical re-run sees a stat + SQLite lookup instead of a file read.
  return await cache.hashFile(filePath)
}
