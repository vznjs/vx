// `vx show [target]` — introspect the workspace's LIVE resolved configs.
// No target: one line per project. `<project>`: every task's resolved
// config, evaluated with the same loader the run path uses (scoped to
// that single project). `<pkg>#<task>`: one task. This is deliberately
// NOT the lock — vx-lock.json is already the frozen JSON; `show` answers
// "what would a live run see here, now".

import type { ProjectConfig, TaskConfig } from '../config.js'
import { seeHelp } from './help.js'
import { relPosix, UserError } from '../util/index.js'
import {
  findWorkspaceRoot,
  listProjects,
  loadProjectConfig,
  loadWorkspace,
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

  if (parsed.target === undefined) {
    process.stdout.write(await renderList(root, metas, parsed.format))
    return 0
  }

  const hashAt = parsed.target.indexOf('#')
  const projectName = hashAt === -1 ? parsed.target : parsed.target.slice(0, hashAt)
  const taskName = hashAt === -1 ? undefined : parsed.target.slice(hashAt + 1)
  if (taskName === '') throw new UserError(`missing task name after '#' in "${parsed.target}"`)

  const meta = metas.find((m) => m.name === projectName)
  if (!meta) {
    throw new UserError(
      `unknown project: "${projectName}"${suggest(
        projectName,
        metas.map((m) => m.name),
      )}`,
    )
  }
  const config = meta.configPath === null ? null : await loadProjectConfig(meta.configPath)
  const dir = projectDir(root, meta)

  if (taskName === undefined) {
    process.stdout.write(renderProject(meta.name, dir, config, parsed.format))
    return 0
  }

  const task = config?.tasks?.[taskName]
  if (task === undefined) {
    throw new UserError(
      `unknown task: "${meta.name}#${taskName}"${suggest(
        taskName,
        Object.keys(config?.tasks ?? {}),
      )}`,
    )
  }
  process.stdout.write(renderTask(meta.name, dir, taskName, task, parsed.format))
  return 0
}

/** Simple includes-match in both directions, case-insensitive. */
function suggest(query: string, candidates: readonly string[]): string {
  const q = query.toLowerCase()
  const near = candidates.filter((c) => {
    const n = c.toLowerCase()
    return n.includes(q) || q.includes(n)
  })
  return near.length > 0 ? ` — did you mean ${near.join(', ')}?` : ''
}

function projectDir(root: string, meta: ProjectMeta): string {
  const rel = relPosix(root, meta.dir)
  return rel === '' ? '.' : rel
}

async function renderList(
  root: string,
  metas: readonly ProjectMeta[],
  format: 'pretty' | 'json',
): Promise<string> {
  const rows = await Promise.all(
    metas.map(async (meta) => {
      const config = meta.configPath === null ? null : await loadProjectConfig(meta.configPath)
      return {
        name: meta.name,
        dir: projectDir(root, meta),
        tasks: Object.keys(config?.tasks ?? {}),
        configured: meta.configPath !== null,
      }
    }),
  )
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
    const tasks = r.configured
      ? `${r.tasks.length} task${r.tasks.length === 1 ? '' : 's'}`
      : '(no vx config)'
    return `${r.name.padEnd(nameW)}  ${r.dir.padEnd(dirW)}  ${tasks}`
  })
  return `${lines.join('\n')}\n`
}

function renderProject(
  name: string,
  dir: string,
  config: ProjectConfig | null,
  format: 'pretty' | 'json',
): string {
  if (format === 'json') {
    // Round-trip so the printed object is exactly the JSON form of the
    // resolved config (drops `undefined` fields).
    return `${JSON.stringify(JSON.parse(JSON.stringify({ name, dir, config })), null, 2)}\n`
  }
  const head = `${name} — ${dir}`
  if (config === null) return `${head}\n  (no vx config)\n`
  const tasks = Object.entries(config.tasks ?? {})
  if (tasks.length === 0) return `${head}\n  (no tasks declared)\n`
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

function taskBlock(taskName: string, task: TaskConfig): string {
  const rows: [string, string][] = []
  if (task.description !== undefined) rows.push(['description', task.description])
  rows.push(['command', task.exec?.command ?? '(group)'])
  if (task.dependsOn !== undefined) rows.push(['dependsOn', task.dependsOn.join(', ')])
  if (task.cache !== undefined) {
    rows.push(['inputs.files', task.cache.inputs.files.join(', ')])
    if (task.cache.inputs.env !== undefined) {
      rows.push(['inputs.env', task.cache.inputs.env.join(', ')])
    }
    if (task.cache.inputs.tasks !== undefined) {
      rows.push(['inputs.tasks', task.cache.inputs.tasks.join(', ')])
    }
    rows.push(['outputs.files', task.cache.outputs.files.join(', ')])
  }
  if (task.exec?.timeout !== undefined) rows.push(['timeout', `${task.exec.timeout}ms`])
  const persistent = task.exec?.persistent
  if (persistent !== undefined) {
    const fields: string[] = []
    if (persistent.readyWhen !== undefined) fields.push(`readyWhen: ${persistent.readyWhen}`)
    rows.push(['persistent', fields.length > 0 ? fields.join(', ') : 'yes'])
  }
  const labelW = Math.max(...rows.map(([label]) => label.length))
  const body = rows.map(([label, value]) => `  ${`${label}:`.padEnd(labelW + 1)} ${value}`)
  return `${taskName}\n${body.join('\n')}\n`
}
