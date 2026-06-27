// Distributed-message envelope adapters live in @vzn/vx-cloud's
// protocol-dist.ts (the base envelope stays in core's wire.ts). These pin
// the worker.*/coord.* round-trips that left core in the split.

import { describe, expect, it } from 'bun:test'
import { isNotification } from '@vzn/vx'
import {
  distClientMessageToEnvelope,
  distServerMessageToEnvelope,
  envelopeToDistClientMessage,
  envelopeToDistServerMessage,
  type DistClientMessage,
  type DistServerMessage,
} from '../src/protocol-dist.js'

describe('round-trip — DistServerMessage ⇄ Envelope', () => {
  it('task:assign / cache:exists / coord:drain round-trip via coord.* notifications', () => {
    const msgs: DistServerMessage[] = [
      {
        t: 'task:assign',
        hash: 'deadbeef',
        node: {
          id: 'pkg#build',
          projectName: 'pkg',
          projectDir: '/x/pkg',
          taskName: 'build',
          command: 'bun build',
          cacheable: true,
        },
      },
      { t: 'cache:exists', hash: 'd', present: true },
      { t: 'coord:drain' },
    ]
    for (const m of msgs) {
      const env = distServerMessageToEnvelope(m)
      expect(isNotification(env)).toBe(true)
      const back = envelopeToDistServerMessage(env)
      expect(back?.t).toBe(m.t)
    }
  })
})

describe('round-trip — DistClientMessage ⇄ Envelope', () => {
  it('worker:* messages map to worker.* notifications', () => {
    const cases: DistClientMessage[] = [
      { t: 'worker:hello', workerId: 'w1', capacity: 4, labels: ['linux-x64'] },
      { t: 'worker:pull', available: 2 },
      { t: 'worker:start', taskHash: 'h' },
      { t: 'worker:stdout', taskHash: 'h', chunk: 'line\n' },
      { t: 'worker:stderr', taskHash: 'h', chunk: 'err\n' },
      {
        t: 'worker:done',
        taskHash: 'h',
        outcome: { status: 'success', exitCode: 0, durationMs: 10, cacheSource: 'miss' },
      },
      { t: 'worker:bye', reason: 'shutdown' },
    ]
    for (const c of cases) {
      const env = distClientMessageToEnvelope(c)
      expect(isNotification(env)).toBe(true)
      const back = envelopeToDistClientMessage(env)
      expect(back?.t).toBe(c.t)
    }
  })
})
