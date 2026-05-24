import { dirname, isAbsolute, resolve } from 'node:path'
import type { Workspace } from '../workspace/index.ts'
import { loadWorkspace } from '../workspace/index.ts'

const WORKSPACE_MARKER = new Bun.Glob('vx.workspace.{ts,mts,js,mjs}')

export type Graph = Workspace

export async function loadGraph(start: string): Promise<Graph> {
  const root = await findRoot(start)
  return loadWorkspace(root)
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
