// `vx show [target]` — introspect the workspace's resolved configs: what a
// run would see here, now. Configs load through the same path a run uses
// (`loadProjects`): from the lock, with the plugin `config` and `project`
// stages applied, so a package a plugin gives tasks to shows them. No lock
// is `NO_LOCK`. No target: one line per project. `<project>`: every task's
// resolved config. `<pkg>#<task>`: one task. `<task>`: that task in every
// project declaring it.

import path from 'node:path'
import type { ProjectConfig, TaskConfig } from '../config.js'
import { declaredTask } from '../graph/index.js'
import { isDefaultBuild } from '../graph/index.js'
import { affectedTaskProjects } from '../orchestrator/index.js'
import { flagHint, formatValue, refuse, seeHelp } from './help.js'
import {
  type ColorSupport,
  detectColors,
  listed,
  nearMatches,
  relPosix,
  secretMask,
  UserError,
  sayNotice,
  ui,
} from '../util/index.js'
import { affectedFilterFor, resolveFilters } from './select.js'
import {
  discoverCliProjects,
  loadCliProjects,
  loadCliWorkspace,
  warnToStderr,
} from './workspace-config.js'
import {
  type AffectedChanges,
  buildPackageGraph,
  findWorkspaceRoot,
  type ProjectEntry,
  type ProjectMeta,
} from '../workspace/index.js'
import { runRules } from '../settings.js'

interface ShowArgs {
  target?: string
  format: 'pretty' | 'json'
  /** `--filter`, as `vx run` reads it: which projects the list shows. */
  filters: string[]
  /** `--affected[=<base>]`: `''` is the default base. */
  affected?: string
  error?: string
}

export function parseShowArgs(args: readonly string[]): ShowArgs {
  const out: ShowArgs = { format: 'pretty', filters: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    let format: string | undefined
    if (a === '--format') format = args[++i] ?? ''
    else if (a.startsWith('--format=')) format = a.slice('--format='.length)
    else if (a === '--filter') {
      const v = args[++i]
      // `--filter --format json` took `--format` as the pattern; no filter opens with `--`.
      if (v === undefined || v === '' || v.startsWith('--'))
        return {
          ...out,
          error: `--filter requires a value: a project name, glob or path${seeHelp('show')}`,
        }
      out.filters.push(v)
    } else if (a.startsWith('--filter=')) out.filters.push(a.slice('--filter='.length))
    else if (a === '--affected') out.affected = ''
    else if (a.startsWith('--affected=')) out.affected = a.slice('--affected='.length)
    else if (a.startsWith('-'))
      return { ...out, error: `unknown flag: ${a}${flagHint('show', a)}${seeHelp('show')}` }
    else if (out.target === 'project')
      // Nx's spelling: `nx show project <name>`.
      return { ...out, error: `\`nx show project ${a}\` is \`vx show ${a}\` here` }
    else if (out.target !== undefined)
      return { ...out, error: `unexpected argument: ${a}${seeHelp('show')}` }
    // An empty name is a part of every name: its "did you mean" listed the
    // whole workspace.
    else if (a === '')
      return { ...out, error: `empty target (omit it to list every project)${seeHelp('show')}` }
    else out.target = a

    if (format !== undefined) {
      const fv = formatValue(format, 'show')
      if (typeof fv === 'object') return { ...out, ...fv }
      out.format = fv
    }
  }
  return out
}

export async function showCmd(args: readonly string[]): Promise<number> {
  const parsed = parseShowArgs(args)
  if (parsed.error) return refuse('show', args, parsed.error, 'VX_E_USAGE')
  const root = await findWorkspaceRoot(process.cwd())
  const metas = await discoverCliProjects(root)
  const byName = new Map(metas.map((m) => [m.name, m]))

  // `//#task` is Turbo's root package's task: the root project here (D-39),
  // and `//` alone is that project, as `--filter //` reads it (D-46).
  const rootMeta = metas.find((m) => path.resolve(m.dir) === path.resolve(root))
  if (parsed.target === '//' || parsed.target?.startsWith('//#')) {
    if (rootMeta === undefined) {
      throw new UserError(
        `vx show: "${parsed.target}" names the workspace root's project, and the root is no project here`,
        'VX_E_USAGE',
      )
    }
    parsed.target = `${rootMeta.name}${parsed.target.slice(2)}`
  }
  const hashAt = parsed.target?.indexOf('#') ?? -1
  const projectName =
    parsed.target === undefined
      ? undefined
      : hashAt === -1
        ? parsed.target
        : parsed.target.slice(0, hashAt)
  const taskName = hashAt === -1 ? undefined : parsed.target!.slice(hashAt + 1)
  if (projectName === '' && taskName !== undefined && taskName !== '') {
    throw new UserError(
      `vx show: missing project name before '#' in "${parsed.target}" (vx show ${taskName} shows it in every project)`,
      'VX_E_USAGE',
    )
  }
  if (taskName === '') {
    const list = projectName === '' ? 'vx show' : `vx show ${projectName}`
    throw new UserError(
      `vx show: missing task name after '#' in "${parsed.target}" (${list} lists the tasks)`,
      'VX_E_USAGE',
    )
  }
  if (projectName !== undefined && (taskName !== undefined || byName.has(projectName))) {
    if (!byName.has(projectName)) {
      throw new UserError(
        `vx show: unknown project: "${projectName}"${suggest(projectName, [...byName.keys()], '', 'projects')}`,
        'VX_E_UNKNOWN_PROJECT',
      )
    }
  }
  // A bare name that is no project is a TASK: shown in every project that
  // declares it, so the whole workspace loads.
  const bareTask = projectName !== undefined && taskName === undefined && !byName.has(projectName)
  const scope = projectName === undefined || bareTask ? 'all' : [projectName]

  // `turbo ls --filter` / `nx show projects --affected`: the list, and a
  // task's projects, narrowed by the selection `vx run` would make.
  let selected: Set<string> | undefined
  // A task's projects under `--affected` are the ones whose task the run
  // keeps: the change reaches another project only along a task edge.
  let byDiff: { changes: AffectedChanges; outright?: readonly string[] | undefined } | undefined
  if (parsed.filters.length > 0 || parsed.affected !== undefined) {
    if (scope !== 'all') {
      throw new UserError(
        'vx show: --filter and --affected narrow a list: `vx show` or `vx show <task>`',
        'VX_E_USAGE',
      )
    }
    const raw = [...parsed.filters]
    let affected: string | undefined
    if (parsed.affected !== undefined) {
      const f = await affectedFilterFor(process.cwd(), parsed.affected)
      if (typeof f === 'object') throw new UserError(`vx show: ${f.error}`, f.code ?? 'VX_E_USAGE')
      affected = f
      raw.unshift(f)
    }
    const r = await resolveFilters(process.cwd(), raw, {}, affected, 'vx show')
    if ('error' in r) throw new UserError(`vx show: ${r.error}`, r.code ?? 'VX_E_USAGE')
    if ('empty' in r) sayNotice('info', 'vx show', r.empty)
    selected = new Set('empty' in r ? [] : r.names)
    if ('names' in r && r.affected !== undefined)
      byDiff = { changes: r.affected, outright: r.outright }
  }
  const inSelection = (name: string): boolean => selected === undefined || selected.has(name)

  const projects = await loadCliProjects(root, metas, scope, { closure: true })

  if (parsed.target === undefined) {
    if (metas.length === 0)
      sayNotice(
        'info',
        'vx show',
        'no projects: no directory holds a vx.config — run `vx init` to write them, then `vx lock`',
      )
    const shown = metas.filter((m) => inSelection(m.name))
    process.stdout.write(renderList(root, shown, projects, parsed.format, colorsOut()))
    return 0
  }

  if (bareTask) {
    // As `vx run <task> --all` takes it: the default build is declared by no one (X-145).
    const declares = (task: TaskConfig | undefined): boolean =>
      task !== undefined && !isDefaultBuild(task)
    const declaring = [...projects.values()].filter((p) =>
      declares(declaredTask(p.config, projectName!)),
    )
    if (declaring.length === 0) {
      const names = new Set<string>()
      for (const p of projects.values())
        for (const [t, task] of Object.entries(p.config.tasks ?? {}))
          if (declares(task)) names.add(t)
      // `nx show projects` lists them; here a bare `vx show` does.
      const nx = projectName === 'projects' ? ' (`nx show projects` is `vx show` here)' : ''
      throw new UserError(
        `vx show: unknown project or task: "${projectName}"${nx}${suggest(projectName!, [...byName.keys(), ...names], '', 'projects and tasks')}`,
        'VX_E_UNKNOWN_TASK',
      )
    }
    let shown = declaring.filter((p) => inSelection(p.name))
    if (byDiff !== undefined) {
      const ws = await loadCliWorkspace(root)
      const kept = new Set(
        await affectedTaskProjects({
          task: projectName!,
          candidates: shown.map((p) => p.name),
          changes: byDiff.changes,
          outright: byDiff.outright,
          projects,
          packageGraph: buildPackageGraph(metas),
          projectMetas: metas,
          plugins: ws.plugins,
          workspaceRoot: root,
          cacheDir: ws.cacheDir,
          rules: runRules(ws.workspaceConfig),
          warn: warnToStderr,
        }),
      )
      shown = shown.filter((p) => kept.has(p.name))
    }
    // An empty list printed nothing and exited 0, where the run says why.
    if (shown.length === 0 && parsed.format === 'pretty') {
      const n = declaring.length
      sayNotice(
        'info',
        'vx show',
        byDiff !== undefined
          ? `no affected project's ${projectName} runs (${n} declare${n === 1 ? 's' : ''} it)`
          : `no selected project declares ${projectName} (${n} outside the selection ${n === 1 ? 'does' : 'do'})`,
      )
    }
    process.stdout.write(renderTaskAcross(root, shown, projectName!, parsed.format, colorsOut()))
    return 0
  }

  const meta = byName.get(projectName!)!
  const entry = projects.get(meta.name)
  const config = entry?.config ?? null
  const dir = projectDir(root, meta)

  if (taskName === undefined) {
    process.stdout.write(
      renderProject(meta.name, dir, config, meta.configPath !== null, parsed.format, colorsOut()),
    )
    return 0
  }

  const task = declaredTask(config, taskName)
  if (task === undefined) {
    throw new UserError(
      `vx show: unknown task: "${meta.name}#${taskName}"${suggest(taskName, Object.keys(config?.tasks ?? {}), `${meta.name}#`, 'its tasks')}`,
      'VX_E_UNKNOWN_TASK',
    )
  }
  process.stdout.write(renderTask(meta.name, dir, taskName, task, parsed.format, colorsOut()))
  return 0
}

/**
 * Near misses by edit distance, plus partial names in either direction.
 * `prefix` makes each a spec the user can paste (`app#build`, not `build`).
 */
function suggest(
  query: string,
  candidates: readonly string[],
  prefix = '',
  label = 'names',
): string {
  const q = query.toLowerCase()
  const near = new Set(nearMatches(query, candidates))
  for (const c of candidates) {
    const n = c.toLowerCase()
    if (n.includes(q) || q.includes(n)) near.add(c)
  }
  if (near.size > 0) return ` — did you mean ${[...near].map((n) => prefix + n).join(', ')}?`
  // Nothing near named nothing to pick from (M-57): say what exists.
  return candidates.length === 0 ? '' : `; ${label}: ${listed(candidates.map((c) => prefix + c))}`
}

function projectDir(root: string, meta: ProjectMeta): string {
  const rel = relPosix(root, meta.dir)
  return rel === '' ? '.' : rel
}

/**
 * A task as `vx show` prints it: a secret variable's value masked in every
 * string it holds, where a TS config that builds one from `process.env`
 * put it (the command, `env.define`, a runtime probe, `readyWhen`, the
 * description) (L-11).
 */
function shownTask(task: TaskConfig): TaskConfig {
  const secrets = secretMask([process.env, task.exec?.env?.define], task.exec?.env?.secret)
  return secrets === null ? task : (maskStrings(task, secrets.mask) as TaskConfig)
}

function maskStrings(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === 'string') return mask(value)
  if (Array.isArray(value)) return value.map((v) => maskStrings(v, mask))
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskStrings(v, mask)]))
}

/** A project config with each task as `shownTask` prints it. */
function shownConfig(config: ProjectConfig | null): ProjectConfig | null {
  if (config?.tasks === undefined) return config
  return {
    ...config,
    tasks: Object.fromEntries(Object.entries(config.tasks).map(([n, t]) => [n, shownTask(t)])),
  }
}

const colorsOut = (): ColorSupport => detectColors(process.stdout)
const PLAIN: ColorSupport = { enabled: false }

/** One block of several, with no blank line between them. */
const joined = (blocks: readonly ui.Block[]): ui.Block => ({
  lines: (c) => blocks.flatMap((b) => b.lines(c)),
})

function renderList(
  root: string,
  metas: readonly ProjectMeta[],
  projects: ReadonlyMap<string, ProjectEntry>,
  format: 'pretty' | 'json',
  colors: ColorSupport = PLAIN,
): string {
  const rows = metas.map((meta) => {
    const tasks = projects.get(meta.name)?.config.tasks ?? {}
    return {
      name: meta.name,
      dir: projectDir(root, meta),
      tags: projects.get(meta.name)?.config.tags ?? [],
      tasks: Object.keys(tasks),
      onlyDefault: Object.values(tasks).every((t) => isDefaultBuild(t)),
      configured: meta.configPath !== null,
    }
  })
  if (format === 'json') {
    return `${JSON.stringify(rows.map(({ name, dir, tags, tasks }) => ({ name, dir, tags, tasks })))}\n`
  }
  if (rows.length === 0) return ''
  const anyTags = rows.some((r) => r.tags.length > 0)
  const cells = rows.map((r) => {
    const n = r.tasks.length
    const count = `${n} task${n === 1 ? '' : 's'}`
    // A package with no config file has only tasks a plugin gave it, or the
    // default `build` a configured dependant's closure gave it.
    const tasks = r.configured
      ? count
      : n === 0
        ? 'no vx config'
        : r.onlyDefault
          ? `${count}, default build (no vx config)`
          : `${count} from plugins (no vx config)`
    return [ui.id(r.name), r.dir, tasks, ...(anyTags ? [r.tags.join(', ')] : [])]
  })
  const columns = ['project', 'dir', 'tasks', ...(anyTags ? ['tags'] : [])]
  return ui.render([ui.table(columns, cells)], colors)
}

function renderProject(
  name: string,
  dir: string,
  config: ProjectConfig | null,
  hasConfigFile: boolean,
  format: 'pretty' | 'json',
  colors: ColorSupport = PLAIN,
): string {
  if (format === 'json') {
    // Round-trip so the printed object is exactly the JSON form of the
    // resolved config (drops `undefined` fields).
    const shown = shownConfig(config)
    return `${JSON.stringify({ name, dir, config: shown })}\n`
  }
  const tags = config?.tags ?? []
  const tasks = Object.entries(config?.tasks ?? {})
  const head: ui.FieldRow[] = [
    ['dir', dir],
    ...(tags.length > 0 ? [['tags', tags.join(', ')] as const] : []),
    // A config-less package a dependant reaches has the default `build` (X-9).
    ...(hasConfigFile ? [] : [['config', 'none'] as const]),
    ...(tasks.length === 0 && hasConfigFile ? [['tasks', 'none declared'] as const] : []),
  ]
  const blocks = tasks.map(([taskName, task]) =>
    joined([ui.text(ui.id(`${name}#${taskName}`)), ui.fields(taskRows(task))]),
  )
  return ui.render([ui.report(name, head), ...blocks], colors)
}

function renderTask(
  name: string,
  dir: string,
  taskName: string,
  task: TaskConfig,
  format: 'pretty' | 'json',
  colors: ColorSupport = PLAIN,
): string {
  if (format === 'json') {
    const obj = { name, dir, task: taskName, config: shownTask(task) }
    return `${JSON.stringify(obj)}\n`
  }
  return ui.render([taskReport(name, dir, taskName, task)], colors)
}

function renderTaskAcross(
  root: string,
  declaring: readonly ProjectEntry[],
  taskName: string,
  format: 'pretty' | 'json',
  colors: ColorSupport,
): string {
  if (format === 'json') {
    const list = declaring.map((p) => ({
      name: p.name,
      dir: relPosix(root, p.dir) || '.',
      task: taskName,
      config: shownTask(p.config.tasks![taskName]!),
    }))
    return `${JSON.stringify(list)}\n`
  }
  if (declaring.length === 0) return ''
  return ui.render(
    [
      joined(
        declaring.map((p) =>
          taskReport(p.name, relPosix(root, p.dir) || '.', taskName, p.config.tasks![taskName]!),
        ),
      ),
    ],
    colors,
  )
}

/** `─ app#build ───`, the project's dir, then every field the run reads. */
function taskReport(name: string, dir: string, taskName: string, task: TaskConfig): ui.Block {
  return ui.report(`${name}#${taskName}`, [['dir', dir], ...taskRows(task)])
}

/** Every field the run reads, in the order the schema declares them. */
function taskRows(raw: TaskConfig): ui.FieldRow[] {
  const task = shownTask(raw)
  const rows: ui.FieldRow[] = []
  // An empty list is a value: a bare label read as a cut-off line.
  const list = (xs: readonly string[] | undefined): string | undefined =>
    xs === undefined ? undefined : xs.length === 0 ? 'none' : xs.join(', ')
  const add = (label: string, value: string | number | boolean | undefined): void => {
    if (value !== undefined) rows.push([label, String(value)])
  }
  add('description', task.description)
  const exec = task.exec
  rows.push(['command', exec?.command ?? '(group)'])
  add('dependsOn', list(task.dependsOn))
  add('timeout', exec?.timeout)
  add('retries', exec?.retries)
  add('env.passThrough', list(exec?.env?.passThrough))
  add(
    'env.define',
    exec?.env?.define === undefined
      ? undefined
      : Object.entries(exec.env.define)
          .map(([k, v]) => `${k}=${v}`)
          .join(', '),
  )
  add('env.secret', list(exec?.env?.secret))
  add('remote', exec?.remote === undefined ? undefined : String(exec.remote))
  add('sandbox', exec?.sandbox === undefined ? undefined : JSON.stringify(exec.sandbox))
  const persistent = exec?.persistent
  if (persistent !== undefined) {
    add(
      'persistent',
      persistent.readyWhen === undefined ? 'yes' : `readyWhen: ${persistent.readyWhen}`,
    )
  }
  add('interactive', exec?.interactive === undefined ? undefined : exec.interactive ? 'yes' : 'no')
  const inputs = task.inputs
  if (inputs !== undefined) {
    add('inputs.files', list(inputs.files))
    add('inputs.workspaceFiles', list(inputs.workspaceFiles))
    add('inputs.env', list(inputs.env))
    add('inputs.tasks', list(inputs.tasks))
    add('inputs.runtime', list(inputs.runtime))
    add('inputs.workspaceRuntime', list(inputs.workspaceRuntime))
  }
  const cache = task.cache
  if (cache !== undefined) {
    add('outputs.files', list(cache.outputs.files))
    add('outputs.workspaceFiles', list(cache.outputs.workspaceFiles))
  }
  return rows
}
