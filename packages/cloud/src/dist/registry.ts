// The session registry on the serve — the whole "persistent coordinator"
// increment (distributed-execution-2026-07 §4.1). In-memory, tens of
// entries, touched on hello/close/submit; a serve restart mid-pipeline
// fails that pipeline loudly and the next one is fine (no persistence by
// design).
//
// Registry key: `{workspaceId, session}`. A session holds its connected
// agents and at most ONE active submission; SEQUENTIAL submissions reuse
// the registered agents (a main job runs `vx run lint` then `vx run test`
// against the same matrix) — that is why the registry outlives a run.
//
// commitSha is enforced at PAIRING time, not hello time: agents usually
// register before the main job submits, so a mismatch only becomes
// meaningful once a submission names its commit.

import { DIST_PROTOCOL_VERSION, type AgentHello, type DistServerMessage } from '../protocol-dist.js'

/**
 * Label the submitter's in-process self-agent carries so the serve can tell
 * "this machine, submitting" apart from genuine remote helper agents. Lives
 * here (the base module that owns agent labels) so both the scheduler and the
 * capacity read can reference it without an import cycle.
 */
export const SUBMITTER_LABEL = 'submitter'

/** Sessions idle longer than this (no agents, no submission) are swept. */
export const SESSION_GC_MS = 15 * 60 * 1000

/** How often the serve runs the GC sweep. */
export const SESSION_GC_INTERVAL_MS = 60 * 1000

/**
 * An agent that hasn't been heard from in this long (≈3 missed heartbeats at
 * AGENT_HEARTBEAT_MS = 10 s) is presumed dead and reaped, reassigning its
 * in-flight tasks. This is what turns a half-open TCP socket (crashed box,
 * network partition — which never fires WS `close`) into a seconds-scale
 * detection instead of an OS-keep-alive-timeout stall.
 */
export const AGENT_STALE_MS = 30 * 1000

/** How often the serve sweeps for stale agents. */
export const AGENT_SWEEP_INTERVAL_MS = 15 * 1000

export interface RegisteredAgent {
  readonly agentId: string
  readonly workspaceId: string
  readonly session: string
  readonly commitSha: string
  readonly capacity: number
  readonly labels: readonly string[]
  /** Task ids currently assigned to this agent. */
  readonly inFlight: Set<string>
  /** Epoch ms of the last message from this agent (hello / heartbeat / task
   *  event). The stale-agent sweep reaps agents whose value falls behind. */
  lastSeenAt: number
  send(msg: DistServerMessage): void
  close(): void
}

/**
 * What the registry needs from a live submission (the scheduler
 * implements it). Join/leave keep dispatch working across agent churn;
 * message routing carries the agent's task events.
 */
export interface ActiveSubmission {
  readonly commitSha: string
  onAgentJoin(agent: RegisteredAgent): void
  onAgentLeave(agent: RegisteredAgent, inFlight: readonly string[]): void
  onAgentMessage(agent: RegisteredAgent, msg: unknown): void
  /** Tasks ready to run but waiting for a free agent slot — the autoscaling
   *  pressure signal surfaced on `/v1/agents`. Optional (defaults to 0). */
  readyDepth?(): number
}

interface SessionState {
  key: string
  workspaceId: string
  session: string
  agents: Map<string, RegisteredAgent>
  active: ActiveSubmission | null
  lastActivityAt: number
}

export interface SubmissionBinding {
  /** Live view of the session's connected agents. */
  agents(): RegisteredAgent[]
  /** Clears the active slot so a sequential submission can start. */
  end(): void
}

function sessionKey(workspaceId: string, session: string): string {
  return `${workspaceId}/${session}`
}

export class AgentRegistry {
  private readonly sessions = new Map<string, SessionState>()

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Register an agent from its `agent:hello`. Refusals (protocol
   * mismatch; commit mismatch against an ACTIVE submission) are sent to
   * the agent and the socket closed — the caller only needs the handle
   * on success.
   */
  hello(
    msg: AgentHello,
    io: { send(m: DistServerMessage): void; close(): void },
  ): RegisteredAgent | null {
    if (msg.protocol !== DIST_PROTOCOL_VERSION) {
      io.send({
        t: 'agent:refused',
        reason: `protocol mismatch: agent speaks v${msg.protocol}, serve speaks v${DIST_PROTOCOL_VERSION}`,
      })
      io.close()
      return null
    }
    const state = this.sessionFor(msg.workspaceId, msg.session)
    // A late hello mismatching an ACTIVE submission is refused (a red
    // matrix row = infra misconfig); with no submission the agent is
    // held as-is — pairing enforces the commit later.
    if (state.active !== null && state.active.commitSha !== msg.commitSha) {
      io.send({
        t: 'agent:refused',
        reason: `commit mismatch: session ${state.key} is running ${state.active.commitSha}, agent is at ${msg.commitSha}`,
      })
      io.close()
      return null
    }
    const agent: RegisteredAgent = {
      agentId: msg.agentId,
      workspaceId: msg.workspaceId,
      session: msg.session,
      commitSha: msg.commitSha,
      capacity: msg.capacity,
      labels: msg.labels ?? [],
      inFlight: new Set(),
      lastSeenAt: this.now(),
      send: io.send,
      close: io.close,
    }
    state.agents.set(agent.agentId, agent)
    state.lastActivityAt = this.now()
    state.active?.onAgentJoin(agent)
    return agent
  }

  /** WS close for a registered agent: unregister + let the scheduler reassign. */
  drop(agent: RegisteredAgent): void {
    const state = this.sessions.get(sessionKey(agent.workspaceId, agent.session))
    if (state === undefined || state.agents.get(agent.agentId) !== agent) return
    state.agents.delete(agent.agentId)
    state.lastActivityAt = this.now()
    state.active?.onAgentLeave(agent, [...agent.inFlight])
  }

  /**
   * Route a post-hello agent message to the session's live submission. ANY
   * message (a task event or a bare `agent:heartbeat`) counts as liveness, so
   * the stale sweep never reaps a busy-but-quiet agent.
   */
  dispatch(agent: RegisteredAgent, msg: unknown): void {
    const state = this.sessions.get(sessionKey(agent.workspaceId, agent.session))
    if (state === undefined) return
    const now = this.now()
    agent.lastSeenAt = now
    state.lastActivityAt = now
    state.active?.onAgentMessage(agent, msg)
  }

  /**
   * Pair a submission with its session. Enforces ONE active submission
   * per session, and drops every already-registered agent whose commit
   * differs (each gets `agent:refused` naming both SHAs).
   */
  beginSubmission(
    workspaceId: string,
    session: string,
    submission: ActiveSubmission,
  ): SubmissionBinding | { error: string } {
    const state = this.sessionFor(workspaceId, session)
    if (state.active !== null) {
      return { error: `session ${state.key} already has an active submission` }
    }
    for (const agent of [...state.agents.values()]) {
      if (agent.commitSha === submission.commitSha) continue
      agent.send({
        t: 'agent:refused',
        reason: `commit mismatch: submission is at ${submission.commitSha}, agent is at ${agent.commitSha}`,
      })
      agent.close()
      state.agents.delete(agent.agentId)
    }
    state.active = submission
    state.lastActivityAt = this.now()
    return {
      agents: () => [...state.agents.values()],
      end: () => {
        if (state.active === submission) {
          state.active = null
          state.lastActivityAt = this.now()
        }
      },
    }
  }

  /**
   * Reap agents that have gone silent past `maxIdleMs` (a crashed box / a
   * half-open TCP socket that never fired `close`). Each is dropped exactly
   * like a clean disconnect — removed from its session and its in-flight tasks
   * handed back to the active submission for reassignment — then its socket is
   * closed best-effort. `drop()` is idempotent, so a later real `close` for the
   * same agent is a no-op. Returns the number reaped.
   */
  sweepStale(maxIdleMs: number): number {
    const cutoff = this.now() - maxIdleMs
    let reaped = 0
    for (const state of this.sessions.values()) {
      for (const agent of [...state.agents.values()]) {
        if (agent.lastSeenAt < cutoff) {
          this.drop(agent)
          agent.close()
          reaped++
        }
      }
    }
    return reaped
  }

  /** Remove sessions with no agents, no submission, and 15 min of silence. */
  gc(): void {
    const cutoff = this.now() - SESSION_GC_MS
    for (const [key, state] of this.sessions) {
      if (state.agents.size === 0 && state.active === null && state.lastActivityAt < cutoff) {
        this.sessions.delete(key)
      }
    }
  }

  /** Session count — GC observability for tests. */
  sessionCount(): number {
    return this.sessions.size
  }

  /**
   * A session's live pool size — total vs REMOTE (helper) agents/capacity.
   * "Remote" excludes the submitter's self-agent (it carries `SUBMITTER_LABEL`),
   * so `remoteAgents > 0` means "there is genuine external capacity here." An
   * ambient `vx run` uses this to decide whether distributing is worth it, or
   * whether to stay a fast local run; an autoscaler reads the same counts.
   * Unknown session → all zeros. Pure read over the in-memory map.
   */
  availableCapacity(
    workspaceId: string,
    session: string,
  ): {
    agents: number
    remoteAgents: number
    capacity: number
    remoteCapacity: number
    ready: number
  } {
    const state = this.sessions.get(sessionKey(workspaceId, session))
    if (state === undefined) {
      return { agents: 0, remoteAgents: 0, capacity: 0, remoteCapacity: 0, ready: 0 }
    }
    let agents = 0
    let remoteAgents = 0
    let capacity = 0
    let remoteCapacity = 0
    for (const agent of state.agents.values()) {
      agents++
      capacity += agent.capacity
      if (!agent.labels.includes(SUBMITTER_LABEL)) {
        remoteAgents++
        remoteCapacity += agent.capacity
      }
    }
    // Ready-but-unassigned tasks: non-zero only when agent capacity is
    // saturated — the signal an autoscaler scales the pool UP on.
    const ready = state.active?.readyDepth?.() ?? 0
    return { agents, remoteAgents, capacity, remoteCapacity, ready }
  }

  private sessionFor(workspaceId: string, session: string): SessionState {
    const key = sessionKey(workspaceId, session)
    let state = this.sessions.get(key)
    if (state === undefined) {
      state = {
        key,
        workspaceId,
        session,
        agents: new Map(),
        active: null,
        lastActivityAt: this.now(),
      }
      this.sessions.set(key, state)
    }
    return state
  }
}
