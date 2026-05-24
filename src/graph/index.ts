import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Project } from '../project/index.ts'
import { loadProject } from '../project/index.ts'
import type { Workspace } from '../workspace/index.ts'
import { loadWorkspace } from '../workspace/index.ts'

const WORKSPACE_FILES = [
  'vx.workspace.ts',
  'vx.workspace.mts',
  'vx.workspace.js',
  'vx.workspace.mjs',
] as const

export interface Graph {
  readonly workspace: Workspace
  /** Relative project dir → loaded project. */
  readonly projects: ReadonlyMap<string, Project>
}

export async function loadGraph(start: string): Promise<Graph> {
  const root = await findRoot(start)
  const workspace = await loadWorkspace(root)
  const dirs = await resolveProjectDirs(root, workspace.packages)
  const entries = await Promise.all(
    dirs.map(async (dir) => [dir, await loadProject(join(root, dir))] as const),
  )
  return { workspace, projects: new Map(entries) }
}

async function findRoot(start: string): Promise<string> {
  let current = isAbsolute(start) ? start : resolve(start)
  while (true) {
    for (const name of WORKSPACE_FILES) {
      if (await Bun.file(join(current, name)).exists()) return current
    }
    const parent = dirname(current)
    if (parent === current) {
      throw new Error(`no vx workspace found from ${start}`)
    }
    current = parent
  }
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
