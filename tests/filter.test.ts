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

  it('path filter selects packages under the directory', () => {
    const filters = [parseFilter('./packages/ui', ROOT)]
    expect([...applyFilters({ filters, projects, graph })].sort()).toEqual(['ui'])
  })

  it('combined includes union', () => {
    const filters = [parseFilter('ui', ROOT), parseFilter('lib', ROOT)]
    expect([...applyFilters({ filters, projects, graph })].sort()).toEqual(['lib', 'ui'])
  })
})
