// `affectedRoots` walks each requested task's `dependsOn` closure for a task
// the diff seeds. It recursed once per edge, so `--affected` on a chain the
// graph builder takes (item 737's 50,000) ended in `RangeError` and a stack
// where a run belonged.
import { describe, expect, it } from 'bun:test'
import { affectedRoots } from '../src/orchestrator/affected-tasks.js'
import type { TaskNode } from '../src/graph/task-graph.js'
import type { AffectedChanges, PackageGraph, ProjectEntry } from '../src/workspace/index.js'

const cached = (file: string) => ({
  exec: { command: 'true' },
  inputs: { files: [file] },
  outputs: { files: [] },
  cache: true,
})

function node(id: string, file: string, deps: string[] = []): TaskNode {
  return {
    id,
    projectName: 'app',
    projectDir: '/w/app',
    taskName: id.split('#')[1]!,
    config: cached(file),
    deps,
    requested: false,
  } as unknown as TaskNode
}

// `zero.txt` changed in `app`; a cached task of it declares the path, so the
// project is not reached whole and only the task declaring it is seeded.
const changes: AffectedChanges = {
  projects: new Set(['app']),
  changed: ['app/zero.txt'],
  paths: new Map([['app', ['zero.txt']]]),
  whole: new Set(),
}
const projects = new Map([
  ['app', { name: 'app', dir: '/w/app', config: { tasks: { zero: cached('zero.txt') } } }],
]) as unknown as ReadonlyMap<string, ProjectEntry>
const packageGraph = {
  edgeSource: true,
  directDeps: () => [],
  dependentsOf: () => new Set(),
} as unknown as PackageGraph

describe('affectedRoots', () => {
  it('a 50,000-deep chain seeded at its bottom reaches its top', () => {
    const DEPTH = 50_000
    const nodes = new Map<string, TaskNode>()
    for (let i = 0; i < DEPTH; i++) {
      nodes.set(
        `app#t${i}`,
        i + 1 < DEPTH
          ? node(`app#t${i}`, 'other.txt', [`app#t${i + 1}`])
          : node(`app#t${i}`, 'zero.txt'),
      )
    }
    nodes.set('app#aside', node('app#aside', 'other.txt'))
    expect(
      affectedRoots(nodes, ['app#t0', 'app#aside'], changes, projects, packageGraph, '/w'),
    ).toEqual(['app#t0'])
  })

  it('a diamond reaches through either arm, and a closure without the seed does not', () => {
    const nodes = new Map<string, TaskNode>([
      ['app#top', node('app#top', 'other.txt', ['app#left', 'app#right'])],
      ['app#left', node('app#left', 'other.txt', ['app#base'])],
      ['app#right', node('app#right', 'other.txt', ['app#seed', 'app#base'])],
      ['app#base', node('app#base', 'other.txt')],
      ['app#seed', node('app#seed', 'zero.txt')],
      ['app#side', node('app#side', 'other.txt', ['app#left'])],
    ])
    expect(
      affectedRoots(
        nodes,
        ['app#side', 'app#top', 'app#left', 'app#seed'],
        changes,
        projects,
        packageGraph,
        '/w',
      ),
    ).toEqual(['app#top', 'app#seed'])
  })

  // `top#lint`'s `^lint` passes through `mid`. Loaded with no `lint`, `mid`
  // folds nothing into the key, so its change reaches nothing; not loaded (a
  // scoped load), it may hold the task, so its change still reaches it.
  it('a ^name passed through a package reaches the task only when it loaded no config', () => {
    const top = {
      ...node('top#lint', 'other.txt'),
      projectName: 'top',
      config: { ...cached('other.txt'), dependsOn: ['^lint'] },
    } as TaskNode
    const midChanged: AffectedChanges = {
      projects: new Set(['mid']),
      changed: ['mid/a.ts'],
      paths: new Map([['mid', ['a.ts']]]),
      whole: new Set(),
    }
    const graph = {
      edgeSource: true,
      directDeps: (p: string) => (p === 'top' ? ['mid'] : []),
      dependentsOf: (names: Iterable<string>) => new Set([...names].includes('mid') ? ['top'] : []),
    } as unknown as PackageGraph
    const loaded = (withMid: boolean) =>
      new Map([
        ['top', { name: 'top', dir: '/w/top', config: { tasks: { lint: top.config } } }],
        ...(withMid
          ? [['mid', { name: 'mid', dir: '/w/mid', config: { tasks: {} } }] as const]
          : []),
      ]) as unknown as ReadonlyMap<string, ProjectEntry>
    const nodes = new Map([['top#lint', top]])
    expect([
      affectedRoots(nodes, ['top#lint'], midChanged, loaded(true), graph, '/w'),
      affectedRoots(nodes, ['top#lint'], midChanged, loaded(false), graph, '/w'),
    ]).toEqual([[], ['top#lint']])
  })
})

// An untracked file no task declares reaches the project whole, but a
// declared input that also changed is the precise reason: `--dry` named the
// stray output (`kind: project`) and sent the user looking at the wrong file.
// M, 2026-11-25: the affected projects are the changed ones and their package
// dependants, and only their tasks are scanned. There a task with inputs runs
// when they match or through its deps, and one with `exec` and no `inputs`
// runs; in a project outside that set nothing is scanned.
describe('affectedRoots: the affected projects', () => {
  const at = (id: string, config: Record<string, unknown>, deps: string[] = []): TaskNode => {
    const projectName = id.split('#')[0]!
    return {
      ...node(id, 'x', deps),
      projectName,
      projectDir: `/w/${projectName}`,
      config,
    } as TaskNode
  }
  const bare = { exec: { command: 'true' } }
  const nodes = new Map<string, TaskNode>([
    ['a#build', at('a#build', cached('src/**'))],
    ['b#check', at('b#check', cached('nope/**'))],
    ['b#lint', at('b#lint', bare)],
    ['b#test', at('b#test', cached('nope/**'), ['a#build'])],
    ['c#lint', at('c#lint', bare)],
  ])
  const aChanged: AffectedChanges = {
    projects: new Set(['a']),
    changed: ['a/src/x.ts'],
    paths: new Map([['a', ['src/x.ts']]]),
    whole: new Set(),
  }
  const graph = {
    edgeSource: true,
    directDeps: (p: string) => (p === 'b' ? ['a'] : []),
    dependentsOf: (names: Iterable<string>) => new Set([...names].includes('a') ? ['b'] : []),
  } as unknown as PackageGraph
  const loaded = new Map(
    ['a', 'b', 'c'].map((n) => [n, { name: n, dir: `/w/${n}`, config: { tasks: {} } }]),
  ) as unknown as ReadonlyMap<string, ProjectEntry>

  it('B depends on A: its no-input task and its task on A#build run, its unmatched one does not', () => {
    expect(affectedRoots(nodes, [...nodes.keys()], aChanged, loaded, graph, '/w')).toEqual([
      'a#build',
      'b#lint',
      'b#test',
    ])
  })

  it('a config edit alone makes no project affected', () => {
    const configOnly: AffectedChanges = {
      projects: new Set(['a']),
      changed: ['a/vx.config.ts', '.vx/workspace.ts'],
      paths: new Map([['a', ['vx.config.ts']]]),
      whole: new Set(),
    }
    const all = new Map([...nodes, ['a#all', at('a#all', cached('**'))]])
    expect(affectedRoots(all, [...all.keys()], configOnly, loaded, graph, '/w')).toEqual([])
  })
})

describe('affectedRoots reasons', () => {
  it('a changed declared input is the reason, not an unclaimed path beside it', () => {
    const both: AffectedChanges = {
      projects: new Set(['app']),
      changed: ['app/dist/out.js', 'app/zero.txt'],
      paths: new Map([['app', ['dist/out.js', 'zero.txt']]]),
      untracked: new Set(['app/dist/out.js']),
      untrackedIn: new Map([['app', new Set(['dist/out.js'])]]),
      whole: new Set(),
    }
    const nodes = new Map<string, TaskNode>([['app#zero', node('app#zero', 'zero.txt')]])
    const explain = { reasons: new Map() }
    expect(affectedRoots(nodes, ['app#zero'], both, projects, packageGraph, '/w', explain)).toEqual(
      ['app#zero'],
    )
    expect(explain.reasons.get('app#zero')).toEqual({ kind: 'input', file: 'app/zero.txt' })
  })
})
