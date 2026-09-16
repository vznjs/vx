// `pinnedLocalSet` is the one rule that keeps a task off every remote
// executor. Two site pages and the local-floor post said a sandboxed task
// runs here because the sandbox is this machine's machinery; the set had no
// such rule until 2026-09-16 (item 335), so a sandboxed cacheable task was
// offered to a remote executor that enforces no sandbox and reports no
// violations.
import { describe, expect, it } from 'bun:test'
import { pinnedLocalSet } from '../src/orchestrator/placement.js'
import type { TaskNode } from '../src/graph/task-graph.js'

function node(id: string, exec: Record<string, unknown>, deps: string[] = []): TaskNode {
  return {
    id,
    projectName: id.split('#')[0]!,
    taskName: id.split('#')[1]!,
    projectDir: '/w/' + id.split('#')[0]!,
    deps,
    config: { exec: { command: 'true', ...exec } },
  } as unknown as TaskNode
}

const graph = (...nodes: TaskNode[]): Map<string, TaskNode> => new Map(nodes.map((n) => [n.id, n]))

describe('pinnedLocalSet', () => {
  it('a plain task is not pinned (control)', () => {
    expect(pinnedLocalSet(graph(node('a#build', {})))).toEqual(new Set())
  })

  it('a persistent task, and everything depending on it, is pinned', () => {
    const set = pinnedLocalSet(
      graph(
        node('a#dev', { persistent: {} }),
        node('b#e2e', {}, ['a#dev']),
        node('c#test', {}, ['b#e2e']),
        node('d#build', {}),
      ),
    )
    expect([...set].sort()).toEqual(['a#dev', 'b#e2e', 'c#test'])
  })

  it('exec.remote: false pins the task and its dependants', () => {
    const set = pinnedLocalSet(
      graph(node('a#build', { remote: false }), node('b#test', {}, ['a#build'])),
    )
    expect([...set].sort()).toEqual(['a#build', 'b#test'])
  })

  it("a sandboxed task is pinned: the sandbox is this machine's machinery", () => {
    const set = pinnedLocalSet(graph(node('a#build', { sandbox: { allow: { read: [] } } })))
    expect([...set]).toEqual(['a#build'])
  })

  it('a dependant of a sandboxed task is pinned with it', () => {
    const set = pinnedLocalSet(
      graph(node('a#build', { sandbox: {} }), node('b#test', {}, ['a#build']), node('c#lint', {})),
    )
    expect([...set].sort()).toEqual(['a#build', 'b#test'])
  })
})
