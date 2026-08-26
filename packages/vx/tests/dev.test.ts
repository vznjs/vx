import { describe, it, expect } from 'bun:test'
import { wireForwarder, type WireEvent } from '../src/orchestrator/index.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'

function mkNode(id: string, group = false): TaskNode {
  const [projectName, taskName] = id.split('#') as [string, string]
  return {
    id,
    projectName,
    taskName,
    config: group ? {} : { exec: { command: 'x' } },
    requested: false,
  } as unknown as TaskNode
}

describe('wireForwarder', () => {
  it('drops group-task start/complete and projects the rest', () => {
    const events: WireEvent[] = []
    const fwd = wireForwarder((e) => events.push(e))
    const group = mkNode('a#ci', true)
    const real = mkNode('a#build')
    fwd({ kind: 'task:start', node: group })
    fwd({
      kind: 'task:complete',
      node: group,
      outcome: { node: group, status: 'success', exitCode: 0, durationMs: 0 } as TaskOutcome,
    })
    fwd({ kind: 'task:start', node: real })
    fwd({ kind: 'run:end' })
    expect(events.map((e) => e.kind)).toEqual(['task:start', 'run:end'])
  })

  it('dedupes the double run:end but still forwards the footer status between them', () => {
    const events: WireEvent[] = []
    const fwd = wireForwarder((e) => events.push(e))
    // run() order: run:end, summary footer (run:status), run:end again.
    fwd({ kind: 'run:end' })
    fwd({ kind: 'run:status', line: 'summary' })
    fwd({ kind: 'run:end' })
    expect(events.map((e) => e.kind)).toEqual(['run:end', 'run:status'])
  })
})
