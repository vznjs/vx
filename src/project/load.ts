import type { Project } from './types.ts'

export async function loadProject(path: string): Promise<Project> {
  const mod = await import(path)
  return mod.default as Project
}
