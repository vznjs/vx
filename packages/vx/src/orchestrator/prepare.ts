// Shared setup for `run()` and `planRun()`. Both entry points perform
// the same workspace-discovery → config-load → graph-build → cache-
// open sequence; this module centralises it so the two callers stay
// thin.
//
// The caller owns the returned `cache.close()` lifetime: `run()`
// closes at the bottom of execution, `planRun()` does so via
// try/finally around its plan() call.

import path from 'node:path'
import type { WorkspaceConfig } from '../config.js'
import { mark, UserError } from '../util/index.js'
import {
  Cache,
  noteSchemaReset,
  type CacheLayer,
  type CachePolicy,
  FULL_CACHE_POLICY,
  GitFilesCache,
  LayeredCache,
  applyGitEnumeration,
  gitPathspecs,
  startGitEnumeration,
  type GitEnumeration,
} from '../cache/index.js'
import {
  buildPackageGraph,
  computeNestedProjectDirs,
  computeWorkspaceFingerprints,
  findWorkspaceRoot,
  listProjects,
  loadWorkspace,
  FROZEN_WITHOUT_LOCK,
  readLockfile,
  resolveCacheDir,
  type ProjectEntry,
} from '../workspace/index.js'
import {
  buildTaskGraph,
  expandRequested,
  type TaskNode,
  unresolvedRequests,
} from '../graph/index.js'
import {
  applyGraphHooks,
  applyKeyHooks,
  applyScheduleHooks,
  fingerprintClaims,
  hasHook,
  resolveCache,
} from './plugin-host.js'
import { loadProjects, loadWorkspacePlugins, type LoadedProjects } from './projects.js'
import type { VxPlugin } from './plugin.js'
import { createHashCache, type HashCache } from './task-hash.js'
import type { Logger } from './logger.js'
import type { RunOptions } from './options.js'

export interface PreparedRun {
  workspaceRoot: string
  workspaceConfig: WorkspaceConfig | null
  /** The workspace's declared plugins, in declaration order. Nothing is added. */
  plugins: readonly VxPlugin[]
  cacheDir: string
  cache: CacheLayer
  /**
   * The local Cache handle (unwrapped). `cache` may be a LayeredCache
   * wrapping this; subsystems that need the raw SQLite (e.g.
   * LocalHistoryProvider) read directly from here.
   */
  localCache: Cache
  /**
   * True when `cache` is something other than the bare local handle — an
   * injected remote layer, or one a plugin's `cache` capability built. The
   * remote axes of the policy only mean anything then: without a remote
   * layer a `remote:w` policy writes NOWHERE, so a task that believed it
   * would be saved still cleans its outputs before executing.
   */
  hasRemoteLayer: boolean
  /**
   * Scheduling priorities from plugins' `schedule` stage (task id → weight,
   * merged over the structural baseline by the scheduler). Empty when no
   * plugin declares the stage.
   */
  priorities: ReadonlyMap<string, number>
  nodes: Map<string, TaskNode>
  /**
   * Requested task specs that matched NO project — a typo, or a stray
   * positional (the value of an `=`-only flag written with a space).
   * Nothing they asked for is in `nodes`, so callers must fail rather
   * than run the remainder silently.
   */
  unresolvedTasks: readonly string[]
  /** Every discovered project — the declared task names a typo is measured against. */
  projects: ReadonlyMap<string, ProjectEntry>
  /**
   * True iff at least one package in the workspace has a `vx.config.*` at
   * all — regardless of scope, so a `--filter` that matched nothing is not
   * mistaken for a workspace vx was never set up in.
   */
  anyProjectConfig: boolean
  workspaceFingerprint: string
  nestedDirsByProject: Map<string, string[]>
  /**
   * Per-run memo for `git ls-files` output, keyed by project dir.
   * Without this, every task in a project re-spawns git just to
   * enumerate its input file set (3× per project for build / test /
   * lint, etc.) — observable in cache-hit run times.
   */
  gitFilesCache: GitFilesCache
  /** Every project discovery found, in or out of scope — header scope bar. */
  workspaceProjectCount: number
  /**
   * Per-run memo for derived hashes — project package.json bytes
   * keyed by projectDir, task-config hash keyed by config object
   * identity. Shared across every task's `computeTaskHash` call so
   * the same project's package.json (and the same task config
   * object) aren't re-hashed on every task in that project.
   */
  hashCache: HashCache
  /**
   * Reason `nodes` is empty. `null` when the prepared run is ready to
   * execute. Either:
   *   - `'no-tasks-declared'` — `requested.length === 0` after the
   *     user's task names were resolved against `projects`. Typically
   *     a typo'd task name; `run()` treats this as a CI footgun and
   *     returns NOT-ok.
   *   - `'empty-graph'`       — `requested` was non-empty but the
   *     graph builder still produced no nodes. Defensive; unreachable
   *     under current `buildTaskGraph` semantics.
   */
  empty: null | 'no-tasks-declared' | 'empty-graph'
}

/**
 * Build the prepared-run context: workspace discovery, project-config
 * load, package + task graph, cache handle (local, optionally wrapped
 * in a remote layer). Caller owns `cache.close()`.
 *
 * Returns even when nothing can run — the `empty` field tells the
 * caller why. We never throw on "no tasks"; behavior on that case is
 * caller-specific (run logs + returns NOT-ok; planRun returns an
 * empty plan).
 */
export async function prepareRun(options: RunOptions, log: Logger): Promise<PreparedRun> {
  mark('startup')
  const workspaceRoot = await findWorkspaceRoot(options.cwd)
  // An UNSCOPED run (no explicit scope, at least one bare task name)
  // enumerates the whole tree whatever the configs say, so git starts
  // HERE — the walk needs only the root — and overlaps the workspace
  // config, discovery, the cache open and the config evaluation. Its
  // ~60 ms is the warm run's wall floor on a 1000-project tree; it used to
  // start after discovery and the cache open, ~25 ms later. A scoped run
  // waits: its pathspecs depend on which projects the configs pull in.
  const unscoped =
    options.projects === undefined && options.tasks.some((spec) => spec.indexOf('#') <= 0)
  const earlyGit: Promise<GitEnumeration> | undefined = unscoped
    ? startGitEnumeration(workspaceRoot, ['.'])
    : undefined
  // A broken config below throws before this is awaited; the detached
  // handler keeps that from surfacing as an unhandled rejection (the real
  // await further down still sees the error).
  earlyGit?.catch(() => {})
  const workspace = await loadWorkspace(workspaceRoot)
  const { workspaceConfig, plugins } = await loadWorkspacePlugins(workspaceRoot, (m) =>
    log.status(m),
  )
  mark('workspace config')
  const projectMetas = await listProjects(workspace)
  mark('discover projects')

  // SCOPED config loading: configs are programs, and evaluating 1090
  // of them costs ~200 ms — the dominant fixed cost of small runs.
  // Only the in-scope projects, their transitive dependency closure
  // (which bounds '^task' frontier expansion) and any project named by
  // a `pkg#task` dependsOn entry can contribute graph nodes, so only
  // those configs are evaluated. Side effect, deliberate and
  // Turbo-like: a broken config in an unrelated package no longer
  // fails a scoped run — it surfaces when that package enters scope.
  const packageGraph = buildPackageGraph(projectMetas)
  // Seeds: explicit scope, plus anchored pkg#task targets (which bypass
  // scope by design). With no explicit scope, bare task names fan out
  // across the whole workspace — but when EVERY spec is anchored, the
  // anchors alone are the scope and nothing else needs its config
  // evaluated.
  const anchored: string[] = []
  let hasBare = false
  for (const spec of options.tasks) {
    const hashIdx = spec.indexOf('#')
    if (hashIdx > 0) anchored.push(spec.slice(0, hashIdx))
    else hasBare = true
  }
  const seeds: 'all' | string[] =
    options.projects !== undefined ? [...options.projects, ...anchored] : hasBare ? 'all' : anchored

  // The local cache opens BEFORE the configs load: it is also where their
  // cached evaluations live. `--cache-dir <path>` (RunOptions.cacheDir)
  // overrides the workspace `cacheDir` field + the `.vx/cache` default;
  // resolved relative to cwd.
  const policy: CachePolicy = options.cache ?? FULL_CACHE_POLICY
  const cacheDir = options.cacheDir
    ? path.resolve(options.cwd, options.cacheDir)
    : resolveCacheDir(workspaceRoot, workspaceConfig)
  const localCache = new Cache(cacheDir, { read: policy.localRead, write: policy.localWrite })
  noteSchemaReset(localCache, (m) => log.status(m))
  // Two digests from one read: the config-evaluation cache keys on every
  // file (a config may import a dependency), the task keys on the files no
  // plugin claims (`VxPlugin.fingerprint`).
  const fingerprints = await computeWorkspaceFingerprints(
    workspaceRoot,
    new Set(fingerprintClaims(plugins).keys()),
  )
  const workspaceFingerprint = fingerprints.unclaimed
  mark('open cache')

  // Frozen mode (--frozen, CI): configs load FROM vx-lock.json after a
  // content-hash tripwire — no evaluation; env-dependent configs keep
  // their locked values. Default (local) runs ALWAYS evaluate live:
  // a byte hash can't see a config's import closure (shared presets),
  // so consuming the lock by default would silently serve stale
  // freezes. `vx lock --check` is the full re-evaluation audit.
  // See docs/design/config-lock-2026-06.md.
  const lock = options.frozen === true ? await readLockfile(workspaceRoot) : null
  if (options.frozen === true && lock === null) {
    throw new UserError(FROZEN_WITHOUT_LOCK)
  }

  let loaded: LoadedProjects
  try {
    loaded = await loadProjects({
      workspaceRoot,
      cacheDir,
      plugins,
      projectMetas,
      packageGraph,
      seeds,
      closure: true,
      lock,
      evalCache: { store: localCache, workspaceFingerprint: fingerprints.all },
      warn: (m) => log.status(m),
    })
  } catch (err) {
    // The cache opened before the configs loaded (it holds their cached
    // evaluations); a config error must not leak the handle.
    localCache.close()
    throw err
  }
  const { projects, configured: projectsWithConfigs } = loaded
  mark('load configs')

  // Boundary geometry considers every config-bearing project in the
  // workspace, loaded or not — an out-of-scope nested project must
  // still fence its files off from its parent's globs.
  const nestedDirsByProject = computeNestedProjectDirs(
    projectsWithConfigs.map((m) => ({ name: m.name, dir: m.dir })),
  )

  const candidateProjects = options.projects
    ? options.projects.filter((p) => projects.has(p))
    : [...projects.keys()]

  const requested = expandRequested(options.tasks, candidateProjects, projects)
  const unresolvedTasks = unresolvedRequests(options.tasks, candidateProjects, projects)

  // Cache seam precedence: an EXPLICITLY injected remote layer
  // (RunOptions.remoteCache — a distribution agent or daemon that already
  // holds a wire client) wins outright; else a plugin's `cache` capability;
  // else the local cache alone. Core ships no wire client — the remote
  // cache is a plugin concern (docs/patterns.md § Remote cache wire). Injection
  // winning prevents double-wrapping when the workspace also declares a
  // cache plugin.
  let cache: CacheLayer
  try {
    cache = options.remoteCache
      ? new LayeredCache(localCache, options.remoteCache, {
          policy,
          onRemoteError: (err) => log.status(`[vx] remote cache: ${err.message}`),
        })
      : await resolveCache(plugins, {
          workspaceRoot,
          cacheDir,
          warn: (m) => log.status(m),
          localCache,
          policy,
        })
  } catch (err) {
    // A cache plugin that throws or returns something off-contract is
    // refused by name; the local handle opened above must not leak with it.
    localCache.close()
    throw err
  }
  // Ask the LAYER, don't infer. Identity against `localCache` answers a
  // DIFFERENT question — "did the plugin hand back something other than the
  // handle I passed in?" — which an ordinary pass-through decorator (a
  // metrics wrapper, a cache-dir redirect) with no remote at all answers
  // yes to, skipping the remote-axis clamp below. `hasRemote` is the
  // layer's own truthful answer; `LayeredCache` sets it, a bare `Cache`
  // doesn't, and a third-party layer opts in when it really has a remote.
  const hasRemoteLayer = cache.hasRemote === true

  const gitFilesCache = new GitFilesCache()
  // Bulk-populate via a single `git ls-files` at the workspace root —
  // partitions the output by project. Avoids one fork+exec per project
  // (~5-10ms each on Linux; the dominant cold-start cost on big
  // monorepos). When any loaded task declares inputs.workspaceFiles,
  // the enumeration must see every file from the root (no pathspec
  // scoping) and additionally stores a workspace-wide partition.
  const usesWorkspaceInputs = [...projects.values()].some((p) =>
    Object.values(p.config.tasks ?? {}).some(
      (t) => (t.cache?.inputs.workspaceFiles?.length ?? 0) > 0,
    ),
  )
  const projectDirs = [...projects.values()].map((p) => p.dir)
  const enumeration = await (earlyGit ??
    startGitEnumeration(
      workspaceRoot,
      gitPathspecs(workspaceRoot, projectDirs, usesWorkspaceInputs),
    ))
  applyGitEnumeration(enumeration, workspaceRoot, projectDirs, gitFilesCache, usesWorkspaceInputs)
  mark('git enumeration')
  const hashCache = createHashCache()

  // Empty-cases bookkeeping. We still construct the cache + fingerprint
  // so the caller's try/finally pattern can close it uniformly.
  if (requested.length === 0) {
    return {
      workspaceRoot,
      workspaceConfig,
      plugins,
      cacheDir,
      cache,
      localCache,
      hasRemoteLayer,
      priorities: new Map(),
      nodes: new Map(),
      unresolvedTasks,
      projects,
      anyProjectConfig: projectsWithConfigs.length > 0,
      workspaceFingerprint,
      nestedDirsByProject,
      gitFilesCache,
      hashCache,
      workspaceProjectCount: projectMetas.length,
      empty: 'no-tasks-declared',
    }
  }

  const nodes = buildTaskGraph({
    projects,
    packageGraph,
    requested,
    ...(options.excludeDependencies !== undefined
      ? { excludeDependencies: options.excludeDependencies }
      : {}),
  })
  // The graph is built; what follows is the plugins' (graph, key,
  // schedule). Two rows, so a plugin's key stage reads as its own cost
  // and not as graph building — a lockfile plugin's 1000 stats per run
  // hid inside one `prepare (graph)` row until 2026-09-10.
  mark('build graph')
  if (hasHook(plugins, 'graph')) {
    await applyGraphHooks(plugins, nodes, {
      workspaceRoot,
      cacheDir,
      warn: (m) => log.status(m),
      requested: [...nodes.values()].filter((n) => n.requested).map((n) => n.id),
    })
  }
  if (hasHook(plugins, 'key')) {
    await applyKeyHooks(plugins, nodes, { workspaceRoot, cacheDir, warn: (m) => log.status(m) })
  }
  let priorities: ReadonlyMap<string, number> = new Map()
  if (hasHook(plugins, 'schedule')) {
    priorities = await applyScheduleHooks(plugins, nodes, {
      workspaceRoot,
      cacheDir,
      warn: (m) => log.status(m),
      localCache,
    })
  }

  return {
    workspaceRoot,
    workspaceConfig,
    plugins,
    cacheDir,
    cache,
    localCache,
    hasRemoteLayer,
    priorities,
    nodes,
    unresolvedTasks,
    projects,
    anyProjectConfig: projectsWithConfigs.length > 0,
    workspaceFingerprint,
    nestedDirsByProject,
    gitFilesCache,
    hashCache,
    workspaceProjectCount: projectMetas.length,
    empty: nodes.size === 0 ? 'empty-graph' : null,
  }
}
