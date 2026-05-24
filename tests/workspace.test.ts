import { describe, expect, it } from 'bun:test'
import { defineWorkspace, loadWorkspace, validateWorkspaceConfig } from '../src/workspace/index.ts'
import { makeWorkspaceAsync } from './_testkit/fixtures.ts'

describe('loadWorkspace', () => {
  it('loads projects from a package.json workspaces declaration', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"root","private":true,"workspaces":["packages/*"]}',
      'bun.lock': '{}',
      'packages/a/package.json': '{"name":"@scope/a","version":"1.0.0"}',
      'packages/b/package.json': '{"name":"@scope/b","version":"1.0.0"}',
    })

    const ws = await loadWorkspace(root)

    expect([...ws.projects.keys()].sort()).toEqual(['packages/a', 'packages/b'])
    expect(ws.projects.get('packages/a')).toEqual({})
  })

  it('loads projects from pnpm-workspace.yaml', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"root","private":true}',
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'packages/a/package.json': '{"name":"a","version":"1.0.0"}',
    })

    const ws = await loadWorkspace(root)

    expect([...ws.projects.keys()]).toEqual(['packages/a'])
  })

  it("uses each project's vx.config when present", async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"root","private":true,"workspaces":["packages/*"]}',
      'bun.lock': '{}',
      'packages/a/package.json': '{"name":"a","version":"1.0.0"}',
      'packages/a/vx.config.ts': 'export default {}',
      'packages/b/package.json': '{"name":"b","version":"1.0.0"}',
    })

    const ws = await loadWorkspace(root)

    expect(ws.projects.get('packages/a')).toEqual({})
    expect(ws.projects.get('packages/b')).toEqual({})
  })

  it('returns an empty projects map when the workspace declares no packages', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"root","private":true,"workspaces":[]}',
      'bun.lock': '{}',
    })

    const ws = await loadWorkspace(root)

    expect(ws.projects.size).toBe(0)
  })

  it('loads vx.workspace.ts alongside discovered projects', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"root","private":true,"workspaces":["packages/*"]}',
      'bun.lock': '{}',
      'vx.workspace.ts': 'export default {}',
      'packages/a/package.json': '{"name":"a","version":"1.0.0"}',
    })

    const ws = await loadWorkspace(root)

    expect([...ws.projects.keys()]).toEqual(['packages/a'])
  })

  it('throws on unknown fields in vx.workspace.ts', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"root","private":true,"workspaces":[]}',
      'bun.lock': '{}',
      'vx.workspace.ts': 'export default { whatever: 7 }',
    })

    await expect(loadWorkspace(root)).rejects.toThrow(/whatever/)
  })

  it('propagates project validation errors', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"root","private":true,"workspaces":["packages/*"]}',
      'bun.lock': '{}',
      'packages/bad/package.json': '{"name":"bad","version":"1.0.0"}',
      'packages/bad/vx.config.ts': 'export default { whatever: 1 }',
    })

    await expect(loadWorkspace(root)).rejects.toThrow(/whatever/)
  })
})

describe('validateWorkspaceConfig', () => {
  it('returns the input when valid', () => {
    expect(validateWorkspaceConfig({})).toEqual({})
  })

  it('throws on unknown fields (schema is strict)', () => {
    expect(() => validateWorkspaceConfig({ whatever: 7 })).toThrow(/whatever/)
  })

  it('throws on non-object input', () => {
    expect(() => validateWorkspaceConfig(42)).toThrow()
    expect(() => validateWorkspaceConfig(null)).toThrow()
  })
})

describe('defineWorkspace', () => {
  it('returns its argument unchanged', () => {
    const input = {} as const
    expect(defineWorkspace(input)).toBe(input)
  })
})
