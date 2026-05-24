import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { makeWorkspaceAsync } from '../../src/_testkit/fixtures.ts'
import { discover } from '../../src/workspace/discover.ts'

describe('discover', () => {
  it('returns a single project for a bare package.json at root', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': JSON.stringify({ name: 'solo' }),
    })

    const ws = await discover({ root })

    expect(ws.root).toBe(root)
    expect(ws.projects).toEqual([{ name: 'solo', dir: root }])
  })

  it('reads pnpm-workspace.yaml packages globs', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': JSON.stringify({ name: 'root' }),
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      'packages/alpha/package.json': JSON.stringify({ name: 'alpha' }),
      'packages/beta/package.json': JSON.stringify({ name: 'beta' }),
    })

    const ws = await discover({ root })

    expect(ws.projects).toEqual([
      { name: 'alpha', dir: join(root, 'packages/alpha') },
      { name: 'beta', dir: join(root, 'packages/beta') },
    ])
  })

  it('reads package.json workspaces as a flat array', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['apps/*', 'libs/*'] }),
      'apps/web/package.json': JSON.stringify({ name: 'web' }),
      'libs/ui/package.json': JSON.stringify({ name: 'ui' }),
    })

    const ws = await discover({ root })

    expect(ws.projects.map((p) => p.name)).toEqual(['web', 'ui'])
  })

  it('reads package.json workspaces.packages shape', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': JSON.stringify({
        name: 'root',
        workspaces: { packages: ['pkg/*'] },
      }),
      'pkg/one/package.json': JSON.stringify({ name: 'one' }),
    })

    const ws = await discover({ root })

    expect(ws.projects).toEqual([{ name: 'one', dir: join(root, 'pkg/one') }])
  })

  it('skips glob matches that lack a package.json', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
      'packages/has-pkg/package.json': JSON.stringify({ name: 'has-pkg' }),
      'packages/no-pkg/README.md': '# tooling-only folder',
    })

    const ws = await discover({ root })

    expect(ws.projects.map((p) => p.name)).toEqual(['has-pkg'])
  })

  it('skips package.json files that are missing a name field', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['pkg/*'] }),
      'pkg/named/package.json': JSON.stringify({ name: 'named' }),
      'pkg/nameless/package.json': JSON.stringify({ version: '0.0.0' }),
    })

    const ws = await discover({ root })

    expect(ws.projects.map((p) => p.name)).toEqual(['named'])
  })

  it('prefers pnpm-workspace.yaml over package.json workspaces when both exist', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['ignored/*'] }),
      'pnpm-workspace.yaml': "packages:\n  - 'used/*'\n",
      'ignored/x/package.json': JSON.stringify({ name: 'should-not-appear' }),
      'used/y/package.json': JSON.stringify({ name: 'should-appear' }),
    })

    const ws = await discover({ root })

    expect(ws.projects.map((p) => p.name)).toEqual(['should-appear'])
  })

  it('returns an empty project list when the root has no package.json at all', async () => {
    const root = await makeWorkspaceAsync({
      'random.txt': 'not a workspace',
    })

    const ws = await discover({ root })

    expect(ws.projects).toEqual([])
  })

  it('returns projects sorted by directory for stable ordering', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
      'packages/zeta/package.json': JSON.stringify({ name: 'zeta' }),
      'packages/alpha/package.json': JSON.stringify({ name: 'alpha' }),
      'packages/mu/package.json': JSON.stringify({ name: 'mu' }),
    })

    const ws = await discover({ root })

    expect(ws.projects.map((p) => p.name)).toEqual(['alpha', 'mu', 'zeta'])
  })

  it('deduplicates if the root package.json is itself matched by a workspace glob', async () => {
    const root = await makeWorkspaceAsync({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['./'] }),
    })

    const ws = await discover({ root })

    expect(ws.projects).toEqual([{ name: 'root', dir: root }])
  })
})
