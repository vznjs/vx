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
  cache: { inputs: { files: [file] }, outputs: { files: [] } },
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
const packageGraph = { directDeps: () => [] } as unknown as PackageGraph

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
    expect(affectedRoots(nodes, ['app#t0', 'app#aside'], changes, projects, packageGraph)).toEqual([
      'app#t0',
    ])
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
      ),
    ).toEqual(['app#top', 'app#seed'])
  })
})
