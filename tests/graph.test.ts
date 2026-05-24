import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { loadGraph } from '../src/graph/index.ts'
import { makeWorkspaceAsync } from './_testkit/fixtures.ts'

describe('loadGraph', () => {
  it('loads workspace + every project that matches a packages glob', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': "export default { packages: ['packages/*'] }",
      'packages/a/vx.config.ts': 'export default {}',
      'packages/b/vx.config.ts': 'export default {}',
    })

    const graph = await loadGraph(root)

    expect(graph.workspace).toEqual({ packages: ['packages/*'] })
    expect([...graph.projects.keys()].sort()).toEqual(['packages/a', 'packages/b'])
    expect(graph.projects.get('packages/a')).toEqual({})
    expect(graph.projects.get('packages/b')).toEqual({})
  })

  it('walks up from a subdirectory to find the workspace root', async () => {
    const root = await makeWorkspaceAsync({
      'pnpm-workspace.yaml': 'packages: ["packages/*"]',
      'vx.workspace.ts': "export default { packages: ['packages/*'] }",
      'packages/a/vx.config.ts': 'export default {}',
      'packages/a/src/x.ts': 'export const x = 1',
    })

    const graph = await loadGraph(join(root, 'packages/a/src'))

    expect([...graph.projects.keys()]).toEqual(['packages/a'])
  })

  it('loads a project from a concrete path entry', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': "export default { packages: ['libs/core'] }",
      'libs/core/vx.config.ts': 'export default {}',
    })

    const graph = await loadGraph(root)

    expect([...graph.projects.keys()]).toEqual(['libs/core'])
  })

  it('discovers projects across multiple patterns', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': "export default { packages: ['packages/*', 'apps/*'] }",
      'packages/lib/vx.config.ts': 'export default {}',
      'apps/web/vx.config.ts': 'export default {}',
    })

    const graph = await loadGraph(root)

    expect([...graph.projects.keys()].sort()).toEqual(['apps/web', 'packages/lib'])
  })

  it('finds projects regardless of vx.config extension', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': "export default { packages: ['packages/*'] }",
      'packages/ts/vx.config.ts': 'export default {}',
      'packages/mts/vx.config.mts': 'export default {}',
      'packages/js/vx.config.js': 'export default {}',
      'packages/mjs/vx.config.mjs': 'export default {}',
    })

    const graph = await loadGraph(root)

    expect([...graph.projects.keys()].sort()).toEqual([
      'packages/js',
      'packages/mjs',
      'packages/mts',
      'packages/ts',
    ])
  })

  it('skips matched dirs that have no vx.config file', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': "export default { packages: ['packages/*'] }",
      'packages/a/vx.config.ts': 'export default {}',
      'packages/no-config/package.json': '{"name":"no-config"}',
    })

    const graph = await loadGraph(root)

    expect([...graph.projects.keys()]).toEqual(['packages/a'])
  })

  it('returns an empty projects map when packages is empty', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': 'export default { packages: [] }',
    })

    const graph = await loadGraph(root)

    expect(graph.projects.size).toBe(0)
    expect(graph.workspace.packages).toEqual([])
  })

  it('throws when no workspace marker is found anywhere', async () => {
    await expect(loadGraph('/this/path/should/have/no/workspace/marker/anywhere')).rejects.toThrow()
  })

  it('throws when a discovered project has an invalid vx.config', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': "export default { packages: ['packages/*'] }",
      'packages/bad/vx.config.ts': 'export default { unknown: 1 }',
    })

    await expect(loadGraph(root)).rejects.toThrow(/unknown/)
  })
})
