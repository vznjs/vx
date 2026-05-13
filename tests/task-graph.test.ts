import { describe, expect, it } from 'bun:test'
import type { TaskConfig } from '../src/config.js'
import type { PackageGraph } from '../src/workspace/package-graph.js'
import { buildTaskGraph, type ProjectEntry } from '../src/graph/task-graph.js'

function project(name: string, tasks: Record<string, TaskConfig>): ProjectEntry {
  return { name, dir: `/ws/${name}`, config: { tasks } }
}

function projects(...entries: ProjectEntry[]): Map<string, ProjectEntry> {
  return new Map(entries.map((e) => [e.name, e]))
}

function packageGraph(direct: Record<string, string[]>): PackageGraph {
  const directDeps = new Map<string, string[]>()
  for (const [k, v] of Object.entries(direct)) directDeps.set(k, v)

  function transitive(name: string, seen: Set<string> = new Set()): string[] {
    if (seen.has(name)) return []
    seen.add(name)
    const out = new Set<string>()
    for (const d of directDeps.get(name) ?? []) {
      out.add(d)
      for (const t of transitive(d, seen)) out.add(t)
    }
    return [...out]
  }

  return {
    byName: new Map(),
    directDeps,
    transitiveDeps: (n) => transitive(n),
    transitiveDependents: () => [],
  }
}

const cmd = (s: string): TaskConfig => ({ exec: { command: s } })

describe('buildTaskGraph', () => {
  it('builds a single zero-dependency node', () => {
    const nodes = buildTaskGraph({
      projects: projects(project('a', { build: cmd('echo a') })),
      packageGraph: packageGraph({}),
      requested: [{ project: 'a', task: 'build' }],
    })
    expect([...nodes.keys()]).toEqual(['a#build'])
    expect(nodes.get('a#build')?.deps).toEqual([])
  })

  it('expands a same-project task dependency via dependsOn.self', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('a', {
          test: { ...cmd('vitest'), dependsOn: { self: ['build'] } },
          build: cmd('tsc'),
        }),
      ),
      packageGraph: packageGraph({}),
      requested: [{ project: 'a', task: 'test' }],
    })
    expect(nodes.get('a#test')?.deps).toEqual(['a#build'])
    expect(nodes.has('a#build')).toBe(true)
  })

  it('errors when dependsOn.self targets a missing task', () => {
    expect(() =>
      buildTaskGraph({
        projects: projects(
          project('a', {
            test: { ...cmd('vitest'), dependsOn: { self: ['nope'] } },
          }),
        ),
        packageGraph: packageGraph({}),
        requested: [{ project: 'a', task: 'test' }],
      }),
    ).toThrow(/depends on a#nope/)
  })

  it('expands across all transitive workspace deps via dependsOn.dependencies', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: { ...cmd('build app'), dependsOn: { dependencies: ['build'] } },
        }),
        project('lib', { build: cmd('build lib') }),
        project('deep', { build: cmd('build deep') }),
      ),
      packageGraph: packageGraph({ app: ['lib'], lib: ['deep'] }),
      requested: [{ project: 'app', task: 'build' }],
    })
    expect(nodes.has('lib#build')).toBe(true)
    expect(nodes.has('deep#build')).toBe(true)
  })

  it('runs both self and dependencies tasks before the dependent', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: {
            ...cmd('build app'),
            dependsOn: { self: ['codegen'], dependencies: ['build'] },
          },
          codegen: cmd('codegen'),
        }),
        project('lib', { build: cmd('build lib') }),
      ),
      packageGraph: packageGraph({ app: ['lib'] }),
      requested: [{ project: 'app', task: 'build' }],
    })
    expect(nodes.get('app#build')?.deps.sort()).toEqual(['app#codegen', 'lib#build'])
  })

  it('silently skips workspace deps that have no such task', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: { ...cmd('build app'), dependsOn: { dependencies: ['build'] } },
        }),
        project('lib', { lint: cmd('lint lib') }), // no `build` task here
      ),
      packageGraph: packageGraph({ app: ['lib'] }),
      requested: [{ project: 'app', task: 'build' }],
    })
    expect([...nodes.keys()]).toEqual(['app#build'])
    expect(nodes.get('app#build')?.deps).toEqual([])
  })

  it('dedupes diamond dependency: shared upstream node is created once', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: { ...cmd('build'), dependsOn: { dependencies: ['build'] } },
        }),
        project('left', {
          build: { ...cmd('build'), dependsOn: { dependencies: ['build'] } },
        }),
        project('right', {
          build: { ...cmd('build'), dependsOn: { dependencies: ['build'] } },
        }),
        project('shared', { build: cmd('build') }),
      ),
      packageGraph: packageGraph({
        app: ['left', 'right'],
        left: ['shared'],
        right: ['shared'],
      }),
      requested: [{ project: 'app', task: 'build' }],
    })
    expect([...nodes.keys()].sort()).toEqual([
      'app#build',
      'left#build',
      'right#build',
      'shared#build',
    ])
    expect(nodes.get('left#build')?.deps).toEqual(['shared#build'])
    expect(nodes.get('right#build')?.deps).toEqual(['shared#build'])
  })

  it('detects a cross-project cycle', () => {
    expect(() =>
      buildTaskGraph({
        projects: projects(
          project('a', {
            build: { ...cmd('a'), dependsOn: { dependencies: ['build'] } },
          }),
          project('b', {
            build: { ...cmd('b'), dependsOn: { dependencies: ['build'] } },
          }),
        ),
        packageGraph: packageGraph({ a: ['b'], b: ['a'] }),
        requested: [{ project: 'a', task: 'build' }],
      }),
    ).toThrow(/Cycle detected/)
  })

  it('detects a same-project task self-cycle', () => {
    expect(() =>
      buildTaskGraph({
        projects: projects(
          project('a', {
            build: { ...cmd('a'), dependsOn: { self: ['build'] } },
          }),
        ),
        packageGraph: packageGraph({}),
        requested: [{ project: 'a', task: 'build' }],
      }),
    ).toThrow(/Cycle detected/)
  })

  it('returns an empty graph when no projects are requested', () => {
    const nodes = buildTaskGraph({
      projects: projects(project('a', { build: cmd('echo') })),
      packageGraph: packageGraph({}),
      requested: [],
    })
    expect(nodes.size).toBe(0)
  })

  it('marks user-requested nodes; deps pulled in by dependsOn are not requested', () => {
    // B2 from real-world test: forwardArgs must not leak to dependencies.
    // The graph builder is the source of truth for which nodes were
    // explicitly asked for vs implicitly pulled.
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: { ...cmd('build app'), dependsOn: { dependencies: ['build'] } },
        }),
        project('lib', { build: cmd('build lib') }),
      ),
      packageGraph: packageGraph({ app: ['lib'] }),
      requested: [{ project: 'app', task: 'build' }],
    })
    expect(nodes.get('app#build')?.requested).toBe(true)
    expect(nodes.get('lib#build')?.requested).toBe(false)
  })

  it('a node added implicitly and then requested explicitly is promoted', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: { ...cmd('build app'), dependsOn: { dependencies: ['build'] } },
        }),
        project('lib', { build: cmd('build lib') }),
      ),
      packageGraph: packageGraph({ app: ['lib'] }),
      // `lib#build` is pulled in by app's dependsOn AND requested directly.
      requested: [
        { project: 'app', task: 'build' },
        { project: 'lib', task: 'build' },
      ],
    })
    expect(nodes.get('app#build')?.requested).toBe(true)
    expect(nodes.get('lib#build')?.requested).toBe(true)
  })

  it('excludeDependencies: "all" skips both self and dependencies expansion', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: {
            ...cmd('build app'),
            dependsOn: { self: ['codegen'], dependencies: ['build'] },
          },
          codegen: cmd('codegen'),
        }),
        project('lib', { build: cmd('build lib') }),
      ),
      packageGraph: packageGraph({ app: ['lib'] }),
      requested: [{ project: 'app', task: 'build' }],
      excludeDependencies: 'all',
    })
    expect([...nodes.keys()]).toEqual(['app#build'])
    expect(nodes.get('app#build')?.deps).toEqual([])
  })

  it('excludeDependencies: name-list drops only matching edges in both self and deps', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: {
            ...cmd('build app'),
            dependsOn: { self: ['codegen'], dependencies: ['build'] },
          },
          codegen: cmd('codegen'),
        }),
        project('lib', { build: cmd('build lib') }),
      ),
      packageGraph: packageGraph({ app: ['lib'] }),
      requested: [{ project: 'app', task: 'build' }],
      excludeDependencies: ['build'],
    })
    // build edge to lib#build is dropped, but the same-project codegen edge stays.
    expect(nodes.has('lib#build')).toBe(false)
    expect(nodes.get('app#build')?.deps).toEqual(['app#codegen'])
  })
})
