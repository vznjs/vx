import { describe, expect, it } from 'bun:test'
import { defineWorkspace, loadWorkspace, validateWorkspace } from '../src/workspace/index.ts'
import { makeWorkspaceAsync } from './_testkit/fixtures.ts'

describe('loadWorkspace', () => {
  it('returns the workspace config plus inferred projects', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': "export default { packages: ['packages/*'] }",
      'packages/a/.keep': '',
      'packages/b/.keep': '',
    })

    const workspace = await loadWorkspace(root)

    expect(workspace.config).toEqual({ packages: ['packages/*'] })
    expect([...workspace.projects.keys()].sort()).toEqual(['packages/a', 'packages/b'])
    expect(workspace.projects.get('packages/a')).toEqual({ config: {} })
  })

  it('uses each project’s vx.config when present', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': "export default { packages: ['packages/*'] }",
      'packages/a/vx.config.ts': 'export default {}',
      'packages/b/.keep': '',
    })

    const workspace = await loadWorkspace(root)

    expect(workspace.projects.get('packages/a')).toEqual({ config: {} })
    expect(workspace.projects.get('packages/b')).toEqual({ config: {} })
  })

  it('handles concrete path entries alongside globs', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': "export default { packages: ['packages/*', 'libs/core'] }",
      'packages/a/.keep': '',
      'libs/core/.keep': '',
    })

    const workspace = await loadWorkspace(root)

    expect([...workspace.projects.keys()].sort()).toEqual(['libs/core', 'packages/a'])
  })

  it('skips file matches (only directories become projects)', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': "export default { packages: ['packages/*'] }",
      'packages/a/.keep': '',
      'packages/README.md': 'not a project',
    })

    const workspace = await loadWorkspace(root)

    expect([...workspace.projects.keys()]).toEqual(['packages/a'])
  })

  it('dedupes when multiple patterns match the same dir', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': "export default { packages: ['packages/*', 'packages/a'] }",
      'packages/a/.keep': '',
    })

    const workspace = await loadWorkspace(root)

    expect([...workspace.projects.keys()]).toEqual(['packages/a'])
  })

  it('returns an empty projects map for an empty packages list', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': 'export default { packages: [] }',
    })

    const workspace = await loadWorkspace(root)

    expect(workspace.projects.size).toBe(0)
    expect(workspace.config.packages).toEqual([])
  })

  it('throws when packages is missing (schema is strict)', async () => {
    const root = await makeWorkspaceAsync({ 'vx.workspace.ts': 'export default {}' })
    await expect(loadWorkspace(root)).rejects.toThrow(/packages/)
  })

  it('throws on unknown fields in vx.workspace.ts', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': 'export default { packages: [], whatever: 7 }',
    })
    await expect(loadWorkspace(root)).rejects.toThrow(/whatever/)
  })

  it('throws when the root has no vx.workspace file', async () => {
    const root = await makeWorkspaceAsync({ 'random.txt': 'nothing' })
    await expect(loadWorkspace(root)).rejects.toThrow()
  })

  it('propagates project validation errors', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': "export default { packages: ['packages/*'] }",
      'packages/bad/vx.config.ts': 'export default { whatever: 1 }',
    })

    await expect(loadWorkspace(root)).rejects.toThrow(/whatever/)
  })
})

describe('validateWorkspace', () => {
  it('returns the input as WorkspaceConfig when valid', () => {
    expect(validateWorkspace({ packages: ['packages/*'] })).toEqual({ packages: ['packages/*'] })
  })

  it('throws on missing packages', () => {
    expect(() => validateWorkspace({})).toThrow(/packages/)
  })

  it('throws on unknown fields (schema is strict)', () => {
    expect(() => validateWorkspace({ packages: [], whatever: 7 })).toThrow(/whatever/)
  })

  it('throws on non-object input', () => {
    expect(() => validateWorkspace(42)).toThrow()
    expect(() => validateWorkspace(null)).toThrow()
  })
})

describe('defineWorkspace', () => {
  it('returns its argument unchanged', () => {
    const input = { packages: ['packages/*'] } as const
    expect(defineWorkspace(input)).toBe(input)
  })
})
