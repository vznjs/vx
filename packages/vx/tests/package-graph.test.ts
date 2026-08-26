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

  it('directDeps returns only immediate workspace deps, sorted', () => {
    const g = buildPackageGraph([
      meta('a', { c: 'workspace:*', b: 'workspace:*', external: '^1.0.0' }),
      meta('b', { c: 'workspace:*' }),
      meta('c'),
    ])
    expect(g.directDeps('a')).toEqual(['b', 'c'])
    expect(g.directDeps('b')).toEqual(['c'])
    expect(g.directDeps('c')).toEqual([])
    expect(g.directDeps('unknown')).toEqual([])
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

  it('a cycle does not poison the closure memo (results are query-order independent)', () => {
    // a → b → c → a, plus c → z. Computing a's closure first used to cache a
    // TRUNCATED closure for the nodes visited while a sat on the DFS stack
    // (the back-edge contributes nothing), so every later query read the
    // partial set. The closure must not depend on which node is asked first.
    const build = (): ReturnType<typeof buildPackageGraph> =>
      buildPackageGraph([
        meta('a', { b: 'workspace:*' }),
        meta('b', { c: 'workspace:*' }),
        meta('c', { a: 'workspace:*', z: 'workspace:*' }),
        meta('z'),
      ])
    const full = ['a', 'b', 'c', 'z']

    const aFirst = build()
    expect(aFirst.transitiveDeps('a')).toEqual(full)
    expect(aFirst.transitiveDeps('c')).toEqual(full)

    const cFirst = build()
    expect(cFirst.transitiveDeps('c')).toEqual(full)
    expect(cFirst.transitiveDeps('a')).toEqual(full)
  })

  it('a node outside the cycle still gets its full closure after a cycle query', () => {
    const g = buildPackageGraph([
      meta('top', { a: 'workspace:*' }),
      meta('a', { b: 'workspace:*' }),
      meta('b', { a: 'workspace:*' }),
      meta('leaf'),
    ])
    expect(g.transitiveDeps('a')).toEqual(['a', 'b'])
    expect(g.transitiveDeps('top')).toEqual(['a', 'b'])
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

  it('transitiveDependents terminates on a 2-node cycle and includes the other node', () => {
    // a ↔ b (each depends on the other). The reverse-edge accessor takes
    // the legacy DFS path (the bitset sweep bails on a cycle); the stack
    // guard must stop the walk. Mirrors the transitiveDeps cycle test.
    const g = buildPackageGraph([meta('a', { b: 'workspace:*' }), meta('b', { a: 'workspace:*' })])
    expect(g.transitiveDependents('a')).toContain('b')
    expect(g.transitiveDependents('b')).toContain('a')
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
