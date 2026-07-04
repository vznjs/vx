// The in-memory session registry: pairing, commit enforcement (at pairing
// AND at late hello), one-active-submission-per-session with sequential
// reuse, agent-death notification, and the 15-min GC sweep.

import { describe, expect, it } from 'bun:test'
import {
  AGENT_STALE_MS,
  AgentRegistry,
  SESSION_GC_MS,
  SUBMITTER_LABEL,
} from '../src/dist/registry.js'
import type { ActiveSubmission, RegisteredAgent } from '../src/dist/registry.js'
import {
  DIST_PROTOCOL_VERSION,
  type AgentHello,
  type DistServerMessage,
} from '../src/protocol-dist.js'

function hello(overrides: Partial<AgentHello> = {}): AgentHello {
  return {
    t: 'agent:hello',
    protocol: DIST_PROTOCOL_VERSION,
    agentId: overrides.agentId ?? 'a1',
    workspaceId: 'ws1',
    session: 'local',
    commitSha: 'commit-a',
    capacity: 1,
    ...overrides,
  }
}

function io(): {
  sent: DistServerMessage[]
  closed: boolean[]
  send(m: DistServerMessage): void
  close(): void
} {
  const sent: DistServerMessage[] = []
  const closed: boolean[] = []
  return {
    sent,
    closed,
    send: (m) => sent.push(m),
    close: () => closed.push(true),
  }
}

function submission(commitSha = 'commit-a'): ActiveSubmission & {
  joined: string[]
  left: Array<{ id: string; inFlight: readonly string[] }>
  messages: unknown[]
} {
  const joined: string[] = []
  const left: Array<{ id: string; inFlight: readonly string[] }> = []
  const messages: unknown[] = []
  return {
    commitSha,
    joined,
    left,
    messages,
    onAgentJoin: (a) => joined.push(a.agentId),
    onAgentLeave: (a, inFlight) => left.push({ id: a.agentId, inFlight }),
    onAgentMessage: (_a, m) => messages.push(m),
  }
}

describe('AgentRegistry — hello + pairing', () => {
  it('registers agents under {workspaceId, session} and hands them to a submission', () => {
    const reg = new AgentRegistry()
    const a = reg.hello(hello({ agentId: 'a1' }), io())
    const b = reg.hello(hello({ agentId: 'a2' }), io())
    // A different session never pairs with this submission.
    reg.hello(hello({ agentId: 'other', session: 'other-session' }), io())
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()

    const bound = reg.beginSubmission('ws1', 'local', submission())
    if ('error' in bound) throw new Error(bound.error)
    expect(
      bound
        .agents()
        .map((x) => x.agentId)
        .sort(),
    ).toEqual(['a1', 'a2'])
  })

  it('refuses a protocol mismatch naming both versions', () => {
    const reg = new AgentRegistry()
    const socket = io()
    const agent = reg.hello(hello({ protocol: 99 }), socket)
    expect(agent).toBeNull()
    expect(socket.sent).toHaveLength(1)
    const refusal = socket.sent[0] as { t: string; reason: string }
    expect(refusal.t).toBe('agent:refused')
    expect(refusal.reason).toContain('v99')
    expect(refusal.reason).toContain(`v${DIST_PROTOCOL_VERSION}`)
    expect(socket.closed).toHaveLength(1)
  })

  it('enforces commitSha at PAIRING: mismatching agents are refused naming both SHAs and dropped', () => {
    const reg = new AgentRegistry()
    const good = io()
    const stale = io()
    reg.hello(hello({ agentId: 'good', commitSha: 'commit-a' }), good)
    reg.hello(hello({ agentId: 'stale', commitSha: 'commit-b' }), stale)

    const bound = reg.beginSubmission('ws1', 'local', submission('commit-a'))
    if ('error' in bound) throw new Error(bound.error)
    expect(bound.agents().map((x) => x.agentId)).toEqual(['good'])
    const refusal = stale.sent[0] as { t: string; reason: string }
    expect(refusal.t).toBe('agent:refused')
    expect(refusal.reason).toContain('commit-a')
    expect(refusal.reason).toContain('commit-b')
    expect(stale.closed).toHaveLength(1)
    expect(good.sent).toHaveLength(0)
  })

  it('refuses a LATE hello mismatching the active submission; a matching one joins it', () => {
    const reg = new AgentRegistry()
    const sub = submission('commit-a')
    const bound = reg.beginSubmission('ws1', 'local', sub)
    if ('error' in bound) throw new Error(bound.error)

    const stale = io()
    expect(reg.hello(hello({ agentId: 'stale', commitSha: 'commit-b' }), stale)).toBeNull()
    expect((stale.sent[0] as { reason: string }).reason).toContain('commit mismatch')

    const fresh = io()
    const agent = reg.hello(hello({ agentId: 'fresh', commitSha: 'commit-a' }), fresh)
    expect(agent).not.toBeNull()
    expect(sub.joined).toEqual(['fresh'])
  })
})

describe('AgentRegistry — submissions', () => {
  it('refuses a concurrent second submission; a SEQUENTIAL one reuses the agents', () => {
    const reg = new AgentRegistry()
    reg.hello(hello({ agentId: 'a1' }), io())
    const first = reg.beginSubmission('ws1', 'local', submission())
    if ('error' in first) throw new Error(first.error)

    const second = reg.beginSubmission('ws1', 'local', submission())
    expect('error' in second && second.error).toContain('already has an active submission')

    first.end()
    const third = reg.beginSubmission('ws1', 'local', submission())
    if ('error' in third) throw new Error(third.error)
    expect(third.agents().map((x) => x.agentId)).toEqual(['a1'])
  })

  it('agent death notifies the active submission with its in-flight ids', () => {
    const reg = new AgentRegistry()
    const agent = reg.hello(hello({ agentId: 'a1' }), io()) as RegisteredAgent
    const sub = submission()
    const bound = reg.beginSubmission('ws1', 'local', sub)
    if ('error' in bound) throw new Error(bound.error)

    agent.inFlight.add('pkg#build')
    reg.drop(agent)
    expect(sub.left).toEqual([{ id: 'a1', inFlight: ['pkg#build'] }])
    expect(bound.agents()).toHaveLength(0)
    // A second close for the same handle is a no-op.
    reg.drop(agent)
    expect(sub.left).toHaveLength(1)
  })

  it('routes post-hello agent messages to the active submission', () => {
    const reg = new AgentRegistry()
    const agent = reg.hello(hello({ agentId: 'a1' }), io()) as RegisteredAgent
    const sub = submission()
    reg.beginSubmission('ws1', 'local', sub)
    reg.dispatch(agent, { t: 'agent:start', taskId: 'pkg#build' })
    expect(sub.messages).toEqual([{ t: 'agent:start', taskId: 'pkg#build' }])
  })
})

describe('AgentRegistry — GC', () => {
  it('sweeps sessions with no agents, no submission, and 15 min of silence', () => {
    let now = 1_000_000
    const reg = new AgentRegistry(() => now)
    const agent = reg.hello(hello({ agentId: 'a1' }), io()) as RegisteredAgent
    expect(reg.sessionCount()).toBe(1)

    // Still connected — never swept, however old.
    now += SESSION_GC_MS + 1
    reg.gc()
    expect(reg.sessionCount()).toBe(1)

    // Disconnected but recent — held.
    reg.drop(agent)
    reg.gc()
    expect(reg.sessionCount()).toBe(1)

    // Idle past the horizon — swept.
    now += SESSION_GC_MS + 1
    reg.gc()
    expect(reg.sessionCount()).toBe(0)
  })

  it('an active submission pins its session regardless of age', () => {
    let now = 1_000_000
    const reg = new AgentRegistry(() => now)
    const bound = reg.beginSubmission('ws1', 'local', submission())
    if ('error' in bound) throw new Error(bound.error)
    now += SESSION_GC_MS * 3
    reg.gc()
    expect(reg.sessionCount()).toBe(1)
    bound.end()
    now += SESSION_GC_MS + 1
    reg.gc()
    expect(reg.sessionCount()).toBe(0)
  })
})

describe('AgentRegistry — availableCapacity (the ambient capacity gate)', () => {
  it('counts total vs REMOTE agents/capacity, excluding the submitter self-agent', () => {
    const reg = new AgentRegistry()
    // The submitter's own self-agent carries SUBMITTER_LABEL and must NOT count
    // as remote capacity (else a solo run would think it has helpers).
    reg.hello(hello({ agentId: 'self', capacity: 8, labels: [SUBMITTER_LABEL] }), io())
    reg.hello(hello({ agentId: 'helper-1', capacity: 4 }), io())
    reg.hello(hello({ agentId: 'helper-2', capacity: 2 }), io())

    expect(reg.availableCapacity('ws1', 'local')).toEqual({
      agents: 3,
      remoteAgents: 2,
      capacity: 14,
      remoteCapacity: 6,
      ready: 0,
    })
  })

  it('reports zero remote agents when only the submitter is present (stays a local run)', () => {
    const reg = new AgentRegistry()
    reg.hello(hello({ agentId: 'self', capacity: 8, labels: [SUBMITTER_LABEL] }), io())
    expect(reg.availableCapacity('ws1', 'local').remoteAgents).toBe(0)
  })

  it('returns all zeros for an unknown {workspaceId, session}', () => {
    const reg = new AgentRegistry()
    expect(reg.availableCapacity('nope', 'nope')).toEqual({
      agents: 0,
      remoteAgents: 0,
      capacity: 0,
      remoteCapacity: 0,
      ready: 0,
    })
  })

  it('surfaces the active submission ready-queue depth (the autoscaling signal)', () => {
    const reg = new AgentRegistry()
    reg.hello(hello({ agentId: 'a1' }), io())
    // A stub submission reporting 5 ready-but-unassigned tasks.
    reg.beginSubmission('ws1', 'local', { ...submission(), readyDepth: () => 5 })
    expect(reg.availableCapacity('ws1', 'local').ready).toBe(5)
  })
})

describe('AgentRegistry — stale-agent sweep (heartbeat liveness)', () => {
  it('reaps a heartbeating agent gone silent past the threshold, closing it + reassigning', () => {
    let now = 1_000_000
    const reg = new AgentRegistry(() => now)
    const sub = submission()
    reg.beginSubmission('ws1', 'local', sub)
    const socket = io()
    const agent = reg.hello(hello({ agentId: 'dead' }), socket) as RegisteredAgent
    agent.inFlight.add('pkg#build')
    reg.heartbeat(agent) // it heartbeated at least once → sweep-eligible

    // Just under the threshold — kept.
    now += AGENT_STALE_MS - 1
    expect(reg.sweepStale(AGENT_STALE_MS)).toBe(0)
    expect(reg.availableCapacity('ws1', 'local').agents).toBe(1)

    // Past the threshold — reaped: dropped, socket closed, in-flight handed back.
    now += 2
    expect(reg.sweepStale(AGENT_STALE_MS)).toBe(1)
    expect(reg.availableCapacity('ws1', 'local').agents).toBe(0)
    expect(socket.closed.length).toBe(1)
    expect(sub.left).toEqual([{ id: 'dead', inFlight: ['pkg#build'] }])
  })

  it('a heartbeat keeps an agent alive across the threshold', () => {
    let now = 1_000_000
    const reg = new AgentRegistry(() => now)
    reg.beginSubmission('ws1', 'local', submission())
    const agent = reg.hello(hello({ agentId: 'live' }), io()) as RegisteredAgent

    now += AGENT_STALE_MS - 1
    reg.heartbeat(agent) // touches lastSeenAt = now
    now += AGENT_STALE_MS - 1 // still within one interval of the heartbeat
    expect(reg.sweepStale(AGENT_STALE_MS)).toBe(0)
    expect(reg.availableCapacity('ws1', 'local').agents).toBe(1)
  })

  it('NEVER reaps an agent that has not heartbeated (old-version skew guard)', () => {
    let now = 1_000_000
    const reg = new AgentRegistry(() => now)
    reg.beginSubmission('ws1', 'local', submission())
    // A heartbeat-less agent (an old vx-cloud) — idle far past the threshold.
    reg.hello(hello({ agentId: 'old' }), io())
    now += AGENT_STALE_MS * 10
    expect(reg.sweepStale(AGENT_STALE_MS)).toBe(0)
    expect(reg.availableCapacity('ws1', 'local').agents).toBe(1)
  })
})
