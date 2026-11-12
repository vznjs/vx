// Shared setup for `run()` and `planRun()`: discovery, config load, graph
// build, cache open. The caller owns `cache.close()`.

import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { InputStability, WorkspaceConfig } from '../config.js'
import {
  beginRun,
  mark,
  nearest,
  OWN_DIR_HINT,
  owedIfStranded,
  relPosix,
  restorableOutput,
  type SecretBroker,
  thrownMessage,
  UserError,
} from '../util/index.js'
import {
  indexDb,
  Cache,
  type CacheLayer,
  applyCacheFlags,
  type CachePolicy,
  FULL_CACHE_POLICY,
  parseCachePolicy,
  GitFilesCache,
  LayeredCache,
  absentPluginCache,
  pluginCache,
  putRunEntry,
  writesRunStore,
  type PluginCache,
  type ResolvedRemote,
  applyGitEnumeration,
  gitPathspecs,
  MAX_SCOPED_PATHSPECS,
  startGitEnumeration,
  checkBlobSizes,
  lazyGitEnumeration,
  DEFAULT_STORE,
} from '../cache/index.js'
import { measureFsClockLag } from '../memo/index.js'
import {
  buildPackageGraph,
  computeNestedProjectDirs,
  findProjectConfigs,
  findWorkspaceRoot,
  configuredBaseBranch,
  type LoadReads,
  lockDigest,
  PROJECT_CONFIG_FILENAMES,
  readClaimedFiles,
  readDependenciesLock,
  resolveCacheDir,
  resolveStoreRoot,
  type ProjectEntry,
} from '../workspace/index.js'
import {
  excludeDependencies,
  expandRequested,
  type GraphRules,
  isDefaultBuild,
  isGroupTask,
  markOutsideAdditions,
  refuseFiltersThroughGroups,
  type TaskNode,
  undeclaredDepsError,
  unresolvedRequests,
} from '../graph/index.js'
import {
  applyKeyHooks,
  applyScheduleHooks,
  fingerprintClaims,
  hasHook,
  resolveCache,
  teardownPlugins,
  type ScheduleRun,
} from './plugin-host.js'
import { lockedFiles } from './locked-digests.js'
import { withExtraHashes } from './lockfile-claim.js'
import {
  discoverProjects,
  extraHashesOfDiscovery,
  gitOfDiscovery,
  graphOfDiscovery,
  ignoredConfigRefusal,
  loadProjects,
  loadWorkspacePlugins,
  lockOfDiscovery,
  pluginsOfDiscovery,
  lockReader,
  type LoadedProjects,
  nestedWorkspacesOf,
} from './projects.js'
import { keptByAffected } from './affected-tasks.js'
import { applyGraphStage } from './graph-stage.js'
import { keyExcludedDependencies } from './excluded-keys.js'
import { FingerprintWatch } from './fingerprint-watch.js'
import type { VxPlugin } from './plugin.js'
import { graphCounts, memoGraph, type GraphMemo } from './graph-memo.js'
import { askIgnoredOutputs, gatedOutputs } from './stable-keys.js'
import { cacheRefs, currentBranch, resolveCacheScope } from './run-context.js'
import { createHashCache, type HashCache } from './task-hash.js'
import { type Logger, warnOf } from '../report/index.js'
import type { CoreRunOptions, RunOptions } from './options.js'
import { resolveSetting, runRules, settingEnv } from '../settings.js'

export interface PreparedRun {
  workspaceRoot: string
  workspaceConfig: WorkspaceConfig | null
  /** The workspace's declared plugins, in declaration order. Nothing is added. */
  plugins: readonly VxPlugin[]
  cacheDir: string
  cache: CacheLayer
  /**
   * The bare local Cache; `cache` may wrap it. Subsystems needing the raw
   * SQLite (history) read it here.
   */
  localCache: Cache
  /**
   * True when `cache` has a remote layer. Only then do the policy's remote axes
   * mean anything: a `remote:w` policy over a bare local cache writes nowhere.
   */
  hasRemoteLayer: boolean
  /** `--cache-policy` with the workspace's `cacheScope` applied: what the layers were built under. */
  cachePolicy: CachePolicy
  /** The scope this run's cache reads and writes, when one is set; named on the summary's `info` row. */
  cacheScope: string | undefined
  /** The run's remotes in declared order, as the policy gates each; `openRemotes` turns one off. */
  remotes: ResolvedRemote[]
  /** The refs the run reads, in order (`CacheContext.refs`). */
  cacheRefs: readonly string[]
  /**
   * Plugins' `schedule` weights (task id → weight), merged over the baseline by
   * the scheduler. Asked only by a run with a task to start: the stage reads
   * history (148 ms at 8,002 tasks) a nothing-changed run never needs. Runs
   * once; `run` times each plugin's call and hears its later `ctx.refine` sets.
   */
  priorities: (run?: ScheduleRun) => Promise<ReadonlyMap<string, number>>
  /**
   * The run's branch (`run.branch`, else git's, else the CI provider's):
   * what its history records and the timings a forecast reads first.
   * Learned on first ask, once per run.
   */
  branch: () => string | null
  /** Each plugin's `ctx.cache`: the run's local store and remotes, under its policy and scope. */
  cacheFor: (plugin: string) => PluginCache
  /**
   * Keep `bytes` of this run under `name` (run-store.ts); undefined when no
   * remote takes the run's writes, and so core keeps nothing.
   */
  keepRunEntry: ((name: string, bytes: Uint8Array) => Promise<boolean>) | undefined
  nodes: Map<string, TaskNode>
  /**
   * The tasks `--exclude-dependencies` took out of the schedule: keyed as a
   * full run keys them, never run. Empty without the flag.
   */
  keyOnly: ReadonlyMap<string, TaskNode>
  /**
   * Requested specs that matched no project (a typo, or a stray positional):
   * callers must fail rather than run the rest silently.
   */
  unresolvedTasks: readonly string[]
  /**
   * The bare names in `unresolvedTasks` a project outside a scoped run's
   * selection (the cwd's project, a `--filter`) declares: no typo, a scope.
   */
  declaredElsewhere: readonly string[]
  /** The loaded projects: the whole workspace, or a scoped run's closure. */
  projects: ReadonlyMap<string, ProjectEntry>
  /** What a typo is measured against: `projects`, or every project when a `pkg#task` named none loaded. */
  hintProjects: ReadonlyMap<string, ProjectEntry>
  /**
   * True if any package has a `vx.config.*`, whatever the scope, so a
   * `--filter` matching nothing is not taken for an unconfigured workspace.
   */
  anyProjectConfig: boolean
  /** A workspace project that declares no task: no config, and nothing configured reaches it. */
  taskless: (name: string) => boolean
  /**
   * With no config in the lock, one a directory holds anyway (root-relative):
   * written after `vx lock`, so the fix is `vx lock`. Asked only by a refusal.
   */
  unlockedConfig: () => string | undefined
  /** The claimed root files, and whether a task has since rewritten one (fingerprint-watch.ts). */
  fingerprintWatch: FingerprintWatch
  nestedDirsByProject: Map<string, string[]>
  /**
   * Per-run memo of `git ls-files` per project dir, or every task re-spawned
   * git to enumerate its inputs.
   */
  gitFilesCache: GitFilesCache
  /** Every project discovery found, in or out of scope — header scope bar. */
  workspaceProjectCount: number
  /**
   * Per-run memo of derived hashes (config hash by object identity, resolved
   * file lists), shared by every `computeTaskHash`.
   */
  hashCache: HashCache
  /**
   * Each task's downstream count, when nothing after the build edits `nodes`:
   * counted while git's blob-size check runs.
   */
  dependents?: ReadonlyMap<string, number>
  /**
   * Why `nodes` is empty; `null` when ready:
   * - `'no-tasks-declared'`: no requested name resolved, typically a typo;
   *   `run()` fails.
   * - `'none-affected'`: the scope came from a diff and every name is declared
   *   elsewhere, or the diff reaches no requested task's `dependsOn` closure: a
   *   clean outcome.
   * - `'empty-graph'`: defensive, unreachable today.
   */
  empty: null | 'no-tasks-declared' | 'none-affected' | 'empty-graph'
}

/**
 * Build the prepared run: discovery, config load, package and task graph, and
 * the cache handle (local, maybe layered). Caller owns `cache.close()`.
 *
 * Never throws on "no tasks": `empty` says why, and each caller decides.
 */
export async function prepareRun(options: RunOptions, log: Logger): Promise<PreparedRun> {
  return prepareRunLocked(options, log)
}

/**
 * `prepareRun`, with `beforeOpen` run once the root is known and before the
 * cache opens: a run takes its lock there, so it never holds the store while
 * waiting for a `vx cache clean` holding the lock. `countDependents`: a run's,
 * which schedules by them. `planning`: a `--dry` plan, which with no remote
 * opens the cache read-only and makes no directory, index, `.gitignore` or row.
 */
export async function prepareRunLocked(
  options: CoreRunOptions,
  log: Logger,
  beforeOpen?: (workspaceRoot: string, sharedCacheDir: string | undefined) => Promise<void>,
  countDependents = false,
  planning = false,
): Promise<PreparedRun> {
  beginRun()
  mark('startup')
  const ws = await startWorkspace(options, log, planning)
  const scope = scopeOf(options, ws)
  const store = await openStore(options, log, ws, beforeOpen, planning)
  const load = await loadScope(options, log, ws, scope, store.localCache)
  const asked = await judgeRequests(options, ws, scope, load)
  const layer = await openLayer(options, log, ws, store)
  const { workspaceRoot, workspaceConfig, plugins, cacheDir, projectMetas } = ws
  const { localCache, policy } = store
  const { cache } = layer
  // The plugins' factories have run and the cache is open: a throw here must
  // close and tear down both, or each failed `vx watch` cycle leaked them.
  // run() owns both only once this returns.
  const unowe = owedIfStranded(() => teardownPlugins(plugins, warnOf(log)))
  try {
    const hashCache = createHashCache(
      localCache.memo.folds,
      resolveSetting('outputs.clean', workspaceConfig).value as boolean | undefined,
      {
        run: settingEnv('inputs.stability.strategy') as InputStability['strategy'],
        workspace: workspaceConfig?.inputs?.stability?.strategy,
      },
    )
    const fingerprintWatch = new FingerprintWatch(
      workspaceRoot,
      store.claimed,
      store.claimedBytes,
      store.fingerprintsAt,
    )
    // What a run holds whether or not it has tasks: an empty run still
    // carries the cache and watch, so the caller closes them uniformly.
    const held = {
      workspaceRoot,
      workspaceConfig,
      plugins,
      cacheDir,
      cache,
      localCache,
      hasRemoteLayer: layer.hasRemoteLayer,
      cachePolicy: policy,
      cacheScope: ws.cacheScope,
      remotes: layer.remotes,
      cacheRefs: layer.refs,
      branch: ws.branch,
      unresolvedTasks: asked.unresolvedTasks,
      declaredElsewhere: asked.declaredElsewhere,
      projects: load.projects,
      hintProjects: asked.hintProjects,
      anyProjectConfig: load.projectsWithConfigs.length > 0,
      taskless: asked.taskless,
      unlockedConfig: () => unlockedConfigOf(load.projectsWithConfigs, projectMetas, workspaceRoot),
      fingerprintWatch,
      nestedDirsByProject: asked.nestedDirsByProject,
      hashCache,
      workspaceProjectCount: projectMetas.length,
    }
    const emptyRun = (reason?: 'none-affected'): PreparedRun => ({
      ...held,
      keepRunEntry: undefined,
      priorities: () => Promise.resolve(new Map()),
      cacheFor: () => absentPluginCache,
      nodes: new Map(),
      keyOnly: new Map(),
      gitFilesCache: new GitFilesCache(),
      empty:
        reason ??
        (options.handoff?.selectedByDiff === true && asked.unresolvedTasks.length === 0
          ? 'none-affected'
          : 'no-tasks-declared'),
    })
    if (asked.requested.length === 0) return emptyRun()

    const graph = await buildGraph(options, log, ws, scope, load, asked, hashCache, cache)
    if (graph === 'none-affected') return emptyRun('none-affected')
    const { nodes } = graph
    const git = await enumerateGit(options, ws, store, asked, graph, hashCache, countDependents)
    const keyOnly = await applyKeyStages(
      options,
      log,
      ws,
      store,
      load,
      asked,
      graph,
      git,
      hashCache,
      cache,
    )
    const access = pluginAccess(log, ws, store, layer, nodes)
    return {
      ...held,
      priorities: access.priorities,
      cacheFor: access.cacheFor,
      keepRunEntry: writesRunStore(layer.remotes)
        ? (name, bytes) => putRunEntry(layer.remotes, ws.cacheScope, name, bytes)
        : undefined,
      nodes,
      keyOnly,
      gitFilesCache: git.gitFilesCache,
      ...(git.dependents !== undefined ? { dependents: git.dependents } : {}),
      empty: nodes.size === 0 ? 'empty-graph' : null,
    }
  } catch (err) {
    await teardownPlugins(plugins, warnOf(log))
    cache.close()
    throw err
  } finally {
    unowe()
  }
}

/**
 * The workspace a run starts from: its root, its declared plugins, where
 * its cache lives, and its projects, with the lock read and git's walk
 * started as early as they can be.
 */
async function startWorkspace(options: CoreRunOptions, log: Logger, planning: boolean) {
  // A claimed root file is read once. A watch cycle is a new run and reads
  // them afresh.
  const reads: LoadReads = new Map()
  const workspaceRoot = await findWorkspaceRoot(options.cwd)
  // The lock is where a run's projects come from: its read (1.1 MB, ~10 ms at
  // 1,000 projects) starts here, overlapping the workspace config's evaluation.
  // A missing or malformed lock refuses at discovery.
  const reused =
    options.handoff?.discovered?.root === workspaceRoot ? options.handoff?.discovered : undefined
  const readLock =
    (reused !== undefined ? lockOfDiscovery(reused.projects) : undefined) ??
    lockReader(workspaceRoot)
  if (reused === undefined) void readLock().catch(() => {})
  // An unscoped run (bare task names, no scope) enumerates the whole tree
  // whatever the configs say, so git starts here, needing only the root, and
  // overlaps discovery, the cache open and config evaluation: its ~60 ms is a
  // warm 1,000-project run's floor. A scoped run waits for its pathspecs,
  // unless it already names more projects than pathspecs scope.
  const wholeTree =
    (options.projects === undefined || options.projects.length > MAX_SCOPED_PATHSPECS) &&
    options.tasks.some((spec) => spec.indexOf('#') <= 0)
  // A `discover` hook that reads the worktree (nx()'s graph key) starts the
  // whole-tree enumeration here; the run reuses it instead of walking twice.
  const git =
    (reused !== undefined ? gitOfDiscovery(reused.projects) : undefined) ??
    lazyGitEnumeration(workspaceRoot)
  if (wholeTree) void git.start()
  const {
    workspaceConfig,
    plugins,
    branch: branchFacts,
  } = (reused !== undefined ? pluginsOfDiscovery(reused.projects) : undefined) ??
  (await loadWorkspacePlugins(workspaceRoot, warnOf(log)))
  mark('workspace config')
  const baseBranch = configuredBaseBranch(workspaceConfig)
  const cacheScope =
    options.cacheScope ??
    resolveCacheScope(
      workspaceRoot,
      branchFacts.trusted === true ? null : branchFacts.scope,
      plugins.some((p) => p.cache !== undefined),
      baseBranch,
    )
  let learnedBranch: string | null | undefined
  const branch = (): string | null =>
    learnedBranch === undefined
      ? (learnedBranch = currentBranch(workspaceRoot, workspaceConfig, options.branch))
      : learnedBranch
  // `--cache-dir` overrides the workspace `cache.dir` and the `.vx/cache`
  // default, relative to cwd. A named dir holds everything; the default shares
  // entries through the user's store.
  const cacheDir = options.cacheDir
    ? path.resolve(options.cwd, options.cacheDir)
    : resolveCacheDir(workspaceRoot, workspaceConfig)
  // Before any racy window is judged: a file system behind this process's clock
  // dated a mid-command edit before the command (fs-clock.ts). A plan may make
  // no cache dir, so it measures in `.vx`.
  measureFsClockLag(planning ? path.join(workspaceRoot, '.vx') : cacheDir)
  // Asked now, read when the cache opens: a repository with no remote is
  // named by its root commit, a git spawn the discovery below overlaps.
  const storeRoot = options.cacheDir ? null : resolveStoreRoot(workspaceRoot, workspaceConfig)
  const discovering =
    reused !== undefined
      ? Promise.resolve(reused.projects)
      : discoverProjects(workspaceRoot, readLock, git)
  const projectMetas = await discovering
  mark('discover projects')
  return {
    reads,
    workspaceRoot,
    reused,
    readLock,
    git,
    workspaceConfig,
    plugins,
    branchFacts,
    baseBranch,
    cacheScope,
    branch,
    cacheDir,
    storeRoot,
    projectMetas,
  }
}
type Workspace = Awaited<ReturnType<typeof startWorkspace>>

/** The package graph and which projects' configs the run's task specs need. */
function scopeOf(options: CoreRunOptions, ws: Workspace) {
  const { reused, projectMetas } = ws
  // Scoped config loading: evaluating 1,090 configs costs ~200 ms, the dominant
  // fixed cost of small runs. Only in-scope projects, their dependency closure
  // (which bounds `^task`) and projects a `pkg#task` names can add nodes, so
  // only those are evaluated. Like Turbo, a broken config elsewhere fails a
  // scoped run only once it enters scope.
  const packageGraph =
    (reused !== undefined ? graphOfDiscovery(reused.projects) : undefined) ??
    buildPackageGraph(projectMetas)
  // Seeds: the explicit scope plus anchored `pkg#task` targets. With no scope,
  // bare names fan out across the workspace; when every spec is anchored, the
  // anchors are the scope. `vx run //#lint` is Turbo's root-project task.
  const root = path.resolve(ws.workspaceRoot)
  const rootName = projectMetas.find((m) => path.resolve(m.dir) === root)?.name
  const tasks =
    rootName === undefined
      ? options.tasks
      : options.tasks.map((t) => (t.startsWith('//#') ? `${rootName}#${t.slice(3)}` : t))
  const anchored: string[] = []
  let hasBare = false
  for (const spec of tasks) {
    const hashIdx = spec.indexOf('#')
    if (hashIdx > 0) anchored.push(spec.slice(0, hashIdx))
    else hasBare = true
  }
  const seeds: 'all' | string[] =
    options.projects !== undefined ? [...options.projects, ...anchored] : hasBare ? 'all' : anchored
  // Its own mark: the package graph (3-8 ms at 1,000 projects) was charged to
  // `open cache` (~1 ms), sending profilers to the wrong code.
  mark('package graph')
  return { packageGraph, tasks, seeds }
}
type Scope = ReturnType<typeof scopeOf>

/**
 * The local cache, opened under the run's policy, and the root files the
 * plugins claim, read before any task can rewrite them.
 */
async function openStore(
  options: CoreRunOptions,
  log: Logger,
  ws: Workspace,
  beforeOpen:
    | ((workspaceRoot: string, sharedCacheDir: string | undefined) => Promise<void>)
    | undefined,
  planning: boolean,
) {
  const { workspaceRoot, workspaceConfig, plugins, cacheDir, git } = ws
  const workspacePolicy = workspaceCachePolicy(workspaceConfig)
  const asked =
    options.cache ?? applyCacheFlags(workspacePolicy ?? FULL_CACHE_POLICY, options.cacheFlags)
  // A laptop reads the shared cache but writes it only when a policy names the
  // remote: a key holds only declared inputs, so a laptop's write could be
  // replayed on CI.
  const readOnly =
    options.handoff?.remoteReadOnlyByDefault === true &&
    !(options.cache === undefined && namesRemote(workspaceConfig?.cache?.policy))
  const wanted: CachePolicy = readOnly ? { ...asked, remoteWrite: false } : asked
  const resolvedStore = await ws.storeRoot
  // A cache directory with no store may be another workspace's too: the
  // run holds it shared (`holdCacheDir`).
  await beforeOpen?.(workspaceRoot, resolvedStore === null ? cacheDir : undefined)
  // A plan with no remote writes nothing: it reads the index as the run would
  // (another schema's as empty, `'preview'`) and upserts no memo. One with a
  // remote keeps the hits it finds, so the next `vx run` GETs them before its
  // own probe answers.
  const planReadOnly =
    planning &&
    (!wanted.remoteRead ||
      (options.remoteCache === undefined && !plugins.some((p) => p.cache !== undefined)))
  const openCache = (): Cache =>
    new Cache(
      cacheDir,
      { read: wanted.localRead, write: wanted.localWrite && !planReadOnly },
      workspaceRoot,
      options.artifactCeiling,
      planReadOnly ? 'preview' : 'open',
      resolvedStore,
      {
        embeddings: (resolveSetting('cache.store.embeddings', workspaceConfig).value ??
          DEFAULT_STORE.embeddings) as number,
        decompress: (resolveSetting('cache.store.decompress', workspaceConfig).value ??
          DEFAULT_STORE.decompress) as boolean,
      },
    )
  // A `vx cache clean` in another checkout holds the shared store until it has
  // deleted it: the run waits its turn, then opens the store.
  let localCache: Cache
  for (let said = false; ; await Bun.sleep(50)) {
    try {
      localCache = openCache()
      break
    } catch (err) {
      if (resolvedStore == null || (err as { code?: unknown }).code !== 'SQLITE_BUSY') throw err
    }
    if (!said) {
      said = true
      warnOf(log)(`[vx] waiting for a vx cache clean of ${resolvedStore} to finish…`)
    }
  }
  const unwritable = localCache.readOnlyNotice()
  if (unwritable !== null) warnOf(log)(`[vx] ${unwritable}`)
  const policy: CachePolicy = unwritable === null ? wanted : { ...wanted, localWrite: false }
  // The root files the plugins claim (`VxPlugin.fingerprint`), whose bytes
  // their claimants fold: read now so a task that rewrites one is caught.
  const fingerprintsAt = Date.now()
  const claimed = [...fingerprintClaims(plugins).keys()]
  const claimedBytes = await readClaimedFiles(workspaceRoot, claimed, ws.reads)
  // What `vx lock` recorded of them: a run keys from it (locked-digests.ts).
  const dependenciesLock = claimed.length > 0 ? readDependenciesLock(workspaceRoot, ws.reads) : null
  dependenciesLock?.catch(() => {})
  // A whole-tree run's blob-size check starts with the cache, beside config
  // load and graph build: after them, a cold 100-package run waited 40-50 ms
  // before its first task.
  if (git.started !== undefined) {
    localCache.memo.holdBlobSizes()
    git.started.then((e) => checkBlobSizes(e, localCache.memo)).catch(() => {})
  }
  mark('open cache')
  return { localCache, policy, fingerprintsAt, claimed, claimedBytes, dependenciesLock }
}
type Store = Awaited<ReturnType<typeof openStore>>

/** The configs in scope, from the lock; `everyProject` loads the rest when a refusal needs them. */
async function loadScope(
  options: CoreRunOptions,
  log: Logger,
  ws: Workspace,
  scope: Scope,
  localCache: Cache,
) {
  const { projectMetas, readLock } = ws
  // Configs load from .vx/projects.lock.json with no evaluation; only `vx lock`
  // evaluates (docs/design/config-lock-2026-06.md). Read once, and only if
  // needed: the CLI's selection may have staged every config already
  // (`handoff.staged`).
  const staged = options.handoff?.staged
  const allStaged =
    staged !== undefined &&
    projectMetas.every(
      (m) => typeof m.configPath !== 'string' || m.configPath === '' || staged.has(m.name),
    )
  if (!allStaged) await readLock()

  const loadArgs = {
    workspaceRoot: ws.workspaceRoot,
    cacheDir: ws.cacheDir,
    plugins: ws.plugins,
    projectMetas,
    packageGraph: scope.packageGraph,
    configs: readLock,
    warn: warnOf(log),
  }
  let loaded: LoadedProjects
  try {
    loaded = await loadProjects({
      ...loadArgs,
      seeds: scope.seeds,
      closure: true,
      ...(options.handoff?.staged !== undefined ? { staged: options.handoff?.staged } : {}),
    })
  } catch (err) {
    // The cache opened before the configs loaded; a config error must not
    // leak the handle.
    localCache.close()
    throw err
  }
  const { projects, configured: projectsWithConfigs } = loaded
  mark('load configs')
  const everyProject = (): Promise<LoadedProjects> =>
    loadProjects({ ...loadArgs, seeds: 'all', closure: false, staged: projects })
  return { allStaged, projects, projectsWithConfigs, everyProject }
}
type Load = Awaited<ReturnType<typeof loadScope>>

/**
 * What the task specs ask for over the loaded projects, and what is said
 * of a name they cannot find: unresolved, declared elsewhere, or hinted at.
 */
async function judgeRequests(options: CoreRunOptions, ws: Workspace, scope: Scope, load: Load) {
  const { workspaceRoot, projectMetas } = ws
  const { tasks } = scope
  const { projects, projectsWithConfigs, everyProject } = load
  // A config the load left out may declare what nothing loaded does. Asked by
  // name, never count: a config-less project counts as loaded.
  const partialLoad = projectsWithConfigs.some((m) => !projects.has(m.name))
  // Asked on a refusal only: a scope never loads a config-less project
  // nothing configured reaches.
  const taskless = (name: string): boolean =>
    !projects.has(name) &&
    projectMetas.some((m) => m.name === name) &&
    !projectsWithConfigs.some((m) => m.name === name)

  // Boundaries consider every project, loaded or not: a config-less one keys
  // its files under its default `build`, so a parent's glob that folded or
  // cleaned them crossed a boundary.
  const nestedDirsByProject = computeNestedProjectDirs(projectMetas)
  const nestedWorkspaces = nestedWorkspacesOf(projectMetas)
  if (nestedWorkspaces.length > 0)
    outputWalls.set(nestedDirsByProject, computeNestedProjectDirs(projectMetas, nestedWorkspaces))

  const candidateProjects = options.projects
    ? options.projects.filter((p) => projects.has(p))
    : [...projects.keys()]

  // A bare name skips the default `build`: it runs nothing, and `vx run build`
  // in a project declaring none ran 0 tasks, exit 0. `^build` and `lib#build`
  // still reach it.
  const requested = expandRequested(tasks, candidateProjects, projects, isDefaultBuild)
  let unresolvedTasks = unresolvedRequests(tasks, candidateProjects, projects, isDefaultBuild)
  // A diff touching only config-less projects loads none: every bare name is
  // still to judge, or a typo ran nothing, exit 0.
  if (options.handoff?.selectedByDiff === true && candidateProjects.length === 0)
    unresolvedTasks = [...new Set([...tasks.filter((t) => !t.includes('#')), ...unresolvedTasks])]
  await refuseUnlockedConfig(tasks, projects, projectMetas, workspaceRoot)
  // A scope that loaded no candidate judged no bare name: each is unresolved.
  if (options.projects !== undefined && options.handoff?.selectedByDiff !== true)
    refuseUnlockedScope(
      candidateProjects.length === 0 ? tasks : unresolvedTasks,
      options.projects,
      projectMetas,
      workspaceRoot,
    )
  if (options.handoff?.selectedByDiff === true && unresolvedTasks.some((t) => !t.includes('#'))) {
    // A name a loaded project declares is no typo, even if the load was
    // partial. Only what is still unjudged pays for the rest of the workspace.
    unresolvedTasks = undeclaredIn(unresolvedTasks, projects)
    if (partialLoad && unresolvedTasks.some((t) => !t.includes('#'))) {
      unresolvedTasks = await declaredNowhere(unresolvedTasks, everyProject)
    }
  }
  // Run inside a project lacking the task, the run said no project declares it.
  // Only a failing run pays for the rest of the workspace.
  let declaredElsewhere: string[] = []
  // A scope with no project to ask (a member with no vx config) leaves
  // every requested name unjudged.
  const bare = (candidateProjects.length === 0 ? tasks : unresolvedTasks).filter(
    (t) => !t.includes('#'),
  )
  if (
    options.projects !== undefined &&
    options.handoff?.selectedByDiff !== true &&
    bare.length > 0
  ) {
    let nowhere = undeclaredIn(bare, projects)
    if (nowhere.length > 0 && partialLoad) {
      nowhere = await declaredNowhere(nowhere, everyProject)
    }
    declaredElsewhere = bare.filter((t) => !nowhere.includes(t))
  }
  // A `pkg#task` run loads pkg's closure alone, so a typo'd pkg (or Nx's short
  // name) got no "did you mean". Only a failing run pays for the rest.
  let hintProjects: ReadonlyMap<string, ProjectEntry> = projects
  // Likewise a bare name no project in scope declares: "no project declares it"
  // must be true of the workspace.
  if (
    unresolvedTasks.some((t) => {
      const at = t.indexOf('#')
      return at > 0 && !projects.has(t.slice(0, at))
    }) ||
    (unresolvedTasks.some((t) => !t.includes('#')) && !declaresAny(projects))
  ) {
    try {
      hintProjects = (await everyProject()).projects
    } catch {
      // A config the scope skipped fails to load: no hint, the run's refusal stands.
    }
  }
  return {
    partialLoad,
    taskless,
    nestedDirsByProject,
    requested,
    unresolvedTasks,
    declaredElsewhere,
    hintProjects,
  }
}
type Asked = Awaited<ReturnType<typeof judgeRequests>>

/** The cache the run reads and writes: the local one, layered over the run's remotes. */
async function openLayer(options: CoreRunOptions, log: Logger, ws: Workspace, store: Store) {
  const { workspaceRoot, plugins } = ws
  const { localCache, policy } = store
  // Cache precedence: an injected remote layer (`RunOptions.remoteCache`, from
  // an agent already holding a client) wins, then a plugin's `cache`, then
  // local alone. Core ships no wire client (docs/patterns.md § Remote cache
  // wire). Injection winning avoids double-wrapping.
  let cache: CacheLayer
  const remotes: ResolvedRemote[] = []
  if (options.remoteCache) {
    remotes.push({
      remote: options.remoteCache,
      read: policy.remoteRead,
      write: policy.remoteWrite,
      onError: (err) => warnOf(log)(`[vx] remote cache: ${err.message}`),
    })
  }
  // An injected remote is no plugin's: nothing reads refs for it.
  const refs = options.remoteCache
    ? []
    : cacheRefs(workspaceRoot, ws.baseBranch, ws.branchFacts.refs)
  try {
    cache = options.remoteCache
      ? new LayeredCache(localCache, remotes, options.uploadConcurrency)
      : await resolveCache(plugins, {
          workspaceRoot,
          cacheDir: ws.cacheDir,
          warn: warnOf(log),
          scope: ws.cacheScope,
          refs,
          localCache,
          policy,
          remotes,
          ...(options.uploadConcurrency !== undefined
            ? { uploadConcurrency: options.uploadConcurrency }
            : {}),
        })
  } catch (err) {
    // A cache plugin that throws or breaks the contract is refused by name,
    // closing the local handle and what other factories opened.
    await teardownPlugins(plugins, warnOf(log))
    localCache.close()
    throw err
  }
  // Ask the layer, don't infer: identity against `localCache` is true for any
  // pass-through decorator with no remote, skipping the clamp below.
  // `hasRemote` is the layer's own answer.
  const hasRemoteLayer = cache.hasRemote === true
  return { cache, remotes, refs, hasRemoteLayer }
}
type Layer = Awaited<ReturnType<typeof openLayer>>

/**
 * The task graph the requests build, narrowed to what `--affected`'s diff
 * reaches; or `'none-affected'` when it reaches no request.
 */
async function buildGraph(
  options: CoreRunOptions,
  log: Logger,
  ws: Workspace,
  scope: Scope,
  load: Load,
  asked: Asked,
  hashCache: HashCache,
  cache: CacheLayer,
) {
  const { workspaceRoot, workspaceConfig, plugins, projectMetas } = ws
  const { projects, everyProject } = load
  const { requested, partialLoad } = asked
  // The whole graph, whatever `--exclude-dependencies` says: dropped tasks are
  // still keyed (excluded-keys.ts). A scoped load is not the whole workspace,
  // so a `^name` nothing loaded declares is handed back, not refused. Graph
  // rules are `vx lock`'s; `exclusiveOutputs: false` still asks for addition
  // marks.
  const graphRules: GraphRules = { ...runRules(workspaceConfig), locked: true }
  const unproven: Array<[taskId: string, name: string]> = []
  // Every config is the lock's when it was read: a `project` plugin's
  // edits are the lock's record too (graph-memo.ts).
  const lock =
    hashCache.folds !== undefined && options.handoff?.staged === undefined && !load.allStaged
      ? lockDigest(await ws.readLock())
      : undefined
  const graphMemo: GraphMemo | undefined =
    lock === undefined ? undefined : { folds: hashCache.folds!, lock, metas: projectMetas }
  const graphOf = (req: typeof requested) => {
    const built = memoGraph(
      {
        projects,
        packageGraph: scope.packageGraph,
        requested: req,
        workspaceRoot,
        rules: graphRules,
        ...(partialLoad
          ? { undeclaredDeps: (id: string, name: string) => void unproven.push([id, name]) }
          : {}),
      },
      graphMemo,
    )
    hashCache.graph = built.token
    return built.nodes
  }
  let nodes = graphOf(requested)
  const hasGraphHook = hasHook(plugins, 'graph')
  const graphStage = (of: Map<string, TaskNode>): Promise<void> =>
    applyGraphStage(plugins, of, {
      workspaceRoot,
      cacheDir: ws.cacheDir,
      projectMetas,
      warn: warnOf(log),
      rules: graphRules,
    })
  // `--affected` selects over the final graph: a `graph` hook's edge or input
  // moves a key, so hooks run first over every candidate.
  const hooksFirst = hasGraphHook && options.affected !== undefined
  // `--affected` keeps a bare request only when the diff reaches its
  // closure; a `pkg#task` the user named runs as it always does.
  if (options.affected !== undefined) {
    const before = hooksFirst ? new Set(nodes.keys()) : null
    if (hooksFirst) await graphStage(nodes)
    const kept = keptByAffected(
      nodes,
      requested,
      options.affected,
      projects,
      scope.packageGraph,
      workspaceRoot,
      {
        named: new Set(scope.tasks.filter((t) => t.includes('#'))),
        outright: new Set(options.handoff?.selectedOutright),
      },
      options.handoff?.affectedReasons && { reasons: options.handoff?.affectedReasons },
    )
    if (kept.length === 0) return 'none-affected' as const
    if (before !== null) {
      const askedIds = new Set(requested.map((r) => `${r.project}#${r.task}`))
      // What a hook added or asked for is the plugin's choice, kept as it
      // would be on a run without the diff.
      const roots = [
        ...kept.map((r) => `${r.project}#${r.task}`),
        ...[...nodes.values()]
          .filter((n) => !before.has(n.id) || (n.requested && !askedIds.has(n.id)))
          .map((n) => n.id),
      ]
      pruneToClosure(nodes, new Set(roots))
      for (let i = unproven.length - 1; i >= 0; i--)
        if (!nodes.has(unproven[i]![0])) unproven.splice(i, 1)
    } else if (kept.length < requested.length) {
      unproven.length = 0
      nodes = graphOf(kept)
    }
  }
  if (unproven.length > 0) await refuseUndeclaredDeps(unproven, everyProject)
  // An `--exclude-dependencies` name no project declares is refused like any
  // other typed name (`=biuld` ran the whole chain). After the graph, so a
  // config error is named first.
  const excludeNames = options.excludeDependencies
  if (Array.isArray(excludeNames) && excludeNames.length > 0) {
    const declared = new Set<string>()
    for (const p of projects.values())
      for (const t of Object.keys(p.config.tasks ?? {})) declared.add(t)
    let unknown = excludeNames.filter((n) => !declared.has(n))
    if (unknown.length > 0 && partialLoad) {
      unknown = await declaredNowhere(unknown, everyProject)
    }
    if (unknown.length > 0) {
      cache.close()
      const hints = new Set(unknown.flatMap((n) => nearest(n, declared) ?? []))
      const hint = hints.size === 0 ? '' : ` Did you mean ${[...hints].join(', ')}?`
      throw new UserError(
        `--exclude-dependencies names a task no project declares: ${unknown.join(', ')}.${hint}`,
      )
    }
  }
  // Git's enumeration, then the plugins' stages, each its own timing row, so a
  // plugin's key stage is not hidden in graph building.
  mark('build graph')
  return { nodes, graphRules, hasGraphHook, hooksFirst, graphStage }
}
type Graph = Exclude<Awaited<ReturnType<typeof buildGraph>>, 'none-affected'>

/** Whether `--exclude-dependencies` names anything to drop. */
function excludes(options: CoreRunOptions): boolean {
  const exclude = options.excludeDependencies
  return exclude !== undefined && (exclude === 'all' || exclude.length > 0)
}

/**
 * Git's file lists for the graph's projects, in one walk, and the
 * dependents count taken while git's blob-size check runs.
 */
async function enumerateGit(
  options: CoreRunOptions,
  ws: Workspace,
  store: Store,
  asked: Asked,
  graph: Graph,
  hashCache: HashCache,
  countDependents: boolean,
) {
  const { workspaceRoot, cacheDir, git, plugins } = ws
  const { localCache } = store
  const { nodes } = graph
  const gitFilesCache = new GitFilesCache()
  gitFilesCache.vxDirs = withinRoot(workspaceRoot, cacheDir)
  // One `git ls-files` at the root, partitioned by project: a spawn per project
  // is the dominant cold-start cost. `inputs.workspaceFiles` makes it unscoped,
  // with a workspace-wide partition. Only over projects that own a task: a
  // scoped run loads its closure for `^`, and walking all of it cost ~60 ms
  // where one pathspec takes ~7. A node a `graph` hook adds elsewhere keys
  // through `resolveFiles`' own spawn.
  const graphDirs = new Set<string>()
  let usesWorkspaceInputs = false
  for (const n of nodes.values()) {
    graphDirs.add(n.projectDir)
    if ((n.config.inputs?.workspaceFiles?.length ?? 0) > 0) usesWorkspaceInputs = true
  }
  const projectDirs = [...graphDirs]
  const enumerating =
    git.started ??
    startGitEnumeration(
      workspaceRoot,
      gitPathspecs(workspaceRoot, projectDirs, usesWorkspaceInputs),
    )
  // While git walks: the gate's pass over every task cost 2-8 ms at
  // 1,000 projects when it ran before the spawn.
  const settleIgnored = askIgnoredOutputs(gatedOutputs(nodes, workspaceRoot), workspaceRoot, nodes)
  const enumeration = await enumerating
  localCache.memo.holdBlobSizes()
  const applied = applyGitEnumeration(
    enumeration,
    workspaceRoot,
    projectDirs,
    gitFilesCache,
    usesWorkspaceInputs,
    localCache.memo,
  )
  // Count dependents while `cat-file` runs (~80 ms of idle wait on a cold
  // 8,002-task run). Only when nothing below edits the nodes.
  const dependents =
    !countDependents ||
    (graph.hasGraphHook && !graph.hooksFirst) ||
    hasHook(plugins, 'key') ||
    excludes(options)
      ? undefined
      : graphCounts(nodes, hashCache.folds, hashCache.graph)
  await applied
  await settleIgnored(gitFilesCache)
  mark('git enumeration')
  return { gitFilesCache, dependents, nestedDirsByProject: asked.nestedDirsByProject }
}
type Enumerated = Awaited<ReturnType<typeof enumerateGit>>

/**
 * The `graph` and `key` stages, the refusals that read the final nodes, and the
 * `--exclude-dependencies` split.
 */
async function applyKeyStages(
  options: CoreRunOptions,
  log: Logger,
  ws: Workspace,
  store: Store,
  load: Load,
  asked: Asked,
  graph: Graph,
  enumerated: Enumerated,
  hashCache: HashCache,
  cache: CacheLayer,
): Promise<ReadonlyMap<string, TaskNode>> {
  const { workspaceRoot, cacheDir, plugins, projectMetas } = ws
  const { nodes, hasGraphHook, hooksFirst } = graph
  const { gitFilesCache } = enumerated
  const { nestedDirsByProject } = asked
  if (hasGraphHook && !hooksFirst) await graph.graphStage(nodes)
  // An upstream run without the dependants that add to its outputs still
  // ignores their additions (`markOutsideAdditions`): over every project, in a
  // workspace that allows it.
  if (graph.graphRules.exclusiveOutputs === false) {
    const every = asked.partialLoad ? (await load.everyProject()).projects : load.projects
    markOutsideAdditions(nodes, every, workspaceRoot)
  }
  // Args after `--` go to requested commands only; with none among them
  // they reached nothing and the run passed, the `--watch` unheard.
  if ((options.forwardArgs?.length ?? 0) > 0) {
    const requestedNodes = [...nodes.values()].filter((n) => n.requested)
    if (requestedNodes.length > 0 && requestedNodes.every(isGroupTask)) {
      const ids = requestedNodes.map((n) => n.id)
      const named = ids.length > 3 ? `${ids.slice(0, 3).join(', ')}, …` : ids.join(', ')
      throw new UserError(
        `args after \`--\` reach no task: ${named} ${ids.length === 1 ? 'has' : 'have'} no command (a group); name the task that runs one`,
      )
    }
  }
  if (hasHook(plugins, 'key')) {
    const locked = lockedFiles(
      workspaceRoot,
      store.claimed,
      store.claimedBytes,
      await store.dependenciesLock,
    )
    await applyKeyHooks(
      plugins,
      nodes,
      withExtraHashes(
        { workspaceRoot, cacheDir, warn: warnOf(log), locked },
        extraHashesOfDiscovery(projectMetas),
      ),
    )
  }
  refuseFiltersThroughGroups(nodes)
  refuseCacheInOutputs(nodes, gitFilesCache.vxDirs, cacheDir, workspaceRoot, nestedDirsByProject)
  // The nodes are what the graph token names only while nothing edited them.
  if (hasGraphHook || hasHook(plugins, 'key') || excludes(options)) hashCache.graph = undefined
  let keyOnly: ReadonlyMap<string, TaskNode> = new Map()
  const exclude = options.excludeDependencies
  if (exclude !== undefined && excludes(options)) {
    const split = excludeDependencies(nodes, exclude)
    keyOnly = split.keyOnly
    const dropped = split.dropped
    if (dropped.size > 0) {
      await keyExcludedDependencies({
        nodes,
        keyOnly,
        dropped,
        cache,
        workspaceRoot,
        forwardArgs: options.forwardArgs,
        nestedDirsByProject,
        gitFilesCache,
        hashCache,
      })
    }
  }
  return keyOnly
}

/** Each plugin's `ctx.cache`, and the `schedule` stage's priorities, asked once. */
function pluginAccess(
  log: Logger,
  ws: Workspace,
  store: Store,
  layer: Layer,
  nodes: Map<string, TaskNode>,
) {
  const { localCache, policy } = store
  const pluginCaches = new Map<string, PluginCache>()
  const cacheFor = (plugin: string): PluginCache => {
    let own = pluginCaches.get(plugin)
    if (own === undefined) {
      own = pluginCache(plugin, {
        db: indexDb(localCache),
        policy,
        remotes: layer.remotes,
        scope: ws.cacheScope,
      })
      pluginCaches.set(plugin, own)
    }
    return own
  }
  let scheduled: Promise<ReadonlyMap<string, number>> | undefined
  const priorities = (run?: ScheduleRun): Promise<ReadonlyMap<string, number>> =>
    (scheduled ??= hasHook(ws.plugins, 'schedule')
      ? applyScheduleHooks(
          ws.plugins,
          nodes,
          {
            workspaceRoot: ws.workspaceRoot,
            cacheDir: ws.cacheDir,
            warn: warnOf(log),
            localCache,
            branch: ws.branch(),
            refs: layer.refs,
          },
          cacheFor,
          run,
        )
      : Promise.resolve(new Map()))
  return { cacheFor, priorities }
}

/**
 * The names in `unresolved` no project anywhere declares: anchored `pkg#task`
 * stays; a bare name leaves when an out-of-scope config declares it. A load
 * failure leaves every name, so the guard still speaks.
 */
async function declaredNowhere(
  unresolved: readonly string[],
  load: () => Promise<LoadedProjects>,
): Promise<string[]> {
  let all: LoadedProjects
  try {
    all = await load()
  } catch {
    return [...unresolved]
  }
  return undeclaredIn(unresolved, all.projects)
}

/** Whether any project in `projects` declares a task: its default `build` is none. */
function declaresAny(projects: LoadedProjects['projects']): boolean {
  for (const p of projects.values())
    for (const task of Object.values(p.config.tasks ?? {})) if (!isDefaultBuild(task)) return true
  return false
}

/**
 * The bare names no project in `projects` declares; `a#b` passes through. A
 * bare name never selects a default `build`.
 */
function undeclaredIn(
  unresolved: readonly string[],
  projects: LoadedProjects['projects'],
): string[] {
  const declared = new Set<string>()
  for (const p of projects.values()) {
    for (const [t, task] of Object.entries(p.config.tasks ?? {})) {
      if (!isDefaultBuild(task)) declared.add(t)
    }
  }
  return unresolved.filter((t) => t.includes('#') || !declared.has(t))
}

/**
 * Refuses the first `^name` in `unproven` no project anywhere declares. Reached
 * only when a `^name` found no holder in scope; out-of-scope configs that fail
 * to load leave names unjudged.
 */
async function refuseUndeclaredDeps(
  unproven: ReadonlyArray<readonly [taskId: string, name: string]>,
  load: () => Promise<LoadedProjects>,
): Promise<void> {
  let all: LoadedProjects
  try {
    all = await load()
  } catch {
    return
  }
  const declared = new Set<string>()
  for (const p of all.projects.values()) {
    for (const t of Object.keys(p.config.tasks ?? {})) declared.add(t)
  }
  for (const [id, name] of unproven) {
    if (!declared.has(name)) throw undeclaredDepsError(id, name, declared)
  }
}

/**
 * Drop every node outside the `dependsOn` closure of `roots`, demoting a
 * requested one only a kept task pulls in; `graph` hook edits are kept.
 */
function pruneToClosure(nodes: Map<string, TaskNode>, roots: ReadonlySet<string>): void {
  const keep = new Set<string>()
  const stack = [...roots]
  while (stack.length > 0) {
    const id = stack.pop()!
    // A `pkg#task` the user named is kept, though a hook may have dropped it.
    const node = nodes.get(id)
    if (node === undefined || keep.has(id)) continue
    keep.add(id)
    stack.push(...node.deps)
  }
  for (const [id, n] of nodes) {
    if (!keep.has(id)) nodes.delete(id)
    else if (!roots.has(id)) n.requested = false
  }
}

export const namesRemote = (spec: string | undefined): boolean =>
  spec !== undefined && /remote:[rw]/.test(spec)

/** Each run's output walls, by its `nestedDirsByProject`, when it has a nested workspace. */
const outputWalls = new WeakMap<ReadonlyMap<string, string[]>, ReadonlyMap<string, string[]>>()

/**
 * Where each project's outputs stop: its nested projects and nested workspaces.
 * Its inputs stop at nested projects alone (a worktree under `src/` holds a
 * workspace: folding it costs a miss, leaving it out a stale hit), but cleaning
 * a nested workspace deleted its work.
 */
export function outputWallsOf(
  nestedDirsByProject: ReadonlyMap<string, string[]>,
): ReadonlyMap<string, string[]> {
  return outputWalls.get(nestedDirsByProject) ?? nestedDirsByProject
}

/**
 * The workspace's `cache.policy`, parsed here: the grammar lives in cache,
 * which workspace may not import.
 */
export function workspaceCachePolicy(
  config: WorkspaceConfig | null | undefined,
): CachePolicy | undefined {
  const spec = config?.cache?.policy
  if (spec === undefined) return undefined
  try {
    return parseCachePolicy(spec)
  } catch (err) {
    throw new UserError(
      `.vx/workspace: \`cache.policy\` ${err instanceof Error ? err.message : String(err)}`,
      'VX_E_CONFIG',
    )
  }
}

/** A config no locked project has, looked for only when the lock holds none. */
function unlockedConfigOf(
  configured: readonly unknown[],
  metas: ReadonlyArray<{ name: string; dir: string }>,
  workspaceRoot: string,
): string | undefined {
  if (configured.length > 0) return undefined
  for (const m of metas) {
    const config = PROJECT_CONFIG_FILENAMES.find((n) => existsSync(path.join(m.dir, n)))
    if (config === undefined) continue
    const file = path.join(m.dir, config)
    // `vx lock` never reads it: the hint would send the user to it for nothing.
    if (ignoredConfigRefusal(workspaceRoot, m, file) === undefined)
      return relPosix(workspaceRoot, file)
  }
  return undefined
}

/**
 * A `project#build` naming the default `build` of a project the lock has no
 * config for, while its directory holds one: it asks for that config's task, so
 * suggest `vx lock` instead of running nothing.
 */
async function refuseUnlockedConfig(
  tasks: readonly string[],
  projects: ReadonlyMap<string, ProjectEntry>,
  metas: ReadonlyArray<{ name: string; dir: string; configPath?: string | null }>,
  workspaceRoot: string,
): Promise<void> {
  for (const spec of tasks) {
    const at = spec.indexOf('#')
    if (at < 0) continue
    const name = spec.slice(0, at)
    const entry = projects.get(name)
    // No entry: a package the lock holds no project for, whose config came after it.
    if (entry !== undefined && !isDefaultBuild(entry.config.tasks?.[spec.slice(at + 1)])) continue
    const config =
      unlockedConfig(name, metas) ??
      (metas.some((m) => m.name === name)
        ? undefined
        : await unlockedDir(name, metas, workspaceRoot))
    if (config === undefined) continue
    throw new UserError(`${spec}: ${notLockedYet(workspaceRoot, config, metas, name)}`, 'VX_E_LOCK')
  }
}

/**
 * The same for a bare name the selection left unresolved: a member whose config
 * came after the lock.
 */
function refuseUnlockedScope(
  unresolved: readonly string[],
  selected: readonly string[],
  metas: ReadonlyArray<{ name: string; dir: string; configPath?: string | null }>,
  workspaceRoot: string,
): void {
  const spec = unresolved.find((t) => !t.includes('#'))
  if (spec === undefined) return
  // The selection, not the loaded projects: a scope loads no config-less
  // member nothing configured reaches, and that is the one to ask about.
  for (const name of selected) {
    const config = unlockedConfig(name, metas)
    if (config === undefined) continue
    throw new UserError(`${spec}: ${notLockedYet(workspaceRoot, config, metas, name)}`, 'VX_E_LOCK')
  }
}

/**
 * Why the lock holds no `config`: git ignores it in a `discover`-made project
 * (which `vx lock` cannot fix), else it came after the lock.
 */
function notLockedYet(
  workspaceRoot: string,
  config: string,
  metas: ReadonlyArray<{ name: string; dir: string }>,
  name: string,
): string {
  const meta = metas.find((m) => m.name === name)
  return (
    (meta === undefined ? undefined : ignoredConfigRefusal(workspaceRoot, meta, config)) ??
    `${relPosix(workspaceRoot, config)} is not in the lock yet — run \`vx lock\``
  )
}

/** The config file in a project's directory the lock holds none for. */
function unlockedConfig(
  name: string,
  metas: ReadonlyArray<{ name: string; dir: string; configPath?: string | null }>,
): string | undefined {
  const meta = metas.find((m) => m.name === name)
  if (meta === undefined) return undefined
  if (typeof meta.configPath === 'string' && meta.configPath !== '') return undefined
  const config = PROJECT_CONFIG_FILENAMES.find((n) => existsSync(path.join(meta.dir, n)))
  return config === undefined ? undefined : path.join(meta.dir, config)
}

/**
 * The config `vx lock` would find for a name no project has: a config written
 * after the lock makes no project. Asked only on a refusal.
 */
export async function unlockedDir(
  name: string,
  metas: ReadonlyArray<{ dir: string }>,
  workspaceRoot: string,
): Promise<string | undefined> {
  const dir = path.resolve(workspaceRoot, name)
  // A project's directory typed for its name is that project, hinted as such.
  if (metas.some((m) => m.dir === dir)) return undefined
  const { configs } = await findProjectConfigs(workspaceRoot)
  const atDir = configs.find((c) => c.dir === dir)
  if (atDir !== undefined) return atDir.configPath
  for (const c of configs) {
    if (metas.some((m) => m.dir === c.dir)) continue
    try {
      const pkg = (await Bun.file(path.join(c.dir, 'package.json')).json()) as { name?: unknown }
      if (pkg.name === name) return c.configPath
    } catch {
      // No package.json, or not JSON: no package name to match.
    }
  }
  return undefined
}

/**
 * Each remote's `open`, in order, for those the policy lets read or write. One
 * at a time: two terminal prompts must not interleave. A throw warns through
 * its `onError` and turns that remote off. True when no remote is left.
 */
export async function openRemotes(
  remotes: readonly ResolvedRemote[],
  ci: boolean,
  secrets: SecretBroker,
): Promise<boolean> {
  let closed = false
  for (const entry of remotes) {
    if (entry.remote.open === undefined || !(entry.read || entry.write)) continue
    try {
      await entry.remote.open({
        ci,
        warn: (message) => entry.onError?.(new Error(message)),
        ...secrets.for(entry.plugin ?? 'vx'),
      })
    } catch (err) {
      entry.read = false
      entry.write = false
      const e = err instanceof Error ? err : new Error(thrownMessage(err))
      entry.onError?.(e)
      closed = true
    }
  }
  return closed && !remotes.some((r) => r.read || r.write)
}

/**
 * Refuses a cache directory under a task's declared outputs: the output clean
 * deleted the index mid-run, and with `clean: false` saves packed the index
 * into entries that later restored over it. Probed with the walk's matcher, so
 * a `!` take-back keeps the run. Free unless the cache is inside the workspace.
 */
function refuseCacheInOutputs(
  nodes: ReadonlyMap<string, TaskNode>,
  vxDirs: readonly string[],
  cacheDir: string,
  workspaceRoot: string,
  nestedDirsByProject: ReadonlyMap<string, string[]>,
): void {
  const dir = vxDirs[0]
  if (dir === undefined) return
  const under = (base: string) => dir === base || dir.startsWith(base + path.sep)
  const reaches = (globs: readonly string[], base: string, scope: 'project' | 'workspace') => {
    const take = restorableOutput(globs, scope)
    const rel = relPosix(base, dir)
    return ['cache.db', 'cache.lock'].some((f) => take(rel === '' ? f : `${rel}/${f}`))
  }
  const walls = outputWallsOf(nestedDirsByProject)
  for (const n of nodes.values()) {
    const files = n.config.outputs?.files ?? []
    const ws = n.config.outputs?.workspaceFiles ?? []
    const own =
      files.length > 0 &&
      under(n.projectDir) &&
      !(walls.get(n.projectName) ?? []).some(under) &&
      reaches(files, n.projectDir, 'project')
    if (own || (ws.length > 0 && reaches(ws, workspaceRoot, 'workspace')))
      throw new UserError(
        `cache directory ${cacheDir} lies under the outputs of ${n.id}: its output clean would delete the cache, or its save would pack the cache into its own entry. ${OWN_DIR_HINT}`,
        'VX_E_CONFIG',
      )
  }
}

/**
 * `dir` spelled under `root` as the run spells it, compared through links
 * (macOS `/var/folders`).
 */
function withinRoot(root: string, dir: string): string[] {
  const real = (p: string): string => {
    try {
      return realpathSync(p)
    } catch {
      return path.resolve(p)
    }
  }
  const rel = path.relative(real(root), real(dir))
  const outside = rel === '' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)
  return outside ? [] : [path.join(root, rel)]
}
