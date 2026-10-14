// `vx lock` — freeze every resolved vx.project.* into vx.lock.json.
// `vx lock --check` — audit the lock against a fresh evaluation in the
// current environment. Design: docs/design/config-lock-2026-06.md.

import type { ProjectConfig } from '../config.js'
import { flagHint, formatValue, refuse, refusedWord, seeHelp } from './help.js'
import { buildTaskGraph, expandRequested } from '../graph/index.js'
import {
  applyGraphStage,
  hasHook,
  isDefaultBuild,
  loadResolvedProjects,
} from '../orchestrator/index.js'
import { runRules } from '../settings.js'
import { isUserError, relPosix, secretMask } from '../util/index.js'
import {
  findWorkspaceRoot,
  type LoadReads,
  loadProjectConfig,
  loadWorkspace,
  LOCKFILE_NAME,
  LOCKFILE_VERSION,
  readLockfile,
  buildPackageGraph,
  checkDependencyRules,
  writeLockfile,
  type Lockfile,
  type ProjectMeta,
} from '../workspace/index.js'
import { taskEdgesFrom } from './select.js'
import { discoverCliProjects, loadCliWorkspace, warnToStderr } from './workspace-config.js'

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
  const reads: LoadReads = new Map()
  const root = await findWorkspaceRoot(process.cwd())
  if (parsed.check) {
    const { all, metas } = await configuredProjects(root, reads)
    return await checkLock(root, all, metas, parsed.format === 'json')
  }
  return await lockWorkspace(root, reads)
}

/** Every project a run discovers, and those with a vx.project. */
async function configuredProjects(
  root: string,
  reads: LoadReads = new Map(),
): Promise<{ all: ProjectMeta[]; metas: ConfiguredMeta[] }> {
  const workspace = await loadWorkspace(root, reads)
  // As a run discovers them: a project a plugin's `discover` stage adds
  // was left out of the lock, and every `--frozen` run then refused it
  // with "run vx lock", which changed nothing (X-143).
  // Sorted by name, as core's discovery is, for stable lockfile diffs.
  const all = (await discoverCliProjects(workspace)).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  const metas = all.filter((m): m is ConfiguredMeta => m.configPath !== null)
  return { all, metas }
}

/**
 * Projects with tasks and no vx.project: a plugin's tasks, which load live
 * under --frozen too, so both verbs name them — `locked 0 project configs`
 * on a turbo() repo read like an audit of something (2026-09-16). One with
 * no task is left out: solidjs/solid's solid-ssr, which has no script Turbo
 * runs, read as a project whose tasks are never frozen.
 */
function bareProjects(all: ProjectMeta[], tasked: ReadonlySet<string>): string[] {
  return all.filter((m) => m.configPath === null && tasked.has(m.name)).map((m) => m.name)
}

/**
 * `vx lock`: evaluate every config, check the graph rules over every task,
 * and write the lock. Also what a frozen run with no lock does first.
 */
export async function lockWorkspace(
  root: string,
  reads?: LoadReads,
  warn: (message: string) => void = warnToStderr,
): Promise<number> {
  const { all, metas } = await configuredProjects(root, reads)
  const { broken, tasked } = await graphRuleRefusal(root, all, warn)
  if (broken !== null) {
    process.stderr.write(`vx lock: ${LOCKFILE_NAME} not written: ${broken}\n`)
    return 1
  }
  return await writeLock(root, metas, bareProjects(all, tasked))
}

/**
 * The graph rules (`run.rules`), checked here over every project and task the
 * workspace declares: a frozen run trusts the lock and does not check them
 * (owner, 2026-10-13). The graph is the one a run builds, the `graph`
 * stage included; its refusal, or null, and the projects that have a task.
 */
async function graphRuleRefusal(
  root: string,
  all: ProjectMeta[],
  warn: (message: string) => void,
): Promise<{ broken: string | null; tasked: Set<string> }> {
  const tasked = new Set<string>()
  try {
    const { workspaceConfig, plugins, cacheDir } = await loadCliWorkspace(root)
    const projects = await loadResolvedProjects(root, { warn })
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
        buildPackageGraph(all, taskEdgesFrom(projects)),
      )
    const rules = runRules(workspaceConfig)
    const nodes = buildTaskGraph({
      projects,
      packageGraph: buildPackageGraph(all),
      requested: expandRequested([...names], [...projects.keys()], projects, isDefaultBuild),
      workspaceRoot: root,
      rules,
    })
    if (hasHook(plugins, 'graph'))
      await applyGraphStage(plugins, nodes, {
        workspaceRoot: root,
        cacheDir,
        projectMetas: all,
        warn,
        rules,
      })
  } catch (err) {
    if (isUserError(err)) return { broken: err.message, tasked }
    throw err
  }
  return { broken: null, tasked }
}

/**
 * Evaluate one config in the current env. `fresh: true`: the lock freezes
 * this environment's evaluation, never a stored one. Stored through
 * `writeLockfile`'s JSON.stringify, which drops a field left `undefined`,
 * the form `--check` compares a fresh evaluation in.
 */
function evaluate(meta: ConfiguredMeta): Promise<ProjectConfig> {
  return loadProjectConfig(meta.configPath, { fresh: true })
}

/**
 * `vx init`'s last step: the lock, as `vx lock` writes it. A refusal (a
 * graph rule, a config that does not load) is printed and leaves the
 * written configs in place.
 */
export async function lockAfterMigration(root: string): Promise<number> {
  try {
    return await lockWorkspace(root)
  } catch (err) {
    if (!isUserError(err)) throw err
    process.stderr.write(`vx lock: ${LOCKFILE_NAME} not written: ${err.message}\n`)
    return 1
  }
}

/** Names shown per note: a turbo() repo can have hundreds of bare projects. */
const BARE_SHOWN = 5

function bareNames(bare: readonly string[]): string {
  const more = bare.length - BARE_SHOWN
  return more > 0 ? `${bare.slice(0, BARE_SHOWN).join(', ')} and ${more} more` : bare.join(', ')
}

function bareNote(bare: readonly string[]): string {
  return bare.length === 0 ? '' : ` (no vx.project, so never frozen: ${bareNames(bare)})`
}

async function writeLock(
  root: string,
  metas: ConfiguredMeta[],
  bare: readonly string[],
): Promise<number> {
  const entries = await Promise.all(metas.map(evaluate))
  // Sorted by name above — stable lockfile diffs. Defined,
  // not assigned: a project named `__proto__` set the map's prototype (D-152).
  const projects: Record<string, ProjectConfig> = Object.fromEntries(
    metas.map((m, i) => [m.name, entries[i]!]),
  )
  const leaks = secretsIn(projects)
  if (leaks.length > 0) {
    process.stderr.write(
      `vx lock: ${LOCKFILE_NAME} is committed, and these configs evaluated to a secret value:\n` +
        leaks.map((l) => `  ${l.at}\n`).join('') +
        `let the shell expand it ($${leaks[0]!.name} in the command, the name in exec.env.passThrough) instead of reading process.env in the config\n`,
    )
    return 1
  }
  const lock: Lockfile = { version: LOCKFILE_VERSION, projects }
  await writeLockfile(root, lock)
  const n = metas.length
  process.stdout.write(
    `vx lock: locked ${n} project config${n === 1 ? '' : 's'} → ${LOCKFILE_NAME}${bareNote(bare)}\n`,
  )
  return 0
}

/**
 * Each place an evaluated config holds the value of a secret in this
 * environment, by the rule output masking uses (a secret-named variable,
 * or one a task lists in `exec.env.secret`). The lock is committed, so
 * such a value would be published, and masking it would freeze a `***`
 * that `--frozen` runs (L-42).
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

/**
 * Audit the lock: re-evaluate every config in the CURRENT environment and
 * deep-compare it with the locked object. That sees an edit to the config,
 * to a file it imports, and to the environment it reads alike.
 */
async function checkLock(
  root: string,
  all: ProjectMeta[],
  metas: ConfiguredMeta[],
  json: boolean,
): Promise<number> {
  const { broken, tasked } = await graphRuleRefusal(root, all, warnToStderr)
  const bare = bareProjects(all, tasked)
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
  const lock = await readLockfile(root)
  if (!lock) {
    const problem = `no ${LOCKFILE_NAME} at ${root} — run \`vx lock\` first`
    if (!json) process.stderr.write(`vx lock --check: ${problem}\n`)
    return answer([problem])
  }
  const results = await Promise.all(
    metas.map(async (m): Promise<string | null> => {
      const rel = relPosix(root, m.configPath)
      const locked = Object.hasOwn(lock.projects, m.name) ? lock.projects[m.name] : undefined
      if (locked === undefined) return `"${m.name}" (${rel}) is not in the lock — run 'vx lock'`
      // The lock's form: a first load is the module's live export, where a
      // field left `undefined` is a key the stored JSON never has.
      const fresh = JSON.parse(JSON.stringify(await evaluate(m))) as ProjectConfig
      if (Bun.deepEquals(fresh, locked, true)) return null
      return (
        `"${m.name}" (${rel}) evaluates differently from the lock here — its config, a file ` +
        `it imports, or the environment it reads changed; run 'vx lock'`
      )
    }),
  )
  const failures = results.filter((r): r is string => r !== null)
  if (broken !== null) failures.push(broken)
  const inWorkspace = new Set(metas.map((m) => m.name))
  for (const name of Object.keys(lock.projects)) {
    if (!inWorkspace.has(name)) {
      failures.push(`locked project "${name}" has no config in the workspace — run 'vx lock'`)
    }
  }
  if (json) return answer(failures)
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`vx lock --check: ${f}\n`)
    return 1
  }
  const n = metas.length
  const audited = `${n} project${n === 1 ? '' : 's'}`
  const skipped = bare.length === 0 ? '' : `; not audited, no vx.project: ${bareNames(bare)}`
  process.stdout.write(`vx lock --check: up to date (${audited}${skipped})\n`)
  return 0
}
