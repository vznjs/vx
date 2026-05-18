import { describe, expect, it } from 'bun:test'
import { buildPackageGraph } from '../src/workspace/package-graph.js'
import type { ProjectMeta } from '../src/workspace/workspace.js'

function meta(name: string, deps: Record<string, string> = {}): ProjectMeta {
  return {
    name,
    dir: `/ws/${name}`,
    packageJson: { name, dependencies: deps },
    configPath: null,
  }
}

describe('buildPackageGraph', () => {
  it('builds an empty graph from no projects', () => {
    const g = buildPackageGraph([])
    // No-projects graph still answers queries — they just return [].
    expect(g.transitiveDeps('anything')).toEqual([])
  })

  it('records direct workspace deps only when the dep is in the workspace', () => {
    const g = buildPackageGraph([meta('a', { b: 'workspace:*', external: '^1.0.0' }), meta('b')])
    // 'external' is not a workspace package — only 'b' counts.
    expect(g.transitiveDeps('a')).toEqual(['b'])
    expect(g.transitiveDeps('b')).toEqual([])
  })

  it('walks transitive deps and dedupes them', () => {
    const g = buildPackageGraph([
      meta('a', { b: 'workspace:*' }),
      meta('b', { c: 'workspace:*' }),
      meta('c'),
    ])
    expect(g.transitiveDeps('a').sort()).toEqual(['b', 'c'])
    expect(g.transitiveDeps('b')).toEqual(['c'])
    expect(g.transitiveDeps('c')).toEqual([])
  })

  it('does not loop forever on a workspace dep cycle', () => {
    const g = buildPackageGraph([meta('a', { b: 'workspace:*' }), meta('b', { a: 'workspace:*' })])
    // Just terminate; resulting set should include the other package.
    expect(g.transitiveDeps('a')).toContain('b')
    expect(g.transitiveDeps('b')).toContain('a')
  })

  it('transitiveDependents walks the reverse direction', () => {
    const g = buildPackageGraph([
      meta('a', { b: 'workspace:*' }),
      meta('b', { c: 'workspace:*' }),
      meta('c'),
      meta('lonely'),
    ])
    expect(g.transitiveDependents('c').sort()).toEqual(['a', 'b'])
    expect(g.transitiveDependents('b')).toEqual(['a'])
    expect(g.transitiveDependents('a')).toEqual([])
    expect(g.transitiveDependents('lonely')).toEqual([])
  })

  it('reads all four dependency fields (dependencies, devDependencies, peer, optional)', () => {
    const m: ProjectMeta = {
      name: 'a',
      dir: '/ws/a',
      packageJson: {
        name: 'a',
        dependencies: { b: 'workspace:*' },
        devDependencies: { c: 'workspace:*' },
        peerDependencies: { d: 'workspace:*' },
        optionalDependencies: { e: 'workspace:*' },
      },
      configPath: null,
    }
    const g = buildPackageGraph([m, meta('b'), meta('c'), meta('d'), meta('e')])
    // All four dep fields contribute, so transitive deps include
    // every workspace package mentioned in any of them.
    expect(g.transitiveDeps('a').sort()).toEqual(['b', 'c', 'd', 'e'])
  })
})
