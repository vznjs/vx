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

  it('throws when the directory has no vx.config file', async () => {
    const dir = await makeWorkspaceAsync({ 'package.json': '{"name":"a"}' })
    await expect(loadProject(dir)).rejects.toThrow()
  })

  it('throws on unknown fields (schema is strict)', async () => {
    const dir = await makeWorkspaceAsync({ 'vx.config.ts': 'export default { whatever: 7 }' })
    await expect(loadProject(dir)).rejects.toThrow(/whatever/)
  })

  it('throws when the default export is not an object', async () => {
    const dir = await makeWorkspaceAsync({ 'vx.config.ts': 'export default 42' })
    await expect(loadProject(dir)).rejects.toThrow()
  })

  it('throws when there is no default export', async () => {
    const dir = await makeWorkspaceAsync({ 'vx.config.ts': 'export const x = 1' })
    await expect(loadProject(dir)).rejects.toThrow()
  })
})
