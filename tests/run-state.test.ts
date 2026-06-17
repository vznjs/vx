import { describe, it, expect } from 'bun:test'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import type { RunEvent } from '../src/orchestrator/events.js'
import { initRunState, reduce, type RunState } from '../src/orchestrator/run-state.js'

function mkNode(id: string, opts: { group?: boolean; persistent?: boolean } = {}): TaskNode {
  const [projectName, taskName] = id.split('#') as [string, string]
  const config = opts.group
    ? {}
    : { exec: { command: 'x', ...(opts.persistent ? { persistent: { readyWhen: 'up' } } : {}) } }
  return { id, projectName, taskName, config, requested: false } as unknown as TaskNode
}

function complete(node: TaskNode, over: Partial<TaskOutcome>): RunEvent {
  return {
    kind: 'task:complete',
    node,
    outcome: { node, status: 'success', exitCode: 0, durationMs: 10, ...over } as TaskOutcome,
  }
}

function fold(events: RunEvent[], start = initRunState()): RunState {
  return events.reduce(reduce, start)
}

describe('reduce', () => {
  it('run:start resets and sets the total', () => {
    const dirty = { ...initRunState(), done: 5, failed: 2 }
    const s = reduce(dirty, { kind: 'run:start', info: { total: 7 } })
    expect(s.total).toBe(7)
    expect(s.done).toBe(0)
    expect(s.failed).toBe(0)
  })

  it('tracks running tasks across start/complete', () => {
    const node = mkNode('a#build')
    let s = reduce(initRunState(1), { kind: 'task:start', node })
    expect(s.running).toEqual(['a#build'])
    expect(s.tasks['a#build']!.state).toBe('running')
    s = reduce(s, complete(node, { status: 'success', durationMs: 30 }))
    expect(s.running).toEqual([])
    expect(s.tasks['a#build']).toEqual({ id: 'a#build', state: 'success', durationMs: 30 })
    expect(s.done).toBe(1)
    expect(s.succeeded).toBe(1)
  })

  it('partitions cache outcomes by restored flag', () => {
    const s = fold([
      complete(mkNode('a#b'), { status: 'cache-hit', restored: true }),
      complete(mkNode('c#d'), { status: 'cache-hit', restored: false }),
      complete(mkNode('e#f'), { status: 'cache-hit-remote', restored: true }),
      complete(mkNode('g#h'), { status: 'cache-hit-remote', restored: false }),
    ])
    expect(s.restoredLocal).toBe(1)
    expect(s.upToDate).toBe(2)
    expect(s.restoredRemote).toBe(1)
    expect(s.done).toBe(4)
  })

  it('counts failed + skipped and folds spread over success+failed only', () => {
    const s = fold([
      complete(mkNode('a#b'), { status: 'success', durationMs: 10 }),
      complete(mkNode('c#d'), { status: 'failed', exitCode: 1, durationMs: 40 }),
      complete(mkNode('e#f'), { status: 'skipped', durationMs: 0 }),
      complete(mkNode('g#h'), { status: 'cache-hit', restored: true, durationMs: 999 }),
    ])
    expect(s.failed).toBe(1)
    expect(s.skipped).toBe(1)
    // spread excludes the skip and the cache hit.
    expect(s.spread).toEqual({ maxMs: 40, minMs: 10, sumMs: 50, count: 2 })
  })

  it('ignores group tasks entirely', () => {
    const group = mkNode('a#ci', { group: true })
    let s = reduce(initRunState(1), { kind: 'task:start', node: group })
    s = reduce(s, complete(group, { status: 'success' }))
    expect(s.done).toBe(0)
    expect(s.running).toEqual([])
    expect(s.tasks).toEqual({})
  })

  it('reverts an aborted task to pending — freed, uncounted, dropped', () => {
    const node = mkNode('a#build')
    let s = reduce(initRunState(1), { kind: 'task:start', node })
    s = reduce(s, complete(node, { status: 'aborted', exitCode: 143 }))
    expect(s.done).toBe(0)
    expect(s.failed).toBe(0)
    expect(s.running).toEqual([])
    expect('a#build' in s.tasks).toBe(false)
  })

  it('flags a persistent task left running after a success outcome', () => {
    const node = mkNode('a#dev', { persistent: true })
    const s = reduce(initRunState(1), complete(node, { status: 'success' }))
    expect(s.tasks['a#dev']!.persistent).toBe(true)
  })

  it('is pure — never mutates the previous state', () => {
    const prev = initRunState(1)
    const frozen = JSON.stringify(prev)
    reduce(prev, complete(mkNode('a#b'), { status: 'success' }))
    expect(JSON.stringify(prev)).toBe(frozen)
  })
})
