import { describe, it, expect } from 'bun:test'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import type { Logger } from '../src/orchestrator/index.js'
import {
  busLogger,
  createEventBus,
  projectNode,
  projectOutcome,
  terminalSubscriber,
  toWireEvent,
  type RunEvent,
} from '../src/orchestrator/events.js'

function mkNode(partial: {
  id: string
  command?: string
  persistent?: boolean
  requested?: boolean
  surfaced?: boolean
}): TaskNode {
  const [projectName, taskName] = partial.id.split('#') as [string, string]
  const exec =
    partial.command === undefined
      ? undefined
      : {
          command: partial.command,
          ...(partial.persistent ? { persistent: { readyWhen: 'up' } } : {}),
        }
  return {
    id: partial.id,
    projectName,
    taskName,
    config: exec === undefined ? {} : { exec },
    requested: partial.requested ?? false,
    ...(partial.surfaced !== undefined ? { surfaced: partial.surfaced } : {}),
  } as unknown as TaskNode
}

function mkOutcome(node: TaskNode, over: Partial<TaskOutcome> = {}): TaskOutcome {
  return {
    node,
    status: 'success',
    exitCode: 0,
    durationMs: 42,
    ...over,
  } as TaskOutcome
}

describe('createEventBus', () => {
  it('fans out events to subscribers in emission order', () => {
    const bus = createEventBus()
    const seen: string[] = []
    bus.subscribe((e) => seen.push(e.kind))
    bus.emit({ kind: 'run:start', info: { total: 1 } })
    bus.emit({ kind: 'task:start', node: mkNode({ id: 'a#build', command: 'x' }) })
    bus.emit({ kind: 'run:end' })
    expect(seen).toEqual(['run:start', 'task:start', 'run:end'])
  })

  it('delivers to multiple subscribers in subscription order', () => {
    const bus = createEventBus()
    const order: string[] = []
    bus.subscribe(() => order.push('first'))
    bus.subscribe(() => order.push('second'))
    bus.emit({ kind: 'run:end' })
    expect(order).toEqual(['first', 'second'])
  })

  it('the disposer removes a subscriber', () => {
    const bus = createEventBus()
    let count = 0
    const dispose = bus.subscribe(() => count++)
    bus.emit({ kind: 'run:end' })
    dispose()
    bus.emit({ kind: 'run:end' })
    expect(count).toBe(1)
  })
})

describe('busLogger + terminalSubscriber', () => {
  it('drives a concrete renderer identically to direct calls', () => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const record =
      (method: string) =>
      (...args: unknown[]) =>
        calls.push({ method, args })
    const sink: Logger = {
      status: record('status'),
      taskStdout: record('taskStdout'),
      taskStderr: record('taskStderr'),
      taskComplete: record('taskComplete'),
      runStart: record('runStart'),
      taskStart: record('taskStart'),
      runEnd: record('runEnd'),
    }
    const bus = createEventBus()
    bus.subscribe(terminalSubscriber(sink))
    const log = busLogger(bus)

    const node = mkNode({ id: 'a#build', command: 'tsc', requested: true })
    const outcome = mkOutcome(node)
    log.runStart?.({ total: 1, concurrency: 4 })
    log.taskStart?.(node)
    log.taskStdout(node, 'hello')
    log.taskStderr(node, 'warn')
    log.taskComplete(node, outcome)
    log.status('done')
    log.runEnd?.()

    expect(calls.map((c) => c.method)).toEqual([
      'runStart',
      'taskStart',
      'taskStdout',
      'taskStderr',
      'taskComplete',
      'status',
      'runEnd',
    ])
    // Live refs pass through untouched (zero-copy in-process path).
    expect(calls[1]!.args[0]).toBe(node)
    expect(calls[2]!.args).toEqual([node, 'hello'])
    expect(calls[4]!.args[0]).toBe(node)
    expect(calls[4]!.args[1]).toBe(outcome)
  })

  it('omits optional hooks a custom logger does not implement', () => {
    const statusCalls: string[] = []
    // No runStart / taskStart / runEnd — a minimal embedder logger.
    const sink: Logger = {
      status: (l) => statusCalls.push(l),
      taskStdout: () => {},
      taskStderr: () => {},
      taskComplete: () => {},
    }
    const bus = createEventBus()
    bus.subscribe(terminalSubscriber(sink))
    const log = busLogger(bus)
    // These must not throw despite the missing optional hooks.
    log.runStart?.({ total: 0 })
    log.taskStart?.(mkNode({ id: 'a#b', command: 'x' }))
    log.runEnd?.()
    log.status('ok')
    expect(statusCalls).toEqual(['ok'])
  })
})

describe('projectNode', () => {
  it('projects a non-group task to its display fields', () => {
    const view = projectNode(
      mkNode({ id: 'web#build', command: 'tsc -b', requested: true, surfaced: false }),
    )
    expect(view).toEqual({
      id: 'web#build',
      project: 'web',
      task: 'build',
      isGroup: false,
      requested: true,
      surfaced: false,
      persistent: false,
      command: 'tsc -b',
    })
  })

  it('marks group tasks (no exec) and omits the command', () => {
    const view = projectNode(mkNode({ id: 'web#ci' }))
    expect(view.isGroup).toBe(true)
    expect(view.persistent).toBe(false)
    expect('command' in view).toBe(false)
  })

  it('flags persistent + surfaced tasks', () => {
    const view = projectNode(
      mkNode({ id: 'web#dev', command: 'vite', persistent: true, surfaced: true }),
    )
    expect(view.persistent).toBe(true)
    expect(view.surfaced).toBe(true)
  })

  it('is JSON-serializable', () => {
    const view = projectNode(mkNode({ id: 'a#b', command: 'x' }))
    expect(() => JSON.stringify(view)).not.toThrow()
  })
})

describe('projectOutcome', () => {
  it('drops the node ref and encodes bigint ns as decimal strings', () => {
    const node = mkNode({ id: 'a#build', command: 'x' })
    const raw = mkOutcome(node, {
      status: 'cache-hit',
      restored: false,
      hash: 'deadbeef',
      cpuMs: 12,
      peakRssBytes: 9999,
      wallclockStartNs: 1000n,
      wallclockEndNs: 2500n,
    })
    const view = projectOutcome(raw)
    expect('node' in view).toBe(false)
    expect(view.taskId).toBe('a#build')
    expect(view.wallclockStartNs).toBe('1000')
    expect(view.wallclockEndNs).toBe('2500')
    expect(view.restored).toBe(false)
    expect(view.hash).toBe('deadbeef')
  })

  it('the raw outcome is NOT JSON-serializable (bigint throws); the projection is', () => {
    const node = mkNode({ id: 'a#build', command: 'x' })
    const raw = mkOutcome(node, { wallclockStartNs: 1n, wallclockEndNs: 2n })
    expect(() => JSON.stringify(raw)).toThrow()
    const view = projectOutcome(raw)
    expect(JSON.parse(JSON.stringify(view))).toEqual(view)
  })

  it('omits absent optional fields', () => {
    const view = projectOutcome(mkOutcome(mkNode({ id: 'a#b', command: 'x' })))
    expect(view).toEqual({ taskId: 'a#b', status: 'success', exitCode: 0, durationMs: 42 })
  })
})

describe('toWireEvent', () => {
  it('maps every event kind to a JSON-safe wire form', () => {
    const node = mkNode({ id: 'a#build', command: 'x' })
    const events: RunEvent[] = [
      { kind: 'run:start', info: { total: 1 } },
      { kind: 'task:start', node },
      { kind: 'task:stdout', node, chunk: 'out' },
      { kind: 'task:stderr', node, chunk: 'err' },
      { kind: 'task:complete', node, outcome: mkOutcome(node, { wallclockStartNs: 5n }) },
      { kind: 'run:status', line: 'hi' },
      { kind: 'run:end' },
    ]
    for (const e of events) {
      const wire = toWireEvent(e)
      expect(() => JSON.stringify(wire)).not.toThrow()
    }
  })

  it('carries the task table on run:start and ids elsewhere', () => {
    const node = mkNode({ id: 'a#build', command: 'x' })
    const tasks = [projectNode(node)]
    const start = toWireEvent({ kind: 'run:start', info: { total: 1 } }, tasks)
    expect(start).toEqual({ kind: 'run:start', info: { total: 1 }, tasks })

    const stdout = toWireEvent({ kind: 'task:stdout', node, chunk: 'c' })
    expect(stdout).toEqual({ kind: 'task:stdout', taskId: 'a#build', chunk: 'c' })

    const complete = toWireEvent({ kind: 'task:complete', node, outcome: mkOutcome(node) })
    expect(complete).toEqual({ kind: 'task:complete', outcome: projectOutcome(mkOutcome(node)) })
  })
})
