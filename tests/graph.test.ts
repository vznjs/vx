import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { loadGraph } from '../src/graph/index.ts'
import { makeWorkspaceAsync } from './_testkit/fixtures.ts'

describe('loadGraph', () => {
  it('loads the workspace from the same dir', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"root","private":true,"workspaces":["packages/*"]}',
      'bun.lock': '{}',
      'packages/a/package.json': '{"name":"a","version":"1.0.0"}',
    })

    const graph = await loadGraph(root)

    expect([...graph.projects.keys()]).toEqual(['packages/a'])
  })

  it('walks up from a subdirectory to find the workspace root', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"root","private":true,"workspaces":["packages/*"]}',
      'bun.lock': '{}',
      'packages/a/package.json': '{"name":"a","version":"1.0.0"}',
      'packages/a/src/x.ts': 'export const x = 1',
    })

    const graph = await loadGraph(join(root, 'packages/a/src'))

    expect([...graph.projects.keys()]).toEqual(['packages/a'])
  })
})
