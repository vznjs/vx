import { join } from 'node:path'
import type { LoadConfigs, LoadedConfig, ProjectConfig, TaskConfig } from './types.ts'

const CONFIG_FILES = ['vx.config.ts', 'vx.config.mts', 'vx.config.js', 'vx.config.mjs'] as const

export const loadConfigs: LoadConfigs = async ({ workspace }) => {
  const results = await Promise.all(
    workspace.projects.map(async (project) => {
      const path = await findConfigPath(project.dir)
      if (path === null) return null
      const mod = await importFresh(path)
      const config = validateProjectConfig(mod, project.name)
      return { project, config } satisfies LoadedConfig
    }),
  )
  return results.filter((r): r is LoadedConfig => r !== null)
}

async function findConfigPath(dir: string): Promise<string | null> {
  for (const name of CONFIG_FILES) {
    const candidate = join(dir, name)
    if (await Bun.file(candidate).exists()) return candidate
  }
  return null
}

async function importFresh(path: string): Promise<unknown> {
  // Bun caches module imports across the process. For tests + watch mode
  // we need to bust the cache so an updated config file is re-evaluated.
  // Path-based fingerprinting via mtime is the cheapest safe option.
  const stat = await Bun.file(path).stat()
  const bust = stat.mtimeMs
  return import(`${path}?t=${bust}`)
}

function validateProjectConfig(mod: unknown, projectName: string): ProjectConfig {
  const fail = (msg: string): never => {
    throw new Error(`vx.config for "${projectName}": ${msg}`)
  }

  if (!isObject(mod) || !('default' in mod)) {
    return fail('module has no default export')
  }
  const cfg = (mod as { default: unknown }).default
  if (!isObject(cfg)) return fail('default export must be an object')

  if ('tasks' in cfg) {
    if (!isObject(cfg.tasks) || Array.isArray(cfg.tasks)) {
      return fail('`tasks` must be an object keyed by task name')
    }
    for (const [taskName, task] of Object.entries(cfg.tasks)) {
      validateTaskConfig(task, projectName, taskName)
    }
  }

  return cfg as ProjectConfig
}

function validateTaskConfig(task: unknown, projectName: string, taskName: string): TaskConfig {
  const fail = (msg: string): never => {
    throw new Error(`vx.config for "${projectName}" task "${taskName}": ${msg}`)
  }

  if (!isObject(task)) return fail('task config must be an object')

  if ('description' in task && typeof task.description !== 'string') {
    return fail('`description` must be a string')
  }
  if ('exec' in task) {
    if (!isObject(task.exec)) return fail('`exec` must be an object')
    if (typeof task.exec.command !== 'string') return fail('`exec.command` must be a string')
  }
  if ('dependsOn' in task) {
    if (!Array.isArray(task.dependsOn)) return fail('`dependsOn` must be an array of strings')
    for (const entry of task.dependsOn) {
      if (typeof entry !== 'string') return fail('`dependsOn` entries must be strings')
    }
  }

  return task as TaskConfig
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
