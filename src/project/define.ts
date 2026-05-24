import type { Project } from './types.ts'

export function defineProject<T extends Project>(project: T): T {
  return project
}
