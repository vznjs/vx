// Distributed-message envelope adapters live in @vzn/vx-cloud's
// protocol-dist.ts (the base envelope stays in core's wire.ts). These pin
// the v2 agent.*/coord.*/dist.submit round-trips + the version sentinel —
// v2 added `submissionId` to every task-scoped message + `dist:submit`, and
// an optional `ownerSubmissionId` to `agent:hello`.

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

describe('protocol v2 shape', () => {
  it('exposes the version sentinel', () => {
    expect(DIST_PROTOCOL_VERSION).toBe(2)
  })

  it('a policy-less assignment is a BARE task id + submissionId — no command, no projectDir, no hash', () => {
    const assign: DistServerMessage = { t: 'task:assign', taskId: 'pkg#build', submissionId: 's1' }
    expect(Object.keys(assign).sort()).toEqual(['submissionId', 't', 'taskId'])
  })
})

describe('round-trip — DistServerMessage ⇄ Envelope', () => {
  it('task:assign / agent:refused / coord:drain round-trip', () => {
    const msgs: DistServerMessage[] = [
      { t: 'task:assign', taskId: 'pkg#build', submissionId: 's1' },
      // A policy-carrying assignment (the submitter's --frozen/--timeout/--retry).
      {
        t: 'task:assign',
        taskId: 'pkg#build',
        submissionId: 's1',
        policy: { frozen: true, timeout: 30_000, retries: 2 },
      },
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
      // A self-agent naming its owner submission (the standing-pool eligibility key).
      {
        t: 'agent:hello',
        protocol: DIST_PROTOCOL_VERSION,
        agentId: 'self',
        workspaceId: 'ws1',
        session: 'gh-42-1',
        commitSha: 'cafebabe',
        capacity: 4,
        labels: ['submitter'],
        ownerSubmissionId: 's1',
      },
      { t: 'agent:start', taskId: 'pkg#build', submissionId: 's1' },
      { t: 'agent:stdout', taskId: 'pkg#build', submissionId: 's1', chunk: 'line\n' },
      { t: 'agent:stderr', taskId: 'pkg#build', submissionId: 's1', chunk: 'err\n' },
      {
        t: 'agent:done',
        taskId: 'pkg#build',
        submissionId: 's1',
        outcome: {
          taskId: 'pkg#build',
          status: 'success',
          exitCode: 0,
          durationMs: 10,
          hash: 'deadbeefdeadbeef',
        },
      },
      { t: 'agent:heartbeat' },
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
      submissionId: 'sub-1',
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

  it('carries the trust-scope branch/defaultBranch when present', () => {
    const submit: DistSubmitMessage = {
      t: 'dist:submit',
      protocol: DIST_PROTOCOL_VERSION,
      session: 'local',
      workspaceId: 'ws1',
      submissionId: 'sub-2',
      commitSha: 'cafebabe',
      branch: 'feature-x',
      defaultBranch: 'main',
      expectedAgents: 1,
      agentTimeoutMs: 300_000,
      request: { tasks: ['build'], cwd: '/w' },
      nodes: [],
    }
    const back = envelopeToDistSubmit(distSubmitToEnvelope(submit))
    expect(back).toEqual(submit)
    expect(back?.branch).toBe('feature-x')
    expect(back?.defaultBranch).toBe('main')
  })

  it('carries the submitter context (invocation header) when present', () => {
    const submit: DistSubmitMessage = {
      t: 'dist:submit',
      protocol: DIST_PROTOCOL_VERSION,
      session: 'local',
      workspaceId: 'ws1',
      submissionId: 'sub-3',
      commitSha: 'cafebabe',
      context: {
        os: 'linux',
        arch: 'x64',
        host: 'ci-runner-7',
        ci: true,
        ciProvider: 'github',
        vxVersion: '9.9.9',
        dirty: false,
        workspaceName: 'acme-monorepo',
      },
      expectedAgents: 1,
      agentTimeoutMs: 300_000,
      request: { tasks: ['build'], cwd: '/w' },
      nodes: [],
    }
    const back = envelopeToDistSubmit(distSubmitToEnvelope(submit))
    expect(back).toEqual(submit)
    expect(back?.context?.ci).toBe(true)
    expect(back?.context?.workspaceName).toBe('acme-monorepo')
  })
})
