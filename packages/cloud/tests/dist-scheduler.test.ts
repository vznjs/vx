// The per-submission scheduler: the store prune (warm tasks NEVER
// dispatch), capacity-bounded dispatch with the dep-affinity preference,
// front-of-queue reassignment on agent death, group auto-completion,
// failure-cascade skips, and the orphaned-submission drain.

import { describe, expect, it } from 'bun:test'
import type { OutcomeView, ServerMessage, TaskView } from '@vzn/vx'
import { DistScheduler, SUBMITTER_LABEL, type ArtifactProbe } from '../src/dist/scheduler.js'
import {
  dispatchGreedy,
  type ActiveSubmission,
  type RegisteredAgent,
  type SubmissionBinding,
} from '../src/dist/registry.js'
import {
  DIST_PROTOCOL_VERSION,
  type DistGraphNode,
  type DistServerMessage,
  type DistSubmitMessage,
} from '../src/protocol-dist.js'

function view(id: string, isGroup = false): TaskView {
  const [project, task] = id.split('#') as [string, string]
  return {
    id,
    project,
    task,
    isGroup,
    requested: true,
    surfaced: false,
    persistent: false,
    ...(isGroup ? {} : { command: `echo ${task}` }),
  }
}

function node(
  id: string,
  deps: string[] = [],
  stableHash?: string,
  isGroup = false,
): DistGraphNode {
  return { id, deps, view: view(id, isGroup), ...(stableHash !== undefined ? { stableHash } : {}) }
}

function submitMsg(nodes: DistGraphNode[], agentTimeoutMs = 60_000): DistSubmitMessage {
  return {
    t: 'dist:submit',
    protocol: DIST_PROTOCOL_VERSION,
    session: 'local',
    workspaceId: 'ws1',
    submissionId: 'sub-a',
    commitSha: 'commit-a',
    expectedAgents: 2,
    agentTimeoutMs,
    request: { tasks: ['build'], cwd: '/w' },
    nodes,
  }
}

function store(hits: Record<string, number> = {}): ArtifactProbe {
  return {
    has: (hash) => Promise.resolve(hash in hits),
    storedDurationMs: (hash) => Promise.resolve(hits[hash]),
  }
}

interface FakeAgent extends RegisteredAgent {
  sent: DistServerMessage[]
  assigned(): string[]
}

function fakeAgent(agentId: string, capacity = 1, labels: string[] = []): FakeAgent {
  const sent: DistServerMessage[] = []
  return {
    agentId,
    workspaceId: 'ws1',
    session: 'local',
    commitSha: 'commit-a',
    capacity,
    labels,
    inFlight: new Map<string, Set<string>>(),
    lastSeenAt: 0,
    sawHeartbeat: false,
    sent,
    send: (m) => sent.push(m),
    close: () => {},
    assigned: () =>
      sent.filter((m) => m.t === 'task:assign').map((m) => (m as { taskId: string }).taskId),
  }
}

/**
 * A stub registry binding for a lone submission: `requestDispatch` runs the
 * registry's real greedy loop over this submission — the same primitive the
 * fair `dispatchSession` uses per submission — so single-submission dispatch
 * is exercised byte-for-byte without spinning up the whole `AgentRegistry`.
 */
function binding(
  agents: FakeAgent[],
  sub: () => ActiveSubmission,
): SubmissionBinding & { ended: boolean[] } {
  const ended: boolean[] = []
  return {
    ended,
    agents: () => [...agents],
    requestDispatch: () => dispatchGreedy(sub(), agents),
    drainIfLast: () => [...agents],
    end: () => ended.push(true),
  }
}

function collector(): { messages: ServerMessage[]; send(m: ServerMessage): void } {
  const messages: ServerMessage[] = []
  return { messages, send: (m) => messages.push(m) }
}

function outcome(taskId: string, status: OutcomeView['status'] = 'success'): OutcomeView {
  return {
    taskId,
    status,
    exitCode: status === 'success' ? 0 : 1,
    durationMs: 5,
    hash: 'h-' + taskId,
  }
}

function doneOf(out: ServerMessage[]): { ok: boolean; outcomes: OutcomeView[] } | undefined {
  const r = out.find((m) => m.t === 'result')
  return r && r.t === 'result' ? r.result : undefined
}

describe('DistScheduler — the store prune', () => {
  it('a warm (probe-hit) task is NEVER assigned; it completes as a synthesized cache hit', async () => {
    const agent = fakeAgent('a1', 4)
    const out = collector()
    const sched = new DistScheduler({
      submit: submitMsg([
        node('pkg#build', [], 'warmhash000000aa'),
        node('pkg#test', ['pkg#build']),
      ]),
      store: store({ warmhash000000aa: 42 }),
      send: out.send,
    })
    sched.attach(binding([agent], () => sched))
    await sched.start()

    expect(agent.assigned()).toEqual(['pkg#test'])
    // The pruned task rendered as a remote hit with the sidecar duration.
    const completes = out.messages.filter(
      (m) => m.t === 'event' && m.event.kind === 'task:complete',
    )
    expect(completes).toHaveLength(1)
    const pruned = (completes[0] as { event: { outcome: OutcomeView } }).event.outcome
    expect(pruned.taskId).toBe('pkg#build')
    expect(pruned.status).toBe('cache-hit-remote')
    expect(pruned.durationMs).toBe(42)
    expect(pruned.hash).toBe('warmhash000000aa')

    sched.onAgentMessage(agent, {
      t: 'agent:done',
      taskId: 'pkg#test',
      outcome: outcome('pkg#test'),
    })
    const result = doneOf(out.messages)
    expect(result?.ok).toBe(true)
    expect(await sched.done).toEqual({ ok: true })
  })

  it('an ALL-warm graph finishes with zero assignments', async () => {
    const agent = fakeAgent('a1', 4)
    const out = collector()
    const sched = new DistScheduler({
      submit: submitMsg([
        node('pkg#a', [], 'hash00000000000a'),
        node('pkg#b', ['pkg#a'], 'hash00000000000b'),
      ]),
      store: store({ hash00000000000a: 1, hash00000000000b: 2 }),
      send: out.send,
    })
    sched.attach(binding([agent], () => sched))
    await sched.start()
    expect(agent.assigned()).toEqual([])
    expect(doneOf(out.messages)?.ok).toBe(true)
    expect(await sched.done).toEqual({ ok: true })
  })
})

describe('DistScheduler — dispatch', () => {
  it('respects agent capacity and drains the queue as tasks complete', async () => {
    const agent = fakeAgent('a1', 1)
    const out = collector()
    const sched = new DistScheduler({
      submit: submitMsg([node('pkg#a'), node('pkg#b')]),
      store: store(),
      send: out.send,
    })
    sched.attach(binding([agent], () => sched))
    await sched.start()
    expect(agent.assigned()).toEqual(['pkg#a'])

    sched.onAgentMessage(agent, { t: 'agent:done', taskId: 'pkg#a', outcome: outcome('pkg#a') })
    expect(agent.assigned()).toEqual(['pkg#a', 'pkg#b'])
  })

  it('dispatches the LONGEST task first when duration hints are present (LPT)', async () => {
    const agent = fakeAgent('a1', 1)
    const out = collector()
    // pkg#a queues before pkg#b, but pkg#b is historically longer → it goes first.
    const sched = new DistScheduler({
      submit: submitMsg([node('pkg#a'), node('pkg#b')]),
      store: store(),
      send: out.send,
      durationHints: new Map([
        ['pkg#a', 1000],
        ['pkg#b', 9000],
      ]),
    })
    sched.attach(binding([agent], () => sched))
    await sched.start()
    expect(agent.assigned()).toEqual(['pkg#b'])
    sched.onAgentMessage(agent, { t: 'agent:done', taskId: 'pkg#b', outcome: outcome('pkg#b') })
    expect(agent.assigned()).toEqual(['pkg#b', 'pkg#a'])
  })

  it('with NO hints (or all-equal) dispatch stays FIFO — byte-identical', async () => {
    const agent = fakeAgent('a1', 1)
    const out = collector()
    // An empty hint map (a no-history workspace) must not reorder anything.
    const sched = new DistScheduler({
      submit: submitMsg([node('pkg#a'), node('pkg#b')]),
      store: store(),
      send: out.send,
      durationHints: new Map(),
    })
    sched.attach(binding([agent], () => sched))
    await sched.start()
    expect(agent.assigned()).toEqual(['pkg#a'])
  })

  it('prefers the agent that executed a dep (dep-affinity), tie → first free', async () => {
    const a1 = fakeAgent('a1', 2)
    const a2 = fakeAgent('a2', 2)
    const out = collector()
    const sched = new DistScheduler({
      submit: submitMsg([node('pkg#a'), node('pkg#b', ['pkg#a'])]),
      store: store(),
      send: out.send,
    })
    sched.attach(binding([a1, a2], () => sched))
    await sched.start()
    // Tie at first dispatch → first free.
    expect(a1.assigned()).toEqual(['pkg#a'])

    // Simulate a2 having executed the dep after a reassignment story: mark
    // done from a2 → the dependent lands on a2 despite a1 being first.
    a1.inFlight.clear()
    sched.onAgentMessage(a2, { t: 'agent:done', taskId: 'pkg#a', outcome: outcome('pkg#a') })
    expect(a2.assigned()).toEqual(['pkg#b'])
    expect(a1.assigned()).toEqual(['pkg#a'])
  })

  it("reassigns a dead agent's in-flight tasks at the FRONT of the queue", async () => {
    const a1 = fakeAgent('a1', 1)
    const a2 = fakeAgent('a2', 1)
    const out = collector()
    const sched = new DistScheduler({
      submit: submitMsg([node('pkg#a'), node('pkg#b')]),
      store: store(),
      send: out.send,
    })
    const agents = [a1, a2]
    const bound = {
      ended: [] as boolean[],
      agents: () => [...agents],
      requestDispatch: () => dispatchGreedy(sched, agents),
      drainIfLast: () => [...agents],
      end: () => {},
    }
    sched.attach(bound)
    await sched.start()
    expect(a1.assigned()).toEqual(['pkg#a'])
    expect(a2.assigned()).toEqual(['pkg#b'])

    // a1 dies mid-task: its task re-dispatches to a2 once a2 frees up.
    agents.splice(0, 1)
    sched.onAgentLeave(a1, ['pkg#a'])
    sched.onAgentMessage(a2, { t: 'agent:done', taskId: 'pkg#b', outcome: outcome('pkg#b') })
    expect(a2.assigned()).toEqual(['pkg#b', 'pkg#a'])

    sched.onAgentMessage(a2, { t: 'agent:done', taskId: 'pkg#a', outcome: outcome('pkg#a') })
    expect(doneOf(out.messages)?.ok).toBe(true)
  })
})

describe('DistScheduler — graph semantics', () => {
  it('groups are never assigned and roll up their members; failures cascade skips', async () => {
    const agent = fakeAgent('a1', 4)
    const out = collector()
    const sched = new DistScheduler({
      submit: submitMsg([
        node('pkg#a'),
        node('pkg#b', ['pkg#a']),
        node('pkg#ci', ['pkg#b'], undefined, true),
      ]),
      store: store(),
      send: out.send,
    })
    sched.attach(binding([agent], () => sched))
    await sched.start()
    expect(agent.assigned()).toEqual(['pkg#a'])

    sched.onAgentMessage(agent, {
      t: 'agent:done',
      taskId: 'pkg#a',
      outcome: outcome('pkg#a', 'failed'),
    })
    // b skipped by the cascade, the group rolled up — never assigned.
    expect(agent.assigned()).toEqual(['pkg#a'])
    const result = doneOf(out.messages)
    expect(result?.ok).toBe(false)
    const byId = new Map(result!.outcomes.map((o) => [o.taskId, o.status]))
    expect(byId.get('pkg#b')).toBe('skipped')
    expect(byId.get('pkg#ci')).toBe('skipped')
    expect(await sched.done).toEqual({ ok: false })
  })

  it('a submitter death mid-run finishes the graph and drains the agents', async () => {
    const agent = fakeAgent('a1', 1)
    const out = collector()
    const sched = new DistScheduler({
      submit: submitMsg([node('pkg#a')]),
      store: store(),
      send: out.send,
    })
    sched.attach(binding([agent], () => sched))
    await sched.start()
    sched.onSubmitterGone()
    sched.onAgentMessage(agent, { t: 'agent:done', taskId: 'pkg#a', outcome: outcome('pkg#a') })
    expect(agent.sent.some((m) => m.t === 'coord:drain')).toBe(true)
    expect(await sched.done).toEqual({ ok: true })
  })

  it('a submitter death with no agents left aborts the submission', async () => {
    const out = collector()
    const sched = new DistScheduler({
      submit: submitMsg([node('pkg#a')]),
      store: store(),
      send: out.send,
    })
    sched.attach(binding([], () => sched))
    await sched.start()
    sched.onSubmitterGone()
    expect(await sched.done).toEqual({ ok: false })
    expect(out.messages.some((m) => m.t === 'error')).toBe(true)
  })

  it('warns loudly when zero REMOTE agents join within the timeout (the submitter does not count)', async () => {
    const self = fakeAgent('self', 4, [SUBMITTER_LABEL])
    const out = collector()
    const sched = new DistScheduler({
      submit: submitMsg([node('pkg#a')], 20),
      store: store(),
      send: out.send,
    })
    sched.attach(binding([self], () => sched))
    await sched.start()
    await Bun.sleep(40)
    const warning = out.messages.find(
      (m) =>
        m.t === 'event' &&
        m.event.kind === 'run:status' &&
        m.event.line.includes('0 remote agents'),
    )
    expect(warning).toBeDefined()
    sched.onAgentMessage(self, { t: 'agent:done', taskId: 'pkg#a', outcome: outcome('pkg#a') })
    expect(await sched.done).toEqual({ ok: true })
  })
})
