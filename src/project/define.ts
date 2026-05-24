import type { Project } from './schema.ts'

export function defineProject<T extends Project>(project: T): T {
  return project
}
