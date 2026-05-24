import { join } from 'node:path'
import type { Project } from './schema.ts'
import { ProjectSchema } from './schema.ts'

const CONFIG_FILES = ['vx.config.ts', 'vx.config.mts', 'vx.config.js', 'vx.config.mjs'] as const

export async function loadProject(dir: string): Promise<Project> {
  const path = await findConfigPath(dir)
  if (path === null) {
    throw new Error(`no vx.config.{ts,mts,js,mjs} in ${dir}`)
  }
  const mod = await import(path)
  return ProjectSchema.parse(mod.default)
}

async function findConfigPath(dir: string): Promise<string | null> {
  for (const name of CONFIG_FILES) {
    const candidate = join(dir, name)
    if (await Bun.file(candidate).exists()) return candidate
  }
  return null
}
