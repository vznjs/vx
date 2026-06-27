import { describe, expect, it } from 'bun:test'
import { parseCoordinatorArgs } from '../src/cli/coordinator.js'
import { parseWorkerArgs } from '../src/cli/worker.js'
import type {
  DistClientMessage,
  DistServerMessage,
  WireOutcome,
  WireTaskNode,
} from '../src/protocol-dist.js'

describe('parseCoordinatorArgs', () => {
  it('accepts a bare task list with defaults', () => {
    const out = parseCoordinatorArgs(['lint', 'test'])
    expect(out).toEqual({
      tasks: ['lint', 'test'],
      port: 5180,
      host: '127.0.0.1',
      expectedWorkers: 1,
    })
  })

  it('honors --port / --host / --workers', () => {
    const out = parseCoordinatorArgs([
      'lint',
      '--port',
      '6000',
      '--host',
      '0.0.0.0',
      '--workers',
      '8',
    ])
    expect(out.port).toBe(6000)
    expect(out.host).toBe('0.0.0.0')
    expect(out.expectedWorkers).toBe(8)
  })

  it('requires at least one task', () => {
    expect(() => parseCoordinatorArgs([])).toThrow(/at least one task/)
  })

  it('rejects unknown flags', () => {
    expect(() => parseCoordinatorArgs(['--unknown', 'lint'])).toThrow(/unknown flag/)
  })

  it('rejects malformed port and workers values', () => {
    expect(() => parseCoordinatorArgs(['lint', '--port', '-1'])).toThrow(/valid port/)
    expect(() => parseCoordinatorArgs(['lint', '--workers', '0'])).toThrow(/positive integer/)
  })
})

describe('parseWorkerArgs', () => {
  it('requires a coordinator URL', () => {
    expect(() => parseWorkerArgs([])).toThrow(/coordinator URL is required/)
  })

  it('parses --worker URL with defaults', () => {
    const out = parseWorkerArgs(['--worker', 'ws://10.0.0.5:5180'])
    expect(out.coordinatorUrl).toBe('ws://10.0.0.5:5180')
    expect(out.capacity).toBe(1)
    expect(out.labels).toEqual(['linux-x64'])
  })

  it('collects multiple --label flags', () => {
    const out = parseWorkerArgs(['--worker', 'ws://h', '--label', 'gpu', '--label', 'fast'])
    expect(out.labels).toEqual(['gpu', 'fast'])
  })

  it('rejects --capacity 0', () => {
    expect(() => parseWorkerArgs(['--worker', 'ws://h', '--capacity', '0'])).toThrow(/positive/)
  })
})

describe('protocol shape', () => {
  it('DistClientMessage tags worker:* messages', () => {
    const hello: DistClientMessage = {
      t: 'worker:hello',
      workerId: 'w1',
      capacity: 4,
      labels: ['linux-x64'],
    }
    const pull: DistClientMessage = { t: 'worker:pull', available: 2 }
    const done: DistClientMessage = {
      t: 'worker:done',
      taskHash: 'cafebabe',
      outcome: { status: 'success', exitCode: 0, durationMs: 12, cacheSource: 'miss' },
    }
    expect(hello.t).toBe('worker:hello')
    expect(pull.t).toBe('worker:pull')
    expect(done.t).toBe('worker:done')
  })

  it('DistServerMessage tags task:assign / cache:exists / coord:drain', () => {
    const assign: DistServerMessage = {
      t: 'task:assign',
      hash: 'deadbeef',
      node: {
        id: 'pkg#build',
        projectName: 'pkg',
        projectDir: '/ws/pkg',
        taskName: 'build',
        command: 'bun build',
        cacheable: true,
      },
    }
    const exists: DistServerMessage = { t: 'cache:exists', hash: 'd', present: true }
    const drain: DistServerMessage = { t: 'coord:drain' }
    expect(assign.t).toBe('task:assign')
    expect(exists.t).toBe('cache:exists')
    expect(drain.t).toBe('coord:drain')
  })

  it('WireOutcome cacheSource is the union (miss/fresh/local/remote)', () => {
    const sources: WireOutcome['cacheSource'][] = ['miss', 'fresh', 'local', 'remote']
    expect(sources).toHaveLength(4)
  })

  it('WireTaskNode is the serializable subset of TaskNode', () => {
    const n: WireTaskNode = {
      id: 'a#b',
      projectName: 'a',
      projectDir: '/x/a',
      taskName: 'b',
      command: 'echo ok',
      cacheable: false,
    }
    expect(n.id).toBe('a#b')
  })
})
