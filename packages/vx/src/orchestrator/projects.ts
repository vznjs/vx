// The project-config load every consumer of "what tasks exist" shares:
// `prepareRun` (a run, a plan) and `vx show` (introspection). One code
// path, so what `show` prints is what a run would see — including the
// plugin `project` stage, which can give tasks to a package that never
// wrote a `vx.config.ts`. `vx lock` runs that stage and records what it
// left (`Lockfile.projectStage`); every other reader takes the record.

import { existsSync } from 'node:fs'
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
  PROJECT_CONFIG_FILENAMES,
  lockKey,
  readLockfile,
  validateProjectConfig,
  type DiscoveredLock,
  type DiscoverStageLock,
  type Lockfile,
  type PackageGraph,
  type ProjectEntry,
  type ProjectMeta,
} from '../workspace/index.js'
import type { WorkspaceConfig } from '../config.js'
import { atPath, SETTINGS } from '../settings.js'
import { lazyGitEnumeration, type LazyGitEnumeration, parseCachePolicy } from '../cache/index.js'
import {
  checkIgnoreSync,
  isUserError,
  relPosix,
  skipWorktreeSync,
  UserError,
} from '../util/index.js'
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
import { workspaceFile } from '../handoff.js'
import { applyConfigHooks, applyDiscoverHooks, applyProjectHooks, hasHook } from './plugin-host.js'
import type { BranchFacts, VxPlugin } from './plugin.js'
import { freezeDeep, readOnly } from './read-only.js'
import { type ExtraHashes, withExtraHashes } from './lockfile-claim.js'

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
  /** Setting path → the last plugin whose `config` hook changed it (`vx info`). */
  settingPlugins: ReadonlyMap<string, string>
}> {
  const loaded = await loadWorkspaceConfig(workspaceRoot)
  const policy = loaded?.cache?.policy
  if (policy !== undefined) {
    // The grammar is the cache module's, which the schema may not import:
    // checked here, where the file is known, so the refusal is framed.
    try {
      parseCachePolicy(policy)
    } catch (err) {
      const file = await workspaceFile(workspaceRoot)
      if (!isUserError(err) || file === null) throw err
      throw new UserError(`${file}: \`cache.policy\` ${err.message}`, 'VX_E_CONFIG')
    }
  }
  const plugins = (loaded?.plugins ?? []) as readonly VxPlugin[]
  const branch: BranchFacts = {}
  const settingPlugins = new Map<string, string>()
  if (loaded === null || !hasHook(plugins, 'config'))
    return { workspaceConfig: loaded, plugins, branch, settingPlugins }
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
    if (facts.base !== undefined) {
      // Read into `--affected`'s `...[<base>]` filter.
      if (typeof facts.base !== 'string' || !/^[^\s\0[\]-][^\s\0[\]]*$/.test(facts.base))
        throw new UserError('setBranch: base must be a commit or a ref')
      branch.base = facts.base
    }
    if (facts.refs !== undefined) {
      if (!Array.isArray(facts.refs) || facts.refs.some((r) => !isRef(r)))
        throw new UserError('setBranch: refs must be a list of refs, each starting "refs/"')
      branch.refs = [...new Set(facts.refs)]
    }
  }
  const settingPaths = SETTINGS.filter((s) => s.config !== false).map((s) => s.path)
  const settingValues = new Map(settingPaths.map((p) => [p, atPath(workspaceConfig, p)]))
  await applyConfigHooks(plugins, workspaceConfig, { workspaceRoot, warn, setBranch }, (plugin) => {
    const at = `.vx/workspace (after plugin '${plugin.name}')`
    validateWorkspace(workspaceConfig, at)
    for (const p of settingPaths) {
      const v = atPath(workspaceConfig, p)
      if (v === settingValues.get(p)) continue
      settingValues.set(p, v)
      settingPlugins.set(p, plugin.name)
    }
    // The run takes `plugins` from the file: an edited list validated and was dropped.
    const now = workspaceConfig.plugins
    if (now?.length !== list?.length || now?.some((p, i) => p !== list![i])) {
      throw new UserError(
        `${at}: \`plugins\` is fixed before the config stage, so an edit to it would change nothing — declare plugins in .vx/workspace`,
      )
    }
  })
  return { workspaceConfig, plugins, branch, settingPlugins }
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

type WorkspacePlugins = Awaited<ReturnType<typeof loadWorkspacePlugins>>

/**
 * The workspace a discovery's caller loaded (`loadWorkspacePlugins`), by the
 * discovery's array: a run handed that array (`RunOptions.discovered`) runs
 * the `config` stage no second time, and a plugin's warning prints once.
 */
const discoveredWorkspace = new WeakMap<readonly ProjectMeta[], WorkspacePlugins>()

export function keepDiscoveryWorkspace(
  projects: readonly ProjectMeta[],
  workspace: WorkspacePlugins,
): void {
  discoveredWorkspace.set(projects, workspace)
}

export function pluginsOfDiscovery(projects: readonly ProjectMeta[]): WorkspacePlugins | undefined {
  return discoveredWorkspace.get(projects)
}

/**
 * The run's extra-file hashes (`ExtraHashes`), by the discovery's array: a
 * discovery is one run's (`vx watch` discovers each cycle), and the CLI's
 * `--affected` pass, the `project` stage and the key share what `discover`
 * hashed.
 */
const discoveredHashes = new WeakMap<readonly ProjectMeta[], ExtraHashes>()

export function extraHashesOfDiscovery(projects: readonly ProjectMeta[]): ExtraHashes | undefined {
  return discoveredHashes.get(projects)
}

/** The lock a discovery read, by the array it returned: a later config load reads no second copy. */
const discoveredLock = new WeakMap<readonly ProjectMeta[], () => Promise<Lockfile>>()

export function lockOfDiscovery(
  projects: readonly ProjectMeta[],
): (() => Promise<Lockfile>) | undefined {
  return discoveredLock.get(projects)
}

/** The nested workspace roots (absolute) the lock a discovery read records, by the array it returned. */
const discoveredWalls = new WeakMap<readonly ProjectMeta[], readonly string[]>()

/**
 * Where every project's outputs stop besides its nested projects: the
 * nested workspaces `vx lock` found. None for an array no discovery made.
 */
export function nestedWorkspacesOf(projects: readonly ProjectMeta[]): readonly string[] {
  return discoveredWalls.get(projects) ?? []
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

/** A locked project as a refusal names it: its directory, and its name where that differs. */
function lockedProject(root: string, name: string, dir: string): string {
  // `.` read as a sentence's end: the notice cut the line there.
  const rel = relPosix(root, dir) || 'the workspace root project'
  return name === pathName(root, dir) ? rel : `${rel} ("${name}")`
}

/**
 * The refusal for a locked project whose directory is gone (X-144): a
 * config-less one has no config file for the load to find missing, so it
 * is asked only when a spawn into the directory failed, and a run pays no
 * stat per project.
 */
export function lockedDirGone(root: string, name: string, dir: string): string {
  return `${LOCKFILE_NAME} locks ${lockedProject(root, name, dir)}, but its directory is gone — run \`vx lock\``
}

/** The plugin whose `discover` entry made each project the lock does not hold. */
const addedBy = new WeakMap<object, string>()

/**
 * Why a project a `discover` plugin added holds no config while its
 * directory has one git ignores, or undefined: `vx lock` reads only the
 * configs git lists, so "run `vx lock`" could never fix it. `config` is
 * the file on disk, looked for when not given. One git spawn, asked only
 * of a directory holding a config.
 */
export function ignoredConfigRefusal(
  root: string,
  meta: { readonly name: string; readonly dir: string },
  config?: string,
): string | undefined {
  const by = addedBy.get(meta)
  if (by === undefined) return undefined
  const file =
    config ?? PROJECT_CONFIG_FILENAMES.map((n) => path.join(meta.dir, n)).find((f) => existsSync(f))
  if (file === undefined) return undefined
  const rel = relPosix(root, file)
  if (checkIgnoreSync(root, [rel])?.has(rel) !== true) return undefined
  return `plugin '${by}' adds project ${meta.name}, but git ignores ${rel}, so \`vx lock\` cannot read it — unignore it or delete it`
}

/**
 * The workspace's projects: the directories the lock records (a run never
 * walks for configs), with what the plugin `discover` stage added, named
 * and linked as `vx lock` recorded it (`Lockfile.discoverStage`). No hook
 * runs, whatever plugins the workspace declares now (2026-11-11: "it
 * should always follow the lock blindly"). Sorted by name; two projects of
 * one name are refused.
 */
export async function discoverProjects(
  workspaceRoot: string,
  lock: () => Promise<Lockfile>,
  /** The run's enumeration, which an `--affected` selection reads (and starts). */
  git: LazyGitEnumeration = lazyGitEnumeration(workspaceRoot),
): Promise<ProjectMeta[]> {
  const read = await lock()
  const projects = lockedDiscovery(workspaceRoot, read, lock, git)
  const recorded = read.discoverStage?.projects ?? {}
  const byDir = new Map(projects.map((p) => [p.dir, p]))
  const named = new Set<ProjectMeta>()
  const atKey = (rel: string): string =>
    rel === '.' ? workspaceRoot : path.join(workspaceRoot, rel)
  for (const rel of Object.keys(recorded)) {
    const rec = recorded[rel]!
    const dir = atKey(rel)
    let meta = byDir.get(dir)
    if (meta === undefined) {
      meta = { name: rec.name, dir, configPath: null }
      projects.push(meta)
      byDir.set(dir, meta)
      if (rec.by !== undefined) addedBy.set(meta, rec.by)
    } else meta.name = rec.name
    named.add(meta)
    if (rec.deps !== undefined) meta.deps = [...rec.deps]
    if (rec.reach !== undefined) meta.reach = [...rec.reach]
  }
  // A run follows the lock blindly: an edge to no project was dropped (the
  // dependant ran, and hit, without it), a stage config for no project was
  // never read, and a clash with a recorded name sent the user to a
  // vx.config. `vx lock` writes none of them.
  const names = new Map<string, ProjectMeta>()
  for (const p of projects) {
    const other = names.get(p.name)
    if (other !== undefined && (named.has(p) || named.has(other))) {
      const dirs = [other, p].map((m) => relPosix(workspaceRoot, m.dir) || '.').sort()
      throw lockInvalid(`two projects are named "${p.name}": ${dirs[0]} and ${dirs[1]}`)
    }
    names.set(p.name, p)
  }
  for (const rel of Object.keys(recorded)) {
    const rec = recorded[rel]!
    for (const [verb, edges] of [
      ['depends on', rec.deps],
      ['reaches', rec.reach],
    ] as const) {
      const unknown = edges?.find((n) => !names.has(n))
      if (unknown !== undefined)
        throw lockInvalid(`${rel} ${verb} "${unknown}", which no project is named`)
    }
  }
  for (const rel of Object.keys(read.projectStage?.configs ?? {})) {
    if (!byDir.has(atKey(rel)))
      throw lockInvalid(`it holds a \`projectStage\` config for ${rel}, which is no project`)
  }
  return checkProjectNames(workspaceRoot, projects)
}

function lockInvalid(why: string): UserError {
  return new UserError(`${LOCKFILE_NAME} is invalid: ${why} — run \`vx lock\``, 'VX_E_LOCK')
}

/**
 * `vx lock`'s discovery: the locked projects through the plugin `discover`
 * hooks, and what they left to record (`Lockfile.discoverStage`), absent
 * when no plugin fills the stage. The one place a `discover` hook runs.
 */
export async function lockDiscovery(
  workspaceRoot: string,
  lock: () => Promise<Lockfile>,
  plugins: readonly VxPlugin[],
  cacheDir: string,
  warn: (message: string) => void,
): Promise<{ projects: ProjectMeta[]; stage?: DiscoverStageLock }> {
  const git = lazyGitEnumeration(workspaceRoot)
  const projects = lockedDiscovery(workspaceRoot, await lock(), lock, git)
  if (!hasHook(plugins, 'discover')) return { projects: checkProjectNames(workspaceRoot, projects) }
  const before = new Map(projects.map((p) => [p, p.name]))
  const worktreeChanges = (): Promise<readonly string[] | null> =>
    git.start().then(
      (e) => e.changed,
      () => null,
    )
  const byDir = new Map(projects.map((p) => [p.dir, p]))
  const edges = await applyDiscoverHooks(
    plugins,
    projects,
    withExtraHashes(
      { workspaceRoot, cacheDir, warn, worktreeChanges },
      discoveredHashes.get(projects),
    ),
    async (entry, plugin) => {
      const found = await discoveredProject(workspaceRoot, byDir, entry, plugin.name)
      if (found.added) {
        byDir.set(found.meta.dir, found.meta)
        addedBy.set(found.meta, plugin.name)
      }
      return found
    },
  )
  checkProjectNames(workspaceRoot, projects)
  linkDiscoveredEdges(workspaceRoot, projects, edges)
  const recorded: [string, DiscoveredLock][] = []
  for (const meta of projects) {
    const by = addedBy.get(meta)
    if (
      meta.name === before.get(meta) &&
      by === undefined &&
      meta.deps === undefined &&
      meta.reach === undefined
    )
      continue
    recorded.push([
      lockKey(workspaceRoot, meta.dir),
      {
        name: meta.name,
        ...(by !== undefined ? { by } : {}),
        ...(meta.deps !== undefined ? { deps: [...meta.deps] } : {}),
        ...(meta.reach !== undefined ? { reach: [...meta.reach] } : {}),
      },
    ])
  }
  recorded.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    projects,
    stage: {
      plugins: plugins.filter((p) => typeof p.discover === 'function').map((p) => p.name),
      projects: Object.fromEntries(recorded),
    },
  }
}

/** The projects the lock records, registered for the readers keyed on the discovery's array. */
function lockedDiscovery(
  workspaceRoot: string,
  read: Lockfile,
  lock: () => Promise<Lockfile>,
  git: LazyGitEnumeration,
): ProjectMeta[] {
  const projects = lockedProjects(workspaceRoot, read.projects)
  if (read.nestedWorkspaces !== undefined)
    discoveredWalls.set(
      projects,
      read.nestedWorkspaces.map((rel) => path.join(workspaceRoot, rel)),
    )
  // An `--affected` selection reads its untracked files from this walk,
  // and the run reuses it (I-26).
  discoveredGit.set(projects, git)
  discoveredLock.set(projects, lock)
  discoveredHashes.set(projects, new Map())
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
  /**
   * `vx lock`'s audit: the one load that runs the `project` stage's hooks
   * (`ctx.lock`) and returns what they left (`LoadedProjects.stage`).
   * Every other load reads that from the lock.
   */
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
  /**
   * With `lock` and a `project` plugin: each loaded project's config as the
   * stage left it, before the default `build`, by directory. What `vx lock`
   * records (`Lockfile.projectStage`).
   */
  stage?: Map<string, ProjectConfig>
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
  // scripts mapped onto packages that never wrote a `vx.config.ts`). Under
  // `vx lock` it then loads as `{ tasks: {} }` — nothing to evaluate — and
  // the stage runs on that like on any loaded config; a run loads what the
  // lock recorded of it. With no
  // `project` plugin a plain run never seeds a config-less
  // package, but loads one a loaded project's closure reaches: it gets the
  // default `build`, so a dependant bundling its source is keyed on it
  // behind `^build`. Left out, its edit replayed the dependant's stale
  // output as a hit (X-9).
  // Only `vx lock` runs the hooks. A run follows the configs they left,
  // as `vx lock` recorded them, blindly: whatever plugins the workspace
  // declares now, and reading nothing a mapping reads (2026-11-11: "we
  // never relock during runs ... it should always follow the lock blindly").
  const hooks = args.lock === true && hasHook(plugins, 'project')
  const stage = hooks ? new Map<string, ProjectConfig>() : undefined
  // Asked only when a config is to be read: a run whose every project the
  // CLI's selection pass staged never parses the lock.
  const recorded =
    !hooks && args.projectMetas.some((m) => args.staged?.get(m.name) === undefined)
      ? (await lock()).projectStage?.configs
      : undefined
  const recordedOf = (meta: ProjectMeta): ProjectConfig | undefined => {
    if (recorded === undefined) return undefined
    const dir = lockKey(workspaceRoot, meta.dir)
    return Object.hasOwn(recorded, dir) ? recorded[dir] : undefined
  }
  // A hook that set one project's `dir` to another's moved it there: the
  // graph's directory guard read the moved entry, and its outputs clean
  // emptied the other project's.
  if (hooks) freezeDeep(args.projectMetas)
  const configured = args.projectMetas.filter(
    (m) =>
      hooks ||
      (typeof m.configPath === 'string' && m.configPath.length > 0) ||
      recordedOf(m) !== undefined ||
      args.staged?.get(m.name) !== undefined,
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
      const locked = lockedProject(workspaceRoot, gone.name, gone.dir)
      const file = relPosix(gone.dir, gone.configPath)
      // A sparse checkout left it out, not deleted: `vx lock` there
      // refuses too. Asked only on this failure path.
      const sparse = skipWorktreeSync(workspaceRoot, relPosix(workspaceRoot, gone.configPath))
      if (sparse !== null) {
        throw new UserError(
          `${locked} is outside this sparse checkout, but this run needs its ${file} — run \`git sparse-checkout add ${path.posix.dirname(sparse)}\``,
        )
      }
      // exists() says false for a file behind a directory this user may not
      // search too; asked only on this failure path, so a run pays no stat.
      const denied = await stat(gone.configPath).then(
        () => null,
        (err: NodeJS.ErrnoException) =>
          err.code === 'EACCES' || err.code === 'EPERM' ? err.code : null,
      )
      throw denied !== null
        ? new UserError(
            `${LOCKFILE_NAME} locks ${locked}, but its ${file} is not readable by this user (${denied})`,
            'VX_E_FS',
          )
        : new UserError(
            `${LOCKFILE_NAME} locks ${locked}, but its ${file} is gone — run \`vx lock\``,
            'VX_E_LOCK',
          )
    }
    const fromLock = withFile.filter((m) => recordedOf(m) === undefined)
    const loaded =
      fromLock.length === 0 ? [] : frozenProjectConfigs(await lock(), fromLock, workspaceRoot)
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
      const frozen: ProjectConfig =
        recordedOf(meta) ??
        (meta.configPath === null ? { tasks: {} } : (loaded[next++] as ProjectConfig))
      // The lock shares a task, or a part of one, every place declares alike,
      // in this project too: an edit in place works on a copy that shares
      // nothing. `structuredClone` keeps the sharing; the lock is JSON.
      let config: ProjectConfig = hooks ? JSON.parse(JSON.stringify(frozen)) : frozen
      if (hooks) {
        // The `project` stage edits the validated object in place; core
        // re-validates after EACH plugin so a plugin can only produce what
        // the loader accepts from a user, and the refusal names both the
        // config file and the plugin whose edit broke it.
        const where = meta.configPath ?? `${meta.name} (no config file)`
        const name = config.name
        await applyProjectHooks(
          plugins,
          config,
          withExtraHashes(
            {
              workspaceRoot,
              cacheDir: args.cacheDir,
              warn: args.warn,
              name: meta.name,
              dir: meta.dir,
              // The view `discover` was handed: nx() keys its graph on its identity.
              projects: readOnly(args.projectMetas),
              lock: true,
            },
            discoveredHashes.get(args.projectMetas),
          ),
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
        // The run takes a copy of what the hooks left: a plugin that kept
        // the object and wrote it later (from `admit`, or another project's
        // hook) ran a command its key never saw, past the validation above.
        // A copy, not a deep freeze: 1.5 ms of 1,000 projects against 4.4.
        config = JSON.parse(JSON.stringify(config))
        stage!.set(meta.dir, config)
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
  return stage === undefined ? { projects, configured } : { projects, configured, stage }
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
        const spec = parseDependencySpec(raw, 'dependsOn')
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
  const metas = await discoverProjects(workspaceRoot, lock)
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
      if (lock === null) throw new UserError(NO_LOCK, 'VX_E_LOCK')
      return lock
    }))
}
