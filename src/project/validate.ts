import type { Project } from './schema.ts'
import { ProjectSchema } from './schema.ts'

export function validateProject(input: unknown): Project {
  return ProjectSchema.parse(input)
}
