// The graph explorer's model (src/components/demos/model/graph-explorer.ts)
// over a plan in `vx run … --dry=json`'s shape: the toy monorepo the Learn
// pages draw (app uses ui and api, both use utils; docs waits on nothing).

import { describe, expect, it } from 'bun:test'
import {
  parsePlan,
  search,
  statusWords,
  upstream,
  whyDepends,
  type Graph,
} from '../src/components/demos/model/graph-explorer.js'

const task = (id: string, deps: string[], cacheStatus = 'miss') => ({
  id,
  project: id.split('#')[0],
  task: id.split('#')[1],
  hash: '0123456789abcdef',
  cacheStatus,
  deps,
})

const PLAN = JSON.stringify({
  tasks: [
    task('utils#build', [], 'hit-local'),
    task('ui#build', ['utils#build']),
    task('api#build', ['utils#build']),
    task('app#build', ['ui#build', 'api#build']),
    task('app#test', ['app#build'], 'no-cache'),
    task('docs#build', []),
    task('app#ci', ['app#test'], 'group'),
  ],
  predicted: { wallMs: 10, workMs: 20, criticalPath: ['utils#build', 'ui#build', 'app#build'] },
})

const graph = parsePlan(PLAN) as Graph

describe('parsePlan', () => {
  it('reads tasks, the reverse edges and the critical path', () => {
    expect(graph.tasks.size).toBe(7)
    expect(graph.dependents.get('utils#build')).toEqual(['ui#build', 'api#build'])
    expect(graph.dependents.get('docs#build')).toBeUndefined()
    expect(graph.criticalPath).toEqual(['utils#build', 'ui#build', 'app#build'])
  })

  it('says in one line what the text is when it is no plan', () => {
    expect(parsePlan('vx run build')).toEqual({ error: expect.stringContaining('Not JSON') })
    expect(parsePlan('{"ok":false,"error":{}}')).toEqual({
      error: expect.stringContaining('vx error'),
    })
    expect(parsePlan('[{"name":"a"}]')).toEqual({ error: expect.stringContaining('"tasks"') })
    expect(parsePlan('{"tasks":[{"name":"a"}]}')).toEqual({
      error: expect.stringContaining('"id"'),
    })
  })
})

describe('questions the page answers', () => {
  it('search matches every word, ids sorted', () => {
    expect(search(graph, 'app')).toEqual(['app#build', 'app#ci', 'app#test'])
    expect(search(graph, 'BUILD api')).toEqual(['api#build'])
    expect(search(graph, 'nothing')).toEqual([])
  })

  it('why A waits on B is the shortest chain of deps', () => {
    expect(whyDepends(graph, 'app#ci', 'utils#build')).toEqual([
      'app#ci',
      'app#test',
      'app#build',
      'ui#build',
      'utils#build',
    ])
    expect(whyDepends(graph, 'app#build', 'app#build')).toEqual(['app#build'])
    // CONTROL: edges point one way; utils never waits on app, docs on nothing.
    expect(whyDepends(graph, 'utils#build', 'app#build')).toBeNull()
    expect(whyDepends(graph, 'docs#build', 'utils#build')).toBeNull()
    expect(whyDepends(graph, 'app#build', 'missing#x')).toBeNull()
  })

  it('upstream is everything a task waits on, through others', () => {
    expect([...upstream(graph, 'app#test')].sort()).toEqual([
      'api#build',
      'app#build',
      'ui#build',
      'utils#build',
    ])
    expect(upstream(graph, 'docs#build').size).toBe(0)
  })

  it('names each predicted status in words', () => {
    expect(statusWords('hit-local')).toBe('cache hit (this machine)')
    expect(statusWords('group')).toBe('group: runs nothing itself')
    expect(statusWords('new-kind')).toBe('new-kind')
  })
})
