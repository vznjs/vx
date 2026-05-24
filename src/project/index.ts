import { join } from 'node:path'
import { z } from 'zod'

const ProjectConfigSchema = z.strictObject({})

const CONFIG_GLOB = new Bun.Glob('vx.config.{ts,mts,js,mjs}')

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>

export interface Project {
  readonly config: ProjectConfig
}

export async function loadProject(dir: string): Promise<Project> {
  for await (const _ of CONFIG_GLOB.scan({ cwd: dir })) {
    const mod = await import(join(dir, 'vx.config'))
    return { config: validateProject(mod.default) }
  }
  return { config: validateProject({}) }
}

export function validateProject(input: unknown): ProjectConfig {
  return ProjectConfigSchema.parse(input)
}

export function defineProject<T extends ProjectConfig>(config: T): T {
  return config
}
