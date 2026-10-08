import * as fsp from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from 'bun:test'
import {
  findWorkspaceRoot,
  listProjects,
  loadWorkspace,
  memberBaseDirs,
  unreachedHint,
  unreachedPackages,
} from '../src/workspace/workspace.js'
import { applyFilters, parseFilter } from '../src/workspace/filter.js'
import { relPosix, UserError } from '../src/util/index.js'
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
    const said = await findWorkspaceRoot(dir).then(
      () => '',
      (err: Error) => err.message,
    )
    // The whole line, next step included (M-56): it named what was missing
    // and not what to do.
    expect(said).toBe(
      `Could not find a workspace root in any parent of ${dir} (looked for pnpm-workspace.yaml or package.json): run vx inside a project, or create a package.json (\`bun init\` or \`npm init -y\`) and run \`vx init\``,
    )
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

    it('a package under a matched directory with no manifest is not claimed (item 989)', async () => {
      // `packages/*` matches `packages/tools`, which holds no package.json;
      // the standalone package below it is no member, so its own directory
      // is the root, as npm has it. The claim counted the matched directory
      // and the standalone package ran in a workspace that does not list it.
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
      )
      const standalone = path.join(dir, 'packages', 'tools', 'standalone')
      await mkdir(standalone, { recursive: true })
      await writeFile(path.join(standalone, 'package.json'), '{"name":"standalone"}')
      expect(await findWorkspaceRoot(standalone)).toBe(standalone)
      // Control: a member's own subdirectory, manifest-less, still resolves up.
      const deep = path.join(dir, 'packages', 'a', 'src')
      await mkdir(deep, { recursive: true })
      await writeFile(path.join(dir, 'packages', 'a', 'package.json'), '{"name":"a"}')
      expect(await findWorkspaceRoot(deep)).toBe(dir)
    })

    it('a package discovery skips (dot-dir, node_modules) is not claimed', async () => {
      // `packages/*` matched `packages/.tpl` in the claim while discovery
      // skips dot-dirs and node_modules, so `vx run` there said "not inside
      // a project" instead of running it as its own root.
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'r', workspaces: ['packages/*', 'apps/**', '.config/*'] }),
      )
      const skipped = ['packages/.tpl', 'apps/a/.cache/x', 'apps/a/node_modules/x']
      const members = ['packages/b', 'apps/a', '.config/c']
      for (const rel of [...skipped, ...members]) {
        await mkdir(path.join(dir, rel), { recursive: true })
        await writeFile(path.join(dir, rel, 'package.json'), JSON.stringify({ name: rel }))
      }
      const listed = (await listProjects(await loadWorkspace(dir))).map((p) => p.name)
      expect(listed.sort()).toEqual([...members].sort())
      const roots: string[] = []
      for (const rel of [...skipped, ...members]) {
        roots.push(relPosix(dir, await findWorkspaceRoot(path.join(dir, rel))))
      }
      expect(roots).toEqual([...skipped, '', '', ''])
    })

    it('the nearest pnpm-workspace.yaml is the root, from any depth (item 990)', async () => {
      // pnpm takes the nearest workspace file. From `apps/inner` itself the
      // walk went past its own file to the outer workspace listing it,
      // while from `apps/inner/pkgs/x` it stopped at the inner one.
      await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n')
      await writeFile(path.join(dir, 'package.json'), '{"name":"outer"}')
      const inner = path.join(dir, 'apps', 'inner')
      const x = path.join(inner, 'pkgs', 'x')
      await mkdir(x, { recursive: true })
      await writeFile(path.join(inner, 'pnpm-workspace.yaml'), 'packages:\n  - "pkgs/*"\n')
      await writeFile(path.join(inner, 'package.json'), '{"name":"inner"}')
      await writeFile(path.join(x, 'package.json'), '{"name":"x"}')
      expect([await findWorkspaceRoot(inner), await findWorkspaceRoot(x)]).toEqual([inner, inner])
      // Control: an outer member without a workspace file of its own.
      const web = path.join(dir, 'apps', 'web')
      await mkdir(web, { recursive: true })
      await writeFile(path.join(web, 'package.json'), '{"name":"web"}')
      expect(await findWorkspaceRoot(web)).toBe(dir)
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

  // vuejs/core's root has no name; its warning named an empty path.
  it('a nameless root with a vx config is named as the workspace root', async () => {
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(dir, 'package.json'), '{"private": true}')
    await writeFile(path.join(dir, 'vx.config.mjs'), 'export default { tasks: {} }\n')
    const written: string[] = []
    const real = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown): boolean => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      await listProjects(await loadWorkspace(dir))
    } finally {
      process.stderr.write = real
    }
    expect(written).toEqual([
      'vx: the workspace root has a vx config but its package.json has no "name" — skipped\n',
    ])
  })

  // vite's playground (eight names, two manifests each) refused the whole
  // workspace; pnpm runs it.
  it('a name several manifests share is left out with one line, unless one has a vx config', async () => {
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    for (const [d, name] of [
      ['a', 'dup'],
      ['b', 'dup'],
      ['c', 'twin'],
      ['d', 'twin'],
      ['e', 'twin'],
      ['f', 'pair'],
      ['g', 'pair'],
      ['h', 'kept'],
    ]) {
      await mkdir(path.join(dir, 'packages', d!), { recursive: true })
      await writeFile(path.join(dir, 'packages', d!, 'package.json'), JSON.stringify({ name }))
    }
    const list = async () => {
      const written: string[] = []
      const real = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: unknown): boolean => {
        written.push(String(chunk))
        return true
      }) as typeof process.stderr.write
      try {
        const names = (await listProjects(await loadWorkspace(dir))).map((p) => p.name)
        return { names, written }
      } finally {
        process.stderr.write = real
      }
    }
    expect(await list()).toEqual({
      names: ['kept'],
      written: [
        'vx: left out, as no project can be addressed by a name several manifests share (none has a vx config): dup (packages/a, packages/b); pair (packages/f, packages/g); and 1 more\n',
      ],
    })
    await writeFile(path.join(dir, 'packages/e/vx.config.mjs'), 'export default { tasks: {} }\n')
    const err = await list().then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(UserError)
    expect((err as Error).message).toBe(
      'Duplicate package name "twin" in workspace: packages/c and packages/d and packages/e; vx names a project by its package name — rename one, or leave one out with a `!` pattern in the workspace globs',
    )
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

  it('a literal negation excludes its directory, not a sibling that shares its prefix (D-19)', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*', '!packages/a'] }),
    )
    for (const name of ['a', 'ab']) {
      await mkdir(path.join(dir, 'packages', name), { recursive: true })
      await writeFile(path.join(dir, 'packages', name, 'package.json'), JSON.stringify({ name }))
    }
    const projects = await listProjects(await loadWorkspace(dir))
    expect(projects.map((p) => p.name)).toEqual(['ab'])
  })

  it('`packages/*` passes over a dot directory and node_modules, as the package managers do (D-19)', async () => {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    )
    for (const [rel, name] of [
      ['packages/a', 'a'],
      ['packages/.cache', 'cache'],
      ['packages/node_modules', 'dep'],
    ] as const) {
      await mkdir(path.join(dir, rel), { recursive: true })
      await writeFile(path.join(dir, rel, 'package.json'), JSON.stringify({ name }))
    }
    const projects = await listProjects(await loadWorkspace(dir))
    expect(projects.map((p) => p.name)).toEqual(['a'])
  })

  it('a deep glob never reaches into node_modules, nested or at the root (D-19)', async () => {
    // pnpm installs each package's dependencies in its own node_modules,
    // right where `packages/**` looks; `**` reaches the root's.
    for (const [globs, want] of [
      [['packages/**'], ['a']],
      [['**'], ['a', 'r']],
    ] as const) {
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'r', workspaces: globs }),
      )
      for (const [rel, name] of [
        ['packages/a', 'a'],
        ['packages/a/node_modules/dep', 'dep'],
        ['node_modules/top', 'top'],
      ] as const) {
        await mkdir(path.join(dir, rel), { recursive: true })
        await writeFile(path.join(dir, rel, 'package.json'), JSON.stringify({ name }))
      }
      const projects = await listProjects(await loadWorkspace(dir))
      expect(projects.map((p) => p.name)).toEqual([...want])
    }
  })

  it("a single-package repo's installed dependencies are not unreached members (D-19)", async () => {
    // The hint names the package.json files a root with no `workspaces`
    // leaves out; node_modules holds the repo's dependencies, not those.
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'r' }))
    for (const rel of ['node_modules/dep', 'node_modules/@s/dep', 'tools/gen']) {
      await mkdir(path.join(dir, rel), { recursive: true })
      await writeFile(path.join(dir, rel, 'package.json'), JSON.stringify({ name: rel }))
    }
    expect(await unreachedPackages(await loadWorkspace(dir))).toEqual(['tools/gen'])
    // Past three, the hint counts the rest.
    expect(unreachedHint(['a', 'b', 'c', 'd'])).toContain('not: a, b, c and 1 more.')
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

  it('an extglob member pattern is refused by name, not widened (turborepo#3766)', async () => {
    // npm (minimatch) and yarn (micromatch) read `packages/!(x)` as "every
    // directory in packages/ but x". Bun.Glob has no extglob: its scan read
    // the segment as a wildcard and x became a project, while its match read
    // it literally. vx cannot honour the pattern, so it says so and names
    // the spelling it does read.
    for (const rel of ['a', 'x']) {
      await mkdir(path.join(dir, 'packages', rel), { recursive: true })
      await writeFile(
        path.join(dir, 'packages', rel, 'package.json'),
        JSON.stringify({ name: rel }),
      )
    }
    const pkg = path.join(dir, 'package.json')
    const refusal = async (pattern: string): Promise<string> => {
      await writeFile(pkg, JSON.stringify({ name: 'r', private: true, workspaces: [pattern] }))
      return loadWorkspace(dir).then(
        () => 'loaded',
        (err: unknown) =>
          err instanceof UserError ? err.message : `not a UserError: ${String(err)}`,
      )
    }
    expect(await refusal('packages/!(x)')).toBe(
      `${pkg}: \`workspaces\` entry "packages/!(x)" is an extglob, which vx's glob engine does ` +
        'not read (npm and yarn read `!(…)` as an exclusion). List the exclusion as its own ' +
        'entry: ["packages/*", "!packages/x"].',
    )
    expect(await refusal('packages/!(x|y)')).toContain(
      'entry: ["packages/*", "!packages/x", "!packages/y"].',
    )
    for (const pattern of ['packages/@(a|x)', 'packages/+(a)', 'packages/*(a)', 'packages/?(a)']) {
      expect(await refusal(pattern)).toBe(
        `${pkg}: \`workspaces\` entry "${pattern}" is an extglob, which vx's glob engine does ` +
          'not read. List the members with `*`, braces or `!` exclusions instead.',
      )
    }
    // CONTROL: the spelling the refusal names is read, and excludes x.
    await writeFile(
      pkg,
      JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*', '!packages/x'] }),
    )
    expect((await listProjects(await loadWorkspace(dir))).map((p) => p.name)).toEqual(['a'])
    // CONTROL: a parenthesis that is no extglob is a name.
    expect(await refusal('packages/(a)')).toBe('loaded')
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

  it('a brace whose alternatives hold a slash lists every member (D-2)', async () => {
    // `Bun.Glob`'s scan finds nothing for such a brace, though its match
    // reads it: both packages vanished from every verb.
    for (const rel of ['packages/a', 'packages/nested/b', 'apps/x', 'apps/y', 'tools/z']) {
      await mkdir(path.join(dir, rel), { recursive: true })
      await writeFile(
        path.join(dir, rel, 'package.json'),
        JSON.stringify({ name: path.basename(rel) }),
      )
    }
    const names = async (workspaces: string[]) => {
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'r', workspaces }))
      return (await listProjects(await loadWorkspace(dir))).map((p) => p.name)
    }
    // Control: a slash-free brace, which the glob expands itself.
    expect(await names(['apps/{x,y}'])).toEqual(['x', 'y'])
    expect(await names(['packages/{a,nested/b}'])).toEqual(['a', 'b'])
    expect(await names(['{packages/{a,nested/b},apps/*}', '!apps/y'])).toEqual(['a', 'b', 'x'])
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

  // nx#19981: a workspace whose globs are all negations threw.
  it('globs that are only negations list no project and do not throw', async () => {
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "!schematics"\n')
    await mkdir(path.join(dir, 'schematics'), { recursive: true })
    await writeFile(path.join(dir, 'schematics', 'package.json'), '{"name":"schematics"}')
    expect(await listProjects(await loadWorkspace(dir))).toEqual([])
  })

  // nx#15625: a project directory named with underscores (`__generated__`)
  // was skipped by the project scan.
  it('a directory named `__generated__` or `_generated` is a project like any other', async () => {
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "libs/*"\n')
    for (const d of ['__generated__', '_generated', 'plain']) {
      await mkdir(path.join(dir, 'libs', d), { recursive: true })
      await writeFile(path.join(dir, 'libs', d, 'package.json'), JSON.stringify({ name: `n${d}` }))
    }
    const listed = (await listProjects(await loadWorkspace(dir))).map((p) => [
      p.name,
      path.relative(dir, p.dir),
    ])
    expect(listed).toEqual([
      ['n__generated__', 'libs/__generated__'],
      ['n_generated', 'libs/_generated'],
      ['nplain', 'libs/plain'],
    ])
  })

  // turborepo#2517: a package directory that is a symlink (a submodule
  // checked out elsewhere) was not discovered.
  it('a member directory that is a symlink to a package outside the glob is discovered', async () => {
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "widgets/*"\n')
    await mkdir(path.join(dir, 'submodules', 'widget-a'), { recursive: true })
    await writeFile(path.join(dir, 'submodules', 'widget-a', 'package.json'), '{"name":"widget-a"}')
    await mkdir(path.join(dir, 'widgets'), { recursive: true })
    await symlink('../submodules/widget-a', path.join(dir, 'widgets', 'widget-a'))
    const listed = (await listProjects(await loadWorkspace(dir))).map((p) => [
      p.name,
      path.relative(dir, p.dir),
    ])
    expect(listed).toEqual([['widget-a', 'widgets/widget-a']])
  })

  it('a symlinked member is found whatever the glob spelling (item 987)', async () => {
    // The readdir path for `widgets/*` followed the link; the glob scan
    // every other spelling takes did not.
    await mkdir(path.join(dir, 'submodules', 'widget-a'), { recursive: true })
    await writeFile(path.join(dir, 'submodules', 'widget-a', 'package.json'), '{"name":"widget-a"}')
    await mkdir(path.join(dir, 'widgets', 'plain'), { recursive: true })
    await writeFile(path.join(dir, 'widgets', 'plain', 'package.json'), '{"name":"plain"}')
    await symlink('../submodules/widget-a', path.join(dir, 'widgets', 'widget-a'))
    for (const glob of ['widgets/*', 'widgets/{plain,widget-a}', 'widg*/*', 'widgets/*/']) {
      await writeFile(path.join(dir, 'pnpm-workspace.yaml'), `packages:\n  - "${glob}"\n`)
      const names = (await listProjects(await loadWorkspace(dir))).map((p) => p.name).sort()
      expect({ glob, names }).toEqual({ glob, names: ['plain', 'widget-a'] })
    }
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

  it('a pnpm-workspace.yaml with no packages list defers to package.json (item 984)', async () => {
    // pnpm 10 keeps settings and catalogs in this file for a single-package
    // repo too. Read as an empty package list, the root found no project,
    // and `vx show` printed nothing and exited 0.
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'onlyBuiltDependencies:\n  - esbuild\n')
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
    const single = await listProjects(await loadWorkspace(dir))
    expect(single.map((p) => [p.name, p.dir])).toEqual([['app', dir]])

    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    )
    await mkdir(path.join(dir, 'packages/a'), { recursive: true })
    await writeFile(path.join(dir, 'packages/a/package.json'), JSON.stringify({ name: 'a' }))
    const members = await listProjects(await loadWorkspace(dir))
    expect(members.map((p) => p.name)).toEqual(['a'])
  })

  it('a trailing slash on a member glob does not make it recursive (item 985)', async () => {
    for (const [file, body] of [
      ['package.json', JSON.stringify({ name: 'r', workspaces: ['packages/*/'] })],
      ['pnpm-workspace.yaml', 'packages:\n  - "packages/*/"\n'],
    ] as const) {
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'r' }))
      await writeFile(path.join(dir, file), body)
      for (const [rel, name] of [
        ['packages/a', 'a'],
        ['packages/a/examples/demo', 'demo'],
        ['packages/b/test/fixtures/proj', 'fixture'],
      ] as const) {
        await mkdir(path.join(dir, rel), { recursive: true })
        await writeFile(path.join(dir, rel, 'package.json'), JSON.stringify({ name }))
      }
      const names = (await listProjects(await loadWorkspace(dir))).map((p) => p.name)
      expect({ file, names }).toEqual({ file, names: ['a'] })
    }
  })

  it("pnpm's `!**/test/**` excludes packages/test itself, as pnpm does (item 986)", async () => {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'r' }))
    await writeFile(
      path.join(dir, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/**"\n  - "!**/test/**"\n',
    )
    for (const [rel, name] of [
      ['packages/a', 'a'],
      ['packages/test', 't1'],
      ['packages/a/test/fx', 'fx'],
    ] as const) {
      await mkdir(path.join(dir, rel), { recursive: true })
      await writeFile(path.join(dir, rel, 'package.json'), JSON.stringify({ name }))
    }
    const names = (await listProjects(await loadWorkspace(dir))).map((p) => p.name)
    expect(names).toEqual(['a'])
  })

  it('refuses a package.json of the wrong shape by name (item 988)', async () => {
    const cases: Array<[string, string]> = [
      ['null', 'must be a JSON object'],
      ['[]', 'must be a JSON object'],
      ['{"name":123}', '"name" must be a string with no surrounding whitespace'],
      ['{"name":{"x":1}}', '"name" must be a string with no surrounding whitespace'],
      ['{"name":" a"}', '"name" must be a string with no surrounding whitespace'],
    ]
    const seen: string[] = []
    for (const [body] of cases) {
      // The root's own manifest, then a member's.
      await writeFile(path.join(dir, 'package.json'), body)
      seen.push(
        await loadWorkspace(dir).then(
          () => 'loaded',
          (e: Error) => e.message,
        ),
      )
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
      )
      await mkdir(path.join(dir, 'packages/m'), { recursive: true })
      await writeFile(path.join(dir, 'packages/m/package.json'), body)
      seen.push(
        await loadWorkspace(dir)
          .then((ws) => listProjects(ws))
          .then(
            () => 'loaded',
            (e: Error) => e.message,
          ),
      )
      await rm(path.join(dir, 'packages'), { recursive: true, force: true })
    }
    expect(seen).toEqual(
      cases.flatMap(([, why]) => [
        `${path.join(dir, 'package.json')}: ${why}`,
        `${path.join(dir, 'packages/m/package.json')}: ${why}`,
      ]),
    )
  })

  it('rejects a pnpm-workspace.yaml that is not a mapping (item 984)', async () => {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
    for (const body of ['- packages/*\n', '42\n']) {
      await writeFile(path.join(dir, 'pnpm-workspace.yaml'), body)
      await expect(loadWorkspace(dir)).rejects.toThrow(
        /pnpm-workspace\.yaml: must be a mapping \(`packages:` and pnpm's settings\)$/,
      )
    }
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

describe('loadWorkspace at a public boundary (D-58)', () => {
  // The CLI reaches it through findWorkspaceRoot, which never returns such a
  // directory; `loadWorkspace` is public API (src/index.ts), and a direct call
  // on a directory with neither manifest is refused, never loaded as nothing.
  it('refuses a root with neither pnpm-workspace.yaml nor package.json', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-ws-bare-'))
    try {
      const err = await loadWorkspace(dir).then(
        () => null,
        (e: unknown) => e as Error,
      )
      expect(err).toBeInstanceOf(UserError)
      expect(err?.message).toBe(
        `workspace root ${dir} has neither pnpm-workspace.yaml nor package.json`,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('discovery out of file descriptors (D-60)', () => {
  // Under a low `ulimit -n` every member read fails with EMFILE, and the
  // catches that mean "absent" read the workspace as empty: a run said "No
  // package matched the workspace's package globs" (lead from A). The spy is
  // restored after each row, so no other file sees it.
  const emfile = (): never => {
    throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
  }
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-emfile-' })
    await addProject(root, 'a', { config: 'export default { tasks: {} }\n' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const listed = async (): Promise<string> => {
    const ws = await loadWorkspace(root)
    return (await listProjects(ws)).map((p) => p.name).join(',')
  }

  // One read site each: the member glob's listing of `packages/`, and the
  // config lookup's listing of the member itself.
  // The config lookup lists the member on Linux and stats each config name
  // elsewhere (`findConfigFile`), so its row fails both: each platform
  // meets the one it takes (the stat path is the macOS job's).
  it.each([
    ['the member listing', (p: string) => p.endsWith(`${path.sep}packages`)],
    [
      'the config lookup',
      (p: string) =>
        p.endsWith(path.join('packages', 'a')) || path.basename(p).startsWith('vx.config.'),
    ],
  ])('fails %s, never lists an empty workspace', async (_site, hit) => {
    expect(await listed()).toBe('a')
    const realReaddir = fsp.readdir
    const realStat = fsp.stat
    const readdirSpy = spyOn(fsp, 'readdir').mockImplementation(((p: string, o: never) =>
      hit(String(p)) ? Promise.resolve().then(emfile) : realReaddir(p, o)) as never)
    const statSpy = spyOn(fsp, 'stat').mockImplementation(((p: string, o: never) =>
      hit(String(p)) ? Promise.resolve().then(emfile) : realStat(p, o)) as never)
    const err = await listed().then(
      () => null,
      (e: unknown) => e as NodeJS.ErrnoException,
    )
    readdirSpy.mockRestore()
    statSpy.mockRestore()
    expect(err?.code).toBe('EMFILE')
  })

  it("fails on a member's package.json read the same way", async () => {
    const real = Bun.file
    const spy = spyOn(Bun, 'file').mockImplementation(((p: string) =>
      p.endsWith('package.json') && p.includes('packages')
        ? { text: async () => emfile() }
        : real(p)) as never)
    const err = await listed().then(
      () => null,
      (e: unknown) => e as NodeJS.ErrnoException,
    )
    spy.mockRestore()
    expect(err?.code).toBe('EMFILE')
    // CONTROL: a directory that is not there is still absent, not a failure.
    await rm(path.join(root, 'packages', 'a'), { recursive: true, force: true })
    expect(await listed()).toBe('')
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
