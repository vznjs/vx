// `vx lock` — freeze every resolved vx.config.* into .vx/projects.lock.json, and
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
  applyGraphStage,
  claimedDigests,
  lockDiscovery,
  fingerprintClaims,
  hasHook,
  ignoredConfigRefusal,
  loadProjects,
} from '../orchestrator/index.js'
import { resolveSetting, runRules } from '../settings.js'
import {
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
  isUserError,
  listed,
  maskedLine,
  outputMatcher,
  relPosix,
  type RefusalParts,
  UserError,
  secretMask,
  secretNamed,
  type SecretMask,
  refuseSymlink,
  writeAllOrNone,
  writeNoFollow,
} from '../util/index.js'
import * as ui from '../ui/index.js'
import { refusalNotice, sayNotice } from '../ui/index.js'
import {
  ConfigsRefused,
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
  parseDependenciesLock,
  dependenciesLockWrite,
  type DependenciesLock,
  type Lockfile,
  type ProjectMeta,
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
  const release = await acquireRunLock(root, { log: warn, of: 'lock' })
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
    const discovered = await lockDiscovery(root, lock, plugins, cacheDir, warn)
    out.all = discovered.projects
    // What the plugin `discover` stage found, recorded: a run reads it and
    // runs no hook (2026-11-11).
    if (discovered.stage !== undefined) out.fresh.discoverStage = discovered.stage
    for (const m of out.all) {
      const why = m.configPath === null ? ignoredConfigRefusal(root, m) : undefined
      if (why !== undefined) throw new UserError(why, 'VX_E_LOCK')
    }
    const { projects, stage } = await loadProjects({
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
    for (const entry of projects.values()) resolved.set(entry.name, entry.config)
    // What the plugin `project` stage left, recorded: a run reads it and
    // runs no hook, so a mapping is made here and nowhere else.
    if (stage !== undefined)
      out.fresh.projectStage = {
        plugins: plugins.filter((p) => typeof p.project === 'function').map((p) => p.name),
        configs: Object.fromEntries(
          [...stage]
            .map(([dir, config]) => [lockKey(root, dir), config] as const)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
      }
    out.loaded = true
    out.dependencies = await dependenciesOf(root, out.all, plugins, cacheDir, warn)
    checkBracketLiterals(root, projects.values())
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
    const nodes = buildTaskGraph({
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
    })
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
  } catch (err) {
    if (isUserError(err))
      return {
        ...out,
        broken: placedDependsOn(err, out.all, root) ?? err.message,
        ...(err.parts ? { brokenParts: err.parts } : {}),
        ...(err instanceof ConfigsRefused ? { alsoBroken: err.all.slice(1) } : {}),
      }
    throw err
  }
  return out
}

interface GraphCheck {
  /** A graph rule's refusal, or a config that does not load; null when sound. */
  broken: string | null
  brokenParts?: RefusalParts
  /** Every config loaded and resolved: `broken`, if set, is a graph rule's refusal. */
  loaded: boolean
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
  return dependenciesLock(root, all, files)
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
    metas.map((m) => [m.name, check.fresh.projects[lockKey(root, m.dir)]!.config]),
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
  const blocked = (
    await Promise.all(
      reviews.map((r) =>
        writeNoFollow(r.file, r.text, root).then(
          () => null,
          (err: unknown): { file: string; err: NodeJS.ErrnoException } => {
            if (typeof (err as NodeJS.ErrnoException).code !== 'string' || isOutOfFds(err))
              throw err
            return { file: r.file, err: err as NodeJS.ErrnoException }
          },
        ),
      ),
    )
  ).filter((b) => b !== null)
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
  await writeAllOrNone(
    [
      lockfileWrite(root, check.fresh),
      ...(check.dependencies === null ? [] : [dependenciesLockWrite(root, check.dependencies)]),
    ],
    root,
  )
  await writeIfMissing(path.join(root, '.vx', '.gitattributes'), DOT_VX_GITATTRIBUTES)
  const n = metas.length
  say(`${n} project config${n === 1 ? '' : 's'} → ${LOCKFILE_NAME}${bareNote(bare)}`)
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
  for (const line of unkeyedReads(root, check)) sayNotice('warn', 'vx lock', line)
  return 0
}

/**
 * Variables a bundler writes into what it builds: Vite's, Next's, CRA's,
 * Astro's and SvelteKit's, Expo's, Gatsby's, Storybook's and Vue CLI's
 * public prefixes, and `NODE_ENV`. Only these: `passThrough` exists for
 * values that do not change the output (`CI`, a region, a token).
 */
const INLINED_ENV =
  /^(?:VITE_|NEXT_PUBLIC_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_|GATSBY_|STORYBOOK_|VUE_APP_)|^NODE_ENV$/

/**
 * What a task reads that its key never sees, said where the lock evaluates
 * every task: an ignored file a glob's last segment matches (a run names it
 * only on a miss, which a stale hit never brings, and Vite loads an ignored
 * `.env.production.local`), and, for a cached task, a `passThrough` name a
 * bundler inlines that `inputs.env` does not key. One git spawn at most.
 */
function unkeyedReads(root: string, check: GraphCheck): string[] {
  const lines: string[] = []
  const found: { task: string; ws: string; rel: string; glob: string }[] = []
  for (const m of check.all) {
    for (const [name, t] of Object.entries(check.resolved.get(m.name)?.tasks ?? {})) {
      const task = `${m.name}#${name}`
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
        if (!own(relPosix(m.dir, abs)) && !ownWs(ws)) found.push({ task, ws, rel, glob })
      }
      if (t.cache !== true) continue
      const quiet = new Set([...(t.inputs?.env ?? []), ...(t.exec?.env?.secret ?? [])])
      const unkeyed = (t.exec?.env?.passThrough ?? []).filter(
        (v) => INLINED_ENV.test(v) && !quiet.has(v) && !secretNamed(v),
      )
      if (unkeyed.length > 0)
        lines.push(
          `${task}: exec.env.passThrough forwards ${unkeyed.join(', ')}, which a bundler writes into its output, and the key does not see ${unkeyed.length === 1 ? 'it' : 'them'} — add ${unkeyed.length === 1 ? 'it' : 'them'} to inputs.env`,
        )
    }
  }
  const ignored =
    found.length === 0 ? null : checkIgnoreSync(root, [...new Set(found.map((f) => f.ws))])
  const said = found
    .filter((f) => ignored?.has(f.ws) === true)
    .map((f) => ignoredInputLine(f.task, f.rel, f.glob))
  return [...said, ...lines]
}

/**
 * Where the plugin `project` stage, run here, maps a project otherwise than
 * the lock records: a run follows the record, so an edited turbo.json or
 * script is drift until `vx lock`. A directory already in `drifted` is
 * named once.
 */
function stageDrift(lock: Lockfile, fresh: Lockfile, drifted: ReadonlySet<string>): string[] {
  const was = lock.projectStage
  const now = fresh.projectStage
  const named = (list: readonly string[]): string => list.map((p) => `'${p}'`).join(', ')
  if (was === undefined && now === undefined) return []
  if (was === undefined)
    return [`the lock holds no \`project\` stage of plugin ${named(now!.plugins)} — run 'vx lock'`]
  if (now === undefined)
    return [
      `the lock holds the \`project\` stage of ${named(was.plugins)}, which no plugin fills now — run 'vx lock'`,
    ]
  if (was.plugins.join('\0') !== now.plugins.join('\0'))
    return [
      `the lock holds the \`project\` stage of ${named(was.plugins)}, not of ${named(now.plugins)} — run 'vx lock'`,
    ]
  const out: string[] = []
  const what = (dir: string): string => (dir === '.' ? 'the workspace root project' : dir)
  for (const [dir, config] of Object.entries(now.configs)) {
    if (drifted.has(dir)) continue
    const held = Object.hasOwn(was.configs, dir) ? was.configs[dir] : undefined
    if (held === undefined)
      out.push(`${what(dir)} is not in the lock's \`project\` stage — run 'vx lock'`)
    else if (!Bun.deepEquals(config, held, true))
      out.push(
        `${what(dir)}: the \`project\` stage maps it differently from the lock here — a file ` +
          `the plugin reads, or the environment, changed; run 'vx lock'` +
          configDiff(held, config)
            .map((d) => `\n  ${maskedLine(d)}`)
            .join(''),
      )
  }
  for (const dir of Object.keys(was.configs))
    if (!Object.hasOwn(now.configs, dir))
      out.push(
        `the lock's \`project\` stage holds ${what(dir)}, which it does not map now — run 'vx lock'`,
      )
  return out
}

/**
 * Where the plugin `discover` stage, run here, finds the projects otherwise
 * than the lock records: a run follows the record, so a new edge or name
 * (an edited `project.json` under nx()) is drift until `vx lock`. A
 * directory already in `drifted` is named once.
 */
function discoverDrift(lock: Lockfile, fresh: Lockfile, drifted: ReadonlySet<string>): string[] {
  const was = lock.discoverStage
  const now = fresh.discoverStage
  const named = (list: readonly string[]): string => list.map((p) => `'${p}'`).join(', ')
  if (was === undefined && now === undefined) return []
  if (was === undefined)
    return [`the lock holds no \`discover\` stage of plugin ${named(now!.plugins)} — run 'vx lock'`]
  if (now === undefined)
    return [
      `the lock holds the \`discover\` stage of ${named(was.plugins)}, which no plugin fills now — run 'vx lock'`,
    ]
  if (was.plugins.join('\0') !== now.plugins.join('\0'))
    return [
      `the lock holds the \`discover\` stage of ${named(was.plugins)}, not of ${named(now.plugins)} — run 'vx lock'`,
    ]
  const out: string[] = []
  const what = (dir: string): string => (dir === '.' ? 'the workspace root project' : dir)
  for (const [dir, found] of Object.entries(now.projects)) {
    if (drifted.has(dir)) continue
    const held = Object.hasOwn(was.projects, dir) ? was.projects[dir] : undefined
    if (held === undefined)
      out.push(`${what(dir)} is not in the lock's \`discover\` stage — run 'vx lock'`)
    else if (!Bun.deepEquals(found, held, true))
      out.push(
        `${what(dir)}: the \`discover\` stage finds it otherwise than the lock here; run 'vx lock'` +
          configDiff(held, found)
            .map((d) => `\n  ${d}`)
            .join(''),
      )
  }
  // A config gone is named as such below.
  const gone = (dir: string): boolean =>
    Object.hasOwn(lock.projects, dir) && !Object.hasOwn(fresh.projects, dir)
  for (const dir of Object.keys(was.projects))
    if (!drifted.has(dir) && !gone(dir) && !Object.hasOwn(now.projects, dir))
      out.push(
        `the lock's \`discover\` stage holds ${what(dir)}, which it does not find now — run 'vx lock'`,
      )
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
  const staged = Object.entries(check.fresh.projectStage?.configs ?? {}).map(
    ([dir, config]) => [nameAt.get(dir) ?? dir, config] as const,
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

/**
 * `read` with each file's record taken from `fresh` where only the files
 * its digests read moved (same bytes, same extra files, an extra's hash
 * changed): a run digests anew on such an edit (`lockfileClaim`'s
 * `lockedOnce`), and cli.md says it needs no `vx lock`, yet `--check`
 * failed every edit in a `file:` directory or a patch. With every hash
 * unchanged a run keys from the record, so its digests are compared.
 */
function liveExtras(read: DependenciesLock, fresh: DependenciesLock): DependenciesLock {
  const files = { ...read.files }
  for (const [name, now] of Object.entries(fresh.files)) {
    const was = files[name]
    if (
      was !== undefined &&
      was.hash === now.hash &&
      Bun.deepEquals(Object.keys(was.extras ?? {}), Object.keys(now.extras ?? {})) &&
      !Bun.deepEquals(was.extras ?? {}, now.extras ?? {})
    )
      files[name] = now
  }
  return { ...read, files }
}

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
  const answer = (problems: string[]): number => {
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
    return answer([err.message])
  }
  if (!lock) {
    const problem = `no ${LOCKFILE_NAME} at ${root} — run \`vx lock\` first`
    if (!json) sayNotice('error', 'vx lock --check', problem)
    return answer([problem])
  }
  const failures: string[] = []
  const drifted = new Set<string>()
  for (const [dir, fresh] of Object.entries(check.fresh.projects)) {
    const rel = dir === '.' ? fresh.file : `${dir}/${fresh.file}`
    const locked = Object.hasOwn(lock.projects, dir) ? lock.projects[dir] : undefined
    const problem =
      locked === undefined
        ? `${rel} is not in the lock — run 'vx lock'`
        : locked.file !== fresh.file
          ? `${rel} is not the ${locked.file} the lock holds for ${dir === '.' ? 'the workspace root project' : dir} — run 'vx lock'`
          : !Bun.deepEquals(fresh.config, locked.config, true)
            ? `${rel} evaluates differently from the lock here — its config, a file ` +
              `it imports, or the environment it reads changed; run 'vx lock'` +
              // What changed: a config that reads the environment shows no file diff.
              configDiff(locked.config, fresh.config)
                .map((d) => `\n  ${maskedLine(d)}`)
                .join('')
            : null
    if (problem === null) continue
    failures.push(problem)
    drifted.add(dir)
  }
  const lockedWalls = lock.nestedWorkspaces ?? []
  const walls = check.fresh.nestedWorkspaces ?? []
  for (const dir of walls)
    if (!lockedWalls.includes(dir))
      failures.push(`${dir} is a nested workspace the lock does not hold — run 'vx lock'`)
  for (const dir of lockedWalls)
    if (!walls.includes(dir))
      failures.push(
        `the lock holds ${dir} as a nested workspace, which it is not now — run 'vx lock'`,
      )
  if (check.loaded)
    failures.push(
      ...discoverDrift(lock, check.fresh, drifted),
      ...stageDrift(lock, check.fresh, drifted),
    )
  if (broken !== null && check.loaded) failures.push(broken)
  // What `vx lock` refuses to write here fails here too: a lock written
  // where the value was no secret passed in an env where it is one.
  if (check.loaded)
    for (const l of await lockLeaks(
      root,
      check,
      metas,
      Object.fromEntries(
        metas.map((m) => [m.name, check.fresh.projects[lockKey(root, m.dir)]!.config]),
      ),
      check.reviewFiles ? reviewsOf(metas, check.resolved) : [],
    ))
      failures.push(
        `${l.at}, a secret value here — the lock is committed, so the secret is too; let the shell expand $${l.name} instead of reading process.env in the config, then run 'vx lock'`,
      )
  // Each config that does not load, as `vx lock` names them: a CI fixing
  // one at a time re-ran the gate once per broken config.
  const refused: { message: string; parts?: RefusalParts }[] =
    broken === null || check.loaded
      ? []
      : [
          { message: broken, ...(check.brokenParts ? { parts: check.brokenParts } : {}) },
          ...(check.alsoBroken ?? []).map((e) => ({
            message: e.message,
            ...(e.parts ? { parts: e.parts } : {}),
          })),
        ]
  if (check.reviewFiles && check.loaded) {
    // A project the lock already fails is named once.
    const stale = await Promise.all(
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
    for (const f of stale) if (f !== null) failures.push(f)
    for (const file of await strayCopies(check)) failures.push(strayLine(root, file))
  }
  // A config that does not load evaluated none: every locked project
  // read as gone, the healthy ones too.
  for (const dir of check.loaded ? Object.keys(lock.projects) : []) {
    if (!Object.hasOwn(check.fresh.projects, dir)) {
      const what = dir === '.' ? 'the workspace root project' : dir
      failures.push(`the lock holds ${what}, which has no vx.config now — run 'vx lock'`)
    }
  }
  // Named only over a lock that holds: a config drift moves the record too.
  if (check.dependencies !== null && failures.length === 0) {
    const text = await Bun.file(path.join(root, DEPENDENCIES_LOCK_NAME))
      .bytes()
      .catch(() => null)
    // Compared as JSON: a formatter may lay the file out its own way.
    const read = parseDependenciesLock(text)
    if (
      read === null ||
      !Bun.deepEquals(liveExtras(read, check.dependencies), check.dependencies, true)
    )
      failures.push(
        `${DEPENDENCIES_LOCK_NAME} ${text === null ? 'is missing' : 'is not what the dependencies resolve to here'} — run 'vx lock'`,
      )
  }
  if (json)
    // Root-relative, as every other problem: the loader names the absolute path.
    return answer([
      ...refused.map((r) => r.message.split(`${root}${path.sep}`).join('')),
      ...failures,
    ])
  if (failures.length + refused.length > 0) {
    for (const r of refused) ui.print('err', refusalNotice('vx lock --check', r.message, r.parts))
    for (const f of failures) sayNotice('error', 'vx lock --check', f)
    return 1
  }
  const n = metas.length
  const audited = `${n} project${n === 1 ? '' : 's'}`
  const mapped = bare.length === 0 ? '' : `; mapped by a plugin: ${bareNames(bare)}`
  ui.print('out', ui.status('ok', 'vx lock --check', `up to date (${audited}${mapped})`))
  return 0
}
