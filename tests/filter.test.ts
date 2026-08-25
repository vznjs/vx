import { describe, expect, it } from 'bun:test'
import path from 'node:path'
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

    it("'@acme/*' still selects exactly the scope", () => {
      const filters = [parseFilter('@acme/*', ROOT)]
      expect([...applyFilters({ filters, projects: scoped, graph: scopedGraph })].sort()).toEqual([
        '@acme/core',
        '@acme/utils',
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
