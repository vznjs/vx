// The project-config load every reader of "what tasks exist" shares
// (`prepareRun`, `vx show`), so `show` prints what a run sees, including the
// plugin `project` stage. `vx lock` runs that stage and records only what it
// left (`LockedProject.config`); others read the record.

import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectConfig } from '../config.js'
import {
  checkProjectNames,
  DEPENDENCIES_LOCK_NAME,
  frozenProjectConfigs,
  LOCK_INVALID,
  LOCKFILE_NAME,
  lockEntryBroken,
  lockedDependencies,
  lockDigest,
  lockedProjects,
  NO_LOCK,
  pathName,
  PROJECT_CONFIG_FILENAMES,
  lockKey,
  loadProjectConfigs,
  readLockfile,
  validateProjectConfig,
  type Lockfile,
  type PackageGraph,
  type ProjectEntry,
  type ProjectMeta,
} from '../workspace/index.js'
import type { WorkspaceConfig } from '../config.js'
import { applyWorkspaceLimits, applyWorkspaceTimers, atPath, SETTINGS } from '../settings.js'
import { lazyGitEnumeration, type LazyGitEnumeration, parseCachePolicy } from '../cache/index.js'
import {
  checkIgnoreSync,
  isUserError,
  listed,
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
import {
  restampConfigs,
  stampsBesideLock,
  takeConfigStamps,
  type ConfigStat,
} from '../memo/index.js'
import { DEFAULT_BUILD, parseDependencySpec } from '../graph/index.js'
import { workspaceFile } from '../handoff.js'
import { applyConfigHooks, applyDiscoverHooks, applyProjectHooks, hasHook } from './plugin-host.js'
import type { BranchFacts, VxPlugin } from './plugin.js'
import { freezeDeep, readOnly } from './read-only.js'
import { holdLockFiles } from './run-lock.js'
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
  if (loaded === null || !hasHook(plugins, 'config')) {
    applyWorkspaceTimers(loaded)
    applyWorkspaceLimits(loaded)
    return { workspaceConfig: loaded, plugins, branch, settingPlugins }
  }
  // Bun keeps one module per specifier, so the file's export is one object per
  // process, and each load's hooks edited the last load's result (`concurrency
  // *= 2` doubled per load). The hooks edit a copy.
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
  applyWorkspaceTimers(workspaceConfig)
  applyWorkspaceLimits(workspaceConfig)
  return { workspaceConfig, plugins, branch, settingPlugins }
}

const isRef = (r: unknown): boolean =>
  typeof r === 'string' && r.startsWith('refs/') && !/[\s\0]/.test(r)

type WorkspacePlugins = Awaited<ReturnType<typeof loadWorkspacePlugins>>

/**
 * What a discovery learned, by the array it returned: a run handed that array
 * (`RunHandoff.discovered`, the CLI's `--filter` pass) reuses each part
 * instead of learning it again.
 */
export interface DiscoveryFacts {
  /** The enumeration its `discover` hooks shared: the run walks no second time. */
  git?: LazyGitEnumeration
  /** The lock it read: a later config load reads no second copy. */
  lock?: () => Promise<Lockfile>
  /** The extra-file hashes `discover` took: `--affected`, the `project` stage and the key share them. */
  hashes?: ExtraHashes
  /** The nested workspace roots (absolute) the lock records: where outputs stop besides nested projects. */
  walls?: readonly string[]
  /** The workspace its caller loaded: the `config` stage runs once, a plugin's warning prints once. */
  workspace?: WorkspacePlugins
  /** The package graph a selection pass built over it, when that folded no task edge in. */
  graph?: PackageGraph
}

const discoveries = new WeakMap<readonly ProjectMeta[], DiscoveryFacts>()

/** The facts kept for a discovery's array: empty for an array no discovery made. */
export function discoveryOf(projects: readonly ProjectMeta[]): DiscoveryFacts {
  let facts = discoveries.get(projects)
  if (facts === undefined) discoveries.set(projects, (facts = {}))
  return facts
}

/** A locked project as a refusal names it: its directory, and its name where that differs. */
function lockedProject(root: string, name: string, dir: string): string {
  // `.` read as a sentence's end: the notice cut the line there.
  const rel = relPosix(root, dir) || 'the workspace root project'
  return name === pathName(root, dir) ? rel : `${rel} ("${name}")`
}

/**
 * The refusal for a locked project whose directory is gone: a config-less one
 * has no config file for the load to find missing, so it is asked only when a
 * spawn into the directory failed, and a run pays no stat per project.
 */
export function lockedDirGone(root: string, name: string, dir: string): string {
  return `${LOCKFILE_NAME} locks ${lockedProject(root, name, dir)}, but its directory is gone — run \`vx lock\``
}

/** The plugin whose `discover` entry made each project the lock does not hold. */
const addedBy = new WeakMap<object, string>()

/**
 * Why a `discover`-added project holds no config while its directory has one
 * git ignores: `vx lock` reads only configs git lists, so "run `vx lock`"
 * cannot fix it. One git spawn, only for a directory holding a config.
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
 * The workspace's projects: the lock's directories (a run never walks for
 * configs) plus what `discover` added, as `vx lock` recorded it. No hook runs.
 * Sorted by name; duplicate names are refused.
 */
export async function discoverProjects(
  workspaceRoot: string,
  lock: () => Promise<Lockfile>,
  /** The run's enumeration, which an `--affected` selection reads (and starts). */
  git: LazyGitEnumeration = lazyGitEnumeration(workspaceRoot),
): Promise<ProjectMeta[]> {
  const read = await lock()
  const projects = lockedDiscovery(workspaceRoot, read, lock, git)
  const graph = lockedDependencies(read)!
  const byDir = new Map(projects.map((p) => [lockKey(workspaceRoot, p.dir), p]))
  for (const rel of Object.keys(read.projects)) {
    const by = read.projects[rel]!.by
    if (by !== undefined) addedBy.set(byDir.get(rel)!, by)
  }
  // A run follows the locks blindly: `vx lock` writes both from one
  // discovery, so a project one holds and the other does not is a lock
  // `vx lock` never wrote.
  const byName = new Map(projects.map((p) => [p.name, p]))
  if (graph.names.length !== projects.length || graph.names.some((n) => !byName.has(n)))
    throw lockInvalid(`${DEPENDENCIES_LOCK_NAME} holds other projects`)
  for (const name of graph.names) {
    const meta = byName.get(name)!
    const { deps, reach } = graph.edges(name)!
    // With an edge source every project is an edge source's leaf at least.
    if (graph.edgeSource) meta.deps = [...deps]
    if (reach.length > 0) meta.reach = [...reach]
  }
  const names = new Map<string, ProjectMeta>()
  for (const p of projects) {
    const other = names.get(p.name)
    if (other !== undefined) {
      const dirs = [other, p].map((m) => relPosix(workspaceRoot, m.dir) || '.').sort()
      throw lockInvalid(`two projects are named "${p.name}": ${dirs[0]} and ${dirs[1]}`)
    }
    names.set(p.name, p)
  }
  return checkProjectNames(workspaceRoot, projects)
}

function lockInvalid(why: string): UserError {
  return new UserError(`${LOCKFILE_NAME} is invalid: ${why} — run \`vx lock\``, 'VX_E_LOCK')
}

/**
 * `vx lock`'s discovery: the locked projects through the plugin `discover`
 * hooks, with their names and edges, which `vx lock` records (names and
 * `by` in the lock, edges in the dependencies lock). The one place a
 * `discover` hook runs.
 */
export async function lockDiscovery(
  workspaceRoot: string,
  lock: () => Promise<Lockfile>,
  plugins: readonly VxPlugin[],
  cacheDir: string,
  warn: (message: string) => void,
): Promise<ProjectMeta[]> {
  const git = lazyGitEnumeration(workspaceRoot)
  const projects = lockedDiscovery(workspaceRoot, await lock(), lock, git)
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
    withExtraHashes(
      { workspaceRoot, cacheDir, warn, worktreeChanges },
      discoveryOf(projects).hashes,
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
  return projects
}

/** The plugin whose `discover` entry added `meta`, the project's `LockedProject.by`. */
export function addedByPlugin(meta: ProjectMeta): string | undefined {
  return addedBy.get(meta)
}

/** The projects the lock records, registered for the readers keyed on the discovery's array. */
function lockedDiscovery(
  workspaceRoot: string,
  read: Lockfile,
  lock: () => Promise<Lockfile>,
  git: LazyGitEnumeration,
): ProjectMeta[] {
  const projects = lockedProjects(workspaceRoot, read.projects)
  // An `--affected` selection reads its untracked files from `git`, and the
  // run reuses it.
  const facts: DiscoveryFacts = { git, lock, hashes: new Map() }
  if (read.nestedWorkspaces !== undefined)
    facts.walls = read.nestedWorkspaces.map((rel) => path.join(workspaceRoot, rel))
  discoveries.set(projects, facts)
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
   * Projects whose configs must load: `'all'`, or names (unknown and
   * config-less ones ignored unless a configured project's closure reaches
   * them). With `closure`, each seed's package dependencies load too, bounding
   * `^task`; a `pkg#task` entry pulls its project in either way.
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
   * Entries this process already loaded with the same cache dir and lock (the
   * CLI's selection pass): taken as is instead of evaluated and staged again,
   * so the stage's cost and warnings come once per run. Never across runs.
   */
  staged?: ReadonlyMap<string, ProjectEntry>
  /**
   * Read the lock as it stands though a config was edited since: `vx
   * watch`'s map of what to hear. Refused, it heard every project until
   * the next `vx lock`; the run the edit starts still refuses it.
   */
  asLocked?: boolean
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
  /** With `stage`: the files each project's plugins made it from, absolute, by directory. */
  reads?: Map<string, Set<string>>
}

/**
 * Scoped loading: evaluating 1,090 configs costs ~200 ms. Only seeds, their
 * closure and `pkg#task`-named projects can add nodes. Like Turbo, an unrelated
 * broken config fails a scoped run only once in scope.
 */
export async function loadProjects(args: LoadProjectsArgs): Promise<LoadedProjects> {
  const { plugins, workspaceRoot } = args
  const lock = args.configs
  const graph = args.closure ? args.packageGraph : null
  // A package with no config declares no tasks, unless a `project` plugin may
  // give it some (`turbo.json` or scripts mapped onto packages with no
  // `vx.config.ts`): under `vx lock` it loads as `{ tasks: {} }` and the stage
  // runs on it. Without such a plugin a run never seeds a config-less package,
  // but loads one a loaded closure reaches: its default `build` keys a
  // dependant bundling its source behind `^build` (left out, its edit replayed
  // a stale hit). Only `vx lock` runs the hooks; a run follows what it
  // recorded.
  const hooks = args.lock === true && hasHook(plugins, 'project')
  const stage = hooks ? new Map<string, ProjectConfig>() : undefined
  // Asked only when a config is to be read: a run whose every project the
  // CLI's selection pass staged never parses the lock.
  // A config-less project's config is the stage's record: read only when one is asked.
  const recorded =
    !hooks &&
    args.projectMetas.some((m) => m.configPath === null && args.staged?.get(m.name) === undefined)
      ? (await lock()).projects
      : undefined
  const recordedOf = (meta: ProjectMeta): ProjectConfig | undefined => {
    if (recorded === undefined || meta.configPath !== null) return undefined
    const dir = lockKey(workspaceRoot, meta.dir)
    return Object.hasOwn(recorded, dir) ? recorded[dir]!.config : undefined
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
  // Counted, not read off `pending`: a round empties `pending`, and a guard on
  // its length let every cross edge after the first round walk its whole
  // closure again (1,500 walks at 300 projects).
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
    // Every config-bearing project already considered: the closure can add
    // nothing, and asking would build the package graph's bitsets for nothing.
    if (neededConfigured === metaByName.size || walked.has(name)) return
    walked.add(name)
    for (const dep of packageGraph.transitiveDeps(name)) consider(dep)
  }
  const seedAll = (): Iterable<string> => configured.map((m) => m.name)
  // A named config-less seed loads only where `'all'` would load it: seeded
  // alone it got a default build no run of the workspace had.
  const configuredNames = new Set(configured.map((m) => m.name))
  const seedable = (name: string): boolean =>
    configuredNames.has(name) ||
    (graph !== null &&
      metaByName.has(name) &&
      graph.transitiveDependents(name).some((d) => configuredNames.has(d)))
  const seeds = args.seeds === 'all' ? seedAll() : [...args.seeds].filter(seedable)
  for (const seed of seeds) consider(seed)
  if (graph !== null && pending.length < metaByName.size) {
    // One walk from every seed: each seed's own closure, at 10,000 projects
    // and a 3,334-project `--affected`, was 210 ms of building and listing.
    const all = args.seeds === 'all' ? [...seedAll()] : seeds
    if (neededConfigured < metaByName.size) for (const dep of graph.depsOf(all)) consider(dep)
    for (const seed of all) walked.add(seed)
  }

  // Load in rounds to a fixpoint: a `pkg#task` entry names a project the
  // package graph cannot reach, and its config may name more. Usually one
  // round. Turbo's root spelling `//` (`dependsOn: ['//#lint']`) is rewritten
  // once here to a named root's name, for closure, graph and `inputs.tasks`;
  // with no root project it stays, and the graph refuses it.
  const root = path.resolve(workspaceRoot)
  const rootName = args.projectMetas.find((m) => path.resolve(m.dir) === root)?.name
  const projects = new Map<string, ProjectEntry>()
  // What each project's `project` plugins said they made it from, by
  // directory (`ProjectHookContext.read`): `vx lock` stamps them.
  const reads = hooks ? new Map<string, Set<string>>() : undefined
  // The stamps beside the lock, read once a load; each file stat'd once a load.
  let stamped: ReturnType<typeof stampsBesideLock> | undefined
  const statted = new Set<string>()
  // `moved`: gone, or there when the lock found it absent: edited either way.
  const pluginReads = async (
    digest: string,
    metas: readonly ProjectMeta[],
  ): Promise<{ moved: string[]; present: ConfigStat[] }> => {
    const got = await (stamped ??= stampsBesideLock(workspaceRoot, args.cacheDir, digest))
    if (got === undefined) return { moved: [], present: [] }
    const files = metas.flatMap((m) => {
      const dir = lockKey(workspaceRoot, m.dir)
      const rels = Object.hasOwn(got.reads, dir) ? got.reads[dir]! : []
      return rels.filter((rel) => !statted.has(rel) && (statted.add(rel), true))
    })
    const moved: string[] = []
    const present: ConfigStat[] = []
    await Promise.all(
      files.map(async (rel) => {
        const file = path.join(workspaceRoot, rel)
        const st = await stat(file).catch(() => null)
        const was = got.present(rel)
        if (st === null) {
          if (was) moved.push(rel)
        } else if (!was) moved.push(rel)
        else
          present.push({
            file,
            size: st.size,
            mtimeMs: st.mtimeMs,
            ctimeMs: st.ctimeMs,
            ino: st.ino,
          })
      }),
    )
    return { moved: moved.sort(), present }
  }
  while (pending.length > 0) {
    const round = pending.splice(0, pending.length)
    // Only a config FILE is evaluated (or read from the lock); a
    // config-less project in the round starts from an empty task table,
    // and a project the caller already staged is neither.
    const withFile = round.filter(
      (m): m is ProjectMeta & { configPath: string } =>
        typeof m.configPath === 'string' && args.staged?.get(m.name) === undefined,
    )
    // A locked project whose config file is gone ran as locked, green, though
    // nothing declares it any more: asked only of the configs this run reads.
    // One stat each: whether it is there, and whether it moved since `vx lock`.
    const stats = await Promise.all(withFile.map((m) => stat(m.configPath).catch(() => null)))
    const present = stats.map((s) => s !== null && !s.isDirectory())
    const goneAll = withFile.filter((_, i) => !present[i])
    const gone = goneAll[0]
    if (gone !== undefined) {
      // A sparse checkout left it out, not deleted: `vx lock` there
      // refuses too. Asked only on this failure path, of every gone config
      // of the round, so one command brings them all back.
      const sparse = goneAll.flatMap((m) => {
        const at = skipWorktreeSync(workspaceRoot, relPosix(workspaceRoot, m.configPath))
        return at === null ? [] : [{ meta: m, add: path.posix.dirname(at) }]
      })
      if (sparse.length > 0) {
        const add = `git sparse-checkout add ${[...new Set(sparse.map((s) => s.add))].join(' ')}`
        const one = sparse.length === 1 ? sparse[0]!.meta : null
        throw new UserError(
          one !== null
            ? `${lockedProject(workspaceRoot, one.name, one.dir)} is outside this sparse checkout, but this run needs its ${relPosix(one.dir, one.configPath)} — run \`${add}\``
            : `${listed(
                sparse.map((s) => lockedProject(workspaceRoot, s.meta.name, s.meta.dir)),
                5,
              )} are outside this sparse checkout, but this run needs their configs — run \`${add}\``,
        )
      }
      const locked = lockedProject(workspaceRoot, gone.name, gone.dir)
      const file = relPosix(gone.dir, gone.configPath)
      // exists() says false for a file behind a directory this user may not
      // search too; asked only on this failure path, so a run pays no stat.
      const denied = await stat(gone.configPath).then(
        () => null,
        (err: NodeJS.ErrnoException) =>
          err.code === 'EACCES' || err.code === 'EPERM' ? err.code : null,
      )
      throw denied !== null
        ? new UserError(
            `${LOCKFILE_NAME} locks ${locked}, but its ${file} is not readable by this user (${denied}) — give this user read access to it, then re-run`,
            'VX_E_FS',
          )
        : new UserError(
            `${LOCKFILE_NAME} locks ${locked}, but its ${file} is gone — run \`vx lock\``,
            'VX_E_LOCK',
          )
    }
    const fromLock = withFile.filter((m) => recordedOf(m) === undefined)
    // A run reads the lock, never the config, nor a file a `project` plugin
    // made one from (turbo.json, a script): one edited with no `vx lock`
    // after it would run as it was, green.
    const unstaged = round.filter((m) => args.staged?.get(m.name) === undefined)
    const digest =
      args.asLocked === true || hooks || (fromLock.length === 0 && unstaged.length === 0)
        ? undefined
        : lockDigest(await lock())
    const got =
      digest === undefined
        ? undefined
        : await (stamped ??= stampsBesideLock(workspaceRoot, args.cacheDir, digest))
    let edited: string[] = []
    if (digest !== undefined && got === undefined) {
      // No stamps beside this lock (a clone, a cleared cache): every config
      // and every mapping is evaluated once, as `vx lock --check` does, and
      // the ones the lock holds are stamped. The round alone left the other
      // projects' mapped-from files unstamped, so an edit to one ran green.
      const held = await lock()
      const mapped = hasHook(plugins, 'project')
      edited = await asLockHolds(args, digest, held, (m) => {
        if (args.staged?.get(m.name) !== undefined) return false
        if (m.configPath !== null) return true
        return mapped && Object.hasOwn(held.projects, lockKey(workspaceRoot, m.dir))
      })
      stamped = stampsBesideLock(workspaceRoot, args.cacheDir, digest)
    } else if (digest !== undefined && got !== undefined) {
      const mappedFrom = await pluginReads(digest, unstaged)
      edited = [
        ...mappedFrom.moved,
        ...(await got.edited([
          ...withFile.flatMap((m, i) =>
            recordedOf(m) === undefined
              ? [
                  {
                    file: m.configPath,
                    size: stats[i]!.size,
                    mtimeMs: stats[i]!.mtimeMs,
                    ctimeMs: stats[i]!.ctimeMs,
                    ino: stats[i]!.ino,
                  },
                ]
              : [],
          ),
          ...mappedFrom.present,
        ])),
      ]
      // A stamp holds the bytes `vx lock` last read, not every text that
      // evaluates as the lock holds: a config restored with its lock (`git
      // checkout`) was refused while `vx lock --check` passed. Evaluated, as
      // the check does, before refusing; one that matches is stamped again.
      if (edited.length > 0) {
        const named = new Set(edited)
        const asked = new Set(
          withFile.filter((m) => named.has(path.relative(workspaceRoot, m.configPath))),
        )
        if (asked.size > 0) {
          const still = new Set(
            await asLockHolds(args, digest, await lock(), (m) => asked.has(m as never)),
          )
          edited = edited.filter(
            (rel) =>
              still.has(rel) ||
              ![...asked].some((m) => path.relative(workspaceRoot, m.configPath) === rel),
          )
        }
      }
    }
    // A hand-broken entry differs from every evaluation: named as itself,
    // as a crash it causes is (cli/index.ts), on this failure path only.
    if (edited.length > 0 && lockEntryBroken(workspaceRoot))
      throw new UserError(LOCK_INVALID, 'VX_E_LOCK')
    if (edited.length > 0)
      throw new UserError(
        `${listed(edited, 5)} changed since the last \`vx lock\` — run \`vx lock\``,
        'VX_E_LOCK',
      )
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
        // re-validates after each plugin, so a plugin produces only what a user
        // could write, and the refusal names config and plugin.
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
              read: (file: string) => {
                let set = reads!.get(meta.dir)
                if (set === undefined) reads!.set(meta.dir, (set = new Set()))
                set.add(path.resolve(workspaceRoot, file))
              },
            },
            discoveryOf(args.projectMetas).hashes,
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
        // The run takes a copy of what the hooks left: a plugin that kept the
        // object and wrote it later ran a command its key never saw. A copy,
        // not a deep freeze: 1.5 ms against 4.4 at 1,000 projects.
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
  return stage === undefined
    ? { projects, configured }
    : { projects, configured, stage, reads: reads! }
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

/**
 * The lock and the dependencies lock beside it, read once on first ask, both
 * under one shared hold so a `vx lock` renaming them cannot land between the
 * two reads; no lock is `NO_LOCK`.
 */
export function lockReader(workspaceRoot: string): () => Promise<Lockfile> {
  let read: Promise<Lockfile> | undefined
  return () =>
    (read ??= holdLockFiles(workspaceRoot, 'shared').then(async (release) => {
      try {
        const lock = await readLockfile(workspaceRoot)
        if (lock === null) throw new UserError(NO_LOCK, 'VX_E_LOCK')
        return lock
      } finally {
        release()
      }
    }))
}

/**
 * Of the projects `pick` names, the ones that do not evaluate to what the
 * lock holds, as `vx lock --check` compares them: the config, then the
 * `project` stage's mapping. Each by its config file, or its directory
 * when it has none. The ones that do are stamped beside `digest`: their
 * configs as read before the evaluation (an edit during it reads as one
 * after), and the files the stage made them from.
 */
async function asLockHolds(
  args: LoadProjectsArgs,
  digest: string,
  held: Lockfile,
  pick: (meta: ProjectMeta) => boolean,
): Promise<string[]> {
  const root = args.workspaceRoot
  const metas = args.projectMetas.filter(pick)
  if (metas.length === 0) return []
  const files = metas.flatMap((m) => (m.configPath === null ? [] : [m.configPath]))
  const taken = await takeConfigStamps(root, files)
  const named = (m: ProjectMeta): string =>
    m.configPath === null ? relPosix(root, m.dir) : path.relative(root, m.configPath)
  let fresh: Map<string, unknown>
  let reads: Map<string, Set<string>> | undefined
  try {
    const configs = await loadProjectConfigs(files, root)
    const evaluated = new Map(files.map((f, i) => [f, JSON.parse(JSON.stringify(configs[i]))]))
    fresh = new Map(
      metas.flatMap((m) =>
        m.configPath === null ? [] : [[m.dir, evaluated.get(m.configPath)] as const],
      ),
    )
    if (hasHook(args.plugins, 'project')) {
      // The stage on what the configs say now, as `vx lock` runs it.
      const view: Lockfile = { ...held, projects: { ...held.projects } }
      for (const m of metas) {
        if (m.configPath === null) continue
        const dir = lockKey(root, m.dir)
        const was = Object.hasOwn(held.projects, dir) ? held.projects[dir] : undefined
        view.projects[dir] = {
          ...(was ?? { name: m.name }),
          file: path.basename(m.configPath),
          config: fresh.get(m.dir) as ProjectConfig,
        }
      }
      const staged = await loadProjects({
        workspaceRoot: root,
        cacheDir: args.cacheDir,
        plugins: args.plugins,
        projectMetas: args.projectMetas,
        seeds: metas.map((m) => m.name),
        closure: false,
        configs: async () => view,
        warn: args.warn,
        lock: true,
      })
      for (const m of metas) fresh.set(m.dir, staged.stage?.get(m.dir))
      reads = staged.reads
    }
  } catch (err) {
    // A config or mapping that no longer evaluates: its error, as `vx lock
    // --check` names it. Read as "changed since the last `vx lock`" alone, the
    // fix was hidden behind a `vx lock` that refused it again.
    if (isUserError(err)) throw err
    return metas.map(named)
  }
  const same = metas.filter((m) => {
    const dir = lockKey(root, m.dir)
    const locked = Object.hasOwn(held.projects, dir) ? held.projects[dir] : undefined
    return (
      locked !== undefined &&
      (m.configPath === null
        ? locked.file === undefined
        : locked.file === path.basename(m.configPath)) &&
      fresh.get(m.dir) !== undefined &&
      Bun.deepEquals(fresh.get(m.dir), locked.config, true)
    )
  })
  // A file a mapping that no longer holds read is stamped for none: the
  // mappings that hold vouched for it, and a project with no config, which
  // only its mapped-from files guard, ran its locked mapping, green.
  const failedReads = new Set(
    metas
      .filter((m) => !same.includes(m))
      .flatMap((m) => [...(reads?.get(m.dir) ?? [])].map((f) => relPosix(root, f))),
  )
  // Every mapping's reads are kept, so a later run asks them of each project.
  const byDir: Record<string, string[]> = {}
  for (const m of metas) {
    const got = reads?.get(m.dir)
    if (got !== undefined && got.size > 0)
      byDir[lockKey(root, m.dir)] = [...got].map((f) => relPosix(root, f)).sort()
  }
  if (same.length > 0 || Object.keys(byDir).length > 0) {
    const kept = new Set(same.flatMap((m) => (m.configPath === null ? [] : [named(m)])))
    // Stamped after the stage read them, as `vx lock` stamps them.
    const mapped = await takeConfigStamps(root, [
      ...new Set(
        Object.values(byDir).flatMap((rels) =>
          rels.filter((r) => !failedReads.has(r)).map((r) => path.join(root, r)),
        ),
      ),
    ])
    await restampConfigs(root, args.cacheDir, digest, {
      at: taken.at,
      configs: {
        ...Object.fromEntries(Object.entries(taken.configs).filter(([rel]) => kept.has(rel))),
        ...mapped.configs,
      },
      reads: byDir,
    })
  }
  const matched = new Set(same)
  return metas.filter((m) => !matched.has(m)).map(named)
}
