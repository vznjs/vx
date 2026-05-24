import { join } from 'node:path'
import type { Project } from '../project/index.ts'
import { loadProject } from '../project/index.ts'
import type { Workspace } from '../workspace/index.ts'
import { loadWorkspace } from '../workspace/index.ts'

export interface Graph {
  readonly workspace: Workspace
  /** Relative project dir → loaded project. */
  readonly projects: ReadonlyMap<string, Project>
}

export async function loadGraph(root: string): Promise<Graph> {
  const workspace = await loadWorkspace(root)
  const dirs = await resolveProjectDirs(root, workspace.packages)
  const entries = await Promise.all(
    dirs.map(async (dir) => [dir, await loadProject(join(root, dir))] as const),
  )
  return { workspace, projects: new Map(entries) }
}

async function resolveProjectDirs(
  root: string,
  patterns: readonly string[],
): Promise<readonly string[]> {
  const dirs = new Set<string>()
  for (const pattern of patterns) {
    const cleaned = pattern.replace(/\/+$/, '')
    const glob = new Bun.Glob(`${cleaned}/vx.config.{ts,mts,js,mjs}`)
    for await (const match of glob.scan({ cwd: root })) {
      const slashIdx = match.lastIndexOf('/vx.config.')
      dirs.add(match.slice(0, slashIdx))
    }
  }
  return Array.from(dirs).sort()
}
