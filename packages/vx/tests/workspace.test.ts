import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import {
  findWorkspaceRoot,
  listProjects,
  loadWorkspace,
  memberBaseDirs,
} from '../src/workspace/workspace.js'
import { applyFilters, parseFilter } from '../src/workspace/filter.js'
import { buildPackageGraph } from '../src/workspace/package-graph.js'
import { run } from '../src/orchestrator/index.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

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

    it('an UNPARSEABLE root manifest is still the root', async () => {
      // A broken `package.json` is a root SIGNAL even though it can claim
      // no members: walking past it would find some ancestor — or nothing
      // — and report that instead of the parse error the user has to fix.
      // `loadWorkspace` is where the message comes from, and it only gets
      // to speak if this dir is the one chosen.
      await writeFile(path.join(dir, 'package.json'), '{ this is not json')
      const sub = path.join(dir, 'packages', 'a')
      await mkdir(sub, { recursive: true })
      expect(await findWorkspaceRoot(sub)).toBe(dir)
      await expect(loadWorkspace(dir)).rejects.toThrow(/package\.json/)
    })

    it('a member EXCLUDED by a negated glob does not claim its root', async () => {
      // The negations subtract from the ROOT WALK too, not only from the
      // project list. `packages/fx` matches `packages/*` and is then
      // excluded, so it is not a member — and a command run inside it
      // belongs to the nearest signal it does have (its own manifest),
      // not to a root that disowned it.
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*', '!packages/fx'] }),
      )
      const fx = path.join(dir, 'packages', 'fx')
      await mkdir(path.join(fx, 'inner'), { recursive: true })
      // A plain manifest: a root SIGNAL (single-project mode) that claims
      // nothing below it, so only the outer root's globs can decide.
      await writeFile(path.join(fx, 'package.json'), JSON.stringify({ name: 'fx' }))
      expect(await findWorkspaceRoot(path.join(fx, 'inner'))).toBe(fx)
      // CONTROL: the same layout WITHOUT the negation resolves to the root,
      // because `packages/*` claims it.
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
      )
      expect(await findWorkspaceRoot(path.join(fx, 'inner'))).toBe(dir)
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

  // The row above is the SILENT half, and it is silent on purpose: a
  // nameless manifest that declares no tasks is nothing to say anything
  // about. A nameless manifest WITH a vx config is the other half — it
  // was meant to run, vx identifies projects by name, so it simply
  // vanishes, and this line is the only trace it ever existed.
  // Silencing it broke nothing in the repo (item 458).
  it('a nameless package that HAS a vx config is skipped loudly, naming the directory', async () => {
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await mkdir(path.join(dir, 'packages/ghost'), { recursive: true })
    await writeFile(path.join(dir, 'packages/ghost/package.json'), '{}')
    await writeFile(
      path.join(dir, 'packages/ghost/vx.config.mjs'),
      'export default { tasks: {} }\n',
    )
    await mkdir(path.join(dir, 'packages/quiet'), { recursive: true })
    await writeFile(path.join(dir, 'packages/quiet/package.json'), '{}')

    const written: string[] = []
    const real = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown): boolean => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    let projects: Awaited<ReturnType<typeof listProjects>>
    try {
      projects = await listProjects(await loadWorkspace(dir))
    } finally {
      process.stderr.write = real
    }

    expect(projects.map((p) => p.name)).toEqual([])
    const notices = written.filter((w) => w.includes('has a vx config'))
    expect(notices).toHaveLength(1)
    // It must name WHICH directory, or the user cannot find it.
    expect(notices[0]).toContain('packages/ghost')
    // CONTROL: the config-less one stays silent, which is the distinction
    // the warning exists to draw.
    expect(notices[0]).not.toContain('quiet')
  })

  // `{"name": ""}` is the other spelling of a nameless manifest: a check on
  // `name === undefined` would admit it as a project named "" that nothing
  // can address, and say nothing.
  it('an EMPTY-string name with a vx config gets the same warning as a missing one', async () => {
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await mkdir(path.join(dir, 'packages/blank'), { recursive: true })
    await writeFile(path.join(dir, 'packages/blank/package.json'), '{"name": ""}')
    await writeFile(
      path.join(dir, 'packages/blank/vx.config.mjs'),
      'export default { tasks: {} }\n',
    )

    const written: string[] = []
    const real = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown): boolean => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    let projects: Awaited<ReturnType<typeof listProjects>>
    try {
      projects = await listProjects(await loadWorkspace(dir))
    } finally {
      process.stderr.write = real
    }

    expect(projects.map((p) => p.name)).toEqual([])
    expect(written).toEqual([
      'vx: packages/blank has a vx config but its package.json has no "name" — skipped\n',
    ])
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

  it('a member glob keeps npm/pnpm semantics: a bracket is a class there (item 667)', async () => {
    // Task globs read `[` literally; a package manager's member list does not,
    // and vx must find the members the package manager installs.
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'r',
        private: true,
        // …and `\[` is how a member list names a literal bracket.
        workspaces: ['packages/*', '!packages/[ab]', '!packages/\\[x\\]'],
      }),
    )
    for (const [rel, name] of [
      ['a', 'a'],
      ['b', 'b'],
      ['c', 'c'],
      ['x', 'x'],
      ['[x]', 'bracket-x'],
    ] as const) {
      await mkdir(path.join(dir, 'packages', rel), { recursive: true })
      await writeFile(path.join(dir, 'packages', rel, 'package.json'), JSON.stringify({ name }))
    }
    const projects = await listProjects(await loadWorkspace(dir))
    expect(projects.map((p) => p.name)).toEqual(['c', 'x'])
  })

  it('a negation covers everything UNDER it, not just the exact path', async () => {
    // `!packages/fixtures` means the tree, the way every package manager
    // reads it — a fixture nested one level deeper is still excluded.
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'r', private: true, workspaces: ['packages/**', '!packages/fx'] }),
    )
    for (const rel of ['packages/app', 'packages/fx', 'packages/fx/deep']) {
      await mkdir(path.join(dir, rel), { recursive: true })
      await writeFile(
        path.join(dir, rel, 'package.json'),
        JSON.stringify({ name: rel.replaceAll('/', '-') }),
      )
    }
    const names = (await listProjects(await loadWorkspace(dir))).map((p) => p.name)
    expect(names).toEqual(['packages-app'])
  })

  it('a bare `!` excludes nothing — least of all the root project', async () => {
    // An empty negation has no tree to subtract, and the root's own
    // relative path is the empty string: matching it against `''` would
    // delete the single-project workspace's only project.
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'root-pkg', private: true, workspaces: ['.', '!'] }),
    )
    const names = (await listProjects(await loadWorkspace(dir))).map((p) => p.name)
    expect(names).toEqual(['root-pkg'])
  })

  it('a matched directory with NO package.json is not a project', async () => {
    // The glob matches directories; the manifest read is what decides
    // membership, and its ENOENT is the "not a member" answer.
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
    )
    await mkdir(path.join(dir, 'packages', 'real'), { recursive: true })
    await writeFile(
      path.join(dir, 'packages', 'real', 'package.json'),
      JSON.stringify({ name: 'real' }),
    )
    await mkdir(path.join(dir, 'packages', 'empty'), { recursive: true })
    const names = (await listProjects(await loadWorkspace(dir))).map((p) => p.name)
    expect(names).toEqual(['real'])
  })

  it('sorts by CODE UNIT, not by locale — the order is the same on every machine', async () => {
    // ICU collation cost 28 ms of a 300 ms warm run at 1000 projects, and
    // the two orders genuinely differ: `localeCompare` puts `apple` before
    // `Zed`, code units put `Zed` first. Every consumer reads this order,
    // so it has to be the machine-independent one.
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
    )
    for (const name of ['apple', 'Zed', 'beta']) {
      await mkdir(path.join(dir, 'packages', name.toLowerCase()), { recursive: true })
      await writeFile(
        path.join(dir, 'packages', name.toLowerCase(), 'package.json'),
        JSON.stringify({ name }),
      )
    }
    const names = (await listProjects(await loadWorkspace(dir))).map((p) => p.name)
    expect(names).toEqual(['Zed', 'apple', 'beta'])
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

describe('memberBaseDirs', () => {
  // The directories `vx watch` arms so a package APPEARING or disappearing
  // is heard as one directory entry, with no walk. Only the `<dir>/*`
  // shape has such a directory; anything else (`apps/**`, a brace, a
  // negation) names a tree, and arming its prefix would watch a directory
  // that is not a member base — or, for `apps/**/*`, a directory literally
  // named `**`, which exists nowhere.
  const ws = (globs: string[]) => ({ root: '/ws', packageGlobs: globs })

  it('takes the `<dir>/*` shape and nothing else', () => {
    expect(memberBaseDirs(ws(['packages/*']))).toEqual([path.resolve('/ws', 'packages')])
    expect(memberBaseDirs(ws(['packages/*', 'apps/*']))).toEqual([
      path.resolve('/ws', 'packages'),
      path.resolve('/ws', 'apps'),
    ])
  })

  it('contributes nothing for a glob that names a TREE', () => {
    expect(memberBaseDirs(ws(['apps/**']))).toEqual([])
    expect(memberBaseDirs(ws(['apps/**/*']))).toEqual([])
    expect(memberBaseDirs(ws(['packages/{a,b}/*']))).toEqual([])
    expect(memberBaseDirs(ws(['.']))).toEqual([])
  })

  it('a negated glob arms nothing', () => {
    expect(memberBaseDirs(ws(['!packages/*']))).toEqual([])
    // …and does not disturb the positive one beside it.
    expect(memberBaseDirs(ws(['packages/*', '!packages/fx']))).toEqual([
      path.resolve('/ws', 'packages'),
    ])
  })
})

// A directory name holding glob metacharacters is still a literal directory
// to the key and the cache: git's pathspec match tries the literal path
// first, and outputs are scanned from inside the project dir, so `[abc]` is
// never read as a character class that also matches the sibling
// `packages/a`. The path FILTER keeps `Bun.Glob`'s alphabet, but a path that
// names a project directory is that directory first (item 664), so
// `./packages/[abc]` selects it; only a bracket path naming no directory is
// read as a glob. (A bracket INSIDE a task glob is literal: item 667.)
describe('a project directory named packages/[abc]', () => {
  let root: string
  const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-ws-brackets-' })
    const dir = await addProject(root, 'br', {
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'cat src/in.txt > out.txt' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
            },
          },
        }
      `,
      files: { 'src/in.txt': 'v1' },
    })
    await rename(dir, path.join(root, 'packages', '[abc]'))
    await addProject(root, 'a', { files: { 'src/in.txt': 'a1' } })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('its inputs key the task, its outputs restore, and a sibling matching the class changes nothing', async () => {
    const out = path.join(root, 'packages', '[abc]', 'out.txt')
    const statuses = async (): Promise<string[]> =>
      (await run({ cwd: root, tasks: ['build'], projects: ['br'], log: quiet })).outcomes.map(
        (o) => `${o.node.id} ${o.status}`,
      )

    expect(await statuses()).toEqual(['br#build success'])
    await rm(out)
    expect(await statuses()).toEqual(['br#build cache-hit'])
    expect(await readFile(out, 'utf8')).toBe('v1')

    await writeFile(path.join(root, 'packages', 'a', 'src', 'in.txt'), 'a2')
    expect(await statuses()).toEqual(['br#build cache-hit'])

    await writeFile(path.join(root, 'packages', '[abc]', 'src', 'in.txt'), 'v2')
    expect(await statuses()).toEqual(['br#build success'])
    expect(await readFile(out, 'utf8')).toBe('v2')
  }, 30_000)

  it('a path filter with the brackets escaped selects it, and only it', async () => {
    const projects = await listProjects(await loadWorkspace(root))
    const graph = buildPackageGraph(projects)
    const select = (f: string): string[] =>
      [...applyFilters({ filters: [parseFilter(f, root)], projects, graph })].sort()
    expect(select('./packages/\\[abc\\]')).toEqual(['br'])
    expect(select('./packages')).toEqual(['a', 'br'])
  })

  // A path that names a project directory literally is that directory, as
  // git reads a pathspec (item 664; before it the form compiled as a glob and
  // selected the sibling the class matches).
  it('the unescaped `./packages/[abc]` selects the directory it names, not the sibling `a`', async () => {
    const projects = await listProjects(await loadWorkspace(root))
    const graph = buildPackageGraph(projects)
    const select = (f: string): string[] =>
      [...applyFilters({ filters: [parseFilter(f, root)], projects, graph })].sort()
    expect(select('./packages/[abc]')).toEqual(['br'])
    expect(select('{packages/[abc]}')).toEqual(['br'])
    // CONTROL: a bracket path that names no directory is still a glob.
    expect(select('./packages/[ab]')).toEqual(['a'])
  })
})
