// `vx lock` — freeze every resolved vx.config.* into .vx/projects.lock.json, and
// each one, pretty, into a `vx.lock.json` beside it for review.
// `vx lock --check` — audit the lock against a fresh evaluation in the
// current environment. Design: docs/design/config-lock-2026-06.md.

import { open } from 'node:fs/promises'
import path from 'node:path'
import type { ProjectConfig } from '../config.js'
import { flagHint, formatValue, refuse, refusedWord, seeHelp } from './help.js'
import { buildTaskGraph, expandRequested, isDefaultBuild } from '../graph/index.js'
import { applyGraphStage, discoverProjects, hasHook, loadProjects } from '../orchestrator/index.js'
import { resolveSetting, runRules } from '../settings.js'
import {
  refusalNotice,
  DOT_VX_GITATTRIBUTES,
  isUserError,
  relPosix,
  type RefusalParts,
  type UserError,
  secretMask,
  ui,
  sayNotice,
} from '../util/index.js'
import {
  ConfigsRefused,
  findProjectConfigs,
  findWorkspaceRoot,
  REVIEW_FILE,
  loadProjectConfigs,
  LOCKFILE_NAME,
  LOCKFILE_VERSION,
  lockKey,
  readLockfile,
  buildPackageGraph,
  checkDependencyRules,
  computeNestedProjectDirs,
  writeLockfile,
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
 * Projects with tasks and no vx.config: a plugin's tasks, which load live
 * in every run, so both verbs name them — `0 project configs`
 * on a turbo() repo read like an audit of something (2026-09-16). One with
 * no task is left out: solidjs/solid's solid-ssr, which has no script Turbo
 * runs, read as a project whose tasks come live from the plugin `project` stage.
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
  const check = await audit(root, warn)
  if (check.broken !== null) {
    notWritten(check.broken, check.brokenParts, check.alsoBroken)
    return 1
  }
  return await writeLock(root, check, say)
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
  }
  try {
    const { workspaceConfig, plugins, cacheDir } = await loadCliWorkspace(root)
    out.reviewFiles = resolveSetting('lock.reviewFiles', workspaceConfig).value !== false
    const { configs: found, strayReviews, shadowed } = await findProjectConfigs(root)
    out.strayReviews = strayReviews
    out.shadowed = shadowed
    // The one load that evaluates: every reader reads the lock this writes.
    const configs = await loadProjectConfigs(found.map((f) => f.configPath))
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
    // The stages edit what they are handed; the lock keeps what the configs say.
    const view = structuredClone(out.fresh)
    const lock = async (): Promise<Lockfile> => view
    out.all = await discoverProjects(root, lock, plugins, cacheDir, warn)
    const { projects } = await loadProjects({
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
    out.loaded = true
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
        [...computeNestedProjectDirs(out.all)].map(([name, dirs]) => [
          name,
          dirs.map((dir) => ({ name: nameOf.get(dir)!, dir })),
        ]),
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
  } catch (err) {
    if (isUserError(err))
      return {
        ...out,
        broken: err.message,
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

/**
 * The lock refused: the refusal's own parts, or its config line and frame,
 * or its message; then each other config that does not load, so one run
 * names what a repo must fix.
 */
function notWritten(
  message: string,
  parts: RefusalParts | undefined,
  also: readonly UserError[] = [],
): void {
  ui.print('err', refusalNotice('vx lock', message, parts, { headline: 'lock not written' }))
  for (const e of also.slice(0, ALSO_SHOWN))
    ui.print('err', refusalNotice('vx lock', e.message, e.parts, { headline: 'also refused' }))
  const more = also.length - ALSO_SHOWN
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
  return bare.length === 0 ? '' : ` (no vx.config, so not locked: ${bareNames(bare)})`
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
  // The review copies are committed too; a plugin's `project` stage can add
  // a value the bare config lacks. A place both hold is named once.
  const leaks = secretsIn(projects)
  const named = new Set(leaks.map((l) => l.at))
  for (const l of secretsIn(Object.fromEntries(reviews.map((r) => [r.name, r.config]))))
    if (!named.has(l.at)) leaks.push(l)
  if (leaks.length > 0) {
    notWritten('', {
      headline: 'these configs evaluated to a secret value',
      what: leaks.map((l) => l.at),
      why: 'the lock is committed, so the secret would be too',
      fix: `let the shell expand it ($${leaks[0]!.name} in the command, the name in exec.env.passThrough) instead of reading process.env in the config`,
    })
    return 1
  }
  await writeLockfile(root, check.fresh)
  await Promise.all([
    ...reviews.map((r) => Bun.write(r.file, r.text)),
    writeIfMissing(path.join(root, '.vx', '.gitattributes'), DOT_VX_GITATTRIBUTES),
  ])
  const n = metas.length
  say(`${n} project config${n === 1 ? '' : 's'} → ${LOCKFILE_NAME}${bareNote(bare)}`)
  // A second config beside the one read was edited and nothing changed.
  warnShadowed(root, check, 'vx lock')
  // Named here too: a lock that wrote clean failed the `--check` after it.
  if (check.reviewFiles)
    for (const file of await strayCopies(check)) sayNotice('warn', 'vx lock', strayLine(root, file))
  return 0
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

const strayLine = (root: string, file: string): string =>
  `${relPosix(root, file)} has no vx.config beside it — delete it`

/**
 * Each place an evaluated config holds the value of a secret in this
 * environment, by the rule output masking uses (a secret-named variable,
 * or one a task lists in `exec.env.secret`). The lock is committed, so
 * such a value would be published, and masking it would freeze a `***`
 * that every run runs (L-42).
 */
function secretsIn(projects: Record<string, ProjectConfig>): Array<{ at: string; name: string }> {
  const named = new Set<string>()
  for (const config of Object.values(projects)) {
    for (const task of Object.values(config.tasks ?? {}))
      for (const n of task?.exec?.env?.secret ?? []) named.add(n)
  }
  const secrets: [value: string, name: string][] = []
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && secretMask([{ [name]: value }], named.has(name) ? [name] : []))
      secrets.push([value, name])
  }
  if (secrets.length === 0) return []
  const found: Array<{ at: string; name: string }> = []
  const walk = (project: string, at: string, v: unknown): void => {
    if (typeof v === 'string') {
      for (const [value, name] of secrets)
        if (v.includes(value)) found.push({ at: `${project}: ${at} holds $${name}`, name })
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
        audited: metas.length,
        notAudited: bare.length,
        problems,
      }
      process.stdout.write(`${JSON.stringify(out)}\n`)
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
          ? `${rel} is not the ${locked.file} the lock holds for ${dir} — run 'vx lock'`
          : !Bun.deepEquals(fresh.config, locked.config, true)
            ? `${rel} evaluates differently from the lock here — its config, a file ` +
              `it imports, or the environment it reads changed; run 'vx lock'`
            : null
    if (problem === null) continue
    failures.push(problem)
    drifted.add(dir)
  }
  if (broken !== null && check.loaded) failures.push(broken)
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
        const text = await Bun.file(r.file)
          .text()
          .catch(() => null)
        // Compared as JSON: a formatter may lay the copy out its own way.
        if (text !== null && sameJson(text, r.config)) return null
        const rel = relPosix(root, r.file)
        return text === null
          ? `"${r.name}" has no ${rel} — run 'vx lock'`
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
      failures.push(`the lock holds ${dir}, which has no vx.config now — run 'vx lock'`)
    }
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
  const skipped = bare.length === 0 ? '' : `; not audited, no vx.config: ${bareNames(bare)}`
  ui.print('out', ui.status('ok', 'vx lock --check', `up to date (${audited}${skipped})`))
  return 0
}
