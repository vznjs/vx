import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import { findWorkspaceRoot, listProjects, loadWorkspace } from '../src/workspace/workspace.js'

describe('findWorkspaceRoot', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-ws-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('walks up from a child directory to find pnpm-workspace.yaml', async () => {
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages: []\n')
    const sub = path.join(dir, 'a', 'b', 'c')
    await mkdir(sub, { recursive: true })
    expect(await findWorkspaceRoot(sub)).toBe(dir)
  })

  it('throws clearly when no workspace root signal exists in any parent', async () => {
    await expect(findWorkspaceRoot(dir)).rejects.toThrow(/Could not find a workspace root/)
  })

  it('accepts a bare package.json as workspace root (single-project mode)', async () => {
    await writeFile(path.join(dir, 'package.json'), '{"name":"r","private":true}')
    const sub = path.join(dir, 'a', 'b', 'c')
    await mkdir(sub, { recursive: true })
    expect(await findWorkspaceRoot(sub)).toBe(dir)
  })

  it('accepts package.json with workspaces field (npm/yarn/bun)', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
    )
    const sub = path.join(dir, 'packages')
    await mkdir(sub, { recursive: true })
    expect(await findWorkspaceRoot(sub)).toBe(dir)
  })

  // Every member has its own package.json, so stopping at the first one
  // makes a run from inside a package treat that package as the whole
  // workspace — `^task` edges vanish and the cache key loses its upstream
  // fold (stale hits). The declaring ancestor must win.
  describe('walking up from a workspace MEMBER', () => {
    async function member(rootManifest: string, memberDir: string): Promise<string> {
      await writeFile(path.join(dir, 'package.json'), rootManifest)
      const abs = path.join(dir, memberDir)
      await mkdir(abs, { recursive: true })
      await writeFile(path.join(abs, 'package.json'), '{"name":"m"}')
      return abs
    }

    it('resolves a member to the root that declares it', async () => {
      const abs = await member(
        JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
        'packages/a',
      )
      expect(await findWorkspaceRoot(abs)).toBe(dir)
    })

    it("resolves a member's subdirectory to the root", async () => {
      const abs = await member(
        JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
        'packages/a',
      )
      const deep = path.join(abs, 'src', 'nested')
      await mkdir(deep, { recursive: true })
      expect(await findWorkspaceRoot(deep)).toBe(dir)
    })

    it('resolves a member of a pnpm-workspace.yaml root', async () => {
      await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
      await writeFile(path.join(dir, 'package.json'), '{"name":"r"}')
      const abs = path.join(dir, 'packages', 'a')
      await mkdir(abs, { recursive: true })
      await writeFile(path.join(abs, 'package.json'), '{"name":"m"}')
      expect(await findWorkspaceRoot(abs)).toBe(dir)
    })

    it('resolves an explicitly listed nested member past its parent package', async () => {
      // This repo's own shape: `packages/cloud/ui` is a member listed by
      // literal path, nested inside `packages/cloud`, itself a member.
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'r', workspaces: ['packages/*', 'packages/cloud/ui'] }),
      )
      const cloud = path.join(dir, 'packages', 'cloud')
      const ui = path.join(cloud, 'ui')
      await mkdir(ui, { recursive: true })
      await writeFile(path.join(cloud, 'package.json'), '{"name":"cloud"}')
      await writeFile(path.join(ui, 'package.json'), '{"name":"ui"}')
      expect(await findWorkspaceRoot(ui)).toBe(dir)
    })

    it('prefers the NEAREST declaring ancestor (nested workspace)', async () => {
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'outer', workspaces: ['inner'] }),
      )
      const inner = path.join(dir, 'inner')
      const pkg = path.join(inner, 'pkgs', 'x')
      await mkdir(pkg, { recursive: true })
      await writeFile(
        path.join(inner, 'package.json'),
        JSON.stringify({ name: 'inner', workspaces: ['pkgs/*'] }),
      )
      await writeFile(path.join(pkg, 'package.json'), '{"name":"x"}')
      expect(await findWorkspaceRoot(pkg)).toBe(inner)
    })

    it('leaves a package no glob claims in single-project mode', async () => {
      const abs = await member(
        JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
        'examples/demo',
      )
      expect(await findWorkspaceRoot(abs)).toBe(abs)
    })
  })
})

describe('listProjects', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-list-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('skips packages without a name field', async () => {
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await mkdir(path.join(dir, 'packages/a'), { recursive: true })
    await writeFile(path.join(dir, 'packages/a/package.json'), '{}') // no name -> skipped
    await mkdir(path.join(dir, 'packages/b'), { recursive: true })
    await writeFile(path.join(dir, 'packages/b/package.json'), '{"name":"b"}')

    const ws = await loadWorkspace(dir)
    const projects = await listProjects(ws)
    expect(projects.map((p) => p.name)).toEqual(['b'])
  })

  // pnpm, npm, yarn and Bun all take `!packages/fixtures` in the list. Handed
  // to Bun.Glob raw, the `!` negated the WHOLE pattern — every manifest in
  // the tree matched, so the excluded package ran under --all and any
  // fixture repeating a name killed the run with "Duplicate package name".
  it('a negated package glob excludes, never inverts — pnpm, npm and glob spellings', async () => {
    for (const manifest of [
      {
        file: 'pnpm-workspace.yaml',
        body: 'packages:\n  - "packages/*"\n  - "!packages/legacy"\n',
      },
      {
        file: 'package.json',
        body: JSON.stringify({ name: 'root', workspaces: ['packages/*', '!packages/legacy/'] }),
      },
      {
        file: 'pnpm-workspace.yaml',
        body: 'packages:\n  - "packages/**"\n  - "!**/fixtures/**"\n  - "!packages/legacy"\n',
      },
      // spellings a matcher turned into nothing (2026-09-10): the negation
      // silently excluded nothing and `legacy` stayed a member
      {
        file: 'pnpm-workspace.yaml',
        body: 'packages:\n  - "./packages/*"\n  - "!./packages/legacy"\n  - "!**/fixtures/**"\n',
      },
      {
        file: 'package.json',
        body: JSON.stringify({
          name: 'root',
          workspaces: ['packages/*', '!packages//legacy', '!./packages/*/fixtures/**'],
        }),
      },
      {
        file: 'pnpm-workspace.yaml',
        body: 'packages:\n  - "packages/*"\n  - "!./packages/leg*"\n  - "!**/fixtures/**"\n',
      },
    ]) {
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, manifest.file), manifest.body)
      for (const [rel, name] of [
        ['packages/a', 'a'],
        ['packages/legacy', 'legacy'],
        ['packages/a/fixtures/demo', 'a'], // a fixture repeating a name: fatal if it were a member
        ['examples/demo', 'demo'],
      ] as const) {
        await mkdir(path.join(dir, rel), { recursive: true })
        await writeFile(path.join(dir, rel, 'package.json'), JSON.stringify({ name }))
      }
      const ws = await loadWorkspace(dir)
      const projects = await listProjects(ws)
      expect(projects.map((p) => p.name).sort()).toEqual(['a'])
    }
  })

  it('warns when a skipped package declares vx tasks (otherwise it vanishes silently)', async () => {
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await mkdir(path.join(dir, 'packages/noname'), { recursive: true })
    await writeFile(path.join(dir, 'packages/noname/package.json'), '{"version":"0.0.0"}')
    await writeFile(path.join(dir, 'packages/noname/vx.config.mjs'), 'export default { tasks: {} }')
    await mkdir(path.join(dir, 'packages/quiet'), { recursive: true })
    await writeFile(path.join(dir, 'packages/quiet/package.json'), '{}')

    let stderr = ''
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    try {
      const projects = await listProjects(await loadWorkspace(dir))
      expect(projects).toEqual([])
    } finally {
      spy.mockRestore()
    }
    expect(stderr).toContain('packages/noname')
    expect(stderr).toContain('name')
    // A nameless manifest with no vx config contributes nothing to a run —
    // warning about it would be noise.
    expect(stderr).not.toContain('packages/quiet')
  })

  it('resolves the config file by CONFIG_FILENAMES precedence, skipping non-files', async () => {
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    // ts wins over mjs when both exist.
    await mkdir(path.join(dir, 'packages/both'), { recursive: true })
    await writeFile(path.join(dir, 'packages/both/package.json'), '{"name":"both"}')
    await writeFile(path.join(dir, 'packages/both/vx.config.ts'), 'export default {}')
    await writeFile(path.join(dir, 'packages/both/vx.config.mjs'), 'export default {}')
    // A DIRECTORY under the first name is not a config; the next name is.
    await mkdir(path.join(dir, 'packages/dirnamed/vx.config.ts'), { recursive: true })
    await writeFile(path.join(dir, 'packages/dirnamed/package.json'), '{"name":"dirnamed"}')
    await writeFile(path.join(dir, 'packages/dirnamed/vx.config.mjs'), 'export default {}')
    // A symlink to a file counts; a dangling one does not.
    await mkdir(path.join(dir, 'packages/linked'), { recursive: true })
    await writeFile(path.join(dir, 'packages/linked/package.json'), '{"name":"linked"}')
    await writeFile(path.join(dir, 'shared.config.ts'), 'export default {}')
    await symlink(
      path.join(dir, 'shared.config.ts'),
      path.join(dir, 'packages/linked/vx.config.ts'),
    )
    await mkdir(path.join(dir, 'packages/dangling'), { recursive: true })
    await writeFile(path.join(dir, 'packages/dangling/package.json'), '{"name":"dangling"}')
    await symlink(path.join(dir, 'missing.ts'), path.join(dir, 'packages/dangling/vx.config.ts'))
    await writeFile(path.join(dir, 'packages/dangling/vx.config.js'), 'export default {}')
    // No config at all.
    await mkdir(path.join(dir, 'packages/none'), { recursive: true })
    await writeFile(path.join(dir, 'packages/none/package.json'), '{"name":"none"}')

    const ws = await loadWorkspace(dir)
    const projects = await listProjects(ws)
    const byName = new Map(
      projects.map((p) => [p.name, p.configPath && path.relative(dir, p.configPath)]),
    )
    expect(byName.get('both')).toBe('packages/both/vx.config.ts')
    expect(byName.get('dirnamed')).toBe('packages/dirnamed/vx.config.mjs')
    expect(byName.get('linked')).toBe('packages/linked/vx.config.ts')
    expect(byName.get('dangling')).toBe('packages/dangling/vx.config.js')
    expect(byName.get('none')).toBeNull()
  })

  it('handles an empty pnpm-workspace.yaml gracefully', async () => {
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), '\n')
    const ws = await loadWorkspace(dir)
    expect(ws.packageGlobs).toEqual([])
    const projects = await listProjects(ws)
    expect(projects).toEqual([])
  })
})

// A workspace manifest is user input. Malformed ones used to surface as
// `Failed to parse JSON` with no filename — useless in a 1000-package
// monorepo — or as raw internals (`packageGlobs.map is not a function`).
describe('malformed workspace manifests', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-ws-bad-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('names the root package.json that failed to parse', async () => {
    await writeFile(path.join(dir, 'package.json'), '{"name":"r",}')
    await expect(loadWorkspace(dir)).rejects.toThrow(/failed to parse .*package\.json/)
  })

  it('names the MEMBER package.json that failed to parse', async () => {
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await mkdir(path.join(dir, 'packages/broken'), { recursive: true })
    await writeFile(path.join(dir, 'packages/broken/package.json'), '{ not json')
    const ws = await loadWorkspace(dir)
    await expect(listProjects(ws)).rejects.toThrow(
      /failed to parse .*packages\/broken\/package\.json/,
    )
  })

  it('rejects a pnpm `packages:` string instead of a list', async () => {
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages: "packages/*"\n')
    await expect(loadWorkspace(dir)).rejects.toThrow(/`packages` must be an array of glob strings/)
  })

  it('rejects a non-string entry in package.json workspaces', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: [42, 'packages/*'] }),
    )
    await expect(loadWorkspace(dir)).rejects.toThrow(
      /`workspaces` must be an array of glob strings/,
    )
  })

  it('rejects a non-list workspaces.packages', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: { packages: 'packages/*' } }),
    )
    await expect(loadWorkspace(dir)).rejects.toThrow(
      /`workspaces\.packages` must be an array of glob strings/,
    )
  })

  it('still accepts every well-formed manifest shape', async () => {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'r' }))
    expect((await loadWorkspace(dir)).packageGlobs).toEqual(['.'])

    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    )
    expect((await loadWorkspace(dir)).packageGlobs).toEqual(['packages/*'])

    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: { packages: ['apps/*'] } }),
    )
    expect((await loadWorkspace(dir)).packageGlobs).toEqual(['apps/*'])
  })
})
