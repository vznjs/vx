import type { ProjectConfig } from './types.ts'

export async function loadConfig(path: string): Promise<ProjectConfig> {
  const mod = await import(path)
  return mod.default as ProjectConfig
}
