import { describe, expect, it } from 'vitest'
import type { TaskConfig } from '@nxt/config'
import type { PackageGraph } from './package-graph.js'
import { buildTaskGraph, type ProjectEntry } from './task-graph.js'

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
  }
}

const cmd = (s: string): TaskConfig => ({ process: { command: s } })

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

  it('expands a same-project task dependency', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('a', {
          test: { ...cmd('vitest'), dependsOn: [{ task: 'build' }] },
          build: cmd('tsc'),
        }),
      ),
      packageGraph: packageGraph({}),
      requested: [{ project: 'a', task: 'test' }],
    })
    expect(nodes.get('a#test')?.deps).toEqual(['a#build'])
    expect(nodes.has('a#build')).toBe(true)
  })

  it('errors when a same-project dependency targets a missing task', () => {
    expect(() =>
      buildTaskGraph({
        projects: projects(
          project('a', {
            test: { ...cmd('vitest'), dependsOn: [{ task: 'nope' }] },
          }),
        ),
        packageGraph: packageGraph({}),
        requested: [{ project: 'a', task: 'test' }],
      }),
    ).toThrow(/depends on a#nope/)
  })

  it('expands across direct workspace deps with dependencies: { transitive: false }', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: { ...cmd('build app'), dependsOn: [{ task: 'build', dependencies: { transitive: false } }] },
        }),
        project('lib', { build: cmd('build lib') }),
        project('deep', { build: cmd('build deep') }),
      ),
      packageGraph: packageGraph({ app: ['lib'], lib: ['deep'] }),
      requested: [{ project: 'app', task: 'build' }],
    })
    expect(nodes.has('lib#build')).toBe(true)
    expect(nodes.has('deep#build')).toBe(false) // transitive deps NOT followed
    expect(nodes.get('app#build')?.deps).toEqual(['lib#build'])
  })

  it('expands across all transitive workspace deps with dependencies: true', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: { ...cmd('build app'), dependsOn: [{ task: 'build', dependencies: true }] },
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

  it('silently skips cross-project deps that have no such task', () => {
    const nodes = buildTaskGraph({
      projects: projects(
        project('app', {
          build: { ...cmd('build app'), dependsOn: [{ task: 'build', dependencies: true }] },
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
          build: { ...cmd('build'), dependsOn: [{ task: 'build', dependencies: true }] },
        }),
        project('left', {
          build: { ...cmd('build'), dependsOn: [{ task: 'build', dependencies: true }] },
        }),
        project('right', {
          build: { ...cmd('build'), dependsOn: [{ task: 'build', dependencies: true }] },
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
    // Both intermediates point at the same shared instance.
    expect(nodes.get('left#build')?.deps).toEqual(['shared#build'])
    expect(nodes.get('right#build')?.deps).toEqual(['shared#build'])
  })

  it('detects a cross-project cycle', () => {
    expect(() =>
      buildTaskGraph({
        projects: projects(
          project('a', {
            build: { ...cmd('a'), dependsOn: [{ task: 'build', dependencies: true }] },
          }),
          project('b', {
            build: { ...cmd('b'), dependsOn: [{ task: 'build', dependencies: true }] },
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
            build: { ...cmd('a'), dependsOn: [{ task: 'build' }] },
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
})
