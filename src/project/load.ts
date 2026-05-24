import { join } from 'node:path'
import type { Project } from './schema.ts'
import { ProjectSchema } from './schema.ts'

export async function loadProject(dir: string): Promise<Project> {
  const mod = await import(join(dir, 'vx.config'))
  return ProjectSchema.parse(mod.default)
}
