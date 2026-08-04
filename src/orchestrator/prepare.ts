// Shared setup for `run()` and `planRun()`. Both entry points perform
// the same workspace-discovery → config-load → graph-build → cache-
// open sequence; this module centralises it so the two callers stay
// thin.
//
// The caller owns the returned `cache.close()` lifetime: `run()`
// closes at the bottom of execution, `planRun()` does so via
// try/finally around its plan() call.

import path from 'node:path'
import type { ProjectConfig, WorkspaceConfig } from '../config.js'
import { UserError } from '../util/index.js'
import {
  Cache,
  type CacheLayer,
  type CachePolicy,
  FULL_CACHE_POLICY,
  GitFilesCache,
  LayeredCache,
  populateGitFilesCache,
} from '../cache/index.js'
import {
  buildPackageGraph,
  computeNestedProjectDirs,
  computeWorkspaceFingerprint,
  findWorkspaceRoot,
  frozenProjectConfig,
  listProjects,
  loadProjectConfig,
  loadWorkspace,
  loadWorkspaceConfig,
  readLockfile,
  resolveCacheDir,
  type ProjectEntry,
} from '../workspace/index.js'
import {
  buildTaskGraph,
  expandRequested,
  parseDependencySpec,
  type TaskNode,
  unresolvedRequests,
} from '../graph/index.js'
import { resolveCache } from './plugin-host.js'
import type { VxPlugin } from './plugin.js'
import { createHashCache, type HashCache } from './task-hash.js'
import type { Logger } from './logger.js'
import type { RunOptions } from './options.js'
import { type HistoryTable, LocalHistoryProvider } from './history.js'
import { computePredictedPriorities } from './predict.js'

export interface PreparedRun {
  workspaceRoot: string
  workspaceConfig: WorkspaceConfig | null
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
   * would be saved still cleans its outputs before executing and (under
   * `--verify`) restores an artifact that was never written.
   */
  hasRemoteLayer: boolean
  /**
   * Predicted priorities (history-aware critical-path). Populated only
   * when the workspace opts in via `defineWorkspace({ predictive: true })`.
   * Empty map otherwise — scheduler falls back to its baseline.
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

/** Project names named by a `pkg#task` dependsOn entry anywhere in `config`. */
function crossDepProjects(config: ProjectConfig): string[] {
  const out: string[] = []
  for (const task of Object.values(config.tasks ?? {})) {
    for (const raw of task.dependsOn ?? []) {
      // A malformed spec is the graph builder's error to report — it names
      // the offending task. Here it just contributes no project.
      if (!raw.includes('#')) continue
      try {
        const spec = parseDependencySpec(raw)
        if (spec.kind === 'cross') out.push(spec.project)
      } catch {
        continue
      }
    }
  }
  return out
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
  const workspaceRoot = await findWorkspaceRoot(options.cwd)
  const workspace = await loadWorkspace(workspaceRoot)
  const workspaceConfig = await loadWorkspaceConfig(workspaceRoot)
  const projectMetas = await listProjects(workspace)

  // SCOPED config loading: configs are programs, and evaluating 1090
  // of them costs ~200 ms — the dominant fixed cost of small runs.
  // Only the in-scope projects, their transitive dependency closure
  // (which bounds '^task' frontier expansion) and any project named by
  // a `pkg#task` dependsOn entry can contribute graph nodes, so only
  // those configs are evaluated. Side effect, deliberate and
  // Turbo-like: a broken config in an unrelated package no longer
  // fails a scoped run — it surfaces when that package enters scope.
  const packageGraph = buildPackageGraph(projectMetas)
  const projectsWithConfigs = projectMetas.filter(
    (m): m is typeof m & { configPath: string } =>
      typeof m.configPath === 'string' && m.configPath.length > 0,
  )
  const haveConfig = new Set(projectsWithConfigs.map((m) => m.name))

  // Seeds: explicit scope, plus anchored pkg#task targets (which
  // bypass scope by design). With no explicit scope, bare task names
  // fan out across the whole workspace — but when EVERY spec is
  // anchored, the anchors alone are the scope and nothing else needs
  // its config evaluated.
  const anchored: string[] = []
  let hasBare = false
  for (const spec of options.tasks) {
    const hashIdx = spec.indexOf('#')
    if (hashIdx > 0) anchored.push(spec.slice(0, hashIdx))
    else hasBare = true
  }
  const seeds = new Set<string>(
    options.projects
      ? options.projects.filter((p) => haveConfig.has(p))
      : hasBare
        ? haveConfig
        : [],
  )
  for (const project of anchored) {
    if (haveConfig.has(project)) seeds.add(project)
  }
  type ConfigMeta = (typeof projectsWithConfigs)[number]
  const metaByName = new Map<string, ConfigMeta>(projectsWithConfigs.map((m) => [m.name, m]))
  const needed = new Set<string>()
  const pending: ConfigMeta[] = []
  const consider = (name: string): void => {
    if (needed.has(name)) return
    needed.add(name)
    const meta = metaByName.get(name)
    if (meta) pending.push(meta)
  }
  const considerWithDeps = (name: string): void => {
    consider(name)
    for (const dep of packageGraph.transitiveDeps(name)) consider(dep)
  }
  for (const seed of seeds) considerWithDeps(seed)

  // Frozen mode (--frozen, CI): configs load FROM vx-lock.json after a
  // content-hash tripwire — no evaluation; env-dependent configs keep
  // their locked values. Default (local) runs ALWAYS evaluate live:
  // a byte hash can't see a config's import closure (shared presets),
  // so consuming the lock by default would silently serve stale
  // freezes. `vx lock --check` is the full re-evaluation audit.
  // See docs/design/config-lock-2026-06.md.
  const lock = options.frozen === true ? await readLockfile(workspaceRoot) : null
  if (options.frozen === true && lock === null) {
    throw new UserError(
      `--frozen requires vx-lock.json at the workspace root — run 'vx lock' and commit it`,
    )
  }

  // Load in rounds to a fixpoint. A `pkg#task` dependsOn entry names a
  // project the PACKAGE graph cannot reach (the cross form ignores npm
  // deps by design), so its config has to be pulled in — and that config
  // may declare cross edges of its own. The common case (no cross deps)
  // is a single round, identical to loading the closure in one batch.
  const projects = new Map<string, ProjectEntry>()
  while (pending.length > 0) {
    const round = pending.splice(0, pending.length)
    const configs = await Promise.all(
      round.map((m) =>
        lock ? frozenProjectConfig(lock, m, workspaceRoot) : loadProjectConfig(m.configPath),
      ),
    )
    for (let i = 0; i < round.length; i++) {
      const meta = round[i]!
      const config = configs[i] as ProjectConfig
      projects.set(meta.name, { name: meta.name, dir: meta.dir, config })
      for (const name of crossDepProjects(config)) considerWithDeps(name)
    }
  }

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

  const policy: CachePolicy = options.cache ?? FULL_CACHE_POLICY
  // `--cache-dir <path>` (RunOptions.cacheDir) overrides the workspace
  // `cacheDir` field + the `.vx/cache` default; resolved relative to cwd.
  const cacheDir = options.cacheDir
    ? path.resolve(options.cwd, options.cacheDir)
    : resolveCacheDir(workspaceRoot, workspaceConfig)
  const localCache = new Cache(cacheDir, { read: policy.localRead, write: policy.localWrite })
  // Cache seam precedence: an EXPLICITLY injected remote layer
  // (RunOptions.remoteCache — a distribution agent or serve that already
  // holds a wire client) wins outright; else a plugin's `cache` capability;
  // else the local cache alone. Core ships no wire client — the remote
  // cache is a plugin concern (native-cache-wire-2026-07). Injection
  // winning prevents double-wrapping when the workspace also declares a
  // cache plugin.
  const plugins = (workspaceConfig?.plugins ?? []) as readonly VxPlugin[]
  const cache = options.remoteCache
    ? new LayeredCache(localCache, options.remoteCache, {
        policy,
        onRemoteError: (err) => log.status(`[vx] remote cache: ${err.message}`),
      })
    : await resolveCache(
        plugins,
        { workspaceRoot, cacheDir, warn: (m) => log.status(m), localCache, policy },
        () => localCache,
      )
  // Ask the LAYER, don't infer. Identity against `localCache` answers a
  // DIFFERENT question — "did the plugin hand back something other than the
  // handle I passed in?" — which an ordinary pass-through decorator (a
  // metrics wrapper, a cache-dir redirect) with no remote at all answers
  // yes to, skipping the remote-axis clamp below. `hasRemote` is the
  // layer's own truthful answer; `LayeredCache` sets it, a bare `Cache`
  // doesn't, and a third-party layer opts in when it really has a remote.
  const hasRemoteLayer = cache.hasRemote === true
  const workspaceFingerprint = await computeWorkspaceFingerprint(workspaceRoot)

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
  await populateGitFilesCache(
    workspaceRoot,
    [...projects.values()].map((p) => p.dir),
    gitFilesCache,
    usesWorkspaceInputs,
  )
  const hashCache = createHashCache()

  // Empty-cases bookkeeping. We still construct the cache + fingerprint
  // so the caller's try/finally pattern can close it uniformly.
  if (requested.length === 0) {
    return {
      workspaceRoot,
      workspaceConfig,
      cacheDir,
      cache,
      localCache,
      hasRemoteLayer,
      priorities: new Map(),
      nodes: new Map(),
      unresolvedTasks,
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

  // Predictive scheduling (architecture-review §8.4 / Phase 4): when
  // the workspace opts in via `predictive: true`, load history for
  // every node in the graph + compute expected-critical-path weights.
  // The scheduler applies them on top of the static baseline. Failing
  // open: any error in history loading degrades to baseline-only,
  // never to a broken run.
  let priorities: ReadonlyMap<string, number> = new Map()
  if (workspaceConfig?.predictive === true) {
    const history = new LocalHistoryProvider(localCache.dbHandle())
    try {
      const ids = [...nodes.keys()]
      const table: HistoryTable = await history.loadFor(ids)
      priorities = computePredictedPriorities([...nodes.values()], table)
    } catch (err) {
      log.status(
        `[vx] predictive scheduling fell back to baseline: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return {
    workspaceRoot,
    workspaceConfig,
    cacheDir,
    cache,
    localCache,
    hasRemoteLayer,
    priorities,
    nodes,
    unresolvedTasks,
    workspaceFingerprint,
    nestedDirsByProject,
    gitFilesCache,
    hashCache,
    workspaceProjectCount: projectMetas.length,
    empty: nodes.size === 0 ? 'empty-graph' : null,
  }
}
