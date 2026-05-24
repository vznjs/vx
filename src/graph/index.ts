import { findRoot } from '@manypkg/find-root'
import type { Workspace } from '../workspace/index.ts'
import { loadWorkspace } from '../workspace/index.ts'

export type Graph = Workspace

export async function loadGraph(start: string): Promise<Graph> {
  const { rootDir } = await findRoot(start)
  return loadWorkspace(rootDir)
}
