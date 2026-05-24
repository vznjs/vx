import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { loadProject } from '../../src/project/load.ts'
import { makeWorkspaceAsync } from '../_testkit/fixtures.ts'

describe('loadProject', () => {
  it('loads an empty project', async () => {
    const root = await makeWorkspaceAsync({
      'vx.config.ts': 'export default {}',
    })

    const project = await loadProject(join(root, 'vx.config.ts'))

    expect(project).toEqual({})
  })

  it('returns whatever the user exported (no validation)', async () => {
    const root = await makeWorkspaceAsync({
      'vx.config.ts': 'export default { whatever: 7, nested: { x: "y" } }',
    })

    const project = await loadProject(join(root, 'vx.config.ts'))

    expect(project).toEqual({ whatever: 7, nested: { x: 'y' } } as unknown as Record<
      string,
      unknown
    >)
  })
})
