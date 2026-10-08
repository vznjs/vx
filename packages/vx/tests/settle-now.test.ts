import { describe, expect, it } from 'bun:test'
import { runGraph, type TaskOutcome } from '../src/graph/scheduler.js'
import type { TaskNode } from '../src/graph/task-graph.js'

function node(id: string, deps: string[] = []): TaskNode {
  return {
    id,
    projectName: id.split('#')[0]!,
    projectDir: '/tmp',
    taskName: id.split('#')[1]!,
    config: { exec: { command: 'noop' } },
    deps,
    requested: true,
  }
}

const outcome = (n: TaskNode, status: TaskOutcome['status'] = 'success'): TaskOutcome => ({
  node: n,
  status,
  exitCode: status === 'success' ? 0 : 1,
  durationMs: 0,
  hash: `h-${n.id}`,
})

function graph(...ns: TaskNode[]): Map<string, TaskNode> {
  return new Map(ns.map((n) => [n.id, n]))
}

describe('ScheduleOptions.settleNow (X-192)', () => {
  it('settles a task in place: no execute, observers hear it, dependents see its outcome', async () => {
    const a = node('a#build')
    const g = node('a#group', ['a#build'])
    const t = node('a#test', ['a#group'])
    const executed: string[] = []
    const started: string[] = []
    const finished: string[] = []
    const asked: string[] = []
    let upstreamOfTest: TaskOutcome[] = []
    const out = await runGraph({
      nodes: graph(a, g, t),
      concurrency: 1,
      execute: async (n, upstream) => {
        executed.push(n.id)
        if (n.id === 'a#test') upstreamOfTest = upstream
        return outcome(n)
      },
      settleNow: (n, upstream) => {
        asked.push(n.id)
        if (n.id !== 'a#group') return undefined
        expect(upstream.map((u) => u.node.id)).toEqual(['a#build'])
        return { ...outcome(n), hash: 'settled' }
      },
      onStart: (n) => started.push(n.id),
      onFinish: (o) => finished.push(o.node.id),
    })
    expect(executed).toEqual(['a#build', 'a#test'])
    expect(asked).toEqual(['a#build', 'a#group', 'a#test'])
    expect(started).toEqual(['a#build', 'a#group', 'a#test'])
    expect(finished).toEqual(['a#build', 'a#group', 'a#test'])
    expect(out.get('a#group')!.hash).toBe('settled')
    expect(upstreamOfTest.map((u) => u.hash)).toEqual(['settled'])
  })

  it('dispatches a task whose settleNow throws', async () => {
    const g = node('a#group')
    const executed: string[] = []
    const out = await runGraph({
      nodes: graph(g),
      concurrency: 1,
      execute: async (n) => {
        executed.push(n.id)
        return outcome(n)
      },
      settleNow: () => {
        throw new Error('boom')
      },
    })
    expect(executed).toEqual(['a#group'])
    expect(out.get('a#group')!.status).toBe('success')
  })

  it('never asks of a restore-tier task or one a failed dependency skips', async () => {
    const r = node('a#build')
    const f = node('b#build')
    const s = node('b#group', ['b#build'])
    const asked: string[] = []
    const out = await runGraph({
      nodes: graph(r, f, s),
      concurrency: 2,
      restoreTier: new Set(['a#build']),
      execute: async (n) => outcome(n, n.id === 'b#build' ? 'failed' : 'success'),
      settleNow: (n) => {
        asked.push(n.id)
        return undefined
      },
    })
    expect(asked).toEqual(['b#build'])
    expect(out.get('a#build')!.status).toBe('success')
    expect(out.get('b#group')!.status).toBe('skipped')
  })
})
