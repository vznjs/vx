// TUI store / reducer tests. Pure function over a State + Action;
// no renderer involvement. See docs/design/tui-design.md §4.

import { describe, expect, it } from 'bun:test'
import { initialState, reduce, type Action } from '../src/tui/state/store.ts'
import type { ObserverEvent } from '../src/orchestrator/observer.ts'
import type { TaskNode } from '../src/graph/task-graph.js'

const tnode = (id: string, deps: string[] = [], persistent = false): TaskNode => ({
  id,
  projectName: id.split('#')[0]!,
  projectDir: '/tmp',
  taskName: id.split('#')[1]!,
  config: {
    exec: {
      command: 'noop',
      ...(persistent ? { persistent: { readyWhen: '.+' } } : {}),
    },
  },
  deps,
  requested: true,
})

const event = (e: ObserverEvent): Action => ({ type: 'event', event: e })

describe('reduce — runStart', () => {
  it('initializes from runStart', () => {
    const s0 = initialState()
    const s1 = reduce(
      s0,
      event({
        kind: 'runStart',
        runId: '01',
        nodes: [tnode('a#build'), tnode('b#build', ['a#build'])],
        concurrency: 4,
        remoteCacheEnabled: true,
        startedAtMs: 1000,
        historyTable: new Map(),
      }),
    )
    expect(s1.runId).toBe('01')
    expect(s1.totalNodes).toBe(2)
    expect(s1.concurrency).toBe(4)
    expect(s1.remoteCacheEnabled).toBe(true)
    expect(s1.tasks.size).toBe(2)
    expect(s1.tasks.get('a#build')?.status).toBe('waiting')
    expect(s1.workerSlots.length).toBe(4)
    expect(s1.workerSlots.every((slot) => slot.taskId === null)).toBe(true)
    expect(s1.dirty).toBe(true)
  })
})

describe('reduce — taskStart / taskComplete', () => {
  const seed = (): ReturnType<typeof reduce> =>
    reduce(
      initialState(),
      event({
        kind: 'runStart',
        runId: '01',
        nodes: [tnode('a#build'), tnode('b#build', ['a#build'])],
        concurrency: 2,
        remoteCacheEnabled: false,
        startedAtMs: 0,
        historyTable: new Map(),
      }),
    )

  it('moves a task to running and assigns its slot', () => {
    const s1 = reduce(seed(), event({ kind: 'taskStart', nodeId: 'a#build', startNs: 1n, slot: 0 }))
    const t = s1.tasks.get('a#build')!
    expect(t.status).toBe('running')
    expect(t.startNs).toBe(1n)
    expect(s1.workerSlots[0]?.taskId).toBe('a#build')
  })

  it('moves a task to its terminal status on taskComplete and frees the slot', () => {
    const s1 = reduce(seed(), event({ kind: 'taskStart', nodeId: 'a#build', startNs: 1n, slot: 0 }))
    const s2 = reduce(
      s1,
      event({
        kind: 'taskComplete',
        outcome: {
          node: tnode('a#build'),
          status: 'success',
          exitCode: 0,
          durationMs: 42,
          wallclockEndNs: 100n,
        },
      }),
    )
    expect(s2.tasks.get('a#build')?.status).toBe('success')
    expect(s2.tasks.get('a#build')?.endNs).toBe(100n)
    expect(s2.workerSlots[0]?.taskId).toBeNull()
  })
})

describe('reduce — log buffering', () => {
  const seed = (): ReturnType<typeof reduce> =>
    reduce(
      initialState(),
      event({
        kind: 'runStart',
        runId: '01',
        nodes: [tnode('a#build')],
        concurrency: 1,
        remoteCacheEnabled: false,
        startedAtMs: 0,
        historyTable: new Map(),
      }),
    )

  it('splits stdout chunks on \\n and parks the trailing partial line in pendingLine', () => {
    const s1 = reduce(seed(), event({ kind: 'taskStdout', nodeId: 'a#build', chunk: 'one\ntw' }))
    const t = s1.tasks.get('a#build')!
    expect(t.logLines).toEqual(['one'])
    expect(t.pendingLine).toBe('tw')

    const s2 = reduce(s1, event({ kind: 'taskStdout', nodeId: 'a#build', chunk: 'o\nthree\n' }))
    expect(s2.tasks.get('a#build')?.logLines).toEqual(['one', 'two', 'three'])
    expect(s2.tasks.get('a#build')?.pendingLine).toBe('')
  })

  it('flushes pendingLine on taskComplete', () => {
    let s = reduce(seed(), event({ kind: 'taskStdout', nodeId: 'a#build', chunk: 'partial' }))
    expect(s.tasks.get('a#build')?.pendingLine).toBe('partial')
    s = reduce(
      s,
      event({
        kind: 'taskComplete',
        outcome: {
          node: tnode('a#build'),
          status: 'success',
          exitCode: 0,
          durationMs: 0,
        },
      }),
    )
    expect(s.tasks.get('a#build')?.logLines).toEqual(['partial'])
    expect(s.tasks.get('a#build')?.pendingLine).toBe('')
  })
})

describe('reduce — cacheProbe', () => {
  it('stores cacheStatus on the row', () => {
    let s = reduce(
      initialState(),
      event({
        kind: 'runStart',
        runId: '01',
        nodes: [tnode('a#build')],
        concurrency: 1,
        remoteCacheEnabled: false,
        startedAtMs: 0,
        historyTable: new Map(),
      }),
    )
    s = reduce(s, event({ kind: 'cacheProbe', nodeId: 'a#build', status: 'hit-local' }))
    expect(s.tasks.get('a#build')?.cacheStatus).toBe('hit-local')
  })
})

describe('reduce — remoteCache', () => {
  const seed = (): ReturnType<typeof reduce> =>
    reduce(
      initialState(),
      event({
        kind: 'runStart',
        runId: '01',
        nodes: [tnode('a#build')],
        concurrency: 1,
        remoteCacheEnabled: true,
        startedAtMs: 0,
        historyTable: new Map(),
      }),
    )

  it('tallies GET / PUT counters + bytes + latencies', () => {
    let s = seed()
    s = reduce(
      s,
      event({ kind: 'remoteCache', op: 'GET', hash: 'h', bytes: 100, latencyMs: 12, ok: true }),
    )
    s = reduce(
      s,
      event({ kind: 'remoteCache', op: 'PUT', hash: 'h2', bytes: 50, latencyMs: 7, ok: true }),
    )
    expect(s.remote.gets).toBe(1)
    expect(s.remote.puts).toBe(1)
    expect(s.remote.bytesDown).toBe(100)
    expect(s.remote.bytesUp).toBe(50)
    expect(s.remote.latencies).toEqual([12, 7])
  })

  it('caps the latencies buffer at 1024 entries (drops oldest)', () => {
    let s = seed()
    for (let i = 0; i < 1100; i++) {
      s = reduce(
        s,
        event({ kind: 'remoteCache', op: 'GET', hash: `h${i}`, latencyMs: i, ok: true }),
      )
    }
    expect(s.remote.latencies.length).toBe(1024)
    expect(s.remote.latencies[0]).toBe(1100 - 1024)
    expect(s.remote.latencies.at(-1)).toBe(1099)
  })
})

describe('reduce — auto-exit', () => {
  const seed = (): ReturnType<typeof reduce> =>
    reduce(
      initialState(),
      event({
        kind: 'runStart',
        runId: '01',
        nodes: [tnode('a#build')],
        concurrency: 1,
        remoteCacheEnabled: false,
        startedAtMs: 0,
        historyTable: new Map(),
      }),
    )

  it('runEnd starts an autoExitAt deadline ~3s in the future', () => {
    const before = Date.now()
    const s = reduce(
      seed(),
      event({ kind: 'runEnd', ok: true, outcomes: [], totalMs: 0, endedAtMs: 0 }),
    )
    const after = Date.now()
    expect(s.autoExitAt).toBeDefined()
    expect(s.autoExitAt!).toBeGreaterThanOrEqual(before + 2999)
    expect(s.autoExitAt!).toBeLessThanOrEqual(after + 3001)
  })

  it('any key press clears autoExitAt (user is engaged)', () => {
    let s = reduce(
      seed(),
      event({ kind: 'runEnd', ok: true, outcomes: [], totalMs: 0, endedAtMs: 0 }),
    )
    expect(s.autoExitAt).toBeDefined()
    s = reduce(s, { type: 'key', key: { kind: 'viewChange', view: 2 } })
    expect(s.autoExitAt).toBeUndefined()
  })

  it('tick after the deadline flips autoExitTriggered', async () => {
    let s = reduce(
      seed(),
      event({ kind: 'runEnd', ok: true, outcomes: [], totalMs: 0, endedAtMs: 0 }),
    )
    // Fast-forward by mutating the deadline into the past.
    s.autoExitAt = Date.now() - 1
    s = reduce(s, { type: 'tick', nowNs: 1n })
    expect(s.autoExitTriggered).toBe(true)
  })

  it('tick before the deadline does not trigger', () => {
    let s = reduce(
      seed(),
      event({ kind: 'runEnd', ok: true, outcomes: [], totalMs: 0, endedAtMs: 0 }),
    )
    s = reduce(s, { type: 'tick', nowNs: 1n })
    expect(s.autoExitTriggered).toBe(false)
  })
})

describe('reduce — runEnd', () => {
  it('marks done and sets dirty', () => {
    let s = reduce(
      initialState(),
      event({
        kind: 'runStart',
        runId: '01',
        nodes: [tnode('a#build')],
        concurrency: 1,
        remoteCacheEnabled: false,
        startedAtMs: 0,
        historyTable: new Map(),
      }),
    )
    s = reduce(
      s,
      event({
        kind: 'runEnd',
        ok: true,
        outcomes: [],
        totalMs: 1000,
        endedAtMs: 1000,
      }),
    )
    expect(s.done).toBe(true)
    expect(s.dirty).toBe(true)
  })
})

describe('reduce — keys', () => {
  const seed = (): ReturnType<typeof reduce> =>
    reduce(
      initialState(),
      event({
        kind: 'runStart',
        runId: '01',
        nodes: [tnode('a#build'), tnode('b#test')],
        concurrency: 1,
        remoteCacheEnabled: false,
        startedAtMs: 0,
        historyTable: new Map(),
      }),
    )

  it('viewChange swaps the active view', () => {
    const s = reduce(seed(), { type: 'key', key: { kind: 'viewChange', view: 3 } })
    expect(s.activeView).toBe(3)
  })

  it('toggleHelp toggles the help overlay', () => {
    const s1 = reduce(seed(), { type: 'key', key: { kind: 'toggleHelp' } })
    expect(s1.showHelp).toBe(true)
    const s2 = reduce(s1, { type: 'key', key: { kind: 'toggleHelp' } })
    expect(s2.showHelp).toBe(false)
  })

  it('selectTask moves the cursor', () => {
    const s = reduce(seed(), { type: 'key', key: { kind: 'selectTask', taskId: 'b#test' } })
    expect(s.selectedTaskId).toBe('b#test')
  })
})

describe('reduce — tick (sparkline sampler)', () => {
  it('samples parallelPct into the buffer', () => {
    let s = reduce(
      initialState(),
      event({
        kind: 'runStart',
        runId: '01',
        nodes: [tnode('a#build'), tnode('b#build')],
        concurrency: 2,
        remoteCacheEnabled: false,
        startedAtMs: 0,
        historyTable: new Map(),
      }),
    )
    // Both slots busy → 100%.
    s = reduce(s, event({ kind: 'taskStart', nodeId: 'a#build', startNs: 1n, slot: 0 }))
    s = reduce(s, event({ kind: 'taskStart', nodeId: 'b#build', startNs: 1n, slot: 1 }))
    s = reduce(s, { type: 'tick', nowNs: 1_000_000_000n })
    expect(s.parallelPctBuf.len).toBe(1)
    expect(s.parallelPctBuf.samples[0]).toBe(100)
  })
})
