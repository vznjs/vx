import { describe, expect, it } from 'bun:test'
import { loadProject } from '../../src/project/load.ts'
import { makeWorkspaceAsync } from '../_testkit/fixtures.ts'

describe('loadProject', () => {
  it('loads vx.config.ts', async () => {
    const dir = await makeWorkspaceAsync({ 'vx.config.ts': 'export default {}' })
    expect(await loadProject(dir)).toEqual({})
  })

  it('loads vx.config.mts', async () => {
    const dir = await makeWorkspaceAsync({ 'vx.config.mts': 'export default {}' })
    expect(await loadProject(dir)).toEqual({})
  })

  it('loads vx.config.js', async () => {
    const dir = await makeWorkspaceAsync({ 'vx.config.js': 'export default {}' })
    expect(await loadProject(dir)).toEqual({})
  })

  it('loads vx.config.mjs', async () => {
    const dir = await makeWorkspaceAsync({ 'vx.config.mjs': 'export default {}' })
    expect(await loadProject(dir)).toEqual({})
  })

  it('returns the default export unchanged — no validation', async () => {
    const dir = await makeWorkspaceAsync({
      'vx.config.ts': 'export default { whatever: 7, nested: { x: "y" } }',
    })

    expect(await loadProject(dir)).toEqual({ whatever: 7, nested: { x: 'y' } })
  })

  it('returns undefined when the file has no default export', async () => {
    const dir = await makeWorkspaceAsync({ 'vx.config.ts': 'export const x = 1' })
    expect(await loadProject(dir)).toBeUndefined()
  })

  it('throws when the directory has no vx.config file', async () => {
    const dir = await makeWorkspaceAsync({ 'package.json': '{"name":"a"}' })
    await expect(loadProject(dir)).rejects.toThrow()
  })
})
