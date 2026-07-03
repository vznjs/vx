// Distributed-message envelope adapters live in @vzn/vx-cloud's
// protocol-dist.ts (the base envelope stays in core's wire.ts). These pin
// the v1 agent.*/coord.*/dist.submit round-trips + the version sentinel.

import { describe, expect, it } from 'bun:test'
import { isNotification } from '@vzn/vx'
import {
  DIST_PROTOCOL_VERSION,
  distClientMessageToEnvelope,
  distServerMessageToEnvelope,
  distSubmitToEnvelope,
  envelopeToDistClientMessage,
  envelopeToDistServerMessage,
  envelopeToDistSubmit,
  type DistClientMessage,
  type DistServerMessage,
  type DistSubmitMessage,
} from '../src/protocol-dist.js'

describe('protocol v1 shape', () => {
  it('exposes the version sentinel', () => {
    expect(DIST_PROTOCOL_VERSION).toBe(1)
  })

  it('assignment is a BARE task id — no command, no projectDir, no hash', () => {
    const assign: DistServerMessage = { t: 'task:assign', taskId: 'pkg#build' }
    expect(Object.keys(assign).sort()).toEqual(['t', 'taskId'])
  })
})

describe('round-trip — DistServerMessage ⇄ Envelope', () => {
  it('task:assign / agent:refused / coord:drain round-trip', () => {
    const msgs: DistServerMessage[] = [
      { t: 'task:assign', taskId: 'pkg#build' },
      { t: 'agent:refused', reason: 'commit mismatch: a vs b' },
      { t: 'coord:drain' },
    ]
    for (const m of msgs) {
      const env = distServerMessageToEnvelope(m)
      expect(isNotification(env)).toBe(true)
      const back = envelopeToDistServerMessage(env)
      expect(back).toEqual(m)
    }
  })
})

describe('round-trip — DistClientMessage ⇄ Envelope', () => {
  it('agent:* messages map to agent.* notifications', () => {
    const cases: DistClientMessage[] = [
      {
        t: 'agent:hello',
        protocol: DIST_PROTOCOL_VERSION,
        agentId: 'a1',
        workspaceId: 'ws1',
        session: 'gh-42-1',
        commitSha: 'cafebabe',
        capacity: 4,
        labels: ['linux-x64'],
      },
      { t: 'agent:start', taskId: 'pkg#build' },
      { t: 'agent:stdout', taskId: 'pkg#build', chunk: 'line\n' },
      { t: 'agent:stderr', taskId: 'pkg#build', chunk: 'err\n' },
      {
        t: 'agent:done',
        taskId: 'pkg#build',
        outcome: {
          taskId: 'pkg#build',
          status: 'success',
          exitCode: 0,
          durationMs: 10,
          hash: 'deadbeefdeadbeef',
        },
      },
      { t: 'agent:bye', reason: 'idle-timeout' },
    ]
    for (const c of cases) {
      const env = distClientMessageToEnvelope(c)
      expect(isNotification(env)).toBe(true)
      const back = envelopeToDistClientMessage(env)
      expect(back).toEqual(c)
    }
  })
})

describe('round-trip — dist:submit ⇄ Envelope', () => {
  it('carries the RunRequest + wire graph verbatim', () => {
    const submit: DistSubmitMessage = {
      t: 'dist:submit',
      protocol: DIST_PROTOCOL_VERSION,
      session: 'local',
      workspaceId: 'ws1',
      commitSha: 'cafebabe',
      expectedAgents: 2,
      agentTimeoutMs: 300_000,
      request: { tasks: ['build'], cwd: '/w' },
      nodes: [
        {
          id: 'pkg#build',
          deps: [],
          view: {
            id: 'pkg#build',
            project: 'pkg',
            task: 'build',
            isGroup: false,
            requested: true,
            surfaced: false,
            persistent: false,
            command: 'echo ok',
          },
          stableHash: 'deadbeefdeadbeef',
        },
      ],
    }
    const env = distSubmitToEnvelope(submit)
    expect(isNotification(env)).toBe(true)
    expect(envelopeToDistSubmit(env)).toEqual(submit)
    expect(envelopeToDistSubmit(distServerMessageToEnvelope({ t: 'coord:drain' }))).toBeNull()
  })
})
