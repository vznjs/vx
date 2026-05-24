import { describe, expect, it } from 'bun:test'
import { loadProject } from '../../src/project/load.ts'
import { makeWorkspaceAsync } from '../_testkit/fixtures.ts'

describe('loadProject', () => {
  it('loads an empty project from a directory', async () => {
    const dir = await makeWorkspaceAsync({
      'vx.config.ts': 'export default {}',
    })

    const project = await loadProject(dir)

    expect(project).toEqual({})
  })

  it('throws when the directory has no vx.config file', async () => {
    const dir = await makeWorkspaceAsync({
      'package.json': '{"name":"a"}',
    })

    await expect(loadProject(dir)).rejects.toThrow(/no vx\.config/)
  })

  it('prefers vx.config.ts over .mts, .js, .mjs', async () => {
    const dir = await makeWorkspaceAsync({
      'vx.config.ts': 'export default {}',
      'vx.config.mts': 'export default { wrong: "mts" }',
      'vx.config.js': 'export default { wrong: "js" }',
      'vx.config.mjs': 'export default { wrong: "mjs" }',
    })

    const project = await loadProject(dir)

    expect(project).toEqual({})
  })

  it('falls through to .mts when .ts is absent', async () => {
    const dir = await makeWorkspaceAsync({
      'vx.config.mts': 'export default {}',
    })

    const project = await loadProject(dir)

    expect(project).toEqual({})
  })

  it('falls through to .js when .ts and .mts are absent', async () => {
    const dir = await makeWorkspaceAsync({
      'vx.config.js': 'export default {}',
    })

    const project = await loadProject(dir)

    expect(project).toEqual({})
  })

  it('falls through to .mjs as a last resort', async () => {
    const dir = await makeWorkspaceAsync({
      'vx.config.mjs': 'export default {}',
    })

    const project = await loadProject(dir)

    expect(project).toEqual({})
  })

  it('throws on unknown fields (schema is strict)', async () => {
    const dir = await makeWorkspaceAsync({
      'vx.config.ts': 'export default { whatever: 7 }',
    })

    await expect(loadProject(dir)).rejects.toThrow(/whatever/)
  })

  it('throws when the default export is not an object', async () => {
    const dir = await makeWorkspaceAsync({
      'vx.config.ts': 'export default 42',
    })

    await expect(loadProject(dir)).rejects.toThrow()
  })

  it('throws when there is no default export', async () => {
    const dir = await makeWorkspaceAsync({
      'vx.config.ts': 'export const x = 1',
    })

    await expect(loadProject(dir)).rejects.toThrow()
  })
})
