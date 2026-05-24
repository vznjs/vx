import { join } from 'node:path'
import { z } from 'zod'

const ProjectSchema = z.strictObject({})

export type Project = z.infer<typeof ProjectSchema>

export async function loadProject(dir: string): Promise<Project> {
  const mod = await import(join(dir, 'vx.config'))
  return validateProject(mod.default)
}

export function validateProject(input: unknown): Project {
  return ProjectSchema.parse(input)
}

export function defineProject<T extends Project>(project: T): T {
  return project
}
