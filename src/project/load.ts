import type { Project } from './schema.ts'
import { ProjectSchema } from './schema.ts'

export async function loadProject(path: string): Promise<Project> {
  const mod = await import(path)
  return ProjectSchema.parse(mod.default)
}
