import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import {
  defineWorkspace,
  findWorkspaceRoot,
  loadWorkspace,
  validateWorkspace,
} from '../src/workspace/index.ts'
import { makeWorkspaceAsync } from './_testkit/fixtures.ts'

describe('loadWorkspace', () => {
  it('loads vx.workspace.ts with a packages list', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': "export default { packages: ['packages/*', 'apps/*'] }",
    })
    expect(await loadWorkspace(root)).toEqual({ packages: ['packages/*', 'apps/*'] })
  })

  it('accepts concrete paths alongside globs', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': "export default { packages: ['libs/core', 'libs/utils'] }",
    })
    expect(await loadWorkspace(root)).toEqual({ packages: ['libs/core', 'libs/utils'] })
  })

  it('accepts an empty packages list', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': 'export default { packages: [] }',
    })
    expect(await loadWorkspace(root)).toEqual({ packages: [] })
  })

  it('loads vx.workspace.mts', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.mts': "export default { packages: ['packages/*'] }",
    })
    expect(await loadWorkspace(root)).toEqual({ packages: ['packages/*'] })
  })

  it('throws when packages is missing (schema is strict)', async () => {
    const root = await makeWorkspaceAsync({ 'vx.workspace.ts': 'export default {}' })
    await expect(loadWorkspace(root)).rejects.toThrow(/packages/)
  })

  it('throws on unknown fields (schema is strict)', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': 'export default { packages: [], whatever: 7 }',
    })
    await expect(loadWorkspace(root)).rejects.toThrow(/whatever/)
  })

  it('throws when packages entries are not strings', async () => {
    const root = await makeWorkspaceAsync({
      'vx.workspace.ts': 'export default { packages: [42] }',
    })
    await expect(loadWorkspace(root)).rejects.toThrow()
  })

  it('throws when the file has no default export', async () => {
    const root = await makeWorkspaceAsync({ 'vx.workspace.ts': 'export const x = 1' })
    await expect(loadWorkspace(root)).rejects.toThrow()
  })

  it('throws when the root has no vx.workspace file', async () => {
    const root = await makeWorkspaceAsync({ 'random.txt': 'nothing' })
    await expect(loadWorkspace(root)).rejects.toThrow()
  })
})

describe('validateWorkspace', () => {
  it('returns the input unchanged when it matches the schema', () => {
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

describe('findWorkspaceRoot', () => {
  it('returns the dir containing pnpm-workspace.yaml', async () => {
    const root = await makeWorkspaceAsync({
      'pnpm-workspace.yaml': 'packages: ["packages/*"]',
    })
    expect(await findWorkspaceRoot(root)).toBe(root)
  })

  it('walks up from a subdirectory to find the workspace root', async () => {
    const root = await makeWorkspaceAsync({
      'pnpm-workspace.yaml': 'packages: ["packages/*"]',
      'packages/a/package.json': '{"name":"a"}',
      'packages/a/src/x.ts': 'export const x = 1',
    })
    expect(await findWorkspaceRoot(join(root, 'packages/a/src'))).toBe(root)
  })

  it('throws when no workspace marker is found', async () => {
    await expect(
      findWorkspaceRoot('/this/path/should/have/no/workspace/marker/anywhere'),
    ).rejects.toThrow()
  })
})
