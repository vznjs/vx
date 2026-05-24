import { describe, expect, it } from 'bun:test'
import type { LoadedConfig } from '../../src/config/types.ts'
import { buildGraph } from '../../src/graph/build.ts'
import { GraphError } from '../../src/graph/types.ts'

function project(name: string, tasks: NonNullable<LoadedConfig['config']['tasks']>): LoadedConfig {
  return { project: { name, dir: `/fake/${name}` }, config: { tasks } }
}

describe('buildGraph', () => {
  it('returns a single node for a task with no dependencies', () => {
    const configs = [project('a', { build: { exec: { command: 'echo build' } } })]
    const graph = buildGraph({ configs, requested: ['build'] })

    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]).toMatchObject({
      id: 'a#build',
      project: 'a',
      task: 'build',
      dependencies: [],
    })
    expect(graph.byId.get('a#build')).toBe(graph.nodes[0]!)
  })

  it('includes same-project deps and topologically orders them', () => {
    const configs = [
      project('a', {
        build: { exec: { command: 'echo build' }, dependsOn: ['compile'] },
        compile: { exec: { command: 'echo compile' } },
      }),
    ]
    const graph = buildGraph({ configs, requested: ['build'] })

    expect(graph.nodes.map((n) => n.id)).toEqual(['a#compile', 'a#build'])
    expect(graph.byId.get('a#build')!.dependencies).toEqual(['a#compile'])
  })

  it('includes cross-project deps via pkg#name', () => {
    const configs = [
      project('a', {
        build: { exec: { command: 'a build' }, dependsOn: ['b#compile'] },
      }),
      project('b', {
        compile: { exec: { command: 'b compile' } },
      }),
    ]
    const graph = buildGraph({ configs, requested: ['a#build'] })

    expect(graph.nodes.map((n) => n.id)).toEqual(['b#compile', 'a#build'])
    expect(graph.byId.get('a#build')!.dependencies).toEqual(['b#compile'])
  })

  it('fans out a bare requested name across every project that declares it', () => {
    const configs = [
      project('a', { test: { exec: { command: 'a test' } } }),
      project('b', { test: { exec: { command: 'b test' } } }),
      project('c', { other: { exec: { command: 'c other' } } }),
    ]
    const graph = buildGraph({ configs, requested: ['test'] })

    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['a#test', 'b#test'])
  })

  it('respects anchored requested tasks (pkg#name)', () => {
    const configs = [
      project('a', { test: { exec: { command: 'a test' } } }),
      project('b', { test: { exec: { command: 'b test' } } }),
    ]
    const graph = buildGraph({ configs, requested: ['a#test'] })

    expect(graph.nodes.map((n) => n.id)).toEqual(['a#test'])
  })

  it('deduplicates shared upstreams across multiple requested tasks', () => {
    const configs = [
      project('a', {
        build: { exec: { command: 'a b' }, dependsOn: ['common'] },
        test: { exec: { command: 'a t' }, dependsOn: ['common'] },
        common: { exec: { command: 'a c' } },
      }),
    ]
    const graph = buildGraph({ configs, requested: ['build', 'test'] })

    const ids = graph.nodes.map((n) => n.id)
    expect(ids).toContain('a#common')
    expect(ids.filter((id) => id === 'a#common')).toHaveLength(1)
    expect(ids[0]).toBe('a#common')
  })

  it('includes group tasks (no exec) as nodes', () => {
    const configs = [
      project('a', {
        ci: { dependsOn: ['lint', 'test'] },
        lint: { exec: { command: 'lint' } },
        test: { exec: { command: 'test' } },
      }),
    ]
    const graph = buildGraph({ configs, requested: ['ci'] })

    const ci = graph.byId.get('a#ci')!
    expect(ci.config.exec).toBeUndefined()
    expect([...ci.dependencies].sort()).toEqual(['a#lint', 'a#test'])
  })

  it('throws when no project declares the requested task', () => {
    const configs = [project('a', { build: { exec: { command: 'b' } } })]
    expect(() => buildGraph({ configs, requested: ['nope'] })).toThrow(GraphError)
    expect(() => buildGraph({ configs, requested: ['nope'] })).toThrow(/no project.*nope/i)
  })

  it('throws when an anchored task targets a project that does not declare it', () => {
    const configs = [
      project('a', { build: { exec: { command: 'b' } } }),
      project('b', { other: { exec: { command: 'o' } } }),
    ]
    expect(() => buildGraph({ configs, requested: ['b#build'] })).toThrow(GraphError)
  })

  it('throws when a same-project dep references a missing task', () => {
    const configs = [
      project('a', {
        build: { exec: { command: 'b' }, dependsOn: ['missing'] },
      }),
    ]
    expect(() => buildGraph({ configs, requested: ['build'] })).toThrow(/missing/)
  })

  it('throws when a cross-project dep references a missing project', () => {
    const configs = [
      project('a', {
        build: { exec: { command: 'b' }, dependsOn: ['nonexistent#x'] },
      }),
    ]
    expect(() => buildGraph({ configs, requested: ['build'] })).toThrow(/nonexistent/)
  })

  it('throws when a cross-project dep references a missing task', () => {
    const configs = [
      project('a', {
        build: { exec: { command: 'b' }, dependsOn: ['b#missing'] },
      }),
      project('b', { other: { exec: { command: 'o' } } }),
    ]
    expect(() => buildGraph({ configs, requested: ['build'] })).toThrow(/missing/)
  })

  it('rejects ^name as not yet supported', () => {
    const configs = [
      project('a', {
        build: { exec: { command: 'b' }, dependsOn: ['^build'] },
      }),
    ]
    expect(() => buildGraph({ configs, requested: ['build'] })).toThrow(/\^|package-graph/i)
  })

  it('rejects wildcards in dependsOn', () => {
    const configs = [
      project('a', {
        build: { exec: { command: 'b' }, dependsOn: ['*'] },
      }),
    ]
    expect(() => buildGraph({ configs, requested: ['build'] })).toThrow(/wildcard/i)
  })

  it('rejects negation in dependsOn', () => {
    const configs = [
      project('a', {
        build: { exec: { command: 'b' }, dependsOn: ['!compile'] },
        compile: { exec: { command: 'c' } },
      }),
    ]
    expect(() => buildGraph({ configs, requested: ['build'] })).toThrow(/negat/i)
  })

  it('detects a 2-node cycle and reports the path', () => {
    const configs = [
      project('a', {
        x: { exec: { command: 'x' }, dependsOn: ['y'] },
        y: { exec: { command: 'y' }, dependsOn: ['x'] },
      }),
    ]
    expect(() => buildGraph({ configs, requested: ['x'] })).toThrow(/cycle/i)
  })

  it('detects a 3-node cycle', () => {
    const configs = [
      project('a', {
        x: { exec: { command: 'x' }, dependsOn: ['y'] },
        y: { exec: { command: 'y' }, dependsOn: ['z'] },
        z: { exec: { command: 'z' }, dependsOn: ['x'] },
      }),
    ]
    expect(() => buildGraph({ configs, requested: ['x'] })).toThrow(/cycle/i)
  })

  it('detects a self-cycle (a depends on a)', () => {
    const configs = [
      project('a', {
        x: { exec: { command: 'x' }, dependsOn: ['x'] },
      }),
    ]
    expect(() => buildGraph({ configs, requested: ['x'] })).toThrow(/cycle/i)
  })

  it('produces deterministic order across calls (ties broken by id)', () => {
    const configs = [
      project('a', { test: { exec: { command: 't' } } }),
      project('b', { test: { exec: { command: 't' } } }),
      project('c', { test: { exec: { command: 't' } } }),
    ]
    const g1 = buildGraph({ configs, requested: ['test'] })
    const g2 = buildGraph({ configs, requested: ['test'] })

    expect(g1.nodes.map((n) => n.id)).toEqual(g2.nodes.map((n) => n.id))
  })

  it('returns an empty graph when nothing is requested', () => {
    const configs = [project('a', { build: { exec: { command: 'b' } } })]
    const graph = buildGraph({ configs, requested: [] })

    expect(graph.nodes).toEqual([])
    expect(graph.byId.size).toBe(0)
  })

  it('handles a diamond: a depends on {b,c}; b and c both depend on d', () => {
    const configs = [
      project('p', {
        a: { exec: { command: 'a' }, dependsOn: ['b', 'c'] },
        b: { exec: { command: 'b' }, dependsOn: ['d'] },
        c: { exec: { command: 'c' }, dependsOn: ['d'] },
        d: { exec: { command: 'd' } },
      }),
    ]
    const graph = buildGraph({ configs, requested: ['a'] })

    const order = graph.nodes.map((n) => n.id)
    expect(order[0]).toBe('p#d')
    expect(order[order.length - 1]).toBe('p#a')
    expect(order.indexOf('p#b')).toBeGreaterThan(order.indexOf('p#d'))
    expect(order.indexOf('p#c')).toBeGreaterThan(order.indexOf('p#d'))
  })
})
