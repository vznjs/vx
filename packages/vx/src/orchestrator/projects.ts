// The project-config load every consumer of "what tasks exist" shares:
// `prepareRun` (a run, a plan) and `vx show` (introspection). One code
// path, so what `show` prints is what a run would see — including the
// plugin `project` stage, which can give tasks to a package that never
// wrote a `vx.config.ts`.

import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectConfig } from '../config.js'
import {
  checkProjectNames,
  frozenProjectConfigs,
  LOCKFILE_NAME,
  lockedProjects,
  NO_LOCK,
  pathName,
  readLockfile,
  validateProjectConfig,
  type Lockfile,
  type PackageGraph,
  type ProjectEntry,
  type ProjectMeta,
} from '../workspace/index.js'
import type { WorkspaceConfig } from '../config.js'
import { lazyGitEnumeration, type LazyGitEnumeration } from '../cache/index.js'
import { relPosix, UserError } from '../util/index.js'
import {
  cacheScopeError,
  isCacheScope,
  loadWorkspaceConfig,
  discoveredProject,
  linkDiscoveredEdges,
  resolveCacheDir,
  validateWorkspace,
} from '../workspace/index.js'
import { DEFAULT_BUILD, parseDependencySpec } from '../graph/index.js'
import { applyConfigHooks, applyDiscoverHooks, applyProjectHooks, hasHook } from './plugin-host.js'
import type { BranchFacts, VxPlugin } from './plugin.js'

/**
 * The workspace config with the plugin `config` stage applied — the first
 * stage of the pipeline, run before anything is derived from the config.
 * The plugin list itself is already fixed by then.
 */
export async function loadWorkspacePlugins(
  workspaceRoot: string,
  warn: (message: string) => void,
): Promise<{
  workspaceConfig: WorkspaceConfig | null
  plugins: readonly VxPlugin[]
  branch: BranchFacts
}> {
  const loaded = await loadWorkspaceConfig(workspaceRoot)
  const plugins = (loaded?.plugins ?? []) as readonly VxPlugin[]
  const branch: BranchFacts = {}
  if (loaded === null || !hasHook(plugins, 'config'))
    return { workspaceConfig: loaded, plugins, branch }
  // Bun keeps one module per specifier, so the file's export is one object
  // per process: the CLI's selection pass, the run and each `vx watch`
  // cycle handed the hooks what the last load's hooks had edited
  // (`concurrency *= 2` doubled per load). The hooks edit a copy; the file
  // holds data and plugins, and validation refused anything else.
  const { plugins: list, ...data } = loaded
  const workspaceConfig: WorkspaceConfig = {
    ...structuredClone(data),
    ...(list !== undefined ? { plugins: [...list] } : {}),
  }
  // Re-validated after each plugin, as the `project` stage is: an edit
  // the loader would refuse from a user (`concurrency: -3`) hung the run,
  // and `cacheDir: 42` reached `path.resolve` as a TypeError.
  const setBranch = (facts: BranchFacts): void => {
    if (facts.scope !== undefined && !isCacheScope(facts.scope))
      throw new UserError(`setBranch: ${cacheScopeError('scope')}`)
    if (facts.trusted === true) {
      delete branch.scope
      branch.trusted = true
    }
    if (facts.scope !== undefined) {
      branch.scope = facts.scope
      delete branch.trusted
    }
    if (facts.base !== undefined) branch.base = facts.base
    if (facts.refs !== undefined) {
      if (!Array.isArray(facts.refs) || facts.refs.some((r) => !isRef(r)))
        throw new UserError('setBranch: refs must be a list of refs, each starting "refs/"')
      branch.refs = [...new Set(facts.refs)]
    }
  }
  await applyConfigHooks(plugins, workspaceConfig, { workspaceRoot, warn, setBranch }, (plugin) => {
    const at = `.vx/workspace (after plugin '${plugin.name}')`
    validateWorkspace(workspaceConfig, at)
    // The run takes `plugins` from the file: an edited list validated and was dropped.
    const now = workspaceConfig.plugins
    if (now?.length !== list?.length || now?.some((p, i) => p !== list![i])) {
      throw new UserError(
        `${at}: \`plugins\` is fixed before the config stage, so an edit to it would change nothing — declare plugins in .vx/workspace`,
      )
    }
  })
  return { workspaceConfig, plugins, branch }
}

const isRef = (r: unknown): boolean =>
  typeof r === 'string' && r.startsWith('refs/') && !/[\s\0]/.test(r)

/**
 * The enumeration a discovery's `discover` hooks shared, by the array it
 * returned: a run handed that array (`RunOptions.discovered`, the CLI's
 * `--filter` pass) reuses the walk a hook started instead of a second one.
 */
const discoveredGit = new WeakMap<readonly ProjectMeta[], LazyGitEnumeration>()

export function gitOfDiscovery(projects: readonly ProjectMeta[]): LazyGitEnumeration | undefined {
  return discoveredGit.get(projects)
}

/** The lock a discovery read, by the array it returned: a later config load reads no second copy. */
const discoveredLock = new WeakMap<readonly ProjectMeta[], () => Promise<Lockfile>>()

export function lockOfDiscovery(
  projects: readonly ProjectMeta[],
): (() => Promise<Lockfile>) | undefined {
  return discoveredLock.get(projects)
}

/**
 * The package graph a selection pass built over a discovery, by that
 * discovery's array, when it folded no task edge in: the graph a run that
 * reuses the discovery (`RunOptions.discovered`) would build again.
 */
const discoveredGraph = new WeakMap<readonly ProjectMeta[], PackageGraph>()

export function graphOfDiscovery(projects: readonly ProjectMeta[]): PackageGraph | undefined {
  return discoveredGraph.get(projects)
}

export function keepDiscoveryGraph(projects: readonly ProjectMeta[], graph: PackageGraph): void {
  discoveredGraph.set(projects, graph)
}

/**
 * The workspace's projects: the directories the lock records (a run never
 * walks for configs), then the plugin `discover` stage, which may add
 * directories, name path-named ones and give edges. Sorted by name; two
 * projects of one name are refused.
 */
export async function discoverProjects(
  workspaceRoot: string,
  lock: () => Promise<Lockfile>,
  plugins: readonly VxPlugin[],
  cacheDir: string,
  warn: (message: string) => void,
  /** The run's enumeration, which `DiscoverContext.worktreeChanges` reads (and starts). */
  git: LazyGitEnumeration = lazyGitEnumeration(workspaceRoot),
): Promise<ProjectMeta[]> {
  const projects = lockedProjects(workspaceRoot, (await lock()).projects)
  // Registered whatever the hooks: an `--affected` selection reads its
  // untracked files from this walk, and the run reuses it (I-26).
  discoveredGit.set(projects, git)
  discoveredLock.set(projects, lock)
  if (!hasHook(plugins, 'discover')) return checkProjectNames(workspaceRoot, projects)
  const worktreeChanges = (): Promise<readonly string[] | null> =>
    git.start().then(
      (e) => e.changed,
      () => null,
    )
  const byDir = new Map(projects.map((p) => [p.dir, p]))
  const edges = await applyDiscoverHooks(
    plugins,
    projects,
    { workspaceRoot, cacheDir, warn, worktreeChanges },
    async (entry, plugin) => {
      const found = await discoveredProject(workspaceRoot, byDir, entry, plugin.name)
      if (found.added) byDir.set(found.meta.dir, found.meta)
      return found
    },
  )
  checkProjectNames(workspaceRoot, projects)
  linkDiscoveredEdges(workspaceRoot, projects, edges)
  return projects
}

export type LoadProjectsArgs = LoadProjectsBase &
  // The graph is read only for the closure: a load without one built it
  // for nothing (1,000 projects: ~10 ms, once per CLI selection pass).
  ({ closure: true; packageGraph: PackageGraph } | { closure: false; packageGraph?: PackageGraph })

interface LoadProjectsBase {
  workspaceRoot: string
  cacheDir: string
  plugins: readonly VxPlugin[]
  projectMetas: readonly ProjectMeta[]
  /**
   * Projects whose configs must load — `'all'`, or names (unknown and
   * config-less ones are ignored, unless a configured project's closure
   * reaches them, as in the `'all'` load). With `closure`, each seed's transitive
   * package dependencies load too, which bounds `^task` frontier
   * expansion; a `pkg#task` dependsOn entry pulls its project in either
   * way, since the package graph cannot see the cross form.
   */
  seeds: 'all' | Iterable<string>
  /**
   * The lock configs come from, asked only when a config is to be read (a
   * run whose every config the CLI's selection pass staged never parses
   * it). `vx lock` hands the one it is about to write.
   */
  configs: () => Promise<Lockfile>
  warn: (message: string) => void
  /** `vx lock`'s audit: the `project` stage's `ctx.lock`. */
  lock?: boolean
  /**
   * Entries a load in this same process already produced with the same
   * cache dir and lock (the CLI's selection pass, which stages every
   * config to walk `pkg#task` edges). Seeding and scoping run exactly as
   * without it; a project found here is taken as is instead of being
   * evaluated and put through the `project` stage a second time — the
   * stage's cost, and its warnings, once per run. Never carried across
   * runs: a config can change between them.
   */
  staged?: ReadonlyMap<string, ProjectEntry>
}

export interface LoadedProjects {
  projects: Map<string, ProjectEntry>
  /**
   * Every project that can carry tasks: it has a config file, or a plugin
   * fills the `project` stage and may give it tasks.
   */
  configured: readonly ProjectMeta[]
}

/**
 * SCOPED config loading: configs are programs, and evaluating 1090 of
 * them costs ~200 ms — the dominant fixed cost of small runs. Only the
 * seeds, their closure and any project a `pkg#task` entry names can
 * contribute graph nodes, so only those configs are evaluated. Side
 * effect, deliberate and Turbo-like: a broken config in an unrelated
 * package does not fail a scoped run — it surfaces when that package
 * enters scope.
 */
export async function loadProjects(args: LoadProjectsArgs): Promise<LoadedProjects> {
  const { plugins, workspaceRoot } = args
  const lock = args.configs
  const graph = args.closure ? args.packageGraph : null
  // A package with no config file declares no tasks — unless a plugin
  // fills the `project` stage, in which case it is a project the stage may
  // give tasks to (the zero-migration shape: `turbo.json` or `package.json`
  // scripts mapped onto packages that never wrote a `vx.config.ts`). It
  // then loads as `{ tasks: {} }` — nothing to evaluate, nothing to freeze
  // — and the stage runs on that like on any loaded config. With no
  // `project` plugin a plain run never seeds a config-less
  // package, but loads one a loaded project's closure reaches: it gets the
  // default `build`, so a dependant bundling its source is keyed on it
  // behind `^build`. Left out, its edit replayed the dependant's stale
  // output as a hit (X-9).
  const projectStage = hasHook(plugins, 'project')
  const configured = args.projectMetas.filter(
    (m) => projectStage || (typeof m.configPath === 'string' && m.configPath.length > 0),
  )
  const metaByName = new Map<string, ProjectMeta>(args.projectMetas.map((m) => [m.name, m]))
  const needed = new Set<string>()
  const pending: ProjectMeta[] = []
  // Counted, not read off `pending`: a round empties `pending`, and a guard
  // on its length let every cross edge after the first round walk its
  // whole closure again (1,500 walks at 300 projects, item 932).
  let neededConfigured = 0
  const consider = (name: string): void => {
    if (needed.has(name)) return
    needed.add(name)
    const meta = metaByName.get(name)
    if (meta) {
      pending.push(meta)
      neededConfigured++
    }
  }
  const walked = new Set<string>()
  const considerWithDeps = (packageGraph: PackageGraph, name: string): void => {
    consider(name)
    // Every config-bearing project already considered: the closure can
    // add nothing, and asking for it would build the package graph's
    // transitive bitsets — a cost the unscoped run (every project a seed)
    // otherwise never pays. A closure already walked adds nothing either.
    if (neededConfigured === metaByName.size || walked.has(name)) return
    walked.add(name)
    for (const dep of packageGraph.transitiveDeps(name)) consider(dep)
  }
  const seedAll = (): Iterable<string> => configured.map((m) => m.name)
  // A named config-less seed loads only where the `'all'` load would load
  // it: a configured project's closure reaches it. Seeded as itself, it got
  // a default build `vx show` listed nowhere and no run of the workspace had
  // (`vx run lone#build` ran a group no dependant reaches).
  const configuredNames = new Set(configured.map((m) => m.name))
  const seedable = (name: string): boolean =>
    configuredNames.has(name) ||
    (graph !== null &&
      metaByName.has(name) &&
      graph.transitiveDependents(name).some((d) => configuredNames.has(d)))
  const seeds = args.seeds === 'all' ? seedAll() : [...args.seeds].filter(seedable)
  for (const seed of seeds) consider(seed)
  if (graph !== null && pending.length < metaByName.size) {
    for (const seed of args.seeds === 'all' ? seedAll() : seeds) {
      considerWithDeps(graph, seed)
    }
  }

  // Load in rounds to a fixpoint. A `pkg#task` dependsOn entry names a
  // project the PACKAGE graph cannot reach (the cross form ignores npm
  // deps by design), so its config has to be pulled in — and that config
  // may declare cross edges of its own. The common case (no cross deps)
  // is a single round, identical to loading the closure in one batch.
  // Turbo spells the root package `//` (`dependsOn: ['//#lint']`), as vx
  // names the root project unless something names it; a named root's
  // spelling is rewritten to its name once, here, for the closure, the
  // graph and `inputs.tasks` alike. With no root project it stays,
  // and the graph's refusal says so.
  const root = path.resolve(workspaceRoot)
  const rootName = args.projectMetas.find((m) => path.resolve(m.dir) === root)?.name
  const projects = new Map<string, ProjectEntry>()
  while (pending.length > 0) {
    const round = pending.splice(0, pending.length)
    // Only a config FILE is evaluated (or read from the lock); a
    // config-less project in the round starts from an empty task table,
    // and a project the caller already staged is neither.
    const withFile = round.filter(
      (m): m is ProjectMeta & { configPath: string } =>
        typeof m.configPath === 'string' && args.staged?.get(m.name) === undefined,
    )
    // A locked project whose config file is gone ran as locked, green,
    // though nothing declares it any more (X-144): asked only of the
    // configs this run reads.
    const present = await Promise.all(withFile.map((m) => Bun.file(m.configPath).exists()))
    const gone = withFile.find((_, i) => !present[i])
    if (gone !== undefined) {
      const rel = relPosix(workspaceRoot, gone.dir) || '.'
      const named = gone.name === pathName(workspaceRoot, gone.dir) ? '' : ` ("${gone.name}")`
      const file = relPosix(gone.dir, gone.configPath)
      // exists() says false for a file behind a directory this user may not
      // search too; asked only on this failure path, so a run pays no stat.
      const denied = await stat(gone.configPath).then(
        () => null,
        (err: NodeJS.ErrnoException) =>
          err.code === 'EACCES' || err.code === 'EPERM' ? err.code : null,
      )
      throw new UserError(
        denied !== null
          ? `${LOCKFILE_NAME} locks ${rel}${named}, but its ${file} is not readable by this user (${denied})`
          : `${LOCKFILE_NAME} locks ${rel}${named}, but its ${file} is gone — run \`vx lock\``,
      )
    }
    const loaded =
      withFile.length === 0 ? [] : frozenProjectConfigs(await lock(), withFile, workspaceRoot)
    let next = 0
    for (const meta of round) {
      const pre = args.staged?.get(meta.name)
      if (pre !== undefined) {
        projects.set(meta.name, pre)
        for (const name of crossDepProjects(pre.config)) {
          if (graph !== null) considerWithDeps(graph, name)
          else consider(name)
        }
        continue
      }
      const config: ProjectConfig =
        meta.configPath === null ? { tasks: {} } : (loaded[next++] as ProjectConfig)
      if (projectStage) {
        // The `project` stage edits the validated object in place; core
        // re-validates after EACH plugin so a plugin can only produce what
        // the loader accepts from a user, and the refusal names both the
        // config file and the plugin whose edit broke it.
        const where = meta.configPath ?? `${meta.name} (no config file)`
        const name = config.name
        await applyProjectHooks(
          plugins,
          config,
          {
            workspaceRoot,
            cacheDir: args.cacheDir,
            warn: args.warn,
            name: meta.name,
            dir: meta.dir,
            projects: args.projectMetas,
            lock: args.lock === true,
          },
          (plugin) => {
            const at = `${where} (after plugin '${plugin.name}')`
            validateProjectConfig(config, at, meta.configPath)
            // Projects are named and edged before any config loads: a new
            // `name` here validated, and the project kept its old one.
            if (config.name !== name) {
              throw new UserError(
                `${at}: project "${meta.name}" is named before the project stage, so \`name: ${JSON.stringify(config.name)}\` cannot rename it — a plugin names a project in its \`discover\` hook`,
              )
            }
          },
        )
      }
      const built = withDefaultBuild(config)
      const named = rootName === undefined ? built : rootSpelled(built, rootName)
      projects.set(meta.name, { name: meta.name, dir: meta.dir, config: named })
      for (const name of crossDepProjects(named)) {
        if (graph !== null) considerWithDeps(graph, name)
        else consider(name)
      }
    }
  }
  return { projects, configured }
}

function withDefaultBuild(config: ProjectConfig): ProjectConfig {
  if (config.tasks?.['build'] !== undefined) return config
  return { ...config, tasks: { ...config.tasks, build: DEFAULT_BUILD } }
}

/**
 * `config` with Turbo's `//#task` (in `dependsOn` and `inputs.tasks`)
 * spelled `<root>#task`; the same object when it holds none. A copy, not
 * an edit: a loaded config may be a cached or a frozen one.
 */
function rootSpelled(config: ProjectConfig, rootName: string): ProjectConfig {
  const fix = (list: readonly string[] | undefined): readonly string[] | undefined =>
    list?.some((e) => e.startsWith('//#') || e.startsWith('!//#'))
      ? list.map((e) => e.replace(/^(!?)\/\/#/, `$1${rootName}#`))
      : list
  let tasks: NonNullable<ProjectConfig['tasks']> | undefined
  for (const [name, task] of Object.entries(config.tasks ?? {})) {
    const dependsOn = fix(task.dependsOn)
    const inputTasks = fix(task.inputs?.tasks)
    if (dependsOn === task.dependsOn && inputTasks === task.inputs?.tasks) continue
    tasks ??= { ...config.tasks }
    tasks[name] = {
      ...task,
      ...(dependsOn !== undefined ? { dependsOn: [...dependsOn] } : {}),
      ...(task.inputs !== undefined && inputTasks !== undefined
        ? { inputs: { ...task.inputs, tasks: [...inputTasks] } }
        : {}),
    }
  }
  return tasks === undefined ? config : { ...config, tasks }
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
 * The run path's view of a workspace's projects for a reader — a plugin's
 * verb, an embedder: the lock, the plugin `config`, `discover` and
 * `project` stages. `scope` is every project or a list of names; no
 * closure. No lock is `NO_LOCK`. Plugin warnings go to `warn`.
 */
export async function loadResolvedProjects(
  workspaceRoot: string,
  opts: { scope?: 'all' | readonly string[]; warn?: (message: string) => void } = {},
): Promise<Map<string, ProjectEntry>> {
  const warn = opts.warn ?? ((): void => {})
  const { workspaceConfig, plugins } = await loadWorkspacePlugins(workspaceRoot, warn)
  const cacheDir = resolveCacheDir(workspaceRoot, workspaceConfig)
  const lock = lockReader(workspaceRoot)
  const metas = await discoverProjects(workspaceRoot, lock, plugins, cacheDir, warn)
  const loaded = await loadProjects({
    workspaceRoot,
    cacheDir,
    plugins,
    projectMetas: metas,
    seeds: opts.scope ?? 'all',
    closure: false,
    configs: lock,
    warn,
  })
  return loaded.projects
}

/** The lock, read once on first ask; no lock is `NO_LOCK`. */
export function lockReader(workspaceRoot: string): () => Promise<Lockfile> {
  let read: Promise<Lockfile> | undefined
  return () =>
    (read ??= readLockfile(workspaceRoot).then((lock) => {
      if (lock === null) throw new UserError(NO_LOCK)
      return lock
    }))
}
