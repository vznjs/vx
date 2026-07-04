// The standing shared-pool multi-run scheduler (ci-platform-2026-07): several
// concurrent submissions multiplexed across shared agents through the REAL
// AgentRegistry + REAL DistScheduler. Three adversarial cases:
//   (a) two same-commit submissions genuinely SHARE the agents (fair, both ok);
//   (b) a submission whose commit no remote agent holds runs on its self-agent
//       only (warns; never a wrong hit);
//   (c) a shared agent's death re-queues ONLY its owner-submission's tasks,
//       leaving the other submission's work untouched.

import { describe, expect, it } from 'bun:test'
import type { OutcomeView, ServerMessage, TaskView } from '@vzn/vx'
import { AgentRegistry, SUBMITTER_LABEL, type RegisteredAgent } from '../src/dist/registry.js'
import { DistScheduler, type ArtifactProbe } from '../src/dist/scheduler.js'
import {
  DIST_PROTOCOL_VERSION,
  type AgentHello,
  type DistGraphNode,
  type DistServerMessage,
  type DistSubmitMessage,
} from '../src/protocol-dist.js'

function view(id: string): TaskView {
  const [project, task] = id.split('#') as [string, string]
  return {
    id,
    project,
    task,
    isGroup: false,
    requested: true,
    surfaced: false,
    persistent: false,
    command: `echo ${task}`,
  }
}

function node(id: string, deps: string[] = []): DistGraphNode {
  return { id, deps, view: view(id) }
}

const emptyStore: ArtifactProbe = {
  has: () => Promise.resolve(false),
  storedDurationMs: () => Promise.resolve(undefined),
}

function submitMsg(
  submissionId: string,
  nodes: DistGraphNode[],
  commitSha = 'commit-a',
  agentTimeoutMs = 60_000,
): DistSubmitMessage {
  return {
    t: 'dist:submit',
    protocol: DIST_PROTOCOL_VERSION,
    session: 'shared',
    workspaceId: 'ws1',
    submissionId,
    commitSha,
    expectedAgents: 2,
    agentTimeoutMs,
    request: { tasks: ['build'], cwd: '/w' },
    nodes,
  }
}

function okOutcome(taskId: string): OutcomeView {
  return { taskId, status: 'success', exitCode: 0, durationMs: 1, hash: `h-${taskId}` }
}

/** A submission driven through the real registry: its own scheduler + collector. */
function submit(
  reg: AgentRegistry,
  submissionId: string,
  nodes: DistGraphNode[],
  commitSha = 'commit-a',
  agentTimeoutMs = 60_000,
): { sched: DistScheduler; messages: ServerMessage[] } {
  const messages: ServerMessage[] = []
  const sched = new DistScheduler({
    submit: submitMsg(submissionId, nodes, commitSha, agentTimeoutMs),
    store: emptyStore,
    send: (m) => messages.push(m),
  })
  const bound = reg.beginSubmission('ws1', 'shared', sched)
  if ('error' in bound) throw new Error(bound.error)
  sched.attach(bound)
  return { sched, messages }
}

/** A fake agent that captures assignments and lets the test complete them. */
interface Driver {
  handle: RegisteredAgent
  /** Every task:assign this agent received, in order (with its submission). */
  assigns: Array<{ taskId: string; submissionId: string }>
  /** Assignments not yet completed. */
  pending: Array<{ taskId: string; submissionId: string }>
  drained: boolean
}

function join(
  reg: AgentRegistry,
  agentId: string,
  opts: { commitSha?: string; capacity?: number; labels?: string[]; owner?: string } = {},
): Driver {
  const d: Driver = {
    handle: undefined as unknown as RegisteredAgent,
    assigns: [],
    pending: [],
    drained: false,
  }
  const io = {
    send: (m: DistServerMessage) => {
      if (m.t === 'task:assign') {
        d.assigns.push({ taskId: m.taskId, submissionId: m.submissionId })
        d.pending.push({ taskId: m.taskId, submissionId: m.submissionId })
      } else if (m.t === 'coord:drain') {
        d.drained = true
      }
    },
    close: () => {},
  }
  const msg: AgentHello = {
    t: 'agent:hello',
    protocol: DIST_PROTOCOL_VERSION,
    agentId,
    workspaceId: 'ws1',
    session: 'shared',
    commitSha: opts.commitSha ?? 'commit-a',
    capacity: opts.capacity ?? 1,
    ...(opts.labels !== undefined ? { labels: opts.labels } : {}),
    ...(opts.owner !== undefined ? { ownerSubmissionId: opts.owner } : {}),
  }
  d.handle = reg.hello(msg, io) as RegisteredAgent
  return d
}

/** Complete the oldest pending task on `d` (agent → serve `agent:done`). */
function complete(reg: AgentRegistry, d: Driver): boolean {
  const next = d.pending.shift()
  if (next === undefined) return false
  reg.dispatch(d.handle, {
    t: 'agent:done',
    taskId: next.taskId,
    submissionId: next.submissionId,
    outcome: okOutcome(next.taskId),
  })
  return true
}

/** Drain every driver FIFO until none has pending work — deterministic. */
function drainAll(reg: AgentRegistry, drivers: Driver[]): void {
  let progressed = true
  while (progressed) {
    progressed = false
    for (const d of drivers) if (complete(reg, d)) progressed = true
  }
}

function resultOf(messages: ServerMessage[]): { ok: boolean; outcomes: OutcomeView[] } | undefined {
  const r = messages.find((m) => m.t === 'result')
  return r && r.t === 'result' ? r.result : undefined
}

describe('multi-run — two same-commit submissions share the pool fairly', () => {
  it('places both submissions across the shared agents; both reach ok', async () => {
    const reg = new AgentRegistry()
    const g1 = join(reg, 'g1', { capacity: 1 })
    const g2 = join(reg, 'g2', { capacity: 1 })

    // A submits first (grabs both free slots), then B submits concurrently.
    const a = submit(reg, 'sub-a', [node('pkg#a1'), node('pkg#a2')])
    await a.sched.start()
    const b = submit(reg, 'sub-b', [node('pkg#b1'), node('pkg#b2')])
    await b.sched.start()

    drainAll(reg, [g1, g2])

    expect(resultOf(a.messages)?.ok).toBe(true)
    expect(resultOf(b.messages)?.ok).toBe(true)
    expect(await a.sched.done).toEqual({ ok: true })
    expect(await b.sched.done).toEqual({ ok: true })

    // Genuine multiplexing: as slots free, the shared agents serve BOTH
    // submissions (not one draining fully before the other starts).
    const subsServed = new Set([...g1.assigns, ...g2.assigns].map((x) => x.submissionId))
    expect(subsServed).toEqual(new Set(['sub-a', 'sub-b']))
    // Every task ran exactly once, across the two agents.
    const allTasks = [...g1.assigns, ...g2.assigns].map((x) => x.taskId).sort()
    expect(allTasks).toEqual(['pkg#a1', 'pkg#a2', 'pkg#b1', 'pkg#b2'])
  })

  it('a small run is not starved by a huge concurrent one (fair share)', async () => {
    const reg = new AgentRegistry()
    // One shared agent, capacity 1 → the two submissions strictly alternate.
    const g = join(reg, 'g1', { capacity: 1 })

    const big = submit(reg, 'sub-big', [node('pkg#x1'), node('pkg#x2'), node('pkg#x3')])
    await big.sched.start()
    const small = submit(reg, 'sub-small', [node('pkg#y1')])
    await small.sched.start()

    drainAll(reg, [g])

    expect(resultOf(big.messages)?.ok).toBe(true)
    expect(resultOf(small.messages)?.ok).toBe(true)
    // The small submission's one task ran BEFORE the big one's last task —
    // round-robin gave it a turn instead of queueing it behind all three.
    const order = g.assigns.map((x) => x.taskId)
    expect(order).toContain('pkg#y1')
    expect(order.indexOf('pkg#y1')).toBeLessThan(order.lastIndexOf('pkg#x3'))
  })
})

describe('multi-run — commit is an eligibility filter, never a refusal', () => {
  it('a submission whose commit no REMOTE agent holds runs on its self-agent only, warning', async () => {
    const reg = new AgentRegistry()
    // A genuine helper, but at a DIFFERENT commit — ineligible, not refused.
    const other = join(reg, 'helper', { commitSha: 'commit-main', capacity: 4 })
    // The submitter's self-agent at the feature-branch commit, owning the run.
    const self = join(reg, 'self', {
      commitSha: 'commit-feature',
      capacity: 2,
      labels: [SUBMITTER_LABEL],
      owner: 'sub-feat',
    })

    const s = submit(reg, 'sub-feat', [node('pkg#a'), node('pkg#b')], 'commit-feature', 20)
    await s.sched.start()
    await Bun.sleep(40) // let the no-remote-agent warning timer fire

    drainAll(reg, [self, other])

    expect(resultOf(s.messages)?.ok).toBe(true)
    // Everything ran on the self-agent; the wrong-commit helper got nothing.
    expect(self.assigns.map((x) => x.taskId).sort()).toEqual(['pkg#a', 'pkg#b'])
    expect(other.assigns).toEqual([])
    // …and the loud "0 remote agents" warning fired.
    const warned = s.messages.some(
      (m) =>
        m.t === 'event' &&
        m.event.kind === 'run:status' &&
        m.event.line.includes('0 remote agents'),
    )
    expect(warned).toBe(true)
  })

  it('a self-agent is eligible ONLY for the submission that owns it', async () => {
    const reg = new AgentRegistry()
    // A's self-agent (owns sub-a). No genuine remote agent exists.
    const selfA = join(reg, 'selfA', { capacity: 1, labels: [SUBMITTER_LABEL], owner: 'sub-a' })

    const a = submit(reg, 'sub-a', [node('pkg#a1')])
    await a.sched.start()
    // B submits at the SAME commit — but must NOT get A's self-agent.
    const b = submit(reg, 'sub-b', [node('pkg#b1')], 'commit-a', 20)
    await b.sched.start()

    // A's task lands on A's self-agent; B has zero eligible agents → nothing yet.
    expect(selfA.assigns.map((x) => x.taskId)).toEqual(['pkg#a1'])
    // Only sub-a was ever placed on the owned self-agent.
    expect(new Set(selfA.assigns.map((x) => x.submissionId))).toEqual(new Set(['sub-a']))

    // B is genuinely stuck without its own agent; give it one and it proceeds.
    const selfB = join(reg, 'selfB', { capacity: 1, labels: [SUBMITTER_LABEL], owner: 'sub-b' })
    drainAll(reg, [selfA, selfB])
    expect(resultOf(a.messages)?.ok).toBe(true)
    expect(resultOf(b.messages)?.ok).toBe(true)
    expect(selfB.assigns.map((x) => x.taskId)).toEqual(['pkg#b1'])
  })
})

describe('multi-run — a shared agent death re-queues only its owner-submission tasks', () => {
  it("reassigns the dead agent's submission's task, leaving the other submission untouched", async () => {
    const reg = new AgentRegistry()
    const g1 = join(reg, 'g1', { capacity: 1 })
    const g2 = join(reg, 'g2', { capacity: 1 })

    // A submits first → its single task grabs the first free agent (g1).
    const a = submit(reg, 'sub-a', [node('pkg#a1')])
    await a.sched.start()
    // B submits → its task grabs the remaining free agent (g2).
    const b = submit(reg, 'sub-b', [node('pkg#b1')])
    await b.sched.start()

    expect(g1.assigns.map((x) => x.taskId)).toEqual(['pkg#a1'])
    expect(g2.assigns.map((x) => x.taskId)).toEqual(['pkg#b1'])

    // g1 dies mid-task WITHOUT completing pkg#a1. Only sub-a's task re-queues;
    // sub-b's pkg#a1 on g2 is untouched (g1 held nothing of sub-b's).
    reg.drop(g1.handle)

    // sub-b finishes on g2 first; that frees g2 for sub-a's reassigned task.
    drainAll(reg, [g2, g1])

    expect(resultOf(a.messages)?.ok).toBe(true)
    expect(resultOf(b.messages)?.ok).toBe(true)
    expect(await a.sched.done).toEqual({ ok: true })
    expect(await b.sched.done).toEqual({ ok: true })

    // pkg#a1 was reassigned (g1 then g2); pkg#b1 ran exactly once, on g2 only.
    expect(g1.assigns.map((x) => x.taskId)).toEqual(['pkg#a1'])
    expect(g2.assigns.map((x) => x.taskId).sort()).toEqual(['pkg#a1', 'pkg#b1'])
    // sub-b's task was NEVER re-queued or re-placed — the death didn't disturb it.
    const b1Placements = [...g1.assigns, ...g2.assigns].filter((x) => x.taskId === 'pkg#b1')
    expect(b1Placements).toHaveLength(1)
  })
})
