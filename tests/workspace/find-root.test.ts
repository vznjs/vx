import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { makeWorkspaceAsync } from '../../src/_testkit/fixtures.ts'
import { findWorkspaceRoot } from '../../src/workspace/find-root.ts'

describe('findWorkspaceRoot', () => {
  it('returns cwd when pnpm-workspace.yaml is right there', async () => {
    const root = await makeWorkspaceAsync({
      'pnpm-workspace.yaml': 'packages: ["a"]',
      'package.json': '{"name":"root"}',
    })

    expect(await findWorkspaceRoot(root)).toBe(root)
  })

  it('walks up until it finds pnpm-workspace.yaml', async () => {
    const root = await makeWorkspaceAsync({
      'pnpm-workspace.yaml': 'packages: ["packages/*"]',
      'package.json': '{"name":"root"}',
      'packages/a/package.json': '{"name":"a"}',
      'packages/a/src/x.ts': '',
    })

    expect(await findWorkspaceRoot(join(root, 'packages/a/src'))).toBe(root)
  })

  it('walks up until it finds package.json with workspaces', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"root","workspaces":["packages/*"]}',
      'packages/a/package.json': '{"name":"a"}',
    })

    expect(await findWorkspaceRoot(join(root, 'packages/a'))).toBe(root)
  })

  it('falls back to the nearest package.json (single-project)', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': '{"name":"solo"}',
      'src/x.ts': '',
    })

    expect(await findWorkspaceRoot(join(root, 'src'))).toBe(root)
  })

  it('returns null when no marker is found before the filesystem root', async () => {
    expect(await findWorkspaceRoot('/nonexistent-path-with-no-pkg-json/xyz')).toBeNull()
  })
})
