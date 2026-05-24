import { join } from 'node:path'
import { z } from 'zod'

const ProjectConfigSchema = z.strictObject({})

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>

export interface Project {}

export async function loadProject(dir: string): Promise<Project> {
  const mod = await import(join(dir, 'vx.config')).catch(() => ({ default: {} }))
  return { ...validateProjectConfig(mod.default) }
}

export function validateProjectConfig(input: unknown): ProjectConfig {
  return ProjectConfigSchema.parse(input)
}

export function defineProject<T extends ProjectConfig>(config: T): T {
  return config
}
