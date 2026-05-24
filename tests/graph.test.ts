import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { loadGraph } from '../src/graph/index.ts'
import { makeWorkspaceAsync } from './_testkit/fixtures.ts'

describe('loadGraph', () => {
  it('loads the workspace from the same dir', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': "export default { packages: ['packages/*'] }",
      'packages/a/.keep': '',
    })

    const graph = await loadGraph(root)

    expect(graph.config).toEqual({ packages: ['packages/*'] })
    expect([...graph.projects.keys()]).toEqual(['packages/a'])
  })

  it('walks up from a subdirectory to find the workspace root', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': "export default { packages: ['packages/*'] }",
      'packages/a/src/x.ts': 'export const x = 1',
    })

    const graph = await loadGraph(join(root, 'packages/a/src'))

    expect([...graph.projects.keys()]).toEqual(['packages/a'])
  })

  it('throws when no vx.workspace marker is found anywhere', async () => {
    await expect(loadGraph('/this/path/should/have/no/workspace/marker/anywhere')).rejects.toThrow()
  })
})
