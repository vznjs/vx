import path from 'node:path'
import type { TaskConfig, CacheConfig } from '../config.js'
import {
  type CacheKeyInput,
  type CacheLayer,
  resolveInputs,
  type GitFilesCache,
} from '../cache/index.js'
import type { InputFile, TaskInputs } from '../exec/index.js'
import type { TaskNode, TaskOutcome } from '../graph/index.js'
import { relPosix, xxh3hex } from '../util/index.js'
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
  runtime: Map<string, Promise<string>>
  workspaceRuntime: Map<string, Promise<string>>
}

export function createHashCache(): HashCache {
  return {
    packageJson: new Map(),
    taskConfig: new WeakMap(),
    runtime: new Map(),
    workspaceRuntime: new Map(),
  }
}

/**
 * One cache-key component captured at hash time. On a cache MISS the
 * orchestrator persists these to `entry_inputs` (keyed by the entry
 * hash, inside the save transaction) so a later run can diff its inputs
 * against this one (the Tier-3 "why did this re-run?" moat). A cache
 * HIT never saves, so it captures nothing — the warm path is free.
 * Mirrors `Cache.key()`'s fold-site rows one-for-one.
 */
export interface TaskInputComponent {
  kind: string
  name: string
  hash: string
}

export interface ComputeHashArgs {
  node: TaskNode
  upstream: TaskOutcome[]
  workspaceRoot: string
  workspaceFingerprint: string
  cache: CacheLayer
  forwardArgs?: readonly string[] | undefined
  nestedProjectDirs: string[]
  gitFilesCache?: GitFilesCache
  hashCache?: HashCache
  /**
   * When provided, the resolved `CacheKeyInput` components are pushed
   * here (one per key contribution) so the caller can persist them.
   * No effect on the returned hash — pure capture of values `key()`
   * already folds. The push happens inside `cache.key()` at each fold
   * site, so the recorded set can't drift from the key.
   */
  captureInto?: TaskInputComponent[]
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
  return await args.cache.key(await resolveKeyInput(args))
}

/**
 * The key AND the structured input set behind it, for the executor seam.
 * Miss path only: it re-runs the (memoized) resolution `computeTaskHash`
 * did for the probe and retains the VALUES the key folded — env, runtime
 * output, per-file digests — which `captureInto` deliberately reduces to
 * digests because its rows are persisted. Per-file digests come from the
 * same sources as the fold: the index-OID map for clean tracked files,
 * else `hashFile`'s stat memo (already warm after `key()`).
 */
export async function describeTaskInputs(
  args: ComputeHashArgs,
): Promise<{ hash: string; inputs: TaskInputs }> {
  const input = await resolveKeyInput(args)
  const hash = await args.cache.key(input)
  const sorted = [...input.inputFiles].sort()
  const digests = await Promise.all(
    sorted.map((f) => input.fileHashes?.get(f) ?? args.cache.hashFile(f)),
  )
  const files: InputFile[] = sorted.map((f, i) => ({
    path: relPosix(input.workspaceRoot, f),
    digest: digests[i]!,
  }))
  const upstreamHashes = [...input.upstreamHashes].sort()
  return {
    hash,
    inputs: {
      files,
      env: input.envValues.map(([name, value]) => ({ name, value })),
      runtime: (input.runtimeValues ?? []).map(([command, output]) => ({ command, output })),
      workspaceRuntime: (input.workspaceRuntimeValues ?? []).map(([command, output]) => ({
        command,
        output,
      })),
      upstream: upstreamHashes.map((h) => ({ taskId: input.upstreamIds?.get(h) ?? h, hash: h })),
      packageJsonDigest: input.projectPackageJsonHash,
      configDigest: input.taskConfigHash,
      workspaceFingerprint: input.workspaceFingerprint,
    },
  }
}

async function resolveKeyInput(args: ComputeHashArgs): Promise<CacheKeyInput> {
  const cfg = args.node.config
  const cacheCfg: CacheConfig | undefined = cfg.cache
  const outputs = cacheCfg?.outputs.files ?? []

  const resolved = await resolveInputs({
    projectDir: args.node.projectDir,
    workspaceRoot: args.workspaceRoot,
    envSource: process.env,
    inputs: cacheCfg?.inputs,
    ownOutputs: outputs,
    ownWorkspaceOutputs: cacheCfg?.outputs.workspaceFiles ?? [],
    nestedProjectDirs: args.nestedProjectDirs,
    ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
    ...(args.hashCache !== undefined
      ? {
          runtimeCache: args.hashCache.runtime,
          workspaceRuntimeCache: args.hashCache.workspaceRuntime,
        }
      : {}),
  })

  const upstreamPairs = filterUpstreamHashes(
    args.upstream,
    cacheCfg?.inputs?.tasks,
    args.node.projectName,
    args.node.id,
  )
  const upstreamHashes = upstreamPairs.map(([, hash]) => hash)
  // hash → upstream task id, for capture-row naming only (not folded).
  const upstreamIds = new Map(upstreamPairs.map(([id, hash]) => [hash, id]))
  // Trusted index-OID map for this project (populated by the run's
  // bulk `git ls-files -s` + `git status` pass). Mapped files skip
  // hashFile entirely; everything else falls back to the identical
  // in-process blob-OID computation. Tasks declaring workspaceFiles
  // also merge the workspace-wide partition's OIDs (keyed by abs
  // path, so the two maps agree wherever they overlap).
  let fileHashes = args.gitFilesCache?.oidsFor(args.node.projectDir)
  if ((cacheCfg?.inputs.workspaceFiles?.length ?? 0) > 0) {
    const wsOids = args.gitFilesCache?.oidsFor(args.workspaceRoot)
    if (wsOids !== undefined && wsOids !== fileHashes) {
      fileHashes = fileHashes === undefined ? wsOids : new Map([...wsOids, ...fileHashes])
    }
  }
  const taskConfigHash = hashTaskConfig(cfg, args.hashCache)
  const projectPackageJsonHash = await hashProjectPackageJson(
    args.node.projectDir,
    args.cache,
    args.hashCache,
    fileHashes,
  )

  const effectiveForwardArgs = args.node.requested ? (args.forwardArgs ?? []) : []

  return {
    taskId: args.node.id,
    taskConfigHash,
    projectPackageJsonHash,
    envValues: resolved.envValues,
    runtimeValues: resolved.runtimeValues,
    workspaceRuntimeValues: resolved.workspaceRuntimeValues,
    inputFiles: resolved.files,
    workspaceRoot: args.workspaceRoot,
    upstreamHashes,
    upstreamIds,
    workspaceFingerprint: args.workspaceFingerprint,
    forwardArgs: effectiveForwardArgs,
    ...(fileHashes !== undefined ? { fileHashes } : {}),
    ...(args.captureInto !== undefined ? { captureInto: args.captureInto } : {}),
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
 * fields). The `hashCache.taskConfig` WeakMap is consulted first —
 * each task's config object is created once per run, so a hit there
 * skips the JSON.stringify + xxh3 entirely.
 */
function hashTaskConfig(cfg: TaskConfig, hashCache?: HashCache): string {
  if (hashCache) {
    const cached = hashCache.taskConfig.get(cfg)
    if (cached !== undefined) return cached
    const hash = xxh3hex(JSON.stringify(hashableConfig(cfg)))
    hashCache.taskConfig.set(cfg, hash)
    return hash
  }
  return xxh3hex(JSON.stringify(hashableConfig(cfg)))
}

/**
 * Project the config for hashing: `exec.resources` is a pure scheduling
 * hint with zero effect on outputs, so it's stripped — tuning a
 * reservation never busts a cache. A config that declares none takes the
 * fast path and stringifies byte-identically to before the field existed
 * (why this needs no CACHE_VERSION bump). `timeout`/`retries` stay folded
 * — their keys are distinct by design (see the decision log); stripping
 * them retroactively would bump CACHE_VERSION.
 */
function hashableConfig(cfg: TaskConfig): unknown {
  if (cfg.exec?.resources === undefined) return cfg
  const { resources: _resources, ...execRest } = cfg.exec
  return { ...cfg, exec: execRest }
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
  fileHashes?: ReadonlyMap<string, string>,
): Promise<string> {
  const cached = hashCache?.packageJson.get(projectDir)
  if (cached !== undefined) return cached
  const promise = doHashProjectPackageJson(projectDir, cache, fileHashes)
  hashCache?.packageJson.set(projectDir, promise)
  return promise
}

async function doHashProjectPackageJson(
  projectDir: string,
  cache: CacheLayer,
  fileHashes?: ReadonlyMap<string, string>,
): Promise<string> {
  const filePath = path.join(projectDir, 'package.json')
  // Clean tracked package.json: its index OID is already in hand —
  // no exists probe, no stat, no SQLite.
  const oid = fileHashes?.get(filePath)
  if (oid !== undefined) return oid
  if (!(await Bun.file(filePath).exists())) return ''
  // Route through the cache layer's mtime+size fast path so the
  // typical re-run sees a stat + SQLite lookup instead of a file read.
  return await cache.hashFile(filePath)
}
