// `vx lock` — freeze every resolved vx.config.* into .vx/projects.lock, and
// each one, pretty, into a `vx.lock.json` beside it for review.
// `vx lock --check` — audit the lock against a fresh evaluation in the
// current environment. Design: docs/design/config-lock-2026-06.md.

import { readdirSync } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectConfig } from '../config.js'
import { flagHint, formatValue, refuse, refusedWord, seeHelp } from './help.js'
import {
  buildTaskGraph,
  expandRequested,
  isDefaultBuild,
  refuseFiltersThroughGroups,
} from '../graph/index.js'
import {
  acquireRunLock,
  addedByPlugin,
  applyGraphStage,
  claimedDigests,
  lockDiscovery,
  fingerprintClaims,
  hasHook,
  holdLockFiles,
  ignoredConfigRefusal,
  loadProjects,
  networkPatternRefusal,
} from '../orchestrator/index.js'
import { resolveSetting, runRules } from '../settings.js'
import {
  anyTaskGlob,
  checkIgnoreSync,
  configErrorFrame,
  configRefusal,
  DOT_VX_GITATTRIBUTES,
  fsRefusalHint,
  ignoredByGlobs,
  ignoredInputLine,
  isFsRefusal,
  isLiteralPattern,
  isOutOfFds,
  ConfigsRefused,
  isUserError,
  listed,
  maskedLine,
  outputMatcher,
  relPosix,
  type RefusalParts,
  UserError,
  errorCode,
  secretMask,
  secretNamed,
  type SecretMask,
  refuseSymlink,
  exitOnStop,
  writeAllOrNone,
  writeNoFollow,
} from '../util/index.js'
import { answerRuntime, makeIgnoredCacheDir } from '../cache/index.js'
import { type ConfigStamps, takeConfigStamps, writeConfigStamps } from '../memo/index.js'
import { workspaceFile, workspaceRootOf } from '../handoff.js'
import * as ui from '../ui/index.js'
import { refusalNotice, sayNotice } from '../ui/index.js'
import {
  configImports,
  findProjectConfigs,
  findWorkspaceRoot,
  REVIEW_FILE,
  PROJECT_CONFIG_FILENAMES,
  loadProjectConfigs,
  LOCKFILE_NAME,
  LOCKFILE_VERSION,
  lockKey,
  readLockfile,
  buildPackageGraph,
  checkBracketLiterals,
  checkDependencyRules,
  computeNestedProjectDirs,
  lockfileWrite,
  DEPENDENCIES_LOCK_NAME,
  dependenciesLock,
  dependenciesLockRefusal,
  sameRecord,
  parseDependenciesLock,
  dependenciesLockWrite,
  evaluatedWorkspace,
  type DependenciesLock,
  type LockedProject,
  type Lockfile,
  type ProjectMeta,
  pathName,
} from '../workspace/index.js'
import { taskEdgesFrom } from './select.js'
import { loadCliWorkspace, warnToStderr } from './workspace-config.js'

interface LockArgs {
  check: boolean
  format: 'pretty' | 'json'
  error?: string
}

export function parseLockArgs(args: readonly string[]): LockArgs {
  const out: LockArgs = { check: false, format: 'pretty' }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--check') out.check = true
    else if (a === '--format' || a.startsWith('--format=')) {
      const fv = formatValue(a === '--format' ? args[++i] : a.slice(9), 'lock')
      if (typeof fv === 'object') return { ...out, ...fv }
      out.format = fv
    } else
      return {
        ...out,
        error: `${refusedWord(a)}: ${a}${flagHint('lock', a)}${seeHelp('lock')}`,
      }
  }
  return out
}

type ConfiguredMeta = ProjectMeta & { configPath: string }

/**
 * A `dependsOn` the graph refused (`a#dep: dependsOn a#nope …`), said as
 * a schema refusal of that field, so it prints at the config's line with
 * its frame as every other config error does. Undefined when the task's
 * `dependsOn` is not in its file (a plugin's task, the default build).
 */
function placedDependsOn(
  err: UserError,
  all: readonly ProjectMeta[],
  root: string,
): string | undefined {
  if (err.code !== 'VX_E_DEPENDS_ON') return undefined
  const m = /^(.+)#([^#\s]+): dependsOn (.+)$/s.exec(err.message)
  if (m === null) return undefined
  const configPath = all.find((p) => p.name === m[1])?.configPath
  if (configPath === undefined || configPath === null) return undefined
  // `does not accept …` reads on from the field; a named dep takes `names`.
  // The frame turns a trailing ` — did you mean X?` into its fix line.
  const said = /^(?:does not|patterns are)\b/.test(m[3]!) ? m[3] : `names ${m[3]}`
  const placed = `${configPath}: tasks.${m[2]}.dependsOn ${said!.replace(/\. Did you mean (.+)\?$/s, ' — did you mean $1?')}`
  return configErrorFrame(placed, root) === undefined ? undefined : placed
}

export async function lockCmd(args: readonly string[]): Promise<number> {
  const parsed = parseLockArgs(args)
  if (parsed.error) return refuse('lock', args, parsed.error, 'VX_E_USAGE')
  // Writing the lock prints one line; only the audit has an answer to shape.
  if (parsed.format === 'json' && !parsed.check)
    return refuse(
      'lock',
      args,
      `--format json answers --check only${seeHelp('lock')}`,
      'VX_E_USAGE',
    )
  const root = await findWorkspaceRoot(process.cwd())
  if (parsed.check) return await checkLock(root, parsed.format === 'json')
  return await lockWorkspace(root)
}

/**
 * Projects with tasks and no vx.config: a plugin's tasks, which the lock
 * records from its `project` stage, so both verbs name them — `0 project
 * configs` on a turbo() repo read like an audit of nothing (2026-09-16).
 * One with no task is left out: solidjs/solid's solid-ssr, which has no
 * script Turbo runs.
 */
function bareProjects(all: readonly ProjectMeta[], tasked: ReadonlySet<string>): string[] {
  return all.filter((m) => m.configPath === null && tasked.has(m.name)).map((m) => m.name)
}

/**
 * `vx lock`: find and evaluate every config, check the graph rules over
 * every task, and write the lock: the only writer of it.
 */
export async function lockWorkspace(
  root: string,
  warn: (message: string) => void = warnToStderr,
  say: (line: string) => void = (line) => ui.print('out', ui.status('ok', 'vx lock', line)),
): Promise<number> {
  // One writer at a time: two at once left a review copy and the lock from
  // different evaluations. Taken before the evaluation, so the second
  // writes what the configs say after the first.
  // A stop ends vx through its exit hooks, which remove the temps it was
  // writing and its run lock's entry.
  return await exitOnStop(async () => {
    const release = await acquireRunLock(root, {
      log: warn,
      // Taking turns is a status line, as a run says it, not a warning.
      wait: (line) => ui.say('info', line),
      of: 'lock',
    })
    try {
      const check = await audit(root, warn)
      if (check.broken !== null) {
        notWritten(check.broken, check.brokenParts, check.alsoBroken)
        return 1
      }
      return await writeLock(root, check, say)
    } finally {
      await release()
    }
  })
}

/**
 * The lock as `vx lock` would write it, and the graph rules (`run.rules`)
 * checked over every project and task the workspace declares: a run trusts
 * the lock and does not check them (2026-10-13). Every config is
 * found (`findProjectConfigs`) and evaluated once; the projects, names and
 * graph are the ones a run builds from that lock, the `discover` and
 * `graph` stages included.
 */
async function audit(root: string, warn: (message: string) => void): Promise<GraphCheck> {
  const tasked = new Set<string>()
  const resolved = new Map<string, ProjectConfig>()
  const out: GraphCheck = {
    broken: null,
    loaded: false,
    staged: false,
    fresh: { version: LOCKFILE_VERSION, projects: {} },
    all: [],
    tasked,
    resolved,
    reviewFiles: true,
    strayReviews: [],
    shadowed: [],
    dependencies: null,
  }
  try {
    const { workspaceConfig, plugins, cacheDir } = await loadCliWorkspace(root)
    out.reviewFiles = resolveSetting('lock.reviewFiles', workspaceConfig).value !== false
    out.staged = !hasHook(plugins, 'project')
    const {
      configs: found,
      strayReviews,
      shadowed,
      nestedWorkspaces,
      sparse,
    } = await findProjectConfigs(root)
    // Left out, the project would leave the committed lock, as a run refuses it.
    if (sparse.length > 0) {
      const dirs = sparse.map(
        ({ file }) => relPosix(root, path.dirname(file)) || 'the workspace root project',
      )
      const add = `git sparse-checkout add ${[...new Set(sparse.map((s) => s.add))].join(' ')}`
      throw new UserError(
        new Set(dirs).size === 1
          ? `${dirs[0]} is outside this sparse checkout, so vx lock cannot read its ${path.basename(sparse[0]!.file)} — run \`${add}\``
          : `${listed(dirs, 5)} are outside this sparse checkout, so vx lock cannot read their configs — run \`${add}\``,
        'VX_E_LOCK',
      )
    }
    out.strayReviews = strayReviews
    out.shadowed = shadowed
    // The workspace file too: the plugins' options there map the projects.
    const workspace = await workspaceFile(root)
    const taken = await takeConfigStamps(root, [
      ...found.map((f) => f.configPath),
      ...(workspace !== null && workspaceRootOf(workspace) === root ? [workspace] : []),
    ])
    // Only the bytes the plugins came from: an edit since the load is
    // asked of the next run.
    const rel = workspace === null ? null : path.relative(root, workspace)
    const read = rel === null ? undefined : taken.configs[rel]
    if (read !== undefined && !evaluatedWorkspace(workspace!, read[2])) delete taken.configs[rel!]
    out.stamps = { cacheDir, taken }
    // The one load that evaluates: every reader reads the lock this writes.
    const configs = await loadProjectConfigs(
      found.map((f) => f.configPath),
      root,
    )
    // In the lock's form: a field left `undefined` is a key the stored JSON
    // never has. Entries, not assignment: a directory named `__proto__` is
    // a key of its own (D-152).
    out.fresh.projects = Object.fromEntries(
      found.map((f, i) => [
        lockKey(root, f.dir),
        {
          name: configs[i]!.name ?? pathName(root, f.dir),
          file: path.basename(f.configPath),
          config: JSON.parse(JSON.stringify(configs[i])) as ProjectConfig,
        },
      ]),
    )
    if (nestedWorkspaces.length > 0)
      out.fresh.nestedWorkspaces = nestedWorkspaces.map((dir) => lockKey(root, dir))
    // The stages edit what they are handed; the lock keeps what the configs say.
    const view = structuredClone(out.fresh)
    const lock = async (): Promise<Lockfile> => view
    out.all = await lockDiscovery(root, lock, plugins, cacheDir, warn)
    for (const m of out.all) {
      const why = m.configPath === null ? ignoredConfigRefusal(root, m) : undefined
      if (why !== undefined) throw new UserError(why, 'VX_E_LOCK')
      // Its configs are the nested workspace's: locked here, it held none, and
      // every reader said to run the `vx lock` that had just run.
      const by = addedByPlugin(m)
      const wall =
        by === undefined
          ? undefined
          : nestedWorkspaces.find((w) => m.dir === w || m.dir.startsWith(w + path.sep))
      if (wall !== undefined) {
        const [dir, inner] = [relPosix(root, m.dir), relPosix(root, wall)]
        throw new UserError(
          `plugin '${by}' adds project ${dir}, but ${inner}/.vx makes ${inner} a workspace of its own, which this one's lock cannot hold — leave ${dir} out of what the plugin discovers, or delete ${inner}/.vx`,
          'VX_E_LOCK',
        )
      }
    }
    const { projects, stage, reads } = await loadProjects({
      workspaceRoot: root,
      cacheDir,
      plugins,
      projectMetas: out.all,
      seeds: 'all',
      closure: false,
      configs: lock,
      warn,
      lock: true,
    })
    // The files a `project` plugin made a config from, stamped as configs are
    // (after the stage read them: one edited in between reads as unchanged).
    if (reads !== undefined && reads.size > 0 && out.stamps !== undefined) {
      const byDir: Record<string, string[]> = {}
      for (const [dir, files] of reads)
        byDir[lockKey(root, dir)] = [...files].map((f) => relPosix(root, f)).sort()
      const read = await takeConfigStamps(root, [
        ...new Set([...reads.values()].flatMap((f) => [...f])),
      ])
      const taken = out.stamps.taken
      // A file absent has no stamp: a run refuses once it appears.
      out.stamps.taken = { ...taken, configs: { ...taken.configs, ...read.configs }, reads: byDir }
    }
    for (const entry of projects.values()) resolved.set(entry.name, entry.config)
    // Each project as the stages left it, and nothing of the steps there: a
    // run reads its name, its config after the `project` stage and its
    // edges (in the dependencies lock) and runs no hook, so a mapping is made
    // here and nowhere else (2026-11-21).
    out.fresh.projects = finalProjects(root, out.all, out.fresh.projects, stage)
    out.staged = true
    out.loaded = true
    out.dependencies = await dependenciesOf(root, out.all, plugins, cacheDir, warn)
    checkBracketLiterals(root, projects.values())
    const badNetwork = await networkPatternRefusal(projects.values())
    if (badNetwork !== undefined) throw new UserError(badNetwork, 'VX_E_LOCK')
    const names = new Set<string>()
    for (const entry of projects.values()) {
      const tasks = Object.entries(entry.config.tasks ?? {})
      // Every project has a `build`; core's default one is nothing to freeze.
      if (tasks.some(([, t]) => !isDefaultBuild(t))) tasked.add(entry.name)
      for (const [t] of tasks) names.add(t)
    }
    const dependencyRules = workspaceConfig?.run?.rules?.dependencies ?? []
    if (dependencyRules.length > 0)
      checkDependencyRules(
        dependencyRules,
        [...projects.keys()],
        new Map([...projects.values()].map((p) => [p.name, p.config.tags ?? []])),
        buildPackageGraph(out.all, taskEdgesFrom(projects)),
      )
    const rules = runRules(workspaceConfig)
    const nameOf = new Map(out.all.map((m) => [m.dir, m.name]))
    const nodes = everyGraphRefusal(
      {
        projects,
        packageGraph: buildPackageGraph(out.all),
        requested: expandRequested([...names], [...projects.keys()], projects, isDefaultBuild),
        workspaceRoot: root,
        rules,
        nestedProjects: new Map(
          [...computeNestedProjectDirs(out.all, nestedWorkspaces)].map(([name, dirs]) => [
            name,
            dirs.map((dir) => {
              const project = nameOf.get(dir)
              return project === undefined
                ? { name: relPosix(root, dir), dir, workspace: true }
                : { name: project, dir }
            }),
          ]),
        ),
        projectConfigs: out.all.flatMap((m) =>
          m.configPath === null ? [] : [{ name: m.name, configPath: m.configPath }],
        ),
      },
      (err) => placedDependsOn(err, out.all, root),
    )
    if (hasHook(plugins, 'graph'))
      await applyGraphStage(plugins, nodes, {
        workspaceRoot: root,
        cacheDir,
        projectMetas: out.all,
        warn,
        rules,
      })
    // A run refuses it after its `graph` stage; the lock, which holds the
    // graph every run trusts, refuses it too.
    refuseFiltersThroughGroups(nodes)
    // A typo in a pipeline's task waited for the CI job that runs it.
    refuseUnknownPipelineTasks(workspaceConfig?.pipelines, nodes.keys(), projects.keys())
  } catch (err) {
    if (isUserError(err))
      return {
        ...out,
        broken: placedDependsOn(err, out.all, root) ?? err.message,
        brokenCode: errorCode(err),
        ...(err.parts ? { brokenParts: err.parts } : {}),
        ...(err instanceof ConfigsRefused ? { alsoBroken: err.all.slice(1) } : {}),
      }
    throw err
  }
  return out
}

/** Each pipeline's task a node of the locked graph, or the lock refused naming it. */
function refuseUnknownPipelineTasks(
  pipelines: Readonly<Record<string, { readonly tasks: readonly string[] }>> | undefined,
  ids: Iterable<string>,
  names: Iterable<string>,
): void {
  if (pipelines === undefined) return
  const all = new Set(ids)
  const bare = new Set([...all].map((id) => id.slice(id.lastIndexOf('#') + 1)))
  // Every project has a `build`: core's default one, which the graph leaves
  // out where it has nothing to run.
  const projects = new Set(names)
  const known = (t: string): boolean => {
    const at = t.lastIndexOf('#')
    if (at < 0) return t === 'build' || bare.has(t)
    return all.has(t) || (t.slice(at + 1) === 'build' && projects.has(t.slice(0, at)))
  }
  for (const [name, p] of Object.entries(pipelines)) {
    const unknown = p.tasks.filter((t) => !known(t))
    if (unknown.length > 0)
      throw new UserError(
        `pipelines.${name}.tasks names ${unknown.join(', ')}, which no project declares; tasks: ${[...bare].sort().join(', ')}`,
        'VX_E_CONFIG',
      )
  }
}

/**
 * The task graph, or every refusal building it meets: the first build stops
 * at one, so each requested task is built alone, every bad `dependsOn` entry
 * collected, to name the rest (a cycle once, whichever task reached it).
 * Only on the refused path.
 */
function everyGraphRefusal(
  options: Parameters<typeof buildTaskGraph>[0],
  placed: (err: UserError) => string | undefined,
): ReturnType<typeof buildTaskGraph> {
  try {
    return buildTaskGraph(options)
  } catch (first) {
    if (!isUserError(first)) throw first
    // One refusal however a build met it: a cycle or a pair of tasks is
    // named from whichever end that task's build started at.
    const keyOf = (err: UserError): string => {
      const ids = err.message.match(/[^\s:'"`,]+#[^\s:'"`,]+/g)
      return ids === null ? err.message : `${err.code}\0${[...new Set(ids)].sort().join('\0')}`
    }
    const all = new Map<string, UserError>([[keyOf(first), first]])
    const sound = new Set<string>()
    for (const one of options.requested) {
      if (sound.has(`${one.project}#${one.task}`)) continue
      const refusals: UserError[] = []
      try {
        const nodes = buildTaskGraph({ ...options, requested: [one], refusals })
        if (refusals.length === 0) for (const id of nodes.keys()) sound.add(id)
      } catch (err) {
        if (!isUserError(err)) throw err
        refusals.push(err)
      }
      for (const err of refusals) {
        const key = keyOf(err)
        if (all.has(key)) continue
        const at = placed(err)
        all.set(key, at === undefined ? err : new UserError(at, err.code))
      }
    }
    if (all.size < 2) throw first
    throw new ConfigsRefused([...all.values()])
  }
}

interface GraphCheck {
  /** A graph rule's refusal, or a config that does not load; null when sound. */
  broken: string | null
  /** `broken`'s error code (`VX_E_CYCLE`, `VX_E_CONFIG`, …). */
  brokenCode?: string
  brokenParts?: RefusalParts
  /** Every config loaded and resolved: `broken`, if set, is a graph rule's refusal. */
  loaded: boolean
  /**
   * `fresh.projects` holds each config as the `project` stage leaves it:
   * the stage ran, or no plugin fills it. A refusal before the stage
   * leaves the configs as written, which no lock entry is.
   */
  staged: boolean
  /** The other configs that do not load, past `broken`. */
  alsoBroken?: readonly UserError[]
  /** The lock the configs evaluate to here. */
  fresh: Lockfile
  /** Every project, as a run discovers them from `fresh`. */
  all: ProjectMeta[]
  /** The projects that have a task. */
  tasked: Set<string>
  /** Each project's config as a run resolves it, plugins applied. */
  resolved: Map<string, ProjectConfig>
  /** `lock.reviewFiles`. */
  reviewFiles: boolean
  /** Review copies in a directory no config is in (`findProjectConfigs`). */
  strayReviews: string[]
  /** Config files a higher-precedence one beside them hides (`findProjectConfigs`). */
  shadowed: { file: string; read: string }[]
  /** What the dependencies resolve to here; null when the configs did not load. */
  dependencies: DependenciesLock | null
  /** Each config as read before its evaluation, and where a run reads it back. */
  stamps?: { cacheDir: string; taken: ConfigStamps }
}

/** Each project's edges and each claimed file's digests, as `--affected` reads them back. */
async function dependenciesOf(
  root: string,
  all: readonly ProjectMeta[],
  plugins: Parameters<typeof fingerprintClaims>[0],
  cacheDir: string,
  warn: (message: string) => void,
): Promise<DependenciesLock> {
  const ctx = {
    workspaceRoot: root,
    cacheDir,
    warn,
    projects: all.map((p) => ({ name: p.name, dir: p.dir })),
  }
  const files = new Map<string, NonNullable<Awaited<ReturnType<typeof claimedDigests>>>>()
  for (const [file, plugin] of fingerprintClaims(plugins)) {
    const answer = await claimedDigests(plugin, file, ctx)
    if (answer !== undefined) files.set(file, answer)
  }
  return dependenciesLock(all, files)
}

/**
 * Each project's lock entry as the stages left it, sorted by directory:
 * its name, its config file, the plugin that
 * added it, and its config after the `project` stage (`evaluated` where no
 * plugin fills it).
 */
function finalProjects(
  root: string,
  all: readonly ProjectMeta[],
  evaluated: Lockfile['projects'],
  stage: ReadonlyMap<string, ProjectConfig> | undefined,
): Lockfile['projects'] {
  const entries = all.map((meta): [string, LockedProject] => {
    const dir = lockKey(root, meta.dir)
    const held = Object.hasOwn(evaluated, dir) ? evaluated[dir] : undefined
    const by = addedByPlugin(meta)
    const config = stage?.get(meta.dir) ?? held?.config
    return [
      dir,
      {
        name: meta.name,
        ...(held?.file !== undefined ? { file: held.file } : {}),
        ...(by !== undefined ? { by } : {}),
        ...(config !== undefined ? { config } : {}),
      },
    ]
  })
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return Object.fromEntries(entries)
}

function configured(all: readonly ProjectMeta[]): ConfiguredMeta[] {
  return all.filter((m): m is ConfiguredMeta => m.configPath !== null)
}

/**
 * `vx init`'s last step: the lock, as `vx lock` writes it, its line
 * returned for the report's `lock` row. A refusal (a graph rule, a config
 * that does not load) is printed and leaves the written configs in place.
 */
export async function lockAfterMigration(root: string): Promise<{ code: number; said: string }> {
  let said = ''
  try {
    const code = await lockWorkspace(root, warnToStderr, (line) => (said = line))
    return { code, said }
  } catch (err) {
    if (!isUserError(err)) throw err
    notWritten(err.message, err.parts, err instanceof ConfigsRefused ? err.all.slice(1) : [])
    return { code: 1, said }
  }
}

/** Refusals shown in full past the first; the rest are counted. */
const ALSO_SHOWN = 4
/** Review copies written at once: well under macOS's default 256 descriptors. */
const REVIEW_WIDTH = 64

/** One refusal `notWritten` prints, and the configs it reaches when it is in a file they import. */
interface Refused {
  message: string
  parts?: RefusalParts
  usedBy: string[]
}

/**
 * The lock refused: the refusal's own parts, or its config line and frame,
 * or its message; then each other config that does not load, so one run
 * names what a repo must fix. A field set in a file several configs import
 * is one refusal, said once with the configs it reaches.
 */
function notWritten(
  message: string,
  parts: RefusalParts | undefined,
  also: readonly UserError[] = [],
): void {
  // Masked: a config's own throw is its author's text, and quotes what
  // it read (L-11). bin.ts masks what reaches it; this is printed here.
  const groups = new Map<string, Refused>()
  for (const [i, e] of [{ message, parts }, ...also].entries()) {
    const masked = maskedLine(e.message)
    const c = e.parts === undefined ? configRefusal(masked, process.cwd()) : undefined
    const key = c?.via === undefined ? `#${i}` : `${c.where}\0${c.problem}`
    const group = groups.get(key)
    if (group !== undefined) group.usedBy.push(c!.via!)
    else
      groups.set(key, {
        message: masked,
        ...(e.parts !== undefined ? { parts: e.parts } : {}),
        usedBy: c?.via === undefined ? [] : [c.via],
      })
  }
  const [first, ...rest] = [...groups.values()]
  const say = (g: Refused, headline: string) =>
    ui.print(
      'err',
      refusalNotice('vx lock', g.message, g.parts, {
        headline,
        ...(g.usedBy.length > 1 ? { usedBy: g.usedBy } : {}),
      }),
    )
  say(first!, 'lock not written')
  for (const g of rest.slice(0, ALSO_SHOWN)) say(g, 'also refused')
  const more = rest.slice(ALSO_SHOWN).reduce((n, g) => n + Math.max(1, g.usedBy.length), 0)
  if (more > 0)
    sayNotice('error', 'vx lock', `${more} more configs refused; fix these, then run vx lock again`)
}

/** Names shown per note: a turbo() repo can have hundreds of bare projects. */
const BARE_SHOWN = 5

function bareNames(bare: readonly string[]): string {
  const more = bare.length - BARE_SHOWN
  return more > 0 ? `${bare.slice(0, BARE_SHOWN).join(', ')} and ${more} more` : bare.join(', ')
}

function bareNote(bare: readonly string[]): string {
  return bare.length === 0 ? '' : ` (and the tasks a plugin maps for ${bareNames(bare)})`
}

interface Review {
  name: string
  file: string
  config: ProjectConfig
  text: string
}

/** Each configured project's review copy: its resolved config, pretty. */
function sameJson(text: string, config: ProjectConfig): boolean {
  try {
    return Bun.deepEquals(JSON.parse(text), JSON.parse(JSON.stringify(config)), true)
  } catch {
    return false
  }
}

function reviewsOf(metas: ConfiguredMeta[], resolved: Map<string, ProjectConfig>): Review[] {
  return metas.flatMap((m) => {
    const config = resolved.get(m.name)
    if (config === undefined) return []
    return [
      {
        name: m.name,
        file: path.join(path.dirname(m.configPath), REVIEW_FILE),
        config,
        text: `${JSON.stringify(config, null, 2)}\n`,
      },
    ]
  })
}

/** Writes `text` to `file` unless it exists: one a user edited stays theirs. */
async function writeIfMissing(file: string, text: string): Promise<void> {
  try {
    const fh = await open(file, 'wx')
    await fh.writeFile(text)
    await fh.close()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
}

async function writeLock(
  root: string,
  check: GraphCheck,
  say: (line: string) => void,
): Promise<number> {
  const metas = configured(check.all)
  const bare = bareProjects(check.all, check.tasked)
  // By project name, as the refusal names them.
  const projects: Record<string, ProjectConfig> = Object.fromEntries(
    metas.map((m) => [m.name, check.fresh.projects[lockKey(root, m.dir)]!.config!]),
  )
  const reviews = check.reviewFiles ? reviewsOf(metas, check.resolved) : []
  const leaks = await lockLeaks(root, check, metas, projects, reviews)
  if (leaks.length > 0) {
    notWritten('', {
      headline: 'these configs evaluated to a secret value',
      what: leaks.map((l) => l.at),
      why: 'the lock is committed, so the secret would be too',
      fix: `let the shell expand it ($${leaks[0]!.name} in the command, the name in exec.env.passThrough) instead of reading process.env in the config`,
    })
    return 1
  }
  // The copies first: one that cannot be written leaves the lock as it was,
  // not a new lock beside stale copies and a stack.
  for (const r of reviews) refuseSymlink(r.file, root)
  // `REVIEW_WIDTH` at a time: all at once ran out of macOS's default 256
  // descriptors in a 400-project workspace.
  const results: ({ file: string; err: NodeJS.ErrnoException } | null)[] = []
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < reviews.length) {
      const i = next++
      const r = reviews[i]!
      results[i] = await writeNoFollow(r.file, r.text, root).then(
        () => null,
        (err: unknown): { file: string; err: NodeJS.ErrnoException } => {
          if (typeof (err as NodeJS.ErrnoException).code !== 'string' || isOutOfFds(err)) throw err
          return { file: r.file, err: err as NodeJS.ErrnoException }
        },
      )
    }
  }
  await Promise.all(Array.from({ length: Math.min(REVIEW_WIDTH, reviews.length) }, lane))
  const blocked = results.filter((b) => b !== null)
  if (blocked.length > 0) {
    const first = blocked[0]!
    notWritten('', {
      headline: `${blocked.length === 1 ? 'a review copy' : 'review copies'} could not be written`,
      // The code and the copy's path: the message names the temp the write renames.
      what: blocked.map((b) => `${b.err.code}: ${relPosix(root, b.file)}`),
      fix: isFsRefusal(first.err)
        ? fsRefusalHint(first.err)
        : `remove what stands at ${relPosix(root, first.file)}, then run vx lock again`,
    })
    return 1
  }
  // Both renames under one exclusive hold: a run reads both under a shared one.
  const held = await holdLockFiles(root, 'exclusive')
  try {
    await writeAllOrNone(
      [lockfileWrite(root, check.fresh), dependenciesLockWrite(root, check.dependencies!)],
      root,
    )
  } finally {
    held()
  }
  await writeIfMissing(path.join(root, '.vx', '.gitattributes'), DOT_VX_GITATTRIBUTES)
  if (check.stamps) await keepConfigStamps(root, check.stamps)
  const n = metas.length
  say(
    `${n} project config${n === 1 ? '' : 's'} → ${LOCKFILE_NAME}, ${DEPENDENCIES_LOCK_NAME}${bareNote(bare)}`,
  )
  // A second config beside the one read was edited and nothing changed.
  warnShadowed(root, check, 'vx lock')
  // Named here too: a lock that wrote clean failed the `--check` after it.
  if (check.reviewFiles)
    for (const file of await strayCopies(check)) sayNotice('warn', 'vx lock', strayLine(root, file))
  // `import.meta.dir` in a command locks this checkout's path: another
  // checkout's `--check` fails and its keys differ.
  const at = new RegExp(`${RegExp.escape(root)}(?![^/\\s"'])`)
  for (const [name, config] of Object.entries(projects))
    if (at.test(JSON.stringify(config)))
      sayNotice(
        'warn',
        'vx lock',
        `${name}: its config holds this checkout's path (${root}), so another checkout locks it otherwise and keys it apart — use a path relative to the project, or $VX_RUN_WORKSPACE in the command`,
      )
  for (const line of await unkeyedReads(root, check)) sayNotice('warn', 'vx lock', line)
  return 0
}

/**
 * Variables a bundler writes into what it builds: Vite's, Next's, CRA's,
 * Astro's and SvelteKit's, Expo's, Gatsby's, Storybook's, Vue CLI's, Bun's,
 * Nx's, Nuxt's, Redwood's and Sanity's public prefixes, and `NODE_ENV`.
 * Only these: `passThrough` exists for values that do not change the output
 * (`CI`, a region, a token).
 */
/** How long `vx lock` waits on every task's runtime probes, asked at once. */
const PROBE_ANSWER_MS = 5_000

const INLINED_ENV =
  /^(?:VITE_|NEXT_PUBLIC_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_|GATSBY_|STORYBOOK_|VUE_APP_|BUN_PUBLIC_|NX_PUBLIC_|NUXT_ENV_|NUXT_PUBLIC_|REDWOOD_ENV_|SANITY_STUDIO_)|^NODE_ENV$/

/**
 * A dotenv file Vite, Next and Bun load from a project's directory on their
 * own: `.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local`. A template
 * (`.env.example`) is read by none.
 */
const LOADED_DOTENV =
  /^\.env(?:\.(?!(?:example|sample|template|dist|defaults)(?:\.|$))[^.]+)?(?:\.local)?$/

/** The loaded dotenv files in `dir`, sorted; one listing per project. */
function dotenvFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && LOADED_DOTENV.test(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * What a task reads that its key never sees, said where the lock evaluates
 * every task: an ignored file a glob's last segment matches (a run names it
 * only on a miss, which a stale hit never brings, and Vite loads an ignored
 * `.env.production.local`), and, for a cached task, a `passThrough` name a
 * bundler inlines that `inputs.env` does not key, or one `inputs.env` keys
 * that the command never gets. One git spawn at most, and a task's runtime
 * probes only for a file it would name: a probe that prints the file's path
 * keys it (turbo()'s `.env` probe), so that file is not named.
 */
async function unkeyedReads(root: string, check: GraphCheck): Promise<string[]> {
  // One line per finding, naming every task it holds for: a migrated Turbo
  // repo's shared `globalPassThroughEnv` (NODE_ENV) printed it once per task,
  // 78 lines on create-t3-turbo.
  const tasksOf = new Map<string, string[]>()
  const said = (task: string, line: string) => {
    const tasks = tasksOf.get(line)
    if (tasks === undefined) tasksOf.set(line, [task])
    else tasks.push(task)
  }
  const found: { task: string; ws: string; rel: string; glob: string }[] = []
  let dotenvOf: Map<string, string[]> | undefined
  const answers = new Map<string, Promise<string>>()
  // One deadline for every probe: a hung one costs its note, never the lock.
  // vx's exit kills the probes still running.
  let probeDeadline: Promise<string> | undefined
  const probedOf = new Map<string, Promise<Set<string>>>()
  type Found = (typeof found)[number]
  // Each task's notes in its own lists, merged in task order below: the
  // tasks run at once, so every probe starts before the one deadline counts
  // (one after another, a third 2 s probe got 1 s).
  const steps = check.all.flatMap((m) =>
    Object.entries(check.resolved.get(m.name)?.tasks ?? {}).map(async ([name, t]) => {
      const task = `${m.name}#${name}`
      const lines: string[] = []
      const taskFound: Found[] = []
      // The workspace-relative paths a line of the task's probe output names.
      const probed = (): Promise<Set<string>> => {
        let got = probedOf.get(task)
        if (got !== undefined) return got
        const ask = async (cmd: string, workspace: boolean) => {
          const at = `${workspace ? root : m.dir}\0${cmd}`
          let out = answers.get(at)
          if (out === undefined)
            answers.set(
              at,
              (out = Promise.race([
                answerRuntime(cmd, m.dir, root, workspace).catch(() => ''),
                (probeDeadline ??= new Promise<string>((resolve) => {
                  setTimeout(resolve, PROBE_ANSWER_MS, '').unref()
                })),
              ])),
            )
          const base = workspace ? root : m.dir
          return (await out).split('\n').map((l) => relPosix(root, path.join(base, l)))
        }
        got = Promise.all([
          ...(t.inputs?.runtime ?? []).map((c) => ask(c, false)),
          ...(t.inputs?.workspaceRuntime ?? []).map((c) => ask(c, true)),
        ]).then((all) => new Set(all.flat()))
        probedOf.set(task, got)
        return got
      }
      const hasProbes =
        (t.inputs?.runtime?.length ?? 0) + (t.inputs?.workspaceRuntime?.length ?? 0) > 0
      const own = outputMatcher(t.outputs?.files ?? [])
      const ownWs = outputMatcher(t.outputs?.workspaceFiles ?? [])
      // A literal entry keys the ignored file it names, as a run's walk does.
      const named = (globs: readonly string[] | undefined, base: string) =>
        (globs ?? [])
          .filter((g) => !g.startsWith('!') && isLiteralPattern(g))
          .map((g) => ({ path: relPosix(root, path.join(base, g)) }))
      const literals = [...named(t.inputs?.files, m.dir), ...named(t.inputs?.workspaceFiles, root)]
      for (const [abs, rel, glob] of [
        ...ignoredByGlobs(t.inputs?.files, m.dir, root, literals),
        ...ignoredByGlobs(t.inputs?.workspaceFiles, root, root, literals),
      ]) {
        const ws = relPosix(root, abs)
        // A `**` reader with no cache has no key to go stale.
        if (glob.includes('**') && t.cache !== true) continue
        if (own(relPosix(m.dir, abs)) || ownWs(ws)) continue
        if (hasProbes && (await probed()).has(ws)) continue
        taskFound.push({ task, ws, rel, glob })
      }
      if (t.cache !== true) return { task, lines, found: taskFound }
      // A build that leaves a `.env` beside its config out of its inputs
      // replays the old bundle after an edit to it: Vite inlines its values.
      const outputs = (t.outputs?.files?.length ?? 0) + (t.outputs?.workspaceFiles?.length ?? 0)
      if (outputs > 0) {
        const files = t.inputs?.files ?? []
        const keyed = anyTaskGlob(files.filter((g) => !g.startsWith('!')))
        const excluded = anyTaskGlob(files.filter((g) => g.startsWith('!')).map((g) => g.slice(1)))
        dotenvOf ??= new Map()
        let env = dotenvOf.get(m.dir)
        if (env === undefined) dotenvOf.set(m.dir, (env = dotenvFiles(m.dir)))
        let unread = env.filter((f) => !keyed(f) && !excluded(f))
        if (unread.length > 0 && hasProbes) {
          const seen = await probed()
          unread = unread.filter((f) => !seen.has(relPosix(root, path.join(m.dir, f))))
        }
        if (unread.length > 0)
          lines.push(
            `${unread.join(', ')} beside its config ${unread.length === 1 ? 'is' : 'are'} in no input, and Vite, Next and Bun load ${unread.length === 1 ? 'it' : 'them'} on their own — add '.env*' to inputs.files, or '!.env*' if the task reads none`,
          )
      }
      const quiet = new Set([...(t.inputs?.env ?? []), ...(t.exec?.env?.secret ?? [])])
      const unkeyed = (t.exec?.env?.passThrough ?? []).filter(
        (v) => INLINED_ENV.test(v) && !quiet.has(v) && !secretNamed(v),
      )
      if (unkeyed.length > 0)
        lines.push(
          `exec.env.passThrough forwards ${unkeyed.join(', ')}, which a bundler writes into its output, and the key does not see ${unkeyed.length === 1 ? 'it' : 'them'} — add ${unkeyed.length === 1 ? 'it' : 'them'} to inputs.env`,
        )
      // The reverse: the key moves with the value, but the build never sees it.
      const given = new Set([
        ...(t.exec?.env?.passThrough ?? []),
        ...Object.keys(t.exec?.env?.define ?? {}),
      ])
      const unseen = (t.inputs?.env ?? []).filter((v) => INLINED_ENV.test(v) && !given.has(v))
      if (unseen.length > 0)
        lines.push(
          `inputs.env keys ${unseen.join(', ')}, which a bundler writes into its output, but the command never gets ${unseen.length === 1 ? 'it' : 'them'} — add ${unseen.length === 1 ? 'it' : 'them'} to exec.env.passThrough`,
        )
      return { task, lines, found: taskFound }
    }),
  )
  for (const step of await Promise.all(steps)) {
    found.push(...step.found)
    for (const line of step.lines) said(step.task, line)
  }
  const ignored =
    found.length === 0 ? null : checkIgnoreSync(root, [...new Set(found.map((f) => f.ws))])
  const ignoredLines = found
    .filter((f) => ignored?.has(f.ws) === true)
    .map((f) => ignoredInputLine(f.task, f.rel, f.glob))
  const lines = [...tasksOf].map(
    ([line, tasks]) =>
      `${tasks.length <= 3 ? tasks.join(', ') : `${tasks.slice(0, 2).join(', ')} and ${tasks.length - 2} more tasks`}: ${line}`,
  )
  return [...ignoredLines, ...lines]
}

/**
 * Where the plugins, run here, leave a project otherwise than the lock
 * records: one a `discover` plugin adds, names or no longer finds, or a
 * config-less one a `project` plugin maps. A run follows the record, so an
 * edited turbo.json or `project.json` is drift until `vx lock`. A
 * directory already in `drifted` (its config file's own drift) is named
 * once.
 */
function pluginDrift(lock: Lockfile, fresh: Lockfile, drifted: ReadonlySet<string>): string[] {
  const out: string[] = []
  const what = (dir: string): string => (dir === '.' ? 'the workspace root project' : dir)
  for (const [dir, now] of Object.entries(fresh.projects)) {
    if (drifted.has(dir)) continue
    const held = Object.hasOwn(lock.projects, dir) ? lock.projects[dir] : undefined
    if (held === undefined) {
      if (now.file === undefined) out.push(`${what(dir)} is not in the lock — run 'vx lock'`)
      continue
    }
    if (held.name !== now.name || held.by !== now.by)
      out.push(
        `${what(dir)}: the lock names it ${JSON.stringify(held.name ?? null)}${held.by === undefined ? '' : ` (added by '${held.by}')`}, the plugins here ${JSON.stringify(now.name ?? null)}${now.by === undefined ? '' : ` (added by '${now.by}')`} — run 'vx lock'`,
      )
    else if (now.file === undefined && !Bun.deepEquals(now.config, held.config, true))
      out.push(
        `${what(dir)}: the plugins map it differently from the lock here — a file ` +
          `a plugin reads, or the environment, changed; run 'vx lock'` +
          configDiff(held.config, now.config)
            .map((d) => `\n  ${maskedLine(d)}`)
            .join(''),
      )
  }
  for (const [dir, held] of Object.entries(lock.projects))
    if (held.file === undefined && !Object.hasOwn(fresh.projects, dir))
      out.push(`the lock holds ${what(dir)}, which no plugin adds now — run 'vx lock'`)
  return out
}

/** The first places (three at most) two evaluated configs differ: `path: locked → now`. */
function configDiff(locked: unknown, now: unknown, at = '', out: string[] = []): string[] {
  if (out.length >= 3 || Bun.deepEquals(locked, now, true)) return out
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object'
  if (isObj(locked) && isObj(now) && Array.isArray(locked) === Array.isArray(now)) {
    for (const k of new Set([...Object.keys(locked), ...Object.keys(now)])) {
      const next = Array.isArray(now) ? `${at}[${k}]` : at === '' ? k : `${at}.${k}`
      configDiff(locked[k], now[k], next, out)
    }
    return out
  }
  out.push(`${at}: ${diffValue(locked)} → ${diffValue(now)}`)
  return out
}

function diffValue(v: unknown): string {
  if (v === undefined) return '(none)'
  const s = JSON.stringify(v)
  return s.length > 60 ? `${s.slice(0, 59)}…` : s
}

/**
 * Review copies with no config beside them, sorted. One left beside a
 * config since deleted shows reviewers tasks nothing runs, and keys the
 * `**` of a project around it. vx never deletes a committed file; it
 * names it. A project kept without a config (a plugin's) is checked on
 * disk; any other directory is what discovery listed.
 */
async function strayCopies(check: GraphCheck): Promise<string[]> {
  const kept = await Promise.all(
    check.all
      .filter((m) => m.configPath === null)
      .map(async (m) => {
        const file = path.join(m.dir, REVIEW_FILE)
        return (await Bun.file(file).exists()) ? file : null
      }),
  )
  return [...new Set([...kept.filter((f) => f !== null), ...check.strayReviews])].sort()
}

/**
 * A copy's config renamed to a name vx does not read (`.json`, `.tsx`)
 * is still there: "delete it" was the wrong advice. Looked for only here,
 * once a copy is already stray.
 */
function strayLine(root: string, file: string): string {
  const copy = `${relPosix(root, file)} has no vx.config beside it`
  let names: string[] = []
  try {
    names = readdirSync(path.dirname(file))
  } catch {
    // gone or unreadable: nothing beside it to name
  }
  const unread = names
    .filter((n) => n.startsWith('vx.config.') && !PROJECT_CONFIG_FILENAMES.includes(n))
    .sort()[0]
  if (unread === undefined) return `${copy} — delete it`
  const exts = PROJECT_CONFIG_FILENAMES.map((n) => n.slice('vx.config.'.length)).join(', ')
  return `${copy}: ${unread} is not a config vx reads (${exts})`
}

/**
 * Where the lock `vx lock` would write holds a secret value here: the
 * configs, the review copies and the `project` stage's record, all
 * committed (a place two hold is named once). A value the config's source
 * or a local module it imports spells is the repo's own text, not one the
 * evaluation read: `docker compose up postgres` beside
 * `DATABASE_URL=postgres://postgres:postgres@…` refused every relock. Read
 * only when some value matched, so the common lock reads nothing more.
 */
async function lockLeaks(
  root: string,
  check: GraphCheck,
  metas: readonly ConfiguredMeta[],
  projects: Record<string, ProjectConfig>,
  reviews: readonly Review[],
): Promise<Array<{ at: string; name: string }>> {
  const nameAt = new Map(check.all.map((m) => [lockKey(root, m.dir), m.name]))
  // A config-less project's config is the `project` stage's alone.
  const staged = Object.entries(check.fresh.projects).flatMap(([dir, e]) =>
    e.file === undefined && e.config !== undefined
      ? [[nameAt.get(dir) ?? dir, e.config] as const]
      : [],
  )
  const committed = Object.fromEntries([
    ...reviews.map((r) => [r.name, r.config] as const),
    ...staged,
  ])
  const scan = (spelled: (project: string, value: string) => boolean) => {
    const leaks = secretsIn(projects, spelled)
    const named = new Set(leaks.map((l) => l.at))
    for (const l of secretsIn(committed, spelled)) if (!named.has(l.at)) leaks.push(l)
    return leaks
  }
  if (scan(() => false).length === 0) return []
  const texts = new Map(
    await Promise.all(metas.map(async (m) => [m.name, await sourceTexts(m.configPath)] as const)),
  )
  return scan((project, value) => texts.get(project)?.some((t) => t.includes(value)) === true)
}

/** A config's text and each local module's it imports, as `vx watch` finds them. */
async function sourceTexts(configPath: string): Promise<string[]> {
  const read = (file: string): Promise<string | null> =>
    Bun.file(file)
      .text()
      .catch(() => null)
  const own = await read(configPath)
  if (own === null) return []
  const imported = await Promise.all((await configImports(configPath, own)).map(read))
  return [own, ...imported.filter((t) => t !== null)]
}

/**
 * Each place an evaluated config holds the value of a secret in this
 * environment, by the rule output masking uses (a secret-named variable,
 * one a task lists in `exec.env.secret`, or a define of such a name whose
 * value this environment holds). The lock is committed, so such a value
 * would be published, and masking it would freeze a `***` that every run
 * runs (L-42). A value the project's own source text `spelled` is not
 * one the config evaluated: it is committed already.
 */
function secretsIn(
  projects: Record<string, ProjectConfig>,
  spelled: (project: string, value: string) => boolean,
): Array<{ at: string; name: string }> {
  const named = new Set<string>()
  const defines: Array<[name: string, value: string]> = []
  for (const config of Object.values(projects)) {
    for (const task of Object.values(config.tasks ?? {})) {
      const secret = task?.exec?.env?.secret ?? []
      for (const n of secret) named.add(n)
      for (const [n, v] of Object.entries(task?.exec?.env?.define ?? {}))
        if (secretNamed(n) || secret.includes(n)) defines.push([n, v])
    }
  }
  // Each variable's own mask: what the output masks of it, a URL's
  // password and a key's lines too, not only the whole value.
  const secrets: [mask: SecretMask, name: string][] = []
  for (const [name, value] of Object.entries(process.env)) {
    const mask =
      value === undefined ? null : secretMask([{ [name]: value }], named.has(name) ? [name] : [])
    if (mask !== null) secrets.push([mask, name])
  }
  // The output masks a secret define's value by the define's name, so
  // `API_TOKEN: process.env.MY_CREDS` printed masked and locked in clear.
  // Only a value this environment holds counts: a literal define is the
  // config's own committed text, and npm's `'${NPM_TOKEN}'` is no secret.
  for (const [n, v] of defines) {
    const mask = secretMask([{ [n]: v }], [n])
    if (mask === null) continue
    for (const [name, value] of Object.entries(process.env))
      if (value !== undefined && mask.spans(value).length > 0) secrets.push([mask, name])
  }
  if (secrets.length === 0) return []
  const found: Array<{ at: string; name: string }> = []
  const walk = (project: string, at: string, v: unknown): void => {
    if (typeof v === 'string') {
      for (const [mask, name] of secrets) {
        const place = `${project}: ${at} holds $${name}`
        // A define's mask and its variable's own both find one value.
        if (
          mask.spans(v).some(([s, e]) => !spelled(project, v.slice(s, e))) &&
          !found.some((f) => f.at === place)
        )
          found.push({ at: place, name })
      }
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(project, `${at}[${i}]`, x))
    } else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(project, at === '' ? k : `${at}.${k}`, x)
    }
  }
  for (const [project, config] of Object.entries(projects)) walk(project, '', config)
  return found
}

/** A second config beside the one read: edited, it changes nothing. */
function warnShadowed(root: string, check: GraphCheck, verb: string): void {
  for (const { file, read } of check.shadowed)
    sayNotice(
      'warn',
      verb,
      `${relPosix(root, file)} is not read: ${path.basename(read)} beside it is — delete one`,
    )
}

/** One `vx lock --check` problem: its code is what an agent branches on. */
interface LockProblem {
  code: string
  message: string
}

/** Drift `vx lock` fixes. */
const stale = (message: string): LockProblem => ({ code: 'VX_E_LOCK', message })

/**
 * Audit the lock: find and re-evaluate every config in the CURRENT
 * environment and deep-compare it with the locked object. That sees an
 * edit to the config, to a file it imports, and to the environment it
 * reads alike, and a config added or removed since.
 */
async function checkLock(root: string, json: boolean): Promise<number> {
  const check = await audit(root, warnToStderr)
  // A warning, as `vx lock` says it: the CI gate passed beside a hidden
  // config whose edit changed nothing.
  warnShadowed(root, check, 'vx lock --check')
  const { broken } = check
  const metas = configured(check.all)
  const bare = bareProjects(check.all, check.tasked)
  const answer = (problems: LockProblem[]): number => {
    if (json) {
      const out = {
        upToDate: problems.length === 0,
        // A plugin's mapping is audited too (`stageDrift`): none is left out.
        audited: metas.length + bare.length,
        notAudited: 0,
        problems,
      }
      ui.data('out', `${JSON.stringify(out)}\n`)
    }
    return problems.length === 0 ? 0 : 1
  }
  // A lock that does not read is drift `vx lock` fixes, as a missing one
  // is: the audit answers it in its own shape, not as a refusal.
  let lock: Lockfile | null
  try {
    lock = await readLockfile(root)
  } catch (err) {
    if (!isUserError(err)) throw err
    if (!json) sayNotice('error', 'vx lock --check', err.message)
    return answer([{ code: errorCode(err), message: err.message }])
  }
  if (!lock) {
    const problem = `no ${LOCKFILE_NAME} at ${root} — run \`vx lock\` first`
    if (!json) sayNotice('error', 'vx lock --check', problem)
    return answer([stale(problem)])
  }
  const failures: LockProblem[] = []
  const drifted = new Set<string>()
  for (const [dir, fresh] of Object.entries(check.fresh.projects)) {
    if (fresh.file === undefined) continue
    const rel = dir === '.' ? fresh.file : `${dir}/${fresh.file}`
    const locked = Object.hasOwn(lock.projects, dir) ? lock.projects[dir] : undefined
    const problem =
      locked?.file === undefined
        ? `${rel} is not in the lock — run 'vx lock'`
        : locked.file !== fresh.file
          ? `${rel} is not the ${locked.file} the lock holds for ${dir === '.' ? 'the workspace root project' : dir} — run 'vx lock'`
          : check.staged && !Bun.deepEquals(fresh.config, locked.config, true)
            ? `${rel} evaluates differently from the lock here — its config, a file ` +
              `it imports, or the environment it reads changed; run 'vx lock'` +
              // What changed: a config that reads the environment shows no file diff.
              configDiff(locked.config, fresh.config)
                .map((d) => `\n  ${maskedLine(d)}`)
                .join('')
            : null
    if (problem === null) continue
    failures.push(stale(problem))
    drifted.add(dir)
  }
  const lockedWalls = lock.nestedWorkspaces ?? []
  const walls = check.fresh.nestedWorkspaces ?? []
  for (const dir of walls)
    if (!lockedWalls.includes(dir))
      failures.push(stale(`${dir} is a nested workspace the lock does not hold — run 'vx lock'`))
  for (const dir of lockedWalls)
    if (!walls.includes(dir))
      failures.push(
        stale(`the lock holds ${dir} as a nested workspace, which it is not now — run 'vx lock'`),
      )
  if (check.loaded) failures.push(...pluginDrift(lock, check.fresh, drifted).map(stale))
  // Every graph refusal, root-relative as the rest of the audit, by its own
  // code: the lock's audit is the one place an agent reads VX_E_CYCLE.
  if (broken !== null && check.loaded)
    for (const [code, m] of [
      [check.brokenCode ?? 'VX_E_REFUSED', broken] as const,
      ...(check.alsoBroken ?? []).map((e) => [errorCode(e), e.message] as const),
    ])
      failures.push({ code, message: m.startsWith(`${root}/`) ? m.slice(root.length + 1) : m })
  // What `vx lock` refuses to write here fails here too: a lock written
  // where the value was no secret passed in an env where it is one.
  if (check.loaded)
    for (const l of await lockLeaks(
      root,
      check,
      metas,
      Object.fromEntries(
        metas.map((m) => [m.name, check.fresh.projects[lockKey(root, m.dir)]!.config!]),
      ),
      check.reviewFiles ? reviewsOf(metas, check.resolved) : [],
    ))
      // The config is what changes, as `vx lock` refusing it says.
      failures.push({
        code: 'VX_E_CONFIG',
        message: `${l.at}, a secret value here — the lock is committed, so the secret is too; let the shell expand $${l.name} instead of reading process.env in the config, then run 'vx lock'`,
      })
  // Each config that does not load, as `vx lock` names them: a CI fixing
  // one at a time re-ran the gate once per broken config.
  const refused: { code: string; message: string; parts?: RefusalParts }[] =
    broken === null || check.loaded
      ? []
      : [
          {
            code: check.brokenCode ?? 'VX_E_REFUSED',
            message: broken,
            ...(check.brokenParts ? { parts: check.brokenParts } : {}),
          },
          ...(check.alsoBroken ?? []).map((e) => ({
            code: errorCode(e),
            message: e.message,
            ...(e.parts ? { parts: e.parts } : {}),
          })),
        ]
  if (check.reviewFiles && check.loaded) {
    // A project the lock already fails is named once.
    const copies = await Promise.all(
      reviewsOf(
        metas.filter((m) => !drifted.has(lockKey(root, m.dir))),
        check.resolved,
      ).map(async (r) => {
        // Only a missing copy is "has no": a directory in its place, or one
        // this user cannot read, read as missing too.
        const text = await Bun.file(r.file)
          .text()
          .catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : err))
        // Compared as JSON: a formatter may lay the copy out its own way.
        if (typeof text === 'string' && sameJson(text, r.config)) return null
        const rel = relPosix(root, r.file)
        return text === null
          ? `"${r.name}" has no ${rel} — run 'vx lock'`
          : typeof text !== 'string'
            ? `"${r.name}" (${rel}) could not be read (${text.code ?? text.message}) — remove it and run 'vx lock'`
            : `"${r.name}" (${rel}) is not what its config resolves to here — run 'vx lock'`
      }),
    )
    for (const f of copies) if (f !== null) failures.push(stale(f))
    for (const file of await strayCopies(check)) failures.push(stale(strayLine(root, file)))
  }
  // A config that does not load evaluated none: every locked project
  // read as gone, the healthy ones too.
  for (const dir of check.loaded ? Object.keys(lock.projects) : []) {
    if (lock.projects[dir]!.file !== undefined && !Object.hasOwn(check.fresh.projects, dir)) {
      const what = dir === '.' ? 'the workspace root project' : dir
      failures.push(stale(`the lock holds ${what}, which has no vx.config now — run 'vx lock'`))
    }
  }
  // Named only over a lock that holds: a config drift moves the record too.
  if (check.dependencies !== null && failures.length === 0) {
    const text = await Bun.file(path.join(root, DEPENDENCIES_LOCK_NAME))
      .bytes()
      .catch(() => null)
    const read = parseDependenciesLock(text)
    if (read === null || !sameRecord(read, check.dependencies))
      failures.push(
        stale(
          text === null
            ? `${DEPENDENCIES_LOCK_NAME} is missing — run 'vx lock'`
            : read === null
              ? // As a run refuses it: a merge conflict is named, not called drift.
                dependenciesLockRefusal(new TextDecoder().decode(text))
              : `${DEPENDENCIES_LOCK_NAME} is not what the dependencies resolve to here — run 'vx lock'`,
        ),
      )
  }
  // The configs read as locked: a run that finds one edited since says so.
  if (failures.length + refused.length === 0 && check.stamps)
    await keepConfigStamps(root, check.stamps)
  if (json)
    // Root-relative, as every other problem: the loader names the absolute path.
    return answer([
      ...refused.map((r) => ({
        code: r.code,
        message: r.message.split(`${root}${path.sep}`).join(''),
      })),
      ...failures,
    ])
  if (failures.length + refused.length > 0) {
    for (const r of refused) ui.print('err', refusalNotice('vx lock --check', r.message, r.parts))
    for (const f of failures) sayNotice('error', 'vx lock --check', f.message)
    return 1
  }
  const n = metas.length
  const audited = `${n} project${n === 1 ? '' : 's'}`
  const mapped = bare.length === 0 ? '' : `; mapped by a plugin: ${bareNames(bare)}`
  ui.print('out', ui.status('ok', 'vx lock --check', `up to date (${audited}${mapped})`))
  return 0
}

/** The configs as read, beside the lock; a cache dir that cannot be made keeps none (a warning light only). */
async function keepConfigStamps(
  root: string,
  stamps: { cacheDir: string; taken: ConfigStamps },
): Promise<void> {
  try {
    makeIgnoredCacheDir(stamps.cacheDir)
  } catch {
    return
  }
  await writeConfigStamps(root, stamps.cacheDir, stamps.taken)
}
