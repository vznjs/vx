import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Project } from '../project/index.ts'
import { loadProject } from '../project/index.ts'

const WorkspaceConfigSchema = z.strictObject({
  packages: z.array(z.string()).readonly(),
})

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>

export interface Workspace {
  readonly config: WorkspaceConfig
  /** Relative project dir → loaded project. Inferred from `config.packages`. */
  readonly projects: ReadonlyMap<string, Project>
}

export async function loadWorkspace(root: string): Promise<Workspace> {
  const mod = await import(join(root, 'vx.workspace'))
  const config = validateWorkspace(mod.default)
  const projects = await inferProjects(root, config.packages)
  return { config, projects }
}

async function inferProjects(
  root: string,
  patterns: readonly string[],
): Promise<ReadonlyMap<string, Project>> {
  const seen = new Set<string>()
  const loads: Promise<[string, Project]>[] = []
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern)
    for await (const match of glob.scan({ cwd: root, onlyFiles: false })) {
      if (seen.has(match)) continue
      seen.add(match)
      const s = await stat(join(root, match))
      if (!s.isDirectory()) continue
      loads.push(loadProject(join(root, match)).then((p) => [match, p]))
    }
  }
  return new Map(await Promise.all(loads))
}

export function validateWorkspace(input: unknown): WorkspaceConfig {
  return WorkspaceConfigSchema.parse(input)
}

export function defineWorkspace<T extends WorkspaceConfig>(config: T): T {
  return config
}
