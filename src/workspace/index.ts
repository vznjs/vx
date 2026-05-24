import { join } from 'node:path'
import { getPackages } from '@manypkg/get-packages'
import { z } from 'zod'
import type { Project } from '../project/index.ts'
import { loadProject } from '../project/index.ts'

const WorkspaceConfigSchema = z.strictObject({})

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>

export interface Workspace {
  readonly projects: ReadonlyMap<string, Project>
}

export async function loadWorkspace(root: string): Promise<Workspace> {
  const mod = await import(join(root, 'vx.workspace')).catch(() => ({ default: {} }))
  const config = validateWorkspaceConfig(mod.default)
  const { packages } = await getPackages(root)
  const projects = new Map(
    await Promise.all(
      packages.map(async (pkg) => [pkg.relativeDir, await loadProject(pkg.dir)] as const),
    ),
  )
  return { ...config, projects }
}

export function validateWorkspaceConfig(input: unknown): WorkspaceConfig {
  return WorkspaceConfigSchema.parse(input)
}

export function defineWorkspace<T extends WorkspaceConfig>(config: T): T {
  return config
}
