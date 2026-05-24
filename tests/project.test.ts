import { describe, expect, it } from 'bun:test'
import { defineProject, loadProject, validateProject } from '../src/project/index.ts'
import { makeWorkspaceAsync } from './_testkit/fixtures.ts'

describe('loadProject', () => {
  it('loads vx.config.ts and wraps the config', async () => {
    const dir = await makeWorkspaceAsync({ 'vx.config.ts': 'export default {}' })
    expect(await loadProject(dir)).toEqual({ config: {} })
  })

  it('loads vx.config.mts', async () => {
    const dir = await makeWorkspaceAsync({ 'vx.config.mts': 'export default {}' })
    expect(await loadProject(dir)).toEqual({ config: {} })
  })

  it('loads vx.config.js', async () => {
    const dir = await makeWorkspaceAsync({ 'vx.config.js': 'export default {}' })
    expect(await loadProject(dir)).toEqual({ config: {} })
  })

  it('loads vx.config.mjs', async () => {
    const dir = await makeWorkspaceAsync({ 'vx.config.mjs': 'export default {}' })
    expect(await loadProject(dir)).toEqual({ config: {} })
  })

  it('returns a project with an empty config when no vx.config exists', async () => {
    const dir = await makeWorkspaceAsync({ 'something.txt': 'no config here' })
    expect(await loadProject(dir)).toEqual({ config: {} })
  })

  it('throws on unknown fields when a config is present', async () => {
    const dir = await makeWorkspaceAsync({
      'vx.config.ts': 'export default { whatever: 7 }',
    })
    await expect(loadProject(dir)).rejects.toThrow(/whatever/)
  })

  it('throws when the file has no default export', async () => {
    const dir = await makeWorkspaceAsync({ 'vx.config.ts': 'export const x = 1' })
    await expect(loadProject(dir)).rejects.toThrow()
  })
})

describe('validateProject', () => {
  it('returns the input as ProjectConfig when valid', () => {
    expect(validateProject({})).toEqual({})
  })

  it('throws on unknown fields (schema is strict)', () => {
    expect(() => validateProject({ whatever: 7 })).toThrow(/whatever/)
  })

  it('throws on non-object input', () => {
    expect(() => validateProject(42)).toThrow()
    expect(() => validateProject('foo')).toThrow()
    expect(() => validateProject(null)).toThrow()
    expect(() => validateProject(undefined)).toThrow()
  })
})

describe('defineProject', () => {
  it('returns its argument unchanged', () => {
    const input = {} as const
    expect(defineProject(input)).toBe(input)
  })
})
