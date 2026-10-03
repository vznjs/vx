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
import { mark, nearest, UserError } from '../util/index.js'
import {
  Cache,
  noteSchemaReset,
  type CacheLayer,
  type CachePolicy,
  FULL_CACHE_POLICY,
  scopeCachePolicy,
  GitFilesCache,
  LayeredCache,
  applyGitEnumeration,
  gitPathspecs,
  MAX_SCOPED_PATHSPECS,
  startGitEnumeration,
  lazyGitEnumeration,
} from '../cache/index.js'
import {
  buildPackageGraph,
  computeNestedProjectDirs,
  computeWorkspaceFingerprints,
  findWorkspaceRoot,
  type LoadReads,
  loadWorkspace,
  FROZEN_WITHOUT_LOCK,
  type Lockfile,
  readLockfile,
  resolveCacheDir,
  type ProjectEntry,
} from '../workspace/index.js'
import {
  buildTaskGraph,
  excludeDependencies,
  expandRequested,
  type TaskNode,
  undeclaredDepsError,
  unresolvedRequests,
} from '../graph/index.js'
import {
  applyGraphHooks,
  applyKeyHooks,
  applyScheduleHooks,
  fingerprintClaims,
  hasHook,
  resolveCache,
  teardownPlugins,
} from './plugin-host.js'
import {
  discoverProjects,
  gitOfDiscovery,
  graphOfDiscovery,
  loadProjects,
  loadWorkspacePlugins,
  type LoadedProjects,
} from './projects.js'
import { keyExcludedDependencies } from './excluded-keys.js'
import { FingerprintWatch } from './fingerprint-watch.js'
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
  /** `--cache` with the workspace's `cacheScope` applied: what the layers were built under. */
  cachePolicy: CachePolicy
  /**
   * Scheduling priorities from plugins' `schedule` stage (task id → weight,
   * merged over the structural baseline by the scheduler). Empty when no
   * plugin declares the stage.
   */
  priorities: ReadonlyMap<string, number>
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
  workspaceFingerprint: string
  /** Whether a task has since rewritten what that fingerprint folded (fingerprint-watch.ts). */
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
   *   - `'none-affected'`     — as `'no-tasks-declared'`, but the scope
   *     came from a diff and every name is declared somewhere else in the
   *     workspace: nothing changed that runs them, a clean outcome.
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
  mark('startup')
  // The root manifest is read once for the root, the globs and the
  // fingerprint. A watch cycle is a new run and reads it afresh.
  const reads: LoadReads = new Map()
  const workspaceRoot = await findWorkspaceRoot(options.cwd, reads)
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
  const reused = options.discovered?.root === workspaceRoot ? options.discovered : undefined
  const git =
    (reused !== undefined ? gitOfDiscovery(reused.projects) : undefined) ??
    lazyGitEnumeration(workspaceRoot)
  if (wholeTree) void git.start()
  const workspace = await loadWorkspace(workspaceRoot, reads)
  const { workspaceConfig, plugins } = await loadWorkspacePlugins(workspaceRoot, (m) =>
    log.status(m),
  )
  mark('workspace config')
  // `--cache-dir <path>` (RunOptions.cacheDir) overrides the workspace
  // `cacheDir` field + the `.vx/cache` default; resolved relative to cwd.
  const cacheDir = options.cacheDir
    ? path.resolve(options.cwd, options.cacheDir)
    : resolveCacheDir(workspaceRoot, workspaceConfig)
  const projectMetas =
    reused !== undefined
      ? reused.projects
      : await discoverProjects(workspace, plugins, cacheDir, (m) => log.status(m), git)
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
  // task, the root named by its package.json name here (D-39).
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
  // graph 3-8 ms against the cache open's ~1 ms and the fingerprints' ~0.3),
  // so a reader profiling that stage was sent to the wrong code.
  mark('package graph')

  // The local cache opens BEFORE the configs load: it is also where their
  // cached evaluations live.
  const policy: CachePolicy = scopeCachePolicy(
    options.cache ?? FULL_CACHE_POLICY,
    workspaceConfig?.cacheScope,
  )
  const localCache = new Cache(
    cacheDir,
    { read: policy.localRead, write: policy.localWrite },
    workspaceRoot,
    options.artifactCeiling,
  )
  localCache.assertWritable()
  noteSchemaReset(localCache, (m) => log.status(m))
  // Two digests from one read: the config-evaluation cache keys on every
  // file (a config may import a dependency), the task keys on the files no
  // plugin claims (`VxPlugin.fingerprint`).
  const fingerprintsAt = Date.now()
  const fingerprints = await computeWorkspaceFingerprints(
    workspaceRoot,
    new Set(fingerprintClaims(plugins).keys()),
    reads,
  )
  const workspaceFingerprint = fingerprints.unclaimed
  mark('open cache')

  // Frozen mode (--frozen, CI): configs load FROM vx-lock.json with no
  // evaluation and no check of the config bytes (`vx lock --check`
  // compares `configHash`; a run does not); env-dependent configs keep
  // their locked values. Default (local) runs ALWAYS evaluate live:
  // a byte hash can't see a config's import closure (shared presets),
  // so consuming the lock by default would silently serve stale
  // freezes. `vx lock --check` is the full re-evaluation audit.
  // See docs/design/config-lock-2026-06.md.
  // Read once, and only when a config is to be read from it: the CLI's
  // selection pass may have staged every config (`options.staged`), and
  // its load refused a frozen run without a lock. A 1,000-project lock is
  // 1.1 MB of JSON (I-27).
  let lockRead: Promise<Lockfile> | undefined
  const readLock = (): Promise<Lockfile> =>
    (lockRead ??= readLockfile(workspaceRoot).then((read) => {
      if (read === null) throw new UserError(FROZEN_WITHOUT_LOCK)
      return read
    }))
  const staged = options.staged
  const allStaged =
    staged !== undefined &&
    projectMetas.every(
      (m) => typeof m.configPath !== 'string' || m.configPath === '' || staged.has(m.name),
    )
  if (options.frozen === true && !allStaged) await readLock()
  const lock = options.frozen === true ? readLock : null

  const loadArgs = {
    workspaceRoot,
    cacheDir,
    plugins,
    projectMetas,
    packageGraph,
    lock,
    evalCache: { store: localCache, workspaceRoot, workspaceFingerprint: fingerprints.all },
    warn: (m: string) => log.status(m),
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

  const requested = expandRequested(tasks, candidateProjects, projects)
  let unresolvedTasks = unresolvedRequests(tasks, candidateProjects, projects)
  if (options.selectedByDiff === true && unresolvedTasks.some((t) => !t.includes('#'))) {
    // A name a loaded project declares is no typo, whether or not the load
    // was whole: an unaffected dependency loaded for the closure declared
    // it, and the run said no project did (C-3). Only what is still
    // unjudged pays for the rest of the workspace.
    unresolvedTasks = undeclaredIn(unresolvedTasks, projects)
    if (
      projects.size < projectsWithConfigs.length &&
      unresolvedTasks.some((t) => !t.includes('#'))
    ) {
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
    if (nowhere.length > 0 && projectsWithConfigs.some((m) => !projects.has(m.name))) {
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
    // refused by name; the local handle opened above must not leak with it,
    // nor what another plugin's factory opened: the factories have run
    // (C-4, item 1029's contract).
    await teardownPlugins(plugins, (m) => log.status(m))
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
    const hashCache = createHashCache()
    const fingerprintWatch = new FingerprintWatch(workspaceRoot, fingerprints, fingerprintsAt)

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
        cachePolicy: policy,
        priorities: new Map(),
        nodes: new Map(),
        keyOnly: new Map(),
        unresolvedTasks,
        declaredElsewhere,
        projects,
        hintProjects,
        anyProjectConfig: projectsWithConfigs.length > 0,
        workspaceFingerprint,
        fingerprintWatch,
        nestedDirsByProject,
        gitFilesCache: new GitFilesCache(),
        hashCache,
        workspaceProjectCount: projectMetas.length,
        empty:
          options.selectedByDiff === true && unresolvedTasks.length === 0
            ? 'none-affected'
            : 'no-tasks-declared',
      }
    }

    // The whole graph, whatever `--exclude-dependencies` says: the stages
    // below shape and key the tasks it drops as a full run would, because
    // a dropped task is still keyed (excluded-keys.ts). A scoped load is not
    // the whole workspace: a `^name` nothing loaded declares may be declared
    // by a config the scope left out, so the builder hands it back instead of
    // refusing it, and the rest decide.
    const unproven: Array<[taskId: string, name: string]> = []
    const nodes = buildTaskGraph({
      projects,
      packageGraph,
      requested,
      workspaceRoot,
      ...(projects.size < projectsWithConfigs.length
        ? { undeclaredDeps: (id: string, name: string) => void unproven.push([id, name]) }
        : {}),
    })
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
      if (unknown.length > 0 && projects.size < projectsWithConfigs.length) {
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
      if ((n.config.cache?.inputs.workspaceFiles?.length ?? 0) > 0) usesWorkspaceInputs = true
    }
    const projectDirs = [...graphDirs]
    const enumeration = await (git.started ??
      startGitEnumeration(
        workspaceRoot,
        gitPathspecs(workspaceRoot, projectDirs, usesWorkspaceInputs),
      ))
    await applyGitEnumeration(
      enumeration,
      workspaceRoot,
      projectDirs,
      gitFilesCache,
      usesWorkspaceInputs,
      localCache,
    )
    mark('git enumeration')
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
    const exclude = options.excludeDependencies
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
          workspaceFingerprint,
          forwardArgs: options.forwardArgs,
          nestedDirsByProject,
          gitFilesCache,
          hashCache,
        })
      }
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
      cachePolicy: policy,
      priorities,
      nodes,
      keyOnly,
      unresolvedTasks,
      declaredElsewhere,
      projects,
      hintProjects,
      anyProjectConfig: projectsWithConfigs.length > 0,
      workspaceFingerprint,
      fingerprintWatch,
      nestedDirsByProject,
      gitFilesCache,
      hashCache,
      workspaceProjectCount: projectMetas.length,
      empty: nodes.size === 0 ? 'empty-graph' : null,
    }
  } catch (err) {
    await teardownPlugins(plugins, (m) => log.status(m))
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

/** The bare names in `unresolved` no project in `projects` declares; `a#b` forms pass through. */
function undeclaredIn(
  unresolved: readonly string[],
  projects: LoadedProjects['projects'],
): string[] {
  const declared = new Set<string>()
  for (const p of projects.values()) {
    for (const t of Object.keys(p.config.tasks ?? {})) declared.add(t)
  }
  return unresolved.filter((t) => t.includes('#') || !declared.has(t))
}

/**
 * Refuses the first `^name` in `unproven` that no project in the whole
 * workspace declares. `load` evaluates the configs a scoped run left out;
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
    if (!declared.has(name)) throw undeclaredDepsError(id, name)
  }
}
