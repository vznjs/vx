import { describe, it, expect } from 'bun:test'
import type { DevframeNodeContext } from 'devframe'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { createEventBus, type WireEvent } from '../src/orchestrator/events.js'
import { createVxSurface } from '../src/orchestrator/devframe-surface.js'
import { initRunState, type RunState } from '../src/orchestrator/run-state.js'

function mkNode(id: string): TaskNode {
  const [projectName, taskName] = id.split('#') as [string, string]
  return {
    id,
    projectName,
    taskName,
    config: { exec: { command: 'x' } },
    requested: false,
  } as unknown as TaskNode
}

/**
 * A mock devframe ctx that captures the stream writes and holds a plain
 * RunState the surface mutates — so we exercise OUR translation logic
 * (events → stream + reduced state) without booting devframe's runtime
 * (whose 0.5.x shared-state/host paths have known rough edges).
 */
function mockCtx() {
  const writes: WireEvent[] = []
  let closed = false
  // Mirror the real devframe sink: writing after close throws
  // (StreamClosedError). Lets us pin that the surface stops on run:end.
  const sink = {
    write: (c: WireEvent) => {
      if (closed) throw new Error('Cannot write to a closed stream')
      writes.push(c)
    },
    close: () => (closed = true),
    error: () => {},
  }
  const channel = { name: 'vx:events', start: () => sink }
  const stateValue = initRunState()
  const sharedState = {
    value: () => stateValue,
    mutate: (fn: (draft: RunState) => void) => fn(stateValue),
  }
  const ctx = {
    rpc: {
      streaming: { create: () => channel },
      sharedState: { get: async () => sharedState },
    },
  } as unknown as DevframeNodeContext
  return { ctx, writes, state: stateValue, isClosed: () => closed }
}

describe('createVxSurface', () => {
  it('defines the vx devframe surface', () => {
    const def = createVxSurface(createEventBus())
    expect(def.id).toBe('vx')
    expect(typeof def.setup).toBe('function')
  })

  it('forwards bus events onto the stream and reduces into shared state', async () => {
    const bus = createEventBus()
    const def = createVxSurface(bus)
    const m = mockCtx()
    await def.setup(m.ctx)

    const node = mkNode('a#build')
    bus.emit({ kind: 'run:start', info: { total: 1 } })
    bus.emit({ kind: 'task:start', node })
    bus.emit({
      kind: 'task:complete',
      node,
      outcome: { node, status: 'success', exitCode: 0, durationMs: 12 } as TaskOutcome,
    })
    bus.emit({ kind: 'run:end' })

    // Raw wire feed: every event, serialized (ids, not node graphs).
    expect(m.writes.map((w) => w.kind)).toEqual([
      'run:start',
      'task:start',
      'task:complete',
      'run:end',
    ])
    const start = m.writes[1] as Extract<WireEvent, { kind: 'task:start' }>
    expect(start.task.id).toBe('a#build')

    // Reduced aggregate in shared state.
    expect(m.state.total).toBe(1)
    expect(m.state.done).toBe(1)
    expect(m.state.succeeded).toBe(1)
    expect(m.state.running).toEqual([])
    expect(m.state.tasks['a#build']!.state).toBe('success')

    // run:end closes the stream.
    expect(m.isClosed()).toBe(true)
  })

  it('ignores events after run:end (duplicate run:end + trailing status)', async () => {
    const bus = createEventBus()
    const def = createVxSurface(bus)
    const m = mockCtx()
    await def.setup(m.ctx)

    // `run()` emits run:end, then summary status lines, then a second
    // run:end from its finally — all AFTER the stream is closed.
    bus.emit({ kind: 'run:end' })
    expect(() => {
      bus.emit({ kind: 'run:status', line: 'summary' })
      bus.emit({ kind: 'run:end' })
    }).not.toThrow()
    // Only the first run:end was written; nothing after close.
    expect(m.writes.map((w) => w.kind)).toEqual(['run:end'])
  })
})
