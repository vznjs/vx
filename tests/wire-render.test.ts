import { describe, it, expect } from 'bun:test'
import { isGroupTask, type TaskNode, type TaskOutcome } from '../src/graph/index.js'
import { createWireRenderer, type Logger, type WireEvent } from '../src/orchestrator/index.js'
import type { TaskView } from '../src/orchestrator/index.js'

function view(over: Partial<TaskView> & { id: string }): TaskView {
  return {
    project: over.id.split('#')[0]!,
    task: over.id.split('#')[1]!,
    isGroup: false,
    requested: false,
    surfaced: false,
    persistent: false,
    ...over,
  }
}

describe('createWireRenderer', () => {
  it('reconstructs nodes/outcomes and drives the sink in order', () => {
    const calls: string[] = []
    let startNode: TaskNode | undefined
    let completeOutcome: TaskOutcome | undefined
    const sink: Logger = {
      runStart: (info) => calls.push(`runStart:${info.total}`),
      taskStart: (n) => {
        startNode = n
        calls.push(`taskStart:${n.id}`)
      },
      taskStdout: (n, c) => calls.push(`stdout:${n.id}:${c}`),
      taskStderr: () => {},
      taskComplete: (n, o) => {
        completeOutcome = o
        calls.push(`complete:${n.id}:${o.status}`)
      },
      status: (l) => calls.push(`status:${l}`),
      runEnd: () => calls.push('runEnd'),
    }
    const render = createWireRenderer(sink)

    const events: WireEvent[] = [
      { kind: 'run:start', info: { total: 1 } },
      { kind: 'task:start', task: view({ id: 'web#build', requested: true, command: 'tsc -b' }) },
      { kind: 'task:stdout', taskId: 'web#build', chunk: 'compiling' },
      {
        kind: 'task:complete',
        outcome: { taskId: 'web#build', status: 'success', exitCode: 0, durationMs: 12 },
      },
      { kind: 'run:end' },
    ]
    for (const e of events) render(e)

    expect(calls).toEqual([
      'runStart:1',
      'taskStart:web#build',
      'stdout:web#build:compiling',
      'complete:web#build:success',
      'runEnd',
    ])
    // The reconstructed node is indistinguishable from a real one to the
    // formatters: non-group (exec present), carries project/task/command.
    expect(startNode!.projectName).toBe('web')
    expect(isGroupTask(startNode!)).toBe(false)
    expect(startNode!.config.exec?.command).toBe('tsc -b')
    expect(completeOutcome!.node).toBe(startNode!)
    expect(completeOutcome!.durationMs).toBe(12)
  })

  it('reconstructs a group task as exec-less (isGroupTask true)', () => {
    let node: TaskNode | undefined
    const sink: Logger = {
      taskStart: (n) => (node = n),
      taskStdout: () => {},
      taskStderr: () => {},
      taskComplete: () => {},
      status: () => {},
    }
    createWireRenderer(sink)({ kind: 'task:start', task: view({ id: 'web#ci', isGroup: true }) })
    expect(isGroupTask(node!)).toBe(true)
  })

  it('ignores task events for an unknown id (no start seen)', () => {
    let completed = false
    const sink: Logger = {
      taskStdout: () => {},
      taskStderr: () => {},
      taskComplete: () => (completed = true),
      status: () => {},
    }
    const render = createWireRenderer(sink)
    render({ kind: 'task:stdout', taskId: 'ghost#x', chunk: 'c' })
    render({
      kind: 'task:complete',
      outcome: { taskId: 'ghost#x', status: 'success', exitCode: 0, durationMs: 1 },
    })
    expect(completed).toBe(false)
  })
})
