import { describe, expect, it } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { planned } from './helpers/parity.js'
import { makeWorkspace } from './helpers/workspace.js'
import { applyFilters, parseFilter } from '../src/workspace/filter.js'
import { buildPackageGraph } from '../src/workspace/package-graph.js'
import type { ProjectMeta } from '../src/workspace/workspace.js'

const ROOT = '/ws'

function mkProject(name: string, dir: string, deps: string[] = []): ProjectMeta {
  return {
    name,
    dir,
    packageJson: {
      name,
      dependencies: Object.fromEntries(deps.map((d) => [d, 'workspace:*'])),
    },
    configPath: null,
  }
}

describe('parseFilter', () => {
  it('parses bare name as glob matcher', () => {
    const p = parseFilter('foo', ROOT)
    expect(p).toMatchObject({
      raw: 'foo',
      negate: false,
      withDeps: false,
      withDependents: false,
      onlyDeps: false,
      onlyDependents: false,
      isPath: false,
      matcher: 'foo',
    })
  })

  it('parses pattern... as withDeps', () => {
    const p = parseFilter('foo...', ROOT)
    expect(p.withDeps).toBe(true)
    expect(p.matcher).toBe('foo')
  })

  it('parses ...pattern as withDependents', () => {
    const p = parseFilter('...foo', ROOT)
    expect(p.withDependents).toBe(true)
    expect(p.matcher).toBe('foo')
  })

  it('parses pattern^... as onlyDeps', () => {
    const p = parseFilter('foo^...', ROOT)
    expect(p.onlyDeps).toBe(true)
    expect(p.withDeps).toBe(false)
    expect(p.matcher).toBe('foo')
  })

  it('parses ...^pattern as onlyDependents (item 890)', () => {
    const p = parseFilter('...^foo', ROOT)
    expect({ d: p.withDependents, o: p.onlyDependents, m: p.matcher }).toEqual({
      d: true,
      o: true,
      m: 'foo',
    })
  })

  it('parses !pattern as negate', () => {
    const p = parseFilter('!foo', ROOT)
    expect(p.negate).toBe(true)
    expect(p.matcher).toBe('foo')
  })

  it('combines negate + suffix forms', () => {
    const p = parseFilter('!foo...', ROOT)
    expect(p.negate).toBe(true)
    expect(p.withDeps).toBe(true)
    expect(p.matcher).toBe('foo')
  })

  it('parses ./<dir> as path', () => {
    const p = parseFilter('./packages/foo', ROOT)
    expect(p.isPath).toBe(true)
    expect(p.matcher).toBe(path.resolve(ROOT, './packages/foo'))
  })

  it('parses {<dir>} as path', () => {
    const p = parseFilter('{packages/foo}', ROOT)
    expect(p.isPath).toBe(true)
    expect(p.matcher).toBe(path.resolve(ROOT, 'packages/foo'))
  })

  it('preserves scoped glob names', () => {
    const p = parseFilter('@scope/*', ROOT)
    expect(p.isPath).toBe(false)
    expect(p.matcher).toBe('@scope/*')
  })

  it('parses [<since>] as a git-relative selector', () => {
    const p = parseFilter('[main]', ROOT)
    expect(p.gitSince).toBe('main')
    expect(p.isPath).toBe(false)
    expect(p.withDeps).toBe(false)
  })

  it('parses [<since>]... as gitSince + withDeps', () => {
    const p = parseFilter('[main]...', ROOT)
    expect(p.gitSince).toBe('main')
    expect(p.withDeps).toBe(true)
  })

  it('parses ![<since>] as negated gitSince', () => {
    const p = parseFilter('![origin/main]', ROOT)
    expect(p.gitSince).toBe('origin/main')
    expect(p.negate).toBe(true)
  })
})

describe('applyFilters', () => {
  // Graph:  app -> ui -> utils
  //         lib (standalone)
  const projects = [
    mkProject('app', `${ROOT}/packages/app`, ['ui']),
    mkProject('ui', `${ROOT}/packages/ui`, ['utils']),
    mkProject('utils', `${ROOT}/packages/utils`),
    mkProject('lib', `${ROOT}/packages/lib`),
  ]
  const graph = buildPackageGraph(projects)

  it('exact name match', () => {
    const filters = [parseFilter('ui', ROOT)]
    expect([...applyFilters({ filters, projects, graph })].sort()).toEqual(['ui'])
  })

  it('glob name match', () => {
    const filters = [parseFilter('u*', ROOT)]
    expect([...applyFilters({ filters, projects, graph })].sort()).toEqual(['ui', 'utils'])
  })

  it('pkg... includes pkg and transitive deps', () => {
    const filters = [parseFilter('app...', ROOT)]
    expect([...applyFilters({ filters, projects, graph })].sort()).toEqual(['app', 'ui', 'utils'])
  })

  it('...pkg includes pkg and transitive dependents', () => {
    const filters = [parseFilter('...utils', ROOT)]
    expect([...applyFilters({ filters, projects, graph })].sort()).toEqual(['app', 'ui', 'utils'])
  })

  it('a cross-project dependsOn edge counts as a dependency for ... and ^... (task edges)', () => {
    // e2e names app#build in dependsOn but has no package.json dep on app:
    // the task graph knows the edge, so selection does too.
    const withE2e = [...projects, mkProject('e2e', `${ROOT}/packages/e2e`)]
    const g = buildPackageGraph(withE2e, new Map([['e2e', ['app']]]))
    const sel = (raw: string) =>
      [...applyFilters({ filters: [parseFilter(raw, ROOT)], projects: withE2e, graph: g })].sort()
    expect(sel('...utils')).toEqual(['app', 'e2e', 'ui', 'utils'])
    expect(sel('...app')).toEqual(['app', 'e2e'])
    expect(sel('e2e...')).toEqual(['app', 'e2e', 'ui', 'utils'])
    expect(sel('e2e^...')).toEqual(['app', 'ui', 'utils'])
    // an edge to a project that is not a member, or to itself, is nothing
    const g2 = buildPackageGraph(withE2e, new Map([['e2e', ['e2e', 'ghost']]]))
    expect(
      [
        ...applyFilters({ filters: [parseFilter('...app', ROOT)], projects: withE2e, graph: g2 }),
      ].sort(),
    ).toEqual(['app'])
  })

  // Turbo 2.5.8 on create-t3-turbo: `...db...` ran the ui and validators
  // db's dependent apps build on; vx ran db's own dependencies alone.
  it('...pkg... also takes the dependencies of every dependent', () => {
    const withKit = [
      mkProject('app', `${ROOT}/packages/app`, ['ui', 'kit']),
      ...projects.slice(1),
      mkProject('kit', `${ROOT}/packages/kit`),
    ]
    const g = buildPackageGraph(withKit)
    const sel = (raw: string) =>
      [...applyFilters({ filters: [parseFilter(raw, ROOT)], projects: withKit, graph: g })].sort()
    expect(sel('...ui...')).toEqual(['app', 'kit', 'ui', 'utils'])
    // Turbo re-adds the package itself through its dependents' dependencies.
    expect(sel('...^ui...')).toEqual(['app', 'kit', 'ui', 'utils'])
    expect(sel('...ui^...')).toEqual(['app', 'kit', 'ui', 'utils'])
    // CONTROL: one walk at a time is unchanged.
    expect([sel('...ui'), sel('ui...')]).toEqual([
      ['app', 'ui'],
      ['ui', 'utils'],
    ])
  })

  // pnpm: `--filter core` selects `@babel/core`. Nx names nx-examples'
  // `@nx-example/cart` `cart`, and `-p cart` matched nothing.
  it('a name that matches no package may leave out the scope, as pnpm reads it', () => {
    const scoped = [
      mkProject('@a/cart', `${ROOT}/packages/cart`),
      mkProject('@a/shared-ui', `${ROOT}/packages/shared-ui`),
      mkProject('@a/shared-io', `${ROOT}/packages/shared-io`),
      mkProject('@b/io', `${ROOT}/packages/b-io`),
      mkProject('@c/io', `${ROOT}/packages/c-io`),
      mkProject('cart-page', `${ROOT}/packages/cart-page`),
    ]
    const g = buildPackageGraph(scoped)
    const sel = (raw: string) =>
      [...applyFilters({ filters: [parseFilter(raw, ROOT)], projects: scoped, graph: g })].sort()
    expect(sel('cart')).toEqual(['@a/cart'])
    expect(sel('shared-*')).toEqual(['@a/shared-io', '@a/shared-ui'])
    // Two scopes carry the exact name: neither is meant.
    expect(sel('io')).toEqual([])
    // A name a package carries wins; a scoped pattern never falls back.
    expect(sel('cart-*')).toEqual(['cart-page'])
    expect(sel('@x/cart')).toEqual([])
  })

  it('...^pkg includes only the dependents, not the package itself (item 890)', () => {
    // cli.md listed the form; the `^` stayed in the name glob, so it matched
    // nothing and the run refused with "no projects matched".
    const sel = (raw: string) =>
      [...applyFilters({ filters: [parseFilter(raw, ROOT)], projects, graph })].sort()
    expect(sel('...^utils')).toEqual(['app', 'ui'])
    expect(sel('...^ui')).toEqual(['app'])
    expect(sel('...^app')).toEqual([])
  })

  it('pkg^... includes only the deps, not the package itself', () => {
    const filters = [parseFilter('app^...', ROOT)]
    expect([...applyFilters({ filters, projects, graph })].sort()).toEqual(['ui', 'utils'])
  })

  it('!pkg excludes from the otherwise-full set', () => {
    const filters = [parseFilter('!lib', ROOT)]
    expect([...applyFilters({ filters, projects, graph })].sort()).toEqual(['app', 'ui', 'utils'])
  })

  it('mixing include + exclude in order', () => {
    const filters = [parseFilter('*', ROOT), parseFilter('!lib', ROOT)]
    expect([...applyFilters({ filters, projects, graph })].sort()).toEqual(['app', 'ui', 'utils'])
  })

  it('an exclude removes what any include adds, whatever the order (item 979)', () => {
    // Applied in argv order, the include after the exclude added `utils`
    // back: `--filter '!utils' --filter 'app...'` ran the excluded project.
    const sel = (...raws: string[]) =>
      [...applyFilters({ filters: raws.map((r) => parseFilter(r, ROOT)), projects, graph })].sort()
    expect(sel('!utils', 'app...')).toEqual(['app', 'ui'])
    expect(sel('app...', '!utils')).toEqual(['app', 'ui'])
    expect(sel('!ui...', '*')).toEqual(['app', 'lib'])
  })

  // Package names carry a `/` in their scope, so the DSL's `*` must mean
  // "any characters" (pnpm's rule) rather than a path segment.
  describe('scoped names', () => {
    const scoped = [
      mkProject('@acme/core', `${ROOT}/packages/core`),
      mkProject('@acme/utils', `${ROOT}/packages/utils`),
      mkProject('app', `${ROOT}/packages/app`),
    ]
    const scopedGraph = buildPackageGraph(scoped)

    it("'*' selects every project, scoped or not", () => {
      const filters = [parseFilter('*', ROOT)]
      expect([...applyFilters({ filters, projects: scoped, graph: scopedGraph })].sort()).toEqual([
        '@acme/core',
        '@acme/utils',
        'app',
      ])
    })

    it("'*core*' matches across the scope separator", () => {
      const filters = [parseFilter('*core*', ROOT)]
      expect([...applyFilters({ filters, projects: scoped, graph: scopedGraph })]).toEqual([
        '@acme/core',
      ])
    })

    it("a name's regex characters are literal: 'socket.io' never selects 'socketxio'", () => {
      const dotted = [
        mkProject('socket.io', `${ROOT}/packages/sio`),
        mkProject('socketxio', `${ROOT}/packages/sxio`),
        mkProject('c++', `${ROOT}/packages/cpp`),
        mkProject('cc', `${ROOT}/packages/cc`),
      ]
      const g = buildPackageGraph(dotted)
      const pick = (f: string) => [
        ...applyFilters({ filters: [parseFilter(f, ROOT)], projects: dotted, graph: g }),
      ]
      expect(pick('socket.io')).toEqual(['socket.io'])
      expect(pick('c++')).toEqual(['c++'])
    })

    it("'@acme/*' still selects exactly the scope", () => {
      const filters = [parseFilter('@acme/*', ROOT)]
      expect([...applyFilters({ filters, projects: scoped, graph: scopedGraph })].sort()).toEqual([
        '@acme/core',
        '@acme/utils',
      ])
    })

    // Nx and pnpm resolve a bare `core` to `@acme/core` when one package
    // carries it (G-129; it selected nothing before).
    it("a bare 'core' selects '@acme/core', the one package it names after the scope", () => {
      const filters = [parseFilter('core', ROOT)]
      expect([...applyFilters({ filters, projects: scoped, graph: scopedGraph })]).toEqual([
        '@acme/core',
      ])
    })

    it("'*core' reaches '@acme/core' across the scope", () => {
      const filters = [parseFilter('*core', ROOT)]
      expect([...applyFilters({ filters, projects: scoped, graph: scopedGraph })]).toEqual([
        '@acme/core',
      ])
    })

    it("'!*utils' excludes a scoped project from the full set", () => {
      const filters = [parseFilter('!*utils', ROOT)]
      expect([...applyFilters({ filters, projects: scoped, graph: scopedGraph })].sort()).toEqual([
        '@acme/core',
        'app',
      ])
    })
  })

  it('a path form with a glob selects by root-relative dir (`./packages/*`, `{apps/**}`)', () => {
    // Turbo's `test_glob_filter_packages_dir`; pnpm's spelling too. The
    // glob is matched against the project's own dir: `*` is the direct
    // children, `**` reaches a nested package.
    const projects = [
      mkProject('ui', '/ws/packages/ui'),
      mkProject('core', '/ws/packages/core'),
      mkProject('inner', '/ws/packages/core/inner'),
      mkProject('web', '/ws/apps/web'),
      mkProject('docs', '/ws/docs'),
    ]
    const graph = buildPackageGraph(projects)
    const pick = (raw: string) =>
      [...applyFilters({ filters: [parseFilter(raw, ROOT)], projects, graph })].sort()
    expect(pick('./packages/*')).toEqual(['core', 'ui'])
    expect(pick('./packages/**')).toEqual(['core', 'inner', 'ui'])
    expect(pick('{apps/**}')).toEqual(['web'])
    expect(pick('./*')).toEqual(['docs'])
    expect(pick('./packages/c*')).toEqual(['core'])
    expect(pick('./nothing/*')).toEqual([])
    // D-84: a trailing `**` matches zero dirs, so the package at its base
    // is in (kit's `check`, pnpm 12 and Turbo); `*` never matches none.
    expect(pick('./packages/core/**')).toEqual(['core', 'inner'])
    expect(pick('{packages/core/**}')).toEqual(['core', 'inner'])
    expect(pick('./packages/c*/**')).toEqual(['core', 'inner'])
    expect(pick('./packages/core/*')).toEqual(['inner'])
  })

  it('path filter selects packages under the directory', () => {
    const filters = [parseFilter('./packages/ui', ROOT)]
    expect([...applyFilters({ filters, projects, graph })].sort()).toEqual(['ui'])
  })

  it('combined includes union', () => {
    const filters = [parseFilter('ui', ROOT), parseFilter('lib', ROOT)]
    expect([...applyFilters({ filters, projects, graph })].sort()).toEqual(['lib', 'ui'])
  })

  // `[<since>]` filter resolves to a project set via affectedByFilter
  // (caller-resolved). Verify the parser + applier compose with the
  // other modifiers — that's the integration point CLI users hit.

  it('[<since>] + ...suffix expands to affected + their transitive deps', () => {
    const f = parseFilter('[main]...', ROOT)
    expect(f.gitSince).toBe('main')
    expect(f.withDeps).toBe(true)
    const affectedByFilter = new Map([[f, new Set(['app'])]])
    expect([...applyFilters({ filters: [f], projects, graph, affectedByFilter })].sort()).toEqual([
      'app',
      'ui',
      'utils',
    ])
  })

  it('a path filter does not spill into a sibling sharing its prefix', () => {
    // `./packages/app` must not drag in `./packages/app-extra`. The guard
    // is matching on `dir + sep`, and the failure it prevents is silent
    // OVER-selection — a filter that runs more than you asked for reports
    // nothing wrong, it just costs time and can hide a real failure.
    const projects2 = [
      mkProject('app', '/ws/packages/app'),
      mkProject('appx', '/ws/packages/app-extra'),
    ]
    const graph2 = buildPackageGraph(projects2)
    const sel = (raw: string): string[] => [
      ...applyFilters({ filters: [parseFilter(raw, ROOT)], projects: projects2, graph: graph2 }),
    ]
    expect(sel('./packages/app')).toEqual(['app'])
    // Shell tab-completion adds the trailing slash; path.resolve eats it.
    expect(sel('./packages/app/')).toEqual(['app'])
    expect(sel('{packages/app}')).toEqual(['app'])
    // `.` is the workspace ROOT, so it selects everything — documented,
    // and deliberately not pnpm's "the package I am standing in".
    expect(sel('.').sort()).toEqual(['app', 'appx'])
  })

  it('...[<since>] expands affected to their transitive DEPENDENTS', () => {
    // The CI-correctness direction, and the one `--affected` alone does
    // NOT cover: a change in `utils` must be able to pull `ui` and `app`
    // in, or downstream breakage ships untested. `--affected` is sugar
    // for the bare `[<base>]`, so this prefix form is what a user reaches
    // for when they want the dependents too.
    const f = parseFilter('...[main]', ROOT)
    expect(f.gitSince).toBe('main')
    expect(f.withDependents).toBe(true)
    const affectedByFilter = new Map([[f, new Set(['utils'])]])
    expect([...applyFilters({ filters: [f], projects, graph, affectedByFilter })].sort()).toEqual([
      'app',
      'ui',
      'utils',
    ])
  })

  it('[<since>] + ^... suffix expands to deps-of-affected only', () => {
    const f = parseFilter('[main]^...', ROOT)
    expect(f.gitSince).toBe('main')
    expect(f.onlyDeps).toBe(true)
    const affectedByFilter = new Map([[f, new Set(['app'])]])
    expect([...applyFilters({ filters: [f], projects, graph, affectedByFilter })].sort()).toEqual([
      'ui',
      'utils',
    ])
  })

  it('![<since>] excludes affected projects from an otherwise-full set', () => {
    const f = parseFilter('![main]', ROOT)
    expect(f.negate).toBe(true)
    expect(f.gitSince).toBe('main')
    // Affected = {app}; full set minus app = the rest.
    const affectedByFilter = new Map([[f, new Set(['app'])]])
    expect([...applyFilters({ filters: [f], projects, graph, affectedByFilter })].sort()).toEqual([
      'lib',
      'ui',
      'utils',
    ])
  })

  it('[<since>] with empty affected set selects nothing (no implicit fallback)', () => {
    // Empty affected after a no-op `git diff` should produce an empty
    // selection — NOT silently fall back to "all projects".
    const f = parseFilter('[HEAD]', ROOT)
    const affectedByFilter = new Map([[f, new Set<string>()]])
    expect([...applyFilters({ filters: [f], projects, graph, affectedByFilter })]).toEqual([])
  })

  it('stacked: --filter ui --filter [main] unions name + affected sets', () => {
    const fName = parseFilter('lib', ROOT)
    const fSince = parseFilter('[main]', ROOT)
    const affectedByFilter = new Map([[fSince, new Set(['app'])]])
    expect(
      [...applyFilters({ filters: [fName, fSince], projects, graph, affectedByFilter })].sort(),
    ).toEqual(['app', 'lib'])
  })

  it('path filter with absolute path resolves correctly', () => {
    // path.resolve(ROOT, './packages/ui') -> absolute. Parser stores
    // the absolute form; applier matches by `p.dir.startsWith(...)`.
    const f = parseFilter('./packages/ui', ROOT)
    expect(f.isPath).toBe(true)
    expect(f.matcher.endsWith('/packages/ui')).toBe(true)
    expect([...applyFilters({ filters: [f], projects, graph })]).toEqual(['ui'])
  })

  it('mixed include + path-filter union', () => {
    const filters = [parseFilter('lib', ROOT), parseFilter('./packages/ui', ROOT)]
    expect([...applyFilters({ filters, projects, graph })].sort()).toEqual(['lib', 'ui'])
  })
})

// A workspace that lists its root as a project (`packages: ['.', …]`) has
// one project whose dir contains every other: the case a path test gets
// backwards first.
describe('applyFilters with the workspace root as a project', () => {
  const projects = [
    mkProject('root', ROOT),
    mkProject('web', `${ROOT}/apps/web`, ['root']),
    mkProject('admin', `${ROOT}/apps/admin`),
    mkProject('docs', `${ROOT}/apps/docs`),
    mkProject('bar', `${ROOT}/packages/bar`),
  ]
  const graph = buildPackageGraph(projects)
  const sel = (...raw: string[]): string[] =>
    [...applyFilters({ filters: raw.map((r) => parseFilter(r, ROOT)), projects, graph })].sort()

  // turborepo#8672
  it('a negated name or path keeps the root project', () => {
    expect(sel('!docs')).toEqual(['admin', 'bar', 'root', 'web'])
    expect(sel('!./apps/docs')).toEqual(['admin', 'bar', 'root', 'web'])
  })

  // turborepo#9578
  it('the root project is selected by its name, and ...name adds its dependents', () => {
    expect(sel('root')).toEqual(['root'])
    expect(sel('...root')).toEqual(['root', 'web'])
  })

  // turborepo#9043
  it('a path glob minus one path selects every other app and nothing else', () => {
    expect(sel('./apps/*', '!./apps/docs')).toEqual(['admin', 'web'])
  })

  it("a path naming a project's own dir is that project, as Turbo and pnpm read it (D-43)", () => {
    // Turbo 2.8.17 and pnpm 10, probed: `--filter .` runs the root task
    // alone. vx read every path as "at or under", so `.` selected every
    // project and a root project could not be named by its path.
    expect(sel('.')).toEqual(['root'])
    expect(sel('{.}')).toEqual(['root'])
    expect(sel('!.')).toEqual(['admin', 'bar', 'docs', 'web'])
    expect(sel('./apps/web')).toEqual(['web'])
    // CONTROL: a directory that is no project keeps "at or under".
    expect(sel('./apps')).toEqual(['admin', 'docs', 'web'])
  })

  it("`//` is the root project, Turbo's name for it (D-46)", () => {
    // Turbo 2.8.17, probed: `//`, `!//`, `...//` and `//[HEAD]` select by
    // the root. vx matched `//` as a name and refused "Did you mean a?".
    expect(sel('//')).toEqual(['root'])
    expect(sel('!//')).toEqual(['admin', 'bar', 'docs', 'web'])
    expect(sel('...//')).toEqual(['root', 'web'])
    expect(parseFilter('//[HEAD]', ROOT)).toMatchObject({ gitSince: 'HEAD', matcher: ROOT })
    // A root that is no project selects nothing, never every project under it.
    const members = projects.filter((p) => p.name !== 'root')
    const pick = [...applyFilters({ filters: [parseFilter('//', ROOT)], projects: members, graph })]
    expect(pick).toEqual([])
  })

  it('a project nested in a project is left out of the outer path (D-43)', () => {
    const nested = [...projects, mkProject('web-example', `${ROOT}/apps/web/examples/x`)]
    const g = buildPackageGraph(nested)
    const pick = (raw: string): string[] =>
      [...applyFilters({ filters: [parseFilter(raw, ROOT)], projects: nested, graph: g })].sort()
    expect(pick('./apps/web')).toEqual(['web'])
    expect(pick('./apps/web/examples/x')).toEqual(['web-example'])
    expect(pick('./apps/web/examples')).toEqual(['web-example'])
  })
})

// turborepo#8599: a member discovered through a `./`-prefixed package glob
// was not matched by the path filter naming its directory.
describe('a path filter over members found through a ./-prefixed glob (e2e)', () => {
  it('--filter ./apps/web selects the member pnpm-workspace.yaml lists as ./apps/*', async () => {
    const root = await makeWorkspace({ prefix: 'vx-filter-dotslash-' })
    try {
      await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - './apps/*'\n")
      for (const name of ['web', 'docs']) {
        const dir = path.join(root, 'apps', name)
        await mkdir(dir, { recursive: true })
        await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
        await writeFile(
          path.join(dir, 'vx.config.mjs'),
          `export default { tasks: { build: { exec: { command: 'true' } } } }`,
        )
      }
      expect(await planned(root, ['build', '--filter', './apps/web'])).toEqual(['web#build'])
      expect(await planned(root, ['build', '--filter', './apps/*'])).toEqual([
        'docs#build',
        'web#build',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('a selector narrowed by a git range (D-44)', () => {
  // Turbo 2.8.17 and pnpm read `@scope/*[HEAD]` and `{./apps/*}[main]` as
  // the selected packages that changed since the ref; vx read the whole as
  // one name glob and refused "no projects matched".
  const projects = [
    mkProject('@s/app', `${ROOT}/apps/app`, ['@s/lib']),
    mkProject('@s/lib', `${ROOT}/libs/lib`, ['core']),
    mkProject('core', `${ROOT}/libs/core`),
  ]
  const graph = buildPackageGraph(projects)
  const sel = (raw: string, changed: string[]): string[] => {
    const f = parseFilter(raw, ROOT)
    const affectedByFilter = new Map([[f, new Set(changed)]])
    return [...applyFilters({ filters: [f], projects, graph, affectedByFilter })].sort()
  }

  it('parses the selector and the ref apart', () => {
    const f = parseFilter('@s/*[origin/main]', ROOT)
    expect([f.matcher, f.gitSince, f.isPath]).toEqual(['@s/*', 'origin/main', false])
    const d = parseFilter('...{./libs/*}[HEAD~1]', ROOT)
    expect([d.gitSince, d.isPath, d.withDependents]).toEqual(['HEAD~1', true, true])
  })

  it('selects the changed ones among the selected, then expands', () => {
    expect(sel('@s/*[HEAD]', ['core'])).toEqual([])
    expect(sel('@s/*[HEAD]', ['core', '@s/lib'])).toEqual(['@s/lib'])
    expect(sel('{./libs/*}[HEAD]', ['core'])).toEqual(['core'])
    expect(sel('...{./libs/*}[HEAD]', ['core'])).toEqual(['@s/app', '@s/lib', 'core'])
    // CONTROL: a bare range is every changed project, as before.
    expect(sel('[HEAD]', ['core', '@s/app'])).toEqual(['@s/app', 'core'])
  })

  // Turbo 2.5.8 on create-t3-turbo, db edited: `@acme/*...[HEAD]` ran db
  // and its five dependants, `@acme/api...[HEAD]` ran api alone. vx kept
  // the `...` in the name glob and selected nothing.
  it('`<name>...[ref]` is the named ones that changed or depend on one that did', () => {
    expect(sel('@s/*...[HEAD]', ['core'])).toEqual(['@s/app', '@s/lib'])
    expect(sel('@s/app...[HEAD]', ['core'])).toEqual(['@s/app'])
    expect(sel('core...[HEAD]', ['@s/lib'])).toEqual([])
    const f = parseFilter('@s/*...[HEAD]', ROOT)
    expect([f.matcher, f.gitSince, f.withDeps, f.sinceViaDeps]).toEqual([
      '@s/*',
      'HEAD',
      false,
      true,
    ])
  })

  it('CONTROL: an unbraced path keeps its brackets as a glob class', () => {
    const f = parseFilter('./libs/[c]ore', ROOT)
    expect([f.gitSince, f.isPath]).toEqual([undefined, true])
    // Ending in the class, the path reaches the range split and passes it.
    const g = parseFilter('./libs/[c]', ROOT)
    expect([g.gitSince, g.isPath, g.matcher]).toEqual([undefined, true, `${ROOT}/libs/[c]`])
  })

  it('`.[ref]` is a name, as Turbo reads it; a directory takes a ref only braced', () => {
    // Turbo 2.8.17: "No package found with name '.[HEAD]'"; `{.}[HEAD]` works.
    const f = parseFilter('.[HEAD]', ROOT)
    expect([f.gitSince, f.isPath, f.matcher]).toEqual([undefined, false, '.[HEAD]'])
  })

  it('a braced path glob with a class takes the last bracket as the ref', () => {
    // Turbo 2.8.17 selects by `{./packages/[a]*}[HEAD~1]`.
    const f = parseFilter('{./libs/[c]*}[HEAD]', ROOT)
    expect([f.gitSince, f.isPath]).toEqual(['HEAD', true])
    expect(sel('{./libs/[c]*}[HEAD]', ['core', '@s/lib'])).toEqual(['core'])
  })
})
