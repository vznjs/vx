// Shared setup for `run()` and `planRun()`. Both entry points perform
// the same workspace-discovery → config-load → graph-build → cache-
// open sequence; this module centralises it so the two callers stay
// thin.
//
// The caller owns the returned `cache.close()` lifetime: `run()`
// closes at the bottom of execution, `planRun()` does so via
// try/finally around its plan() call.

import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { WorkspaceConfig } from '../config.js'
import {
  beginRun,
  mark,
  nearest,
  relPosix,
  type SecretBroker,
  thrownMessage,
  UserError,
} from '../util/index.js'
import {
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
  lazyGitEnumeration,
  measureFsClockLag,
  DEFAULT_STORE,
} from '../cache/index.js'
import {
  buildPackageGraph,
  computeNestedProjectDirs,
  findWorkspaceRoot,
  configuredBaseBranch,
  type LoadReads,
  lockDigest,
  PROJECT_CONFIG_FILENAMES,
  readClaimedFiles,
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
import {
  discoverProjects,
  gitOfDiscovery,
  graphOfDiscovery,
  loadProjects,
  loadWorkspacePlugins,
  lockOfDiscovery,
  lockReader,
  type LoadedProjects,
} from './projects.js'
import { keptByAffected } from './affected-tasks.js'
import { applyGraphStage } from './graph-stage.js'
import { keyExcludedDependencies } from './excluded-keys.js'
import { FingerprintWatch } from './fingerprint-watch.js'
import type { VxPlugin } from './plugin.js'
import { memoGraph, type GraphMemo } from './graph-memo.js'
import { askIgnoredOutputs, gatedOutputs } from './stable-keys.js'
import { cacheRefs, currentBranch, resolveCacheScope } from './run-context.js'
import { createHashCache, type HashCache } from './task-hash.js'
import { type Logger, warnOf } from '../report/index.js'
import type { RunOptions } from './options.js'
import { resolveSetting, runRules } from '../settings.js'

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
  /** `--cache-policy` with the workspace's `cacheScope` applied: what the layers were built under. */
  cachePolicy: CachePolicy
  /** The scope this run's cache reads and writes, when one is set; named on the summary's `info` row. */
  cacheScope: string | undefined
  /** The run's remotes in declared order, as the policy gates each; `openRemotes` turns one off. */
  remotes: ResolvedRemote[]
  /** The refs the run reads, in order (`CacheContext.refs`). */
  cacheRefs: readonly string[]
  /**
   * Scheduling priorities from plugins' `schedule` stage (task id → weight,
   * merged over the structural baseline by the scheduler). Empty when no
   * plugin declares the stage. Asked only by a run with a task to start:
   * the stage reads history (148 ms at 8,002 tasks) to order work a
   * nothing-changed run never dispatches. Runs the stage once: `run`
   * times each plugin's call and hears its later `ctx.refine` sets.
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
   * Requested task specs that matched NO project — a typo, or a stray
   * positional (the value of an `=`-only flag written with a space).
   * Nothing they asked for is in `nodes`, so callers must fail rather
   * than run the remainder silently.
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
   * True iff at least one package in the workspace has a `vx.config.*` at
   * all — regardless of scope, so a `--filter` that matched nothing is not
   * mistaken for a workspace vx was never set up in.
   */
  anyProjectConfig: boolean
  /** A workspace project that declares no task: no config, and nothing configured reaches it. */
  taskless: (name: string) => boolean
  /**
   * With no config in the lock, one a directory holds anyway (root-relative):
   * written after `vx lock`, so the fix is `vx lock`, not `vx init`. Asked
   * only by a refusal, so a run that goes on pays no stat.
   */
  unlockedConfig: () => string | undefined
  /** The claimed root files, and whether a task has since rewritten one (fingerprint-watch.ts). */
  fingerprintWatch: FingerprintWatch
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
   * Per-run memo for derived hashes — task-config hash keyed by config
   * object identity, resolved file lists. Shared across every task's
   * `computeTaskHash` call so the same config object isn't re-hashed.
   */
  hashCache: HashCache
  /**
   * Reason `nodes` is empty. `null` when the prepared run is ready to
   * execute. Either:
   *   - `'no-tasks-declared'` — `requested.length === 0` after the
   *     user's task names were resolved against `projects`. Typically
   *     a typo'd task name; `run()` treats this as a CI footgun and
   *     returns NOT-ok.
   *   - `'none-affected'`     — as `'no-tasks-declared'`, but the scope
   *     came from a diff and every name is declared somewhere else in the
   *     workspace: nothing changed that runs them, a clean outcome. Also
   *     when `--affected`'s diff reaches no requested task's `dependsOn`
   *     closure (`affected-tasks.ts`).
   *   - `'empty-graph'`       — `requested` was non-empty but the
   *     graph builder still produced no nodes. Defensive; unreachable
   *     under current `buildTaskGraph` semantics.
   */
  empty: null | 'no-tasks-declared' | 'none-affected' | 'empty-graph'
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
  beginRun()
  mark('startup')
  // A claimed root file is read once. A watch cycle is a new run and reads
  // them afresh.
  const reads: LoadReads = new Map()
  const workspaceRoot = await findWorkspaceRoot(options.cwd)
  // The lock is where a run's projects come from, so the read (1.1 MB at
  // 1,000 projects, ~10 ms to read and parse) starts here and overlaps the
  // workspace config's evaluation (X-181). A missing or malformed lock
  // refuses at discovery, after any earlier refusal.
  const reused = options.discovered?.root === workspaceRoot ? options.discovered : undefined
  const readLock =
    (reused !== undefined ? lockOfDiscovery(reused.projects) : undefined) ??
    lockReader(workspaceRoot)
  if (reused === undefined) void readLock().catch(() => {})
  // An UNSCOPED run (no explicit scope, at least one bare task name)
  // enumerates the whole tree whatever the configs say, so git starts
  // HERE — the walk needs only the root — and overlaps the workspace
  // config, discovery, the cache open and the config evaluation. Its
  // ~60 ms is the warm run's wall floor on a 1000-project tree; it used to
  // start after discovery and the cache open, ~25 ms later. A scoped run
  // waits: its pathspecs depend on which projects the configs pull in —
  // unless it already names more projects than pathspecs scope, where the
  // walk is the whole tree either way (an `--affected` run on 1,000
  // projects waited ~60 ms for it after the configs loaded).
  const wholeTree =
    (options.projects === undefined || options.projects.length > MAX_SCOPED_PATHSPECS) &&
    options.tasks.some((spec) => spec.indexOf('#') <= 0)
  // A `discover` hook that reads the worktree (nx()'s graph key) starts the
  // whole-tree enumeration a scoped run would otherwise scope later, here or
  // in the CLI's selection pass; the run reuses it instead of walking the
  // tree twice (G-75).
  const git =
    (reused !== undefined ? gitOfDiscovery(reused.projects) : undefined) ??
    lazyGitEnumeration(workspaceRoot)
  if (wholeTree) void git.start()
  const {
    workspaceConfig,
    plugins,
    branch: branchFacts,
  } = await loadWorkspacePlugins(workspaceRoot, warnOf(log))
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
  // `--cache-dir <path>` (RunOptions.cacheDir) overrides the workspace
  // `cache.dir` + the `.vx/cache` default; resolved relative to cwd.
  // A cache dir named anywhere holds everything; the default shares its
  // entries through the user's store.
  const cacheDir = options.cacheDir
    ? path.resolve(options.cwd, options.cacheDir)
    : resolveCacheDir(workspaceRoot, workspaceConfig)
  // Before any racy window is judged: a file system behind this process's
  // clock dated a mid-command edit before the command (fs-clock.ts).
  measureFsClockLag(cacheDir)
  // Asked now, read when the cache opens: a repository with no remote is
  // named by its root commit, a git spawn the discovery below overlaps.
  const storeRoot = options.cacheDir ? null : resolveStoreRoot(workspaceRoot, workspaceConfig)
  const discovering =
    reused !== undefined
      ? Promise.resolve(reused.projects)
      : discoverProjects(workspaceRoot, readLock, plugins, cacheDir, warnOf(log), git)
  const projectMetas = await discovering
  mark('discover projects')

  // SCOPED config loading: configs are programs, and evaluating 1090
  // of them costs ~200 ms — the dominant fixed cost of small runs.
  // Only the in-scope projects, their transitive dependency closure
  // (which bounds '^task' frontier expansion) and any project named by
  // a `pkg#task` dependsOn entry can contribute graph nodes, so only
  // those configs are evaluated. Side effect, deliberate and
  // Turbo-like: a broken config in an unrelated package no longer
  // fails a scoped run — it surfaces when that package enters scope.
  const packageGraph =
    (reused !== undefined ? graphOfDiscovery(reused.projects) : undefined) ??
    buildPackageGraph(projectMetas)
  // Seeds: explicit scope, plus anchored pkg#task targets (which bypass
  // scope by design). With no explicit scope, bare task names fan out
  // across the whole workspace — but when EVERY spec is anchored, the
  // anchors alone are the scope and nothing else needs its config
  // evaluated.
  // `vx run //#lint` is Turbo's `turbo run //#lint`: the root project's
  // task, under the name it has when something names it (D-39).
  const root = path.resolve(workspaceRoot)
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
  // Its own mark: the package graph is the bulk of what used to be charged
  // to `open cache` (measured on a 1,000-project tree, 2026-09-20 — the
  // graph 3-8 ms against the cache open's ~1 ms and the root files' ~0.3),
  // so a reader profiling that stage was sent to the wrong code.
  mark('package graph')

  const workspacePolicy = workspaceCachePolicy(workspaceConfig)
  const asked =
    options.cache ?? applyCacheFlags(workspacePolicy ?? FULL_CACHE_POLICY, options.cacheFlags)
  // A laptop reads the shared cache and does not write it unless a policy
  // names the remote (2026-10-03; Security F1, 2026-10-14): a key
  // holds only declared inputs, so a laptop's write could be replayed on CI.
  // A workspace policy naming the remote asks to write it, as `--cache-policy` does.
  const readOnly =
    options.remoteReadOnlyByDefault === true &&
    !(options.cache === undefined && namesRemote(workspaceConfig?.cache?.policy))
  const wanted: CachePolicy = readOnly ? { ...asked, remoteWrite: false } : asked
  const localCache = new Cache(
    cacheDir,
    { read: wanted.localRead, write: wanted.localWrite },
    workspaceRoot,
    options.artifactCeiling,
    'open',
    await storeRoot,
    {
      embeddings: (resolveSetting('cache.store.embeddings', workspaceConfig).value ??
        DEFAULT_STORE.embeddings) as number,
      decompress: (resolveSetting('cache.store.decompress', workspaceConfig).value ??
        DEFAULT_STORE.decompress) as boolean,
    },
  )
  const unwritable = localCache.readOnlyNotice()
  if (unwritable !== null) warnOf(log)(`[vx] ${unwritable}`)
  const policy: CachePolicy = unwritable === null ? wanted : { ...wanted, localWrite: false }
  // The root files the plugins claim (`VxPlugin.fingerprint`), whose bytes
  // their claimants fold: read now so a task that rewrites one is caught.
  const fingerprintsAt = Date.now()
  const claimed = [...fingerprintClaims(plugins).keys()]
  const claimedBytes = await readClaimedFiles(workspaceRoot, claimed, reads)
  mark('open cache')

  // Configs load FROM .vx/projects.lock.json with no evaluation and no check of
  // the configs (`vx lock --check` re-evaluates them; a run does not):
  // only `vx lock` evaluates (2026-10-14).
  // See docs/design/config-lock-2026-06.md.
  // Read once, and only when a config is to be read from it: the CLI's
  // selection pass may have staged every config (`options.staged`), and
  // its load refused a run without a lock. A 1,000-project lock is
  // 1.1 MB of JSON (I-27); a run with nothing staged started its read
  // beside discovery, above.
  const staged = options.staged
  const allStaged =
    staged !== undefined &&
    projectMetas.every(
      (m) => typeof m.configPath !== 'string' || m.configPath === '' || staged.has(m.name),
    )
  if (!allStaged) await readLock()

  const loadArgs = {
    workspaceRoot,
    cacheDir,
    plugins,
    projectMetas,
    packageGraph,
    configs: readLock,
    warn: warnOf(log),
  }
  let loaded: LoadedProjects
  try {
    loaded = await loadProjects({
      ...loadArgs,
      seeds,
      closure: true,
      ...(options.staged !== undefined ? { staged: options.staged } : {}),
    })
  } catch (err) {
    // The cache opened before the configs loaded; a config error must not
    // leak the handle.
    localCache.close()
    throw err
  }
  const { projects, configured: projectsWithConfigs } = loaded
  mark('load configs')
  // A config the load left out may declare what nothing loaded does. Asked by
  // name, never by count: a config-less project counts as loaded, so a
  // scope holding one hid an unloaded declarer (X-129, X-182).
  const partialLoad = projectsWithConfigs.some((m) => !projects.has(m.name))
  // Asked on a refusal only: a scope never loads a config-less project
  // nothing configured reaches.
  const taskless = (name: string): boolean =>
    !projects.has(name) &&
    projectMetas.some((m) => m.name === name) &&
    !projectsWithConfigs.some((m) => m.name === name)

  // Boundary geometry considers every workspace project, loaded or not,
  // config or not: `--affected` gives a changed path to the deepest project
  // dir, and a config-less one keys its files under its default `build`, so
  // a parent's glob that folded (or cleaned) them crossed a boundary the
  // selection drew (X-57).
  const nestedDirsByProject = computeNestedProjectDirs(projectMetas)

  const candidateProjects = options.projects
    ? options.projects.filter((p) => projects.has(p))
    : [...projects.keys()]

  // A bare name skips the default `build`: it runs nothing, and matched,
  // `vx run build` in a project declaring none ran 0 tasks, exit 0 (X-102).
  // A dependant's `^build` still reaches it, and `lib#build` names it.
  const requested = expandRequested(tasks, candidateProjects, projects, isDefaultBuild)
  let unresolvedTasks = unresolvedRequests(tasks, candidateProjects, projects, isDefaultBuild)
  // A diff that changed only config-less projects loads none of them: no
  // candidate to ask, so every bare name is still to judge, or a typo ran
  // nothing, exit 0.
  if (options.selectedByDiff === true && candidateProjects.length === 0)
    unresolvedTasks = [...new Set([...tasks.filter((t) => !t.includes('#')), ...unresolvedTasks])]
  refuseUnlockedConfig(tasks, projects, projectMetas, workspaceRoot)
  // A scope that loaded no candidate judged no bare name: each is unresolved.
  if (options.projects !== undefined && options.selectedByDiff !== true)
    refuseUnlockedScope(
      candidateProjects.length === 0 ? tasks : unresolvedTasks,
      options.projects,
      projectMetas,
      workspaceRoot,
    )
  if (options.selectedByDiff === true && unresolvedTasks.some((t) => !t.includes('#'))) {
    // A name a loaded project declares is no typo, whether or not the load
    // was whole: an unaffected dependency loaded for the closure declared
    // it, and the run said no project did (C-3). Only what is still
    // unjudged pays for the rest of the workspace.
    unresolvedTasks = undeclaredIn(unresolvedTasks, projects)
    if (partialLoad && unresolvedTasks.some((t) => !t.includes('#'))) {
      unresolvedTasks = await declaredNowhere(unresolvedTasks, () =>
        loadProjects({ ...loadArgs, seeds: 'all', closure: false, staged: projects }),
      )
    }
  }
  // Run inside a project that lacks the task (`vx run typecheck` at a
  // root whose members declare it), the run said no project declares it.
  // Only a failing run pays for the rest of the workspace.
  let declaredElsewhere: string[] = []
  // A scope with no project to ask (a member with no vx config) leaves
  // every requested name unjudged.
  const bare = (candidateProjects.length === 0 ? tasks : unresolvedTasks).filter(
    (t) => !t.includes('#'),
  )
  if (options.projects !== undefined && options.selectedByDiff !== true && bare.length > 0) {
    let nowhere = undeclaredIn(bare, projects)
    if (nowhere.length > 0 && partialLoad) {
      nowhere = await declaredNowhere(nowhere, () =>
        loadProjects({ ...loadArgs, seeds: 'all', closure: false, staged: projects }),
      )
    }
    declaredElsewhere = bare.filter((t) => !nowhere.includes(t))
  }
  // A `pkg#task` run loads pkg's closure alone, so a typo'd pkg (or Nx's
  // short name for `@scope/pkg`) was measured against nothing and got no
  // "did you mean". Only a failing run pays for the rest of the workspace.
  let hintProjects: ReadonlyMap<string, ProjectEntry> = projects
  if (
    unresolvedTasks.some((t) => {
      const at = t.indexOf('#')
      return at > 0 && !projects.has(t.slice(0, at))
    })
  ) {
    try {
      hintProjects = (
        await loadProjects({ ...loadArgs, seeds: 'all', closure: false, staged: projects })
      ).projects
    } catch {
      // A config the scope skipped fails to load: no hint, the run's refusal stands.
    }
  }

  // Cache seam precedence: an EXPLICITLY injected remote layer
  // (RunOptions.remoteCache — a distribution agent or daemon that already
  // holds a wire client) wins outright; else a plugin's `cache` capability;
  // else the local cache alone. Core ships no wire client — the remote
  // cache is a plugin concern (docs/patterns.md § Remote cache wire). Injection
  // winning prevents double-wrapping when the workspace also declares a
  // cache plugin.
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
  const refs = options.remoteCache ? [] : cacheRefs(workspaceRoot, baseBranch, branchFacts.refs)
  try {
    cache = options.remoteCache
      ? new LayeredCache(localCache, remotes, options.uploadConcurrency)
      : await resolveCache(plugins, {
          workspaceRoot,
          cacheDir,
          warn: warnOf(log),
          scope: cacheScope,
          refs,
          localCache,
          policy,
          remotes,
          ...(options.uploadConcurrency !== undefined
            ? { uploadConcurrency: options.uploadConcurrency }
            : {}),
        })
  } catch (err) {
    // A cache plugin that throws or returns something off-contract is
    // refused by name; the local handle opened above must not leak with it,
    // nor what another plugin's factory opened: the factories have run
    // (C-4, item 1029's contract).
    await teardownPlugins(plugins, warnOf(log))
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
  // From here the plugins' factories have run and the cache is open: a
  // throw (a stage hook, a `^name` nobody declares, a cycle, an unknown
  // exclude name) closed neither and tore nothing down, once per failed
  // cycle under `vx watch` (item 1029). run() owns both only once this
  // returns.
  try {
    const hashCache = createHashCache(localCache.foldMemo())
    const fingerprintWatch = new FingerprintWatch(
      workspaceRoot,
      claimed,
      claimedBytes,
      fingerprintsAt,
    )

    // Empty-cases bookkeeping. We still construct the cache + watch
    // so the caller's try/finally pattern can close it uniformly.
    const emptyRun = (reason?: 'none-affected'): PreparedRun => ({
      workspaceRoot,
      workspaceConfig,
      plugins,
      cacheDir,
      cache,
      localCache,
      hasRemoteLayer,
      cachePolicy: policy,
      cacheScope,
      remotes,
      cacheRefs: refs,
      keepRunEntry: undefined,
      priorities: () => Promise.resolve(new Map()),
      branch,
      cacheFor: () => absentPluginCache,
      nodes: new Map(),
      keyOnly: new Map(),
      unresolvedTasks,
      declaredElsewhere,
      projects,
      hintProjects,
      anyProjectConfig: projectsWithConfigs.length > 0,
      taskless,
      unlockedConfig: () => unlockedConfigOf(projectsWithConfigs, projectMetas, workspaceRoot),
      fingerprintWatch,
      nestedDirsByProject,
      gitFilesCache: new GitFilesCache(),
      hashCache,
      workspaceProjectCount: projectMetas.length,
      empty:
        reason ??
        (options.selectedByDiff === true && unresolvedTasks.length === 0
          ? 'none-affected'
          : 'no-tasks-declared'),
    })
    if (requested.length === 0) return emptyRun()

    // The whole graph, whatever `--exclude-dependencies` says: the stages
    // below shape and key the tasks it drops as a full run would, because
    // a dropped task is still keyed (excluded-keys.ts). A scoped load is not
    // the whole workspace: a `^name` nothing loaded declares may be declared
    // by a config the scope left out, so the builder hands it back instead of
    // refusing it, and the rest decide.
    // A run never checks the graph rules: `vx lock` and `vx lock --check`
    // do (2026-10-14). `exclusiveOutputs: false` still asks the walk
    // for its addition marks.
    const graphRules: GraphRules = { ...runRules(workspaceConfig), locked: true }
    const unproven: Array<[taskId: string, name: string]> = []
    // Every config is the lock's only when it was read and no `project`
    // plugin edited one (graph-memo.ts).
    const lock =
      hashCache.folds !== undefined &&
      options.staged === undefined &&
      !allStaged &&
      !hasHook(plugins, 'project')
        ? lockDigest(await readLock())
        : undefined
    const graphMemo: GraphMemo | undefined =
      lock === undefined ? undefined : { folds: hashCache.folds!, lock, metas: projectMetas }
    const graphOf = (req: typeof requested) => {
      const built = memoGraph(
        {
          projects,
          packageGraph,
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
    const graphStage = (): Promise<void> =>
      applyGraphStage(plugins, nodes, {
        workspaceRoot,
        cacheDir,
        projectMetas,
        warn: warnOf(log),
        rules: graphRules,
      })
    // `--affected` selects over the FINAL graph: an edge or an input a
    // `graph` hook adds moves a key, so the hooks run first, over every
    // candidate, and the selection prunes what they left.
    const hooksFirst = hasGraphHook && options.affected !== undefined
    // `--affected` keeps a bare request only when the diff reaches its
    // closure; a `pkg#task` the user named runs as it always does.
    if (options.affected !== undefined) {
      const before = hooksFirst ? new Set(nodes.keys()) : null
      if (hooksFirst) await graphStage()
      const kept = keptByAffected(
        nodes,
        requested,
        options.affected,
        projects,
        packageGraph,
        {
          named: new Set(tasks.filter((t) => t.includes('#'))),
          outright: new Set(options.selectedOutright),
        },
        options.affectedReasons && { workspaceRoot, reasons: options.affectedReasons },
      )
      if (kept.length === 0) return emptyRun('none-affected')
      if (before !== null) {
        const asked = new Set(requested.map((r) => `${r.project}#${r.task}`))
        // What a hook added or asked for is the plugin's choice, kept as it
        // would be on a run without the diff.
        const roots = [
          ...kept.map((r) => `${r.project}#${r.task}`),
          ...[...nodes.values()]
            .filter((n) => !before.has(n.id) || (n.requested && !asked.has(n.id)))
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
    if (unproven.length > 0) {
      await refuseUndeclaredDeps(unproven, () =>
        loadProjects({ ...loadArgs, seeds: 'all', closure: false, staged: projects }),
      )
    }
    // An `--exclude-dependencies` name no project declares drops nothing:
    // `=biuld` planned the whole chain and ran it, exit 0 (item 1026). Every
    // other name the user types must resolve; so must this one. After the
    // graph, so a config error (`^biuld` nobody declares) is named first.
    const excludeNames = options.excludeDependencies
    if (Array.isArray(excludeNames) && excludeNames.length > 0) {
      const declared = new Set<string>()
      for (const p of projects.values())
        for (const t of Object.keys(p.config.tasks ?? {})) declared.add(t)
      let unknown = excludeNames.filter((n) => !declared.has(n))
      if (unknown.length > 0 && partialLoad) {
        unknown = await declaredNowhere(unknown, () =>
          loadProjects({ ...loadArgs, seeds: 'all', closure: false, staged: projects }),
        )
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
    // The graph is built; what follows is git's enumeration over its
    // projects, then the plugins' stages (graph, key, schedule). Separate
    // rows, so a plugin's key stage reads as its own cost and not as graph
    // building — a lockfile plugin's 1000 stats per run hid inside one
    // `prepare (graph)` row until 2026-09-10.
    mark('build graph')
    const gitFilesCache = new GitFilesCache()
    gitFilesCache.vxDirs = withinRoot(workspaceRoot, cacheDir)
    // Bulk-populate via a single `git ls-files` at the workspace root —
    // partitions the output by project. Avoids one fork+exec per project
    // (~5-10ms each on Linux; the dominant cold-start cost on big
    // monorepos). When any task in the graph declares inputs.workspaceFiles,
    // the enumeration must see every file from the root (no pathspec
    // scoping) and additionally stores a workspace-wide partition.
    // Over the projects that own a task, not every project loaded: a scoped
    // run loads its dependency closure for the `^` walk, and a `lint` of one
    // package walked the whole tree for it (~60 ms of git where one
    // project's pathspec takes ~7, 1,000 projects). A node a `graph` hook
    // adds in another project keys through `resolveFiles`' own spawn.
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
    const settleIgnored = askIgnoredOutputs(gatedOutputs(nodes, workspaceRoot), workspaceRoot)
    const enumeration = await enumerating
    await applyGitEnumeration(
      enumeration,
      workspaceRoot,
      projectDirs,
      gitFilesCache,
      usesWorkspaceInputs,
      localCache,
    )
    await settleIgnored(gitFilesCache)
    mark('git enumeration')
    if (hasGraphHook && !hooksFirst) await graphStage()
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
      await applyKeyHooks(plugins, nodes, { workspaceRoot, cacheDir, warn: warnOf(log) })
    }
    refuseFiltersThroughGroups(nodes)
    const exclude = options.excludeDependencies
    // The nodes are what the graph token names only while nothing edited them.
    if (
      hasGraphHook ||
      hasHook(plugins, 'key') ||
      (exclude !== undefined && (exclude === 'all' || exclude.length > 0))
    )
      hashCache.graph = undefined
    let keyOnly: ReadonlyMap<string, TaskNode> = new Map()
    if (exclude !== undefined && (exclude === 'all' || exclude.length > 0)) {
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
    const pluginCaches = new Map<string, PluginCache>()
    const cacheFor = (plugin: string): PluginCache => {
      let own = pluginCaches.get(plugin)
      if (own === undefined) {
        own = pluginCache(plugin, {
          db: localCache.dbHandle(),
          policy,
          remotes,
          scope: cacheScope,
        })
        pluginCaches.set(plugin, own)
      }
      return own
    }
    let scheduled: Promise<ReadonlyMap<string, number>> | undefined
    const priorities = (run?: ScheduleRun): Promise<ReadonlyMap<string, number>> =>
      (scheduled ??= hasHook(plugins, 'schedule')
        ? applyScheduleHooks(
            plugins,
            nodes,
            {
              workspaceRoot,
              cacheDir,
              warn: warnOf(log),
              localCache,
              branch: branch(),
              refs,
            },
            cacheFor,
            run,
          )
        : Promise.resolve(new Map()))

    return {
      workspaceRoot,
      workspaceConfig,
      plugins,
      cacheDir,
      cache,
      localCache,
      hasRemoteLayer,
      cachePolicy: policy,
      cacheScope,
      remotes,
      cacheRefs: refs,
      priorities,
      branch,
      cacheFor,
      keepRunEntry: writesRunStore(remotes)
        ? (name, bytes) => putRunEntry(remotes, cacheScope, name, bytes)
        : undefined,
      nodes,
      keyOnly,
      unresolvedTasks,
      declaredElsewhere,
      projects,
      hintProjects,
      anyProjectConfig: projectsWithConfigs.length > 0,
      taskless,
      unlockedConfig: () => unlockedConfigOf(projectsWithConfigs, projectMetas, workspaceRoot),
      fingerprintWatch,
      nestedDirsByProject,
      gitFilesCache,
      hashCache,
      workspaceProjectCount: projectMetas.length,
      empty: nodes.size === 0 ? 'empty-graph' : null,
    }
  } catch (err) {
    await teardownPlugins(plugins, warnOf(log))
    cache.close()
    throw err
  }
}

/**
 * The names in `unresolved` no project in the whole workspace declares: an
 * anchored `pkg#task` stays as it is, a bare name leaves when a config the
 * diff's scope left out declares it. `load` evaluates those configs; one
 * failing to load leaves every name as it was, so the guard still speaks.
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

/**
 * The bare names in `unresolved` no project in `projects` declares; `a#b`
 * forms pass through. Every project has a `build`, its default one if
 * nothing declares it, and a bare name does not select that (X-102).
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
 * Refuses the first `^name` in `unproven` that no project in the whole
 * workspace declares. `load` reads the locked configs a scoped run left out;
 * it is reached only when a `^name` found no holder and nothing loaded
 * declares it, so a run that names only declared tasks never pays for it.
 * The rest failing to load leaves the names unjudged: an out-of-scope
 * broken config does not fail a scoped run.
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
 * Drops every node outside the `dependsOn` closure of `roots`, and demotes a
 * requested one only a kept task pulls in: what a rebuild from the kept
 * requests would hold, with the `graph` hooks' edits kept.
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

/**
 * The workspace's `cache.policy`, parsed: the schema checks only its shape,
 * since the grammar lives in the cache module the workspace module may not
 * import. Undefined when it names none.
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
      `.vx/workspace: \`cache.policy\`: ${err instanceof Error ? err.message : String(err)}`,
      'VX_E_CONFIG',
    )
  }
}

/** A config no locked project has, looked for only when the lock holds none. */
function unlockedConfigOf(
  configured: readonly unknown[],
  metas: ReadonlyArray<{ dir: string }>,
  workspaceRoot: string,
): string | undefined {
  if (configured.length > 0) return undefined
  for (const m of metas) {
    const config = PROJECT_CONFIG_FILENAMES.find((n) => existsSync(path.join(m.dir, n)))
    if (config !== undefined) return relPosix(workspaceRoot, path.join(m.dir, config))
  }
  return undefined
}

/**
 * A `project#build` naming the default `build` of a project the lock holds
 * no config for (or no project at all), while its directory holds one, asks for that config's task, not
 * one that runs nothing: ran, `c#build` was 0 tasks, exit 0, where a
 * renamed task gets "run `vx lock`" (Growth, lock drift).
 */
function refuseUnlockedConfig(
  tasks: readonly string[],
  projects: ReadonlyMap<string, ProjectEntry>,
  metas: ReadonlyArray<{ name: string; dir: string; configPath?: string | null }>,
  workspaceRoot: string,
): void {
  for (const spec of tasks) {
    const at = spec.indexOf('#')
    if (at < 0) continue
    const name = spec.slice(0, at)
    const entry = projects.get(name)
    // No entry: a package the lock holds no project for, whose config came after it.
    if (entry !== undefined && !isDefaultBuild(entry.config.tasks?.[spec.slice(at + 1)])) continue
    const config = unlockedConfig(name, metas)
    if (config === undefined) continue
    throw new UserError(
      `${spec}: ${relPosix(workspaceRoot, config)} is not in the lock yet — run \`vx lock\``,
      'VX_E_LOCK',
    )
  }
}

/**
 * The same for a bare name the selection (the cwd's project, `--filter`)
 * left unresolved: run from a member whose config came after the lock, it
 * said only projects outside the selection declare the task — pass
 * `--all`, which skips that member too.
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
    throw new UserError(
      `${spec}: ${relPosix(workspaceRoot, config)} is not in the lock yet — run \`vx lock\``,
      'VX_E_LOCK',
    )
  }
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
 * Each remote's `open`, in declared order, for the ones the policy lets read
 * or write. One at a time: two that ask on the terminal must not interleave.
 * A throw warns through the remote's `onError` (naming its plugin) and
 * turns that remote off; the run goes on, as after any remote failure.
 * True when that left the run no remote at all.
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
 * `dir` spelled under `root` as the run spells the root, when it lies
 * there; compared through links, so a root reached by a symlink (macOS's
 * `/var/folders`) still finds a cache directory written canonical.
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
