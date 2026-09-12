// `vx show [target]` — introspect the workspace's LIVE resolved configs:
// what a run would see here, now. Configs load through the same path a
// run uses (`loadProjects`): the plugin `config` and `project` stages
// apply, so a package a plugin gives tasks to shows them. No target: one
// line per project. `<project>`: every task's resolved config. `<pkg>#
// <task>`: one task. `<task>`: that task in every project declaring it.
// Deliberately NOT the lock — vx-lock.json is already the frozen JSON.

import type { ProjectConfig, TaskConfig } from '../config.js'
import { seeHelp } from './help.js'
import { nearMatches, relPosix, UserError } from '../util/index.js'
import { loadCliProjects } from './workspace-config.js'
import {
  findWorkspaceRoot,
  listProjects,
  loadWorkspace,
  type ProjectEntry,
  type ProjectMeta,
} from '../workspace/index.js'

export interface ShowArgs {
  target?: string
  format: 'pretty' | 'json'
  error?: string
}

export function parseShowArgs(args: readonly string[]): ShowArgs {
  const out: ShowArgs = { format: 'pretty' }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    let format: string | undefined
    if (a === '--format') format = args[++i] ?? ''
    else if (a.startsWith('--format=')) format = a.slice('--format='.length)
    else if (a.startsWith('-')) return { ...out, error: `unknown flag: ${a}${seeHelp('show')}` }
    else if (out.target !== undefined) return { ...out, error: `unexpected argument: ${a}` }
    else out.target = a

    if (format !== undefined) {
      if (format !== 'pretty' && format !== 'json') {
        return { ...out, error: '--format must be pretty or json' }
      }
      out.format = format
    }
  }
  return out
}

export async function showCmd(args: readonly string[]): Promise<number> {
  const parsed = parseShowArgs(args)
  if (parsed.error) {
    process.stderr.write(`vx show: ${parsed.error}\n`)
    return 1
  }
  const root = await findWorkspaceRoot(process.cwd())
  const metas = await listProjects(await loadWorkspace(root))
  const byName = new Map(metas.map((m) => [m.name, m]))

  const hashAt = parsed.target?.indexOf('#') ?? -1
  const projectName =
    parsed.target === undefined
      ? undefined
      : hashAt === -1
        ? parsed.target
        : parsed.target.slice(0, hashAt)
  const taskName = hashAt === -1 ? undefined : parsed.target!.slice(hashAt + 1)
  if (taskName === '') throw new UserError(`missing task name after '#' in "${parsed.target}"`)
  if (projectName !== undefined && (taskName !== undefined || byName.has(projectName))) {
    if (!byName.has(projectName)) {
      throw new UserError(
        `unknown project: "${projectName}"${suggest(projectName, [...byName.keys()])}`,
      )
    }
  }
  // A bare name that is no project is a TASK: shown in every project that
  // declares it, so the whole workspace loads.
  const bareTask = projectName !== undefined && taskName === undefined && !byName.has(projectName)
  const scope = projectName === undefined || bareTask ? 'all' : [projectName]

  const projects = await loadCliProjects(root, metas, scope)

  if (parsed.target === undefined) {
    process.stdout.write(renderList(root, metas, projects, parsed.format))
    return 0
  }

  if (bareTask) {
    const declaring = [...projects.values()].filter((p) => p.config.tasks?.[projectName!])
    if (declaring.length === 0) {
      const names = new Set<string>()
      for (const p of projects.values())
        for (const t of Object.keys(p.config.tasks ?? {})) names.add(t)
      throw new UserError(
        `unknown project or task: "${projectName}"${suggest(projectName!, [...byName.keys(), ...names])}`,
      )
    }
    process.stdout.write(renderTaskAcross(root, declaring, projectName!, parsed.format))
    return 0
  }

  const meta = byName.get(projectName!)!
  const entry = projects.get(meta.name)
  const config = entry?.config ?? null
  const dir = projectDir(root, meta)

  if (taskName === undefined) {
    process.stdout.write(
      renderProject(meta.name, dir, config, meta.configPath !== null, parsed.format),
    )
    return 0
  }

  const task = config?.tasks?.[taskName]
  if (task === undefined) {
    throw new UserError(
      `unknown task: "${meta.name}#${taskName}"${suggest(taskName, Object.keys(config?.tasks ?? {}))}`,
    )
  }
  process.stdout.write(renderTask(meta.name, dir, taskName, task, parsed.format))
  return 0
}

/** Near misses by edit distance, plus partial names in either direction. */
function suggest(query: string, candidates: readonly string[]): string {
  const q = query.toLowerCase()
  const near = new Set(nearMatches(query, candidates))
  for (const c of candidates) {
    const n = c.toLowerCase()
    if (n.includes(q) || q.includes(n)) near.add(c)
  }
  return near.size > 0 ? ` — did you mean ${[...near].join(', ')}?` : ''
}

function projectDir(root: string, meta: ProjectMeta): string {
  const rel = relPosix(root, meta.dir)
  return rel === '' ? '.' : rel
}

function renderList(
  root: string,
  metas: readonly ProjectMeta[],
  projects: ReadonlyMap<string, ProjectEntry>,
  format: 'pretty' | 'json',
): string {
  const rows = metas.map((meta) => ({
    name: meta.name,
    dir: projectDir(root, meta),
    tasks: Object.keys(projects.get(meta.name)?.config.tasks ?? {}),
    configured: meta.configPath !== null,
  }))
  if (format === 'json') {
    return `${JSON.stringify(
      rows.map(({ name, dir, tasks }) => ({ name, dir, tasks })),
      null,
      2,
    )}\n`
  }
  const nameW = Math.max(...rows.map((r) => r.name.length))
  const dirW = Math.max(...rows.map((r) => r.dir.length))
  const lines = rows.map((r) => {
    const n = r.tasks.length
    const count = `${n} task${n === 1 ? '' : 's'}`
    // A package with no config file only has tasks a plugin gave it.
    const tasks = r.configured
      ? count
      : n > 0
        ? `${count} (no vx config; from plugins)`
        : '(no vx config)'
    return `${r.name.padEnd(nameW)}  ${r.dir.padEnd(dirW)}  ${tasks}`
  })
  return `${lines.join('\n')}\n`
}

function renderProject(
  name: string,
  dir: string,
  config: ProjectConfig | null,
  hasConfigFile: boolean,
  format: 'pretty' | 'json',
): string {
  if (format === 'json') {
    // Round-trip so the printed object is exactly the JSON form of the
    // resolved config (drops `undefined` fields).
    return `${JSON.stringify(JSON.parse(JSON.stringify({ name, dir, config })), null, 2)}\n`
  }
  const head = `${name} — ${dir}`
  const tasks = Object.entries(config?.tasks ?? {})
  if (tasks.length === 0)
    return `${head}\n  ${hasConfigFile ? '(no tasks declared)' : '(no vx config)'}\n`
  const blocks = tasks.map(([taskName, task]) => taskBlock(taskName, task))
  return `${head}\n\n${blocks.join('\n')}`
}

function renderTask(
  name: string,
  dir: string,
  taskName: string,
  task: TaskConfig,
  format: 'pretty' | 'json',
): string {
  if (format === 'json') {
    const obj = { name, dir, task: taskName, config: task }
    return `${JSON.stringify(JSON.parse(JSON.stringify(obj)), null, 2)}\n`
  }
  return `${name} — ${dir}\n\n${taskBlock(taskName, task)}`
}

function renderTaskAcross(
  root: string,
  declaring: readonly ProjectEntry[],
  taskName: string,
  format: 'pretty' | 'json',
): string {
  if (format === 'json') {
    const list = declaring.map((p) => ({
      name: p.name,
      dir: relPosix(root, p.dir) || '.',
      task: taskName,
      config: p.config.tasks![taskName],
    }))
    return `${JSON.stringify(JSON.parse(JSON.stringify(list)), null, 2)}\n`
  }
  return declaring
    .map(
      (p) =>
        `${p.name} — ${relPosix(root, p.dir) || '.'}\n\n${taskBlock(taskName, p.config.tasks![taskName]!)}`,
    )
    .join('\n')
}

/** Every field the run reads, in the order the schema declares them. */
function taskBlock(taskName: string, task: TaskConfig): string {
  const rows: [string, string][] = []
  const list = (xs: readonly string[] | undefined): string | undefined =>
    xs === undefined ? undefined : xs.join(', ')
  const add = (label: string, value: string | number | boolean | undefined): void => {
    if (value !== undefined) rows.push([label, String(value)])
  }
  add('description', task.description)
  const exec = task.exec
  rows.push(['command', exec?.command ?? '(group)'])
  add('dependsOn', list(task.dependsOn))
  add('timeout', exec?.timeout === undefined ? undefined : `${exec.timeout}ms`)
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
  add('remote', exec?.remote === undefined ? undefined : String(exec.remote))
  add('sandbox', exec?.sandbox === undefined ? undefined : JSON.stringify(exec.sandbox))
  const persistent = exec?.persistent
  if (persistent !== undefined) {
    add(
      'persistent',
      persistent.readyWhen === undefined ? 'yes' : `readyWhen: ${persistent.readyWhen}`,
    )
  }
  const cache = task.cache
  if (cache !== undefined) {
    add('inputs.files', list(cache.inputs.files))
    add('inputs.workspaceFiles', list(cache.inputs.workspaceFiles))
    add('inputs.env', list(cache.inputs.env))
    add('inputs.tasks', list(cache.inputs.tasks))
    add('inputs.runtime', list(cache.inputs.runtime))
    add('inputs.workspaceRuntime', list(cache.inputs.workspaceRuntime))
    add('outputs.files', list(cache.outputs.files))
    add('outputs.workspaceFiles', list(cache.outputs.workspaceFiles))
  }
  const labelW = Math.max(...rows.map(([label]) => label.length))
  const body = rows.map(([label, value]) => `  ${`${label}:`.padEnd(labelW + 1)} ${value}`)
  return `${taskName}\n${body.join('\n')}\n`
}
