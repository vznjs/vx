import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Project } from '../project/index.ts'
import { loadProject } from '../project/index.ts'
import type { Workspace } from '../workspace/index.ts'
import { loadWorkspace } from '../workspace/index.ts'

const WORKSPACE_MARKER = new Bun.Glob('vx.workspace.{ts,mts,js,mjs}')

export interface Graph {
  readonly workspace: Workspace
  /** Relative project dir → loaded project. */
  readonly projects: ReadonlyMap<string, Project>
}

export async function loadGraph(start: string): Promise<Graph> {
  const root = await findRoot(start)
  const workspace = await loadWorkspace(root)
  const loads: Promise<[string, Project]>[] = []
  const seen = new Set<string>()
  for (const pattern of workspace.packages) {
    const glob = new Bun.Glob(`${pattern.replace(/\/+$/, '')}/vx.config.{ts,mts,js,mjs}`)
    for await (const match of glob.scan({ cwd: root })) {
      const dir = match.slice(0, match.lastIndexOf('/vx.config.'))
      if (seen.has(dir)) continue
      seen.add(dir)
      loads.push(loadProject(join(root, dir)).then((p) => [dir, p]))
    }
  }
  return { workspace, projects: new Map(await Promise.all(loads)) }
}

async function findRoot(start: string): Promise<string> {
  let current = isAbsolute(start) ? start : resolve(start)
  while (true) {
    for await (const _ of WORKSPACE_MARKER.scan({ cwd: current })) return current
    const parent = dirname(current)
    if (parent === current) throw new Error(`no vx workspace found from ${start}`)
    current = parent
  }
}
