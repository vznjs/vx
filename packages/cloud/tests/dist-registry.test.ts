// The in-memory session registry: pairing, commit as an ELIGIBILITY filter
// (not a refusal), CONCURRENT submissions per session sharing the pool,
// per-submission agent-death reassignment, the commit-filtered capacity read,
// the stale-agent heartbeat sweep, and the 15-min GC sweep.

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

let subSeq = 0

type StubSubmission = ActiveSubmission & {
  joined: string[]
  left: Array<{ id: string; inFlight: readonly string[] }>
  messages: unknown[]
  ready: string[]
  assignments: Array<{ taskId: string; agentId: string }>
}

function submission(
  opts: { commitSha?: string; submissionId?: string; ready?: string[] } = {},
): StubSubmission {
  const submissionId = opts.submissionId ?? `sub-${++subSeq}`
  const commitSha = opts.commitSha ?? 'commit-a'
  const ready = opts.ready ?? []
  const joined: string[] = []
  const left: Array<{ id: string; inFlight: readonly string[] }> = []
  const messages: unknown[] = []
  const assignments: Array<{ taskId: string; agentId: string }> = []
  return {
    submissionId,
    commitSha,
    joined,
    left,
    messages,
    ready,
    assignments,
    onAgentJoin: (a) => joined.push(a.agentId),
    onAgentLeave: (a, inFlight) => left.push({ id: a.agentId, inFlight }),
    onAgentMessage: (_a, m) => messages.push(m),
    nextReady: () => ready[0],
    affinityAgents: () => new Set<string>(),
    assign: (taskId, agent) => {
      const i = ready.indexOf(taskId)
      if (i >= 0) ready.splice(i, 1)
      let s = agent.inFlight.get(submissionId)
      if (s === undefined) {
        s = new Set()
        agent.inFlight.set(submissionId, s)
      }
      s.add(taskId)
      assignments.push({ taskId, agentId: agent.agentId })
    },
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

  it('does NOT refuse a commit-mismatched agent — it stays registered but ineligible', () => {
    const reg = new AgentRegistry()
    const good = io()
    const stale = io()
    reg.hello(hello({ agentId: 'good', commitSha: 'commit-a' }), good)
    reg.hello(hello({ agentId: 'stale', commitSha: 'commit-b' }), stale)

    const bound = reg.beginSubmission('ws1', 'local', submission({ commitSha: 'commit-a' }))
    if ('error' in bound) throw new Error(bound.error)
    // Only the same-commit agent is eligible for this submission…
    expect(bound.agents().map((x) => x.agentId)).toEqual(['good'])
    // …but the mismatched one is neither refused nor dropped (no message, no close)
    // and stays registered so it can serve a matching submission later.
    expect(stale.sent).toHaveLength(0)
    expect(stale.closed).toHaveLength(0)
    expect(good.sent).toHaveLength(0)
    expect(reg.availableCapacity('ws1', 'local').agents).toBe(2)
  })

  it('a LATE mismatched hello registers (ineligible, not refused); a matching one joins', () => {
    const reg = new AgentRegistry()
    const sub = submission({ commitSha: 'commit-a' })
    const bound = reg.beginSubmission('ws1', 'local', sub)
    if ('error' in bound) throw new Error(bound.error)

    const stale = io()
    const staleAgent = reg.hello(hello({ agentId: 'stale', commitSha: 'commit-b' }), stale)
    expect(staleAgent).not.toBeNull() // registered, not refused
    expect(stale.sent).toHaveLength(0)
    expect(sub.joined).toEqual([]) // ineligible → never joined the submission

    const fresh = io()
    const agent = reg.hello(hello({ agentId: 'fresh', commitSha: 'commit-a' }), fresh)
    expect(agent).not.toBeNull()
    expect(sub.joined).toEqual(['fresh'])
  })
})

describe('AgentRegistry — submissions', () => {
  it('accepts CONCURRENT submissions in one session; both share the agents', () => {
    const reg = new AgentRegistry()
    reg.hello(hello({ agentId: 'a1' }), io())
    const first = reg.beginSubmission('ws1', 'local', submission())
    if ('error' in first) throw new Error(first.error)

    // A second concurrent submission is accepted (no "already active" error).
    const second = reg.beginSubmission('ws1', 'local', submission())
    if ('error' in second) throw new Error(second.error)
    expect(second.agents().map((x) => x.agentId)).toEqual(['a1'])

    first.end()
    const third = reg.beginSubmission('ws1', 'local', submission())
    if ('error' in third) throw new Error(third.error)
    expect(third.agents().map((x) => x.agentId)).toEqual(['a1'])
  })

  it('rejects a DUPLICATE submissionId (client-bug guard)', () => {
    const reg = new AgentRegistry()
    const first = reg.beginSubmission('ws1', 'local', submission({ submissionId: 'dup' }))
    if ('error' in first) throw new Error(first.error)
    const dup = reg.beginSubmission('ws1', 'local', submission({ submissionId: 'dup' }))
    expect('error' in dup && dup.error).toContain('already active')
  })

  it('agent death hands each submission back ONLY its own in-flight ids', () => {
    const reg = new AgentRegistry()
    const agent = reg.hello(hello({ agentId: 'a1' }), io()) as RegisteredAgent
    const sub = submission({ submissionId: 'sub-x' })
    const bound = reg.beginSubmission('ws1', 'local', sub)
    if ('error' in bound) throw new Error(bound.error)

    agent.inFlight.set('sub-x', new Set(['pkg#build']))
    reg.drop(agent)
    expect(sub.left).toEqual([{ id: 'a1', inFlight: ['pkg#build'] }])
    expect(bound.agents()).toHaveLength(0)
    // A second close for the same handle is a no-op.
    reg.drop(agent)
    expect(sub.left).toHaveLength(1)
  })

  it('routes post-hello agent messages to the submission they NAME', () => {
    const reg = new AgentRegistry()
    const agent = reg.hello(hello({ agentId: 'a1' }), io()) as RegisteredAgent
    const sub = submission({ submissionId: 'sub-x' })
    reg.beginSubmission('ws1', 'local', sub)
    const msg = { t: 'agent:start', taskId: 'pkg#build', submissionId: 'sub-x' }
    reg.dispatch(agent, msg)
    expect(sub.messages).toEqual([msg])
  })

  it('a message naming an unknown submission is a no-op (does not throw)', () => {
    const reg = new AgentRegistry()
    const agent = reg.hello(hello({ agentId: 'a1' }), io()) as RegisteredAgent
    const sub = submission({ submissionId: 'sub-x' })
    reg.beginSubmission('ws1', 'local', sub)
    reg.dispatch(agent, { t: 'agent:done', taskId: 'pkg#x', submissionId: 'gone' })
    expect(sub.messages).toEqual([])
  })

  it("a self-agent's hello joins ONLY the submission that owns it", () => {
    const reg = new AgentRegistry()
    const mine = submission({ submissionId: 'sub-mine' })
    const peer = submission({ submissionId: 'sub-peer' }) // same commit
    reg.beginSubmission('ws1', 'local', mine)
    reg.beginSubmission('ws1', 'local', peer)

    reg.hello(
      hello({ agentId: 'self', labels: [SUBMITTER_LABEL], ownerSubmissionId: 'sub-mine' }),
      io(),
    )
    expect(mine.joined).toEqual(['self'])
    expect(peer.joined).toEqual([]) // a peer can't conscript this machine
  })

  it('drainIfLast drains only when last active, and only ELIGIBLE agents', () => {
    const reg = new AgentRegistry()
    reg.hello(hello({ agentId: 'match', commitSha: 'commit-a' }), io())
    reg.hello(hello({ agentId: 'standing', commitSha: 'commit-main' }), io())
    reg.hello(
      hello({
        agentId: 'foreign-self',
        commitSha: 'commit-a',
        labels: [SUBMITTER_LABEL],
        ownerSubmissionId: 'sub-other',
      }),
      io(),
    )

    const a = reg.beginSubmission('ws1', 'local', submission({ commitSha: 'commit-a' }))
    const b = reg.beginSubmission('ws1', 'local', submission({ commitSha: 'commit-a' }))
    if ('error' in a || 'error' in b) throw new Error('begin failed')

    // Two active submissions → neither may drain the shared pool.
    expect(a.drainIfLast()).toEqual([])
    b.end()
    // Last active → drains its eligible agents ONLY: the different-commit
    // standing helper and the other run's self-agent are never told to drain.
    expect(a.drainIfLast().map((x) => x.agentId)).toEqual(['match'])
  })
})

describe('AgentRegistry — org isolation (platform §8.2)', () => {
  it('keys sessions by org — a cross-org agent never joins another org pool', () => {
    const reg = new AgentRegistry()
    // Same {workspaceId, session}, DIFFERENT orgs (server-derived from token).
    reg.hello(hello({ agentId: 'a-org1' }), io(), 'org-1')
    reg.hello(hello({ agentId: 'a-org2' }), io(), 'org-2')

    // A submission under org-1 only sees org-1's agent.
    const bound1 = reg.beginSubmission('ws1', 'local', submission(), 'org-1')
    if ('error' in bound1) throw new Error(bound1.error)
    expect(bound1.agents().map((x) => x.agentId)).toEqual(['a-org1'])

    // Capacity reads are org-scoped too.
    expect(reg.availableCapacity('ws1', 'local', undefined, 'org-1').agents).toBe(1)
    expect(reg.availableCapacity('ws1', 'local', undefined, 'org-2').agents).toBe(1)
    // The default org (transitional single-tenant) sees neither.
    expect(reg.availableCapacity('ws1', 'local').agents).toBe(0)
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

  it('surfaces the SUM of active submissions ready-queue depth (the autoscaling signal)', () => {
    const reg = new AgentRegistry()
    reg.hello(hello({ agentId: 'a1' }), io())
    // Two concurrent stub submissions reporting 5 and 3 ready-but-unassigned tasks.
    reg.beginSubmission('ws1', 'local', { ...submission(), readyDepth: () => 5 })
    reg.beginSubmission('ws1', 'local', { ...submission(), readyDepth: () => 3 })
    expect(reg.availableCapacity('ws1', 'local').ready).toBe(8)
  })

  it('commit-filters the REMOTE counts when a commit is given', () => {
    const reg = new AgentRegistry()
    reg.hello(hello({ agentId: 'a', commitSha: 'commit-a', capacity: 4 }), io())
    reg.hello(hello({ agentId: 'b', commitSha: 'commit-b', capacity: 2 }), io())
    // No commit → both remote; with a commit → only the matching agent.
    expect(reg.availableCapacity('ws1', 'local').remoteAgents).toBe(2)
    const scoped = reg.availableCapacity('ws1', 'local', 'commit-a')
    expect(scoped.remoteAgents).toBe(1)
    expect(scoped.remoteCapacity).toBe(4)
    // Totals stay whole-session regardless of the commit filter.
    expect(scoped.agents).toBe(2)
    expect(scoped.capacity).toBe(6)
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
    agent.inFlight.set(sub.submissionId, new Set(['pkg#build']))
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
