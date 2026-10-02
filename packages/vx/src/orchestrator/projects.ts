// The project-config load every consumer of "what tasks exist" shares:
// `prepareRun` (a run, a plan) and `vx show` (introspection). One code
// path, so what `show` prints is what a run would see — including the
// plugin `project` stage, which can give tasks to a package that never
// wrote a `vx.config.ts`.

import path from 'node:path'
import type { ProjectConfig } from '../config.js'
import {
  frozenProjectConfigs,
  loadProjectConfigs,
  validateProjectConfig,
  type LoadProjectConfigOptions,
  type LoadReads,
  type Lockfile,
  type PackageGraph,
  type ProjectEntry,
  type ProjectMeta,
  type Workspace,
} from '../workspace/index.js'
import type { WorkspaceConfig } from '../config.js'
import { Cache, lazyGitEnumeration, type LazyGitEnumeration } from '../cache/index.js'
import { UserError } from '../util/index.js'
import {
  computeWorkspaceFingerprint,
  listProjects,
  loadWorkspace,
  loadWorkspaceConfig,
  namedProject,
  resolveCacheDir,
  validateWorkspace,
} from '../workspace/index.js'
import { parseDependencySpec } from '../graph/index.js'
import { applyConfigHooks, applyDiscoverHooks, applyProjectHooks, hasHook } from './plugin-host.js'
import type { VxPlugin } from './plugin.js'

/**
 * The workspace config with the plugin `config` stage applied — the first
 * stage of the pipeline, run before anything is derived from the config.
 * The plugin list itself is already fixed by then.
 */
export async function loadWorkspacePlugins(
  workspaceRoot: string,
  warn: (message: string) => void,
): Promise<{ workspaceConfig: WorkspaceConfig | null; plugins: readonly VxPlugin[] }> {
  const workspaceConfig = await loadWorkspaceConfig(workspaceRoot)
  const plugins = (workspaceConfig?.plugins ?? []) as readonly VxPlugin[]
  if (workspaceConfig !== null && hasHook(plugins, 'config')) {
    // Re-validated after each plugin, as the `project` stage is: an edit
    // the loader would refuse from a user (`concurrency: -3`) hung the run,
    // and `cacheDir: 42` reached `path.resolve` as a TypeError.
    await applyConfigHooks(plugins, workspaceConfig, { workspaceRoot, warn }, (plugin) =>
      validateWorkspace(workspaceConfig, `vx.workspace (after plugin '${plugin.name}')`),
    )
  }
  return { workspaceConfig, plugins }
}

/**
 * The enumeration a discovery's `discover` hooks shared, by the array it
 * returned: a run handed that array (`RunOptions.discovered`, the CLI's
 * `--filter` pass) reuses the walk a hook started instead of a second one.
 */
const discoveredGit = new WeakMap<readonly ProjectMeta[], LazyGitEnumeration>()

export function gitOfDiscovery(projects: readonly ProjectMeta[]): LazyGitEnumeration | undefined {
  return discoveredGit.get(projects)
}

/**
 * The workspace's projects: core's discovery, then the plugin `discover`
 * stage. With no plugin declaring it, `listProjects` alone.
 */
export async function discoverProjects(
  workspace: Workspace,
  plugins: readonly VxPlugin[],
  cacheDir: string,
  warn: (message: string) => void,
  /** The run's enumeration, which `DiscoverContext.worktreeChanges` reads (and starts). */
  git: LazyGitEnumeration = lazyGitEnumeration(workspace.root),
): Promise<ProjectMeta[]> {
  const projects = await listProjects(workspace)
  // Registered whatever the hooks: an `--affected` selection reads its
  // untracked files from this walk, and the run reuses it (I-26).
  discoveredGit.set(projects, git)
  if (!hasHook(plugins, 'discover')) return projects
  const worktreeChanges = (): Promise<readonly string[] | null> =>
    git.start().then(
      (e) => e.changed,
      () => null,
    )
  await applyDiscoverHooks(
    plugins,
    projects,
    { workspaceRoot: workspace.root, cacheDir, warn, worktreeChanges },
    (named, plugin) => namedProject(workspace, projects, named, plugin.name),
  )
  return projects.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
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
   * config-less ones are ignored). With `closure`, each seed's transitive
   * package dependencies load too, which bounds `^task` frontier
   * expansion; a `pkg#task` dependsOn entry pulls its project in either
   * way, since the package graph cannot see the cross form.
   */
  seeds: 'all' | Iterable<string>
  /** Read configs from the lock instead of evaluating them (`--frozen`). */
  lock: Lockfile | null
  evalCache: LoadProjectConfigOptions['evalCache']
  warn: (message: string) => void
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
   * fills the `project` stage and may give it tasks. Boundary geometry
   * fences all of them, loaded or not.
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
  const { plugins, lock, workspaceRoot } = args
  const graph = args.closure ? args.packageGraph : null
  // A package with no config file declares no tasks — unless a plugin
  // fills the `project` stage, in which case it is a project the stage may
  // give tasks to (the zero-migration shape: `turbo.json` or `package.json`
  // scripts mapped onto packages that never wrote a `vx.config.ts`). It
  // then loads as `{ tasks: {} }` — nothing to evaluate, nothing to freeze
  // — and the stage runs on that like on any loaded config. With no
  // `project` plugin a plain run never visits (or fences, or seeds) a
  // config-less package.
  const projectStage = hasHook(plugins, 'project')
  const configured = args.projectMetas.filter(
    (m) => projectStage || (typeof m.configPath === 'string' && m.configPath.length > 0),
  )
  const metaByName = new Map<string, ProjectMeta>(configured.map((m) => [m.name, m]))
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
  const seeds = args.seeds === 'all' ? metaByName.keys() : [...args.seeds]
  for (const seed of seeds) consider(seed)
  if (graph !== null && pending.length < metaByName.size) {
    for (const seed of args.seeds === 'all' ? metaByName.keys() : seeds) {
      considerWithDeps(graph, seed)
    }
  }

  // Load in rounds to a fixpoint. A `pkg#task` dependsOn entry names a
  // project the PACKAGE graph cannot reach (the cross form ignores npm
  // deps by design), so its config has to be pulled in — and that config
  // may declare cross edges of its own. The common case (no cross deps)
  // is a single round, identical to loading the closure in one batch.
  // Turbo spells the root package `//` (`dependsOn: ['//#lint']`); vx names
  // the root project by its package.json name, so the spelling is rewritten
  // to it once, here, for the closure, the graph and `cache.inputs.tasks`
  // alike. With no root project it stays, and the graph's refusal says so.
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
    const loaded = lock
      ? await frozenProjectConfigs(lock, withFile, workspaceRoot, args.evalCache?.store)
      : await loadProjectConfigs(
          withFile.map((m) => m.configPath),
          args.evalCache !== undefined ? { evalCache: args.evalCache } : {},
        )
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
        await applyProjectHooks(
          plugins,
          config,
          {
            workspaceRoot,
            cacheDir: args.cacheDir,
            warn: args.warn,
            name: meta.name,
            dir: meta.dir,
            packageJson: meta.packageJson as unknown as Readonly<Record<string, unknown>>,
            projects: args.projectMetas,
          },
          (plugin) => validateProjectConfig(config, `${where} (after plugin '${plugin.name}')`),
        )
      }
      const named = rootName === undefined ? config : rootSpelled(config, rootName)
      projects.set(meta.name, { name: meta.name, dir: meta.dir, config: named })
      for (const name of crossDepProjects(named)) {
        if (graph !== null) considerWithDeps(graph, name)
        else consider(name)
      }
    }
  }
  return { projects, configured }
}

/**
 * `config` with Turbo's `//#task` (in `dependsOn` and `cache.inputs.tasks`)
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
    const inputTasks = fix(task.cache?.inputs?.tasks)
    if (dependsOn === task.dependsOn && inputTasks === task.cache?.inputs?.tasks) continue
    tasks ??= { ...config.tasks }
    tasks[name] = {
      ...task,
      ...(dependsOn !== undefined ? { dependsOn: [...dependsOn] } : {}),
      ...(task.cache?.inputs !== undefined && inputTasks !== undefined
        ? { cache: { ...task.cache, inputs: { ...task.cache.inputs, tasks: [...inputTasks] } } }
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
 * The run path's view of a workspace's projects for a reader — `vx show`,
 * the MCP server, an embedder: discovery, the plugin `config` and
 * `project` stages, and the local cache opened only to serve cached
 * evaluations, so a pure config costs a stat, not an evaluation. `scope`
 * is every project or a list of names; no closure, no lock (a reader
 * reads live, as a default run does). Plugin warnings go to `warn`.
 */
export async function loadResolvedProjects(
  workspaceRoot: string,
  opts: { scope?: 'all' | readonly string[]; warn?: (message: string) => void } = {},
): Promise<Map<string, ProjectEntry>> {
  const warn = opts.warn ?? ((): void => {})
  const reads: LoadReads = new Map()
  const { workspaceConfig, plugins } = await loadWorkspacePlugins(workspaceRoot, warn)
  const cacheDir = resolveCacheDir(workspaceRoot, workspaceConfig)
  const metas = await discoverProjects(
    await loadWorkspace(workspaceRoot, reads),
    plugins,
    cacheDir,
    warn,
  )
  // Opened as `vx last` opens it: a reader makes no index where there is
  // none and never resets an earlier schema's (C-5). One it cannot read
  // serves nothing; the configs evaluate live.
  let cache: Cache | undefined
  try {
    cache = Cache.inspect(cacheDir)
  } catch (err) {
    if (!(err instanceof UserError)) throw err
  }
  try {
    const loaded = await loadProjects({
      workspaceRoot,
      cacheDir,
      plugins,
      projectMetas: metas,
      seeds: opts.scope ?? 'all',
      closure: false,
      lock: null,
      evalCache:
        cache === undefined
          ? undefined
          : {
              store: cache,
              workspaceRoot,
              workspaceFingerprint: await computeWorkspaceFingerprint(workspaceRoot, reads),
            },
      warn,
    })
    return loaded.projects
  } finally {
    cache?.close()
  }
}
