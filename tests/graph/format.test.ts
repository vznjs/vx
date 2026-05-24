import { describe, expect, it } from 'bun:test'
import { buildGraph } from '../../src/graph/build.ts'
import { formatGraph } from '../../src/graph/format.ts'
import type { LoadedConfig } from '../../src/config/types.ts'

function project(name: string, tasks: NonNullable<LoadedConfig['config']['tasks']>): LoadedConfig {
  return { project: { name, dir: `/fake/${name}` }, config: { tasks } }
}

describe('formatGraph text', () => {
  it('prints tasks in topo order with dep arrows', () => {
    const configs = [
      project('a', {
        build: {
          description: 'compile',
          exec: { command: 'echo build' },
          dependsOn: ['compile'],
        },
        compile: { exec: { command: 'echo compile' } },
      }),
    ]
    const g = buildGraph({ configs, requested: ['build'] })
    const out = formatGraph(g, 'text')

    expect(out).toContain('a#compile')
    expect(out).toContain('a#build')
    expect(out.indexOf('a#compile')).toBeLessThan(out.indexOf('a#build'))
    expect(out).toMatch(/a#build.*<- a#compile/)
  })

  it('marks group tasks with "(group)"', () => {
    const configs = [
      project('a', {
        ci: { dependsOn: ['lint'] },
        lint: { exec: { command: 'oxlint' } },
      }),
    ]
    const g = buildGraph({ configs, requested: ['ci'] })
    const out = formatGraph(g, 'text')

    expect(out).toMatch(/a#ci.*\(group\)/)
  })

  it('returns an empty-message line for an empty graph', () => {
    const g = buildGraph({ configs: [], requested: [] })
    const out = formatGraph(g, 'text')

    expect(out).toMatch(/no tasks/i)
  })
})

describe('formatGraph json', () => {
  it('returns a parseable JSON envelope with nodes + edges', () => {
    const configs = [
      project('a', {
        build: { exec: { command: 'b' }, dependsOn: ['compile'] },
        compile: { exec: { command: 'c' } },
      }),
    ]
    const g = buildGraph({ configs, requested: ['build'] })
    const parsed = JSON.parse(formatGraph(g, 'json'))

    expect(parsed.nodes).toHaveLength(2)
    expect(parsed.nodes[0]).toMatchObject({
      id: 'a#compile',
      project: 'a',
      task: 'compile',
      dependencies: [],
    })
    expect(parsed.nodes[1]).toMatchObject({
      id: 'a#build',
      project: 'a',
      task: 'build',
      dependencies: ['a#compile'],
    })
  })

  it('includes description and command when present', () => {
    const configs = [
      project('a', {
        build: { description: 'compile sources', exec: { command: 'tsc' } },
      }),
    ]
    const g = buildGraph({ configs, requested: ['build'] })
    const parsed = JSON.parse(formatGraph(g, 'json'))

    expect(parsed.nodes[0]).toMatchObject({
      description: 'compile sources',
      command: 'tsc',
    })
  })

  it('omits command for group tasks', () => {
    const configs = [
      project('a', {
        ci: { dependsOn: ['lint'] },
        lint: { exec: { command: 'oxlint' } },
      }),
    ]
    const g = buildGraph({ configs, requested: ['ci'] })
    const parsed = JSON.parse(formatGraph(g, 'json'))
    const ci = parsed.nodes.find((n: { id: string }) => n.id === 'a#ci')

    expect(ci.command).toBeUndefined()
    expect(ci.group).toBe(true)
  })
})

describe('formatGraph dot', () => {
  it('emits Graphviz digraph with one edge per dependency', () => {
    const configs = [
      project('a', {
        build: { exec: { command: 'b' }, dependsOn: ['compile'] },
        compile: { exec: { command: 'c' } },
      }),
    ]
    const g = buildGraph({ configs, requested: ['build'] })
    const out = formatGraph(g, 'dot')

    expect(out).toMatch(/^digraph/)
    expect(out).toContain('"a#compile" -> "a#build"')
  })

  it('emits every node even if it has no edges', () => {
    const configs = [project('a', { x: { exec: { command: 'x' } } })]
    const g = buildGraph({ configs, requested: ['x'] })
    const out = formatGraph(g, 'dot')

    expect(out).toContain('"a#x"')
  })
})
