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

  it('throws on unknown fields (schema is strict)', async () => {
    const root = await makeWorkspaceAsync({
      'vx.config.ts': 'export default { whatever: 7 }',
    })

    await expect(loadProject(join(root, 'vx.config.ts'))).rejects.toThrow(/whatever/)
  })

  it('throws when the default export is not an object', async () => {
    const root = await makeWorkspaceAsync({
      'vx.config.ts': 'export default 42',
    })

    await expect(loadProject(join(root, 'vx.config.ts'))).rejects.toThrow()
  })

  it('throws when there is no default export', async () => {
    const root = await makeWorkspaceAsync({
      'vx.config.ts': 'export const x = 1',
    })

    await expect(loadProject(join(root, 'vx.config.ts'))).rejects.toThrow()
  })
})
