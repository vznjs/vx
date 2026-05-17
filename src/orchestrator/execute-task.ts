import path from 'node:path'
import type { ExecConfig, TaskConfig, CacheConfig } from '../config.js'
import type { CacheLayer } from '../cache/cache.js'
import { cleanOutputs, resolveInputs, resolveOutputs } from '../cache/inputs.js'
import { buildIsolatedEnv } from '../exec/env.js'
import { runCommand, runPersistent } from '../exec/runner.js'
import type { TaskOutcome } from '../graph/scheduler.js'
import { isGroupTask, type TaskNode } from '../graph/task-graph.js'
import type { Logger } from './logger.js'
import type { Observer } from './observer.js'
import { xxh3hex } from '../util/hash.js'
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
  /**
   * Structural event sink. Wrapped via `makeSafeObserver` at the
   * orchestrator boundary so `emit` is always safe. Used here for the
   * `cacheProbe` event after the local + remote lookup resolves.
   */
  observer?: Observer
  nestedProjectDirs: string[]
  /** Anchor for hrtime spans across all tasks in this run. */
  runStartHrTimeNs: bigint
  /**
   * Registry the orchestrator owns. For each persistent task we
   * spawn, we stash the subprocess handle here so the orchestrator
   * can SIGTERM it once the rest of the graph finishes.
   */
  persistentRegistry?: Map<string, ReturnType<typeof Bun.spawn>>
  /** Per-run memo for `git ls-files` (one entry per project dir). */
  gitFilesCache?: Map<string, readonly string[] | null>
  /** Per-run memo for derived hashes (package.json bytes + task config). */
  hashCache?: HashCache
}

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
  gitFilesCache?: Map<string, readonly string[] | null>
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
 * Dispatch a single task to one of three execution paths. Each path
 * owns its own outcome shape; the dispatcher just picks based on the
 * task's config shape (group vs persistent vs cached). Sharing
 * helpers (`taskEnv`, `effectiveForwardArgs`) live below.
 */
export async function executeTask(args: ExecuteArgs): Promise<TaskOutcome> {
  if (isGroupTask(args.node)) return executeGroupTask(args)
  if (args.node.config.exec?.persistent !== undefined) return executePersistentTask(args)
  return executeCachedTask(args)
}

/**
 * Group task: no `exec`. The scheduler has already ensured every
 * dependency completed; we just return success with a hash rolled up
 * from upstream outcomes so downstream cache keys still cascade
 * through us.
 */
function executeGroupTask(args: ExecuteArgs): TaskOutcome {
  const wallclockNs = process.hrtime.bigint() - args.runStartHrTimeNs
  return {
    node: args.node,
    status: 'success',
    exitCode: 0,
    durationMs: 0,
    hash: computeGroupHash(args.upstream),
    wallclockStartNs: wallclockNs,
    wallclockEndNs: wallclockNs,
  }
}

/**
 * Persistent task: dev server / file watcher / daemon. Spawn, wait
 * for ready (regex match or immediate), stash the subprocess in the
 * orchestrator-owned registry, return success. The orchestrator
 * SIGTERMs the registry at end-of-run.
 *
 * Never reads or writes the cache — the project loader rejects
 * `cache + persistent` at config-load time, so by the time we get
 * here, `cache` is guaranteed undefined.
 */
async function executePersistentTask(args: ExecuteArgs): Promise<TaskOutcome> {
  const { node, log } = args
  // Type narrowing: the dispatcher checks `exec.persistent` before
  // calling us, so `exec` and `exec.persistent` are both present.
  const step = node.config.exec as ExecConfig & {
    persistent: NonNullable<ExecConfig['persistent']>
  }
  const effectiveForwardArgs = node.requested ? (args.forwardArgs ?? []) : []
  const env = taskEnv(node, step)
  const wallclockStartNs = process.hrtime.bigint() - args.runStartHrTimeNs

  // When readyWhen is set we leave the command untouched so the
  // regex matcher sees the unmodified output. When it's absent the
  // task is "ready on spawn" — we can safely append forwardArgs in
  // the same way runCommand does.
  const persistentOpts: Parameters<typeof runPersistent>[0] = {
    command:
      step.persistent.readyWhen !== undefined
        ? step.command
        : effectiveForwardArgs.length > 0
          ? step.command + ' ' + effectiveForwardArgs.map((s) => JSON.stringify(s)).join(' ')
          : step.command,
    cwd: node.projectDir,
    env,
    onStdout: (chunk) => log.taskStdout(node, chunk),
    onStderr: (chunk) => log.taskStderr(node, chunk),
  }
  if (step.persistent.readyWhen !== undefined) {
    persistentOpts.readyWhen = step.persistent.readyWhen
  }

  const spawn = runPersistent(persistentOpts)
  try {
    await spawn.ready
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      node,
      status: 'failed',
      exitCode: 1,
      durationMs: spawn.readyMs(),
      stdout: spawn.bufferedStdout(),
      stderr:
        spawn.bufferedStderr() + `\n[vx] persistent task failed to become ready: ${message}\n`,
      wallclockStartNs,
      wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
    }
  }

  args.persistentRegistry?.set(node.id, spawn.child)
  return {
    node,
    status: 'success',
    exitCode: 0,
    durationMs: spawn.readyMs(),
    stdout: spawn.bufferedStdout(),
    stderr: spawn.bufferedStderr(),
    wallclockStartNs,
    wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
  }
}

/**
 * Cached task: the common case. Hash inputs, try cache.get; on hit,
 * clean+restore+replay logs; on miss (or --no-cache), clean outputs,
 * spawn the command, save on success.
 */
async function executeCachedTask(args: ExecuteArgs): Promise<TaskOutcome> {
  const { node, upstream, cache, noCache, log } = args
  const cfg: TaskConfig = node.config
  const step = cfg.exec as ExecConfig // dispatcher guarantees exec is present
  const cacheCfg: CacheConfig | undefined = cfg.cache
  const cacheEnabled = cacheCfg !== undefined && !noCache

  const outputs = cacheCfg?.outputs.files ?? []
  const effectiveForwardArgs = node.requested ? (args.forwardArgs ?? []) : []

  // Prefer the hash precomputed in `prepareRun` (batched topo-walk).
  // Falls back to per-task computation only when a caller skips the
  // upfront pass (legacy entry points, focused tests).
  // Hash is computed mid-run, not at prepareRun time. Tasks whose
  // `cache.inputs.files` matches sibling outputs (e.g. `'**/*'` after
  // a `codegen` step has written `generated.txt`) need the upstream
  // outputs ALREADY on disk when their hash is computed — so we
  // can't lift this into prepareRun. Same model as Turbo / Nx.
  const hash = await computeTaskHash({
    node,
    upstream,
    workspaceRoot: args.workspaceRoot,
    workspaceFingerprint: args.workspaceFingerprint,
    cache,
    forwardArgs: args.forwardArgs,
    nestedProjectDirs: args.nestedProjectDirs,
    ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
    ...(args.hashCache !== undefined ? { hashCache: args.hashCache } : {}),
  })

  const cleanArgs = {
    projectDir: node.projectDir,
    outputs,
    nestedProjectDirs: args.nestedProjectDirs,
  }

  // Cache lookup. On hit, time the user-perceived restore op
  // (clean+restore+log-replay) — that's what the framed-block footer
  // shows, not the original exec time stored in the entry.
  if (cacheEnabled) {
    const cacheOpStart = performance.now()
    const hit = await cache.get(hash)
    args.observer?.emit({
      kind: 'cacheProbe',
      nodeId: node.id,
      status: hit ? (hit.source === 'remote' ? 'hit-remote' : 'hit-local') : 'miss',
    })
    if (hit) {
      // "Tree is already current" short-circuit — skip cleanOutputs
      // + restoreOutputs when the on-disk state matches what this
      // entry recorded at save time. Integrity-preserving: we
      // require BOTH that the output-glob walk yields exactly the
      // expected paths (no strays, no missing) AND that every file's
      // (size, mode, mtime) matches the stored fingerprint. Any
      // divergence falls through to a real clean + restore.
      //
      // The output-file fingerprints can't be batch-loaded at
      // prepareRun time — non-leaf task hashes depend on upstream
      // outputs that haven't been written yet, so hashes are
      // necessarily computed mid-run. We do one extra SELECT per
      // cache hit here. Still beats reading the manifest from the
      // tar (decompress + parse) at the same point.
      let skipRestore = false
      if (outputs.length > 0) {
        const expected = cache.loadOutputFilesBatch([hash]).get(hash) ?? []
        if (expected.length > 0) {
          const actualAbs = await resolveOutputs({
            projectDir: node.projectDir,
            outputs,
            nestedProjectDirs: args.nestedProjectDirs,
          })
          const expectedRels = new Set(expected.map((e) => e.path))
          const actualRels = actualAbs.map((p) =>
            path.relative(node.projectDir, p).split(path.sep).join('/'),
          )
          const setMatches =
            actualRels.length === expectedRels.size && actualRels.every((r) => expectedRels.has(r))
          if (setMatches) {
            skipRestore = await cache.isOutputsCurrent(node.projectDir, expected)
          }
        }
      }
      if (!skipRestore) {
        if (outputs.length > 0) await cleanOutputs(cleanArgs)
        await cache.restoreOutputs(hash, node.projectDir)
      }
      if (hit.stdout) log.taskStdout(node, hit.stdout)
      if (hit.stderr) log.taskStderr(node, hit.stderr)
      const status =
        hit.exitCode !== 0 ? 'failed' : hit.source === 'remote' ? 'cache-hit-remote' : 'cache-hit'
      // `restored` distinguishes "we just wrote files to disk" from
      // "disk already matched the cached snapshot". Drives the
      // "up-to-date" vs "local-cache" / "remote-cache" label in the
      // framed block. Only meaningful when at least one output was
      // declared — no-outputs tasks never materialize anything, so
      // they're vacuously up-to-date.
      const restored = !skipRestore && outputs.length > 0
      return {
        node,
        status,
        exitCode: hit.exitCode,
        durationMs: Math.round(performance.now() - cacheOpStart),
        hash,
        restored,
      }
    }
  } else {
    args.observer?.emit({ kind: 'cacheProbe', nodeId: node.id, status: 'no-cache' })
  }

  // Cache miss path (or caching disabled). Clean declared outputs
  // before exec so a stale prior-build artifact can't survive into a
  // fresh run.
  if (cacheEnabled && outputs.length > 0) await cleanOutputs(cleanArgs)

  const env = taskEnv(node, step)
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
 * Build the child-process env for one task. Same arguments at every
 * call site (persistent + cached); the project's own
 * `node_modules/.bin` is prepended to PATH — never the workspace
 * root's, never sibling projects' (per the project-isolation rule).
 */
function taskEnv(node: TaskNode, step: ExecConfig): NodeJS.ProcessEnv {
  return buildIsolatedEnv({
    passThrough: step.env?.passThrough ?? [],
    define: step.env?.define ?? {},
    source: process.env,
    binPaths: [path.join(node.projectDir, 'node_modules', '.bin')],
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
