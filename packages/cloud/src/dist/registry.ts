// The session registry on the serve — the persistent coordinator
// (distributed-execution-2026-07 §4.1) grown into the standing shared pool
// (ci-platform-2026-07). In-memory, tens of entries, touched on
// hello/close/submit; a serve restart mid-pipeline fails that pipeline
// loudly and the next one is fine (no persistence by design).
//
// Registry key: `{orgId, workspaceId, session}` (cloud-platform-2026-07 §8.2).
// The org is SERVER-DERIVED from the agent's / submitter's token (never a wire
// claim), so two tenants' pools can never collide or pair; a caller that passes
// no org (the `DEFAULT_ORG` fallback — the registry's own unit tests) keys
// everything under `'default'`, byte-identical to the pre-tenancy
// `{workspaceId, session}` key. A session holds its
// connected agents and any number of CONCURRENT submissions, fairly
// multiplexed across the shared agents by the registry's `dispatchSession`
// loop. The registry outlives a run so sequential submissions reuse the pool
// AND so concurrent submissions (parallel CI jobs at one commit, two teammates)
// can share it.
//
// commitSha is a dispatch-ELIGIBILITY filter, never a refusal: an agent is
// at exactly one commit for its lifetime, so a submission dispatches only to
// same-commit agents (the correctness law §6.3 holds per task); a submission
// no remote agent's commit matches runs entirely on its own self-agent
// (= submitter-local), degrading toward local execution, never a wrong hit.
// A `SUBMITTER_LABEL` self-agent is additionally eligible ONLY for the
// submission that owns it (`ownerSubmissionId`), so a same-commit peer can
// never conscript your laptop for its run.

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

/** Fallback org when a caller passes none (the registry unit tests). The
 *  platform dispatch always passes the token-derived org, so a real request is
 *  never keyed under this. */
export const DEFAULT_ORG = 'default'

export interface RegisteredAgent {
  readonly agentId: string
  /** The token-derived org — the top tenant boundary of the session key. */
  readonly orgId: string
  readonly workspaceId: string
  readonly session: string
  readonly commitSha: string
  readonly capacity: number
  readonly labels: readonly string[]
  /**
   * Task ids currently assigned to this agent, keyed by the submission that
   * owns them: `submissionId → Set<taskId>`. Capacity is a physical property
   * of the machine, so the free-slot check is `inFlightTotal < capacity` — one
   * agent can hold slots for several concurrent submissions at once, and
   * agent death hands each submission back only its own tasks.
   */
  readonly inFlight: Map<string, Set<string>>
  /**
   * For a `SUBMITTER_LABEL` self-agent: the id of the one submission it may
   * serve. Unset on a standing helper agent (serves any same-commit submission).
   */
  ownerSubmissionId?: string
  /** Epoch ms of the last message from this agent (hello / heartbeat / task
   *  event). The stale-agent sweep reaps agents whose value falls behind. */
  lastSeenAt: number
  /**
   * Whether this agent has ever sent an `agent:heartbeat`. The staleness sweep
   * applies ONLY to agents that heartbeat — so an OLD agent (a version that
   * predates heartbeats) is never wrongly reaped for being idle; it's still
   * cleaned up on WS close like before. A partitioned NEW agent heartbeated
   * before it vanished, so it IS reaped.
   */
  sawHeartbeat: boolean
  send(msg: DistServerMessage): void
  close(): void
}

/**
 * What the registry needs from a live submission (the scheduler
 * implements it). Join/leave/message keep bookkeeping across agent churn;
 * the "dispatchable" trio (`nextReady`/`affinityAgents`/`assign`) lets the
 * registry's fair loop hand this submission's ready tasks to eligible free
 * agents.
 */
export interface ActiveSubmission {
  readonly submissionId: string
  readonly commitSha: string
  onAgentJoin(agent: RegisteredAgent): void
  onAgentLeave(agent: RegisteredAgent, inFlight: readonly string[]): void
  onAgentMessage(agent: RegisteredAgent, msg: unknown): void
  /** The next ready-but-unassigned task, or undefined when none/finished. */
  nextReady(): string | undefined
  /** Agent ids that already executed a dep of `taskId` (dep-affinity locality). */
  affinityAgents(taskId: string): ReadonlySet<string>
  /** Splice `taskId` out of ready, record it on `agent`, send `task:assign`. */
  assign(taskId: string, agent: RegisteredAgent): void
  /** Tasks ready to run but waiting for a free agent slot — the autoscaling
   *  pressure signal surfaced on `/v1/agents`. Optional (defaults to 0). */
  readyDepth?(): number
}

interface SessionState {
  key: string
  orgId: string
  workspaceId: string
  session: string
  agents: Map<string, RegisteredAgent>
  /** submissionId → its live submission. Concurrent submissions multiplex. */
  active: Map<string, ActiveSubmission>
  /** Round-robin cursor so no submission is perpetually served first. */
  rotation: number
  lastActivityAt: number
}

export interface SubmissionBinding {
  /** Live view of the session's agents ELIGIBLE for this submission. */
  agents(): RegisteredAgent[]
  /** Run the session's fair dispatch loop (a submission triggers it on any
   *  state change — start, agent join/leave, task done). */
  requestDispatch(): void
  /** The agents to drain — this submission's ELIGIBLE agents, and ONLY when it
   *  is the last active submission (so aborting one shared run never kills
   *  another's agents, and never drains different-commit standing helpers it
   *  couldn't use). Empty otherwise. */
  drainIfLast(): RegisteredAgent[]
  /** Remove this submission from the session + release its slots on every agent. */
  end(): void
}

function sessionKey(orgId: string, workspaceId: string, session: string): string {
  return `${orgId}/${workspaceId}/${session}`
}

/** Total tasks this agent holds across all submissions (the capacity check). */
export function inFlightTotal(agent: RegisteredAgent): number {
  let total = 0
  for (const set of agent.inFlight.values()) total += set.size
  return total
}

/**
 * Can `agent` execute a task for `sub`? Same commit (its checkout can't mix
 * commits, so a different-commit agent would derive a wrong key), and — if it
 * is a submitter self-agent — only for the submission that owns it.
 */
export function eligible(agent: RegisteredAgent, sub: ActiveSubmission): boolean {
  if (agent.commitSha !== sub.commitSha) return false
  if (agent.labels.includes(SUBMITTER_LABEL) && agent.ownerSubmissionId !== sub.submissionId) {
    return false
  }
  return true
}

/** Pick an eligible free agent for `taskId`, preferring one with a dep warm. */
function pickAgent(
  agents: readonly RegisteredAgent[],
  sub: ActiveSubmission,
  taskId: string,
): RegisteredAgent | undefined {
  const affinity = sub.affinityAgents(taskId)
  let first: RegisteredAgent | undefined
  for (const a of agents) {
    if (!eligible(a, sub)) continue
    if (inFlightTotal(a) >= a.capacity) continue
    // First free eligible agent that ran a dep (warm local cache) wins;
    // else the first free eligible agent — byte-identical to the old greedy.
    if (affinity.has(a.agentId)) return a
    first ??= a
  }
  return first
}

/** Assign ONE ready task of `sub` to an eligible free agent, if possible. */
function assignOne(sub: ActiveSubmission, agents: readonly RegisteredAgent[]): boolean {
  const taskId = sub.nextReady()
  if (taskId === undefined) return false
  const agent = pickAgent(agents, sub, taskId)
  if (agent === undefined) return false
  sub.assign(taskId, agent)
  return true
}

/**
 * Drain one submission greedily against `agents` (assign until no ready task
 * or no free eligible agent). This is what the registry's fair loop does per
 * submission, and — for a lone submission — degenerates to the old greedy
 * dispatch, byte-for-byte. Exported so the scheduler unit tests can drive a
 * stub binding without the whole registry.
 */
export function dispatchGreedy(sub: ActiveSubmission, agents: readonly RegisteredAgent[]): void {
  while (assignOne(sub, agents)) {
    // keep assigning
  }
}

export class AgentRegistry {
  private readonly sessions = new Map<string, SessionState>()

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Register an agent from its `agent:hello`. The only refusal is a protocol
   * mismatch (sent + socket closed); a commit mismatch is NOT a refusal — the
   * agent registers and is simply ineligible for a different-commit
   * submission (it can still serve a matching one that arrives later).
   */
  hello(
    msg: AgentHello,
    io: { send(m: DistServerMessage): void; close(): void },
    orgId: string = DEFAULT_ORG,
  ): RegisteredAgent | null {
    const refuse = (reason: string): null => {
      io.send({ t: 'agent:refused', reason })
      io.close()
      return null
    }
    if (msg.protocol !== DIST_PROTOCOL_VERSION) {
      return refuse(
        `protocol mismatch: agent speaks v${msg.protocol}, serve speaks v${DIST_PROTOCOL_VERSION}`,
      )
    }
    // `agent:hello` is a raw wire frame — every field reaches here as an
    // unchecked cast, and each malformed shape fails SILENTLY rather than
    // loudly, which is why they are refused here (the one boundary every
    // caller goes through) instead of trusted:
    //
    //   - capacity is compared as `inFlightTotal(a) >= a.capacity`. A missing
    //     field or any non-number reads as NaN, and `n >= NaN` is ALWAYS false,
    //     so the agent never reads as full and absorbs every ready task in one
    //     dispatch pass (measured: 6 of 6). `null` is the mirror image —
    //     `0 >= null` is true — so it registers as remote capacity an ambient
    //     submitter distributes toward, then takes zero work.
    //   - a duplicate agentId silently REPLACES the live agent in the session
    //     map, so its in-flight tasks are never handed back (`drop` no-ops on
    //     the identity mismatch) and its socket is never closed: the submission
    //     waits on a task no one holds, forever. Refusing is terminal in
    //     `runAgentLoop`, so this can never ping-pong two agents evicting each
    //     other; and ids are random UUIDv7 per connect, so it cannot fire for a
    //     real agent.
    for (const [field, value] of [
      ['agentId', msg.agentId],
      ['workspaceId', msg.workspaceId],
      ['session', msg.session],
      ['commitSha', msg.commitSha],
    ] as const) {
      if (typeof value !== 'string' || value === '') {
        return refuse(`invalid agent:hello — ${field} must be a non-empty string`)
      }
    }
    if (!Number.isInteger(msg.capacity) || msg.capacity < 1) {
      return refuse(
        `invalid agent:hello — capacity must be a positive integer (got ${String(msg.capacity)})`,
      )
    }
    const state = this.sessionFor(orgId, msg.workspaceId, msg.session)
    if (state.agents.has(msg.agentId)) {
      return refuse(`agent id ${msg.agentId} is already connected to ${state.key}`)
    }
    const agent: RegisteredAgent = {
      agentId: msg.agentId,
      orgId,
      workspaceId: msg.workspaceId,
      session: msg.session,
      commitSha: msg.commitSha,
      capacity: msg.capacity,
      labels: msg.labels ?? [],
      inFlight: new Map(),
      ...(msg.ownerSubmissionId !== undefined ? { ownerSubmissionId: msg.ownerSubmissionId } : {}),
      lastSeenAt: this.now(),
      sawHeartbeat: false,
      send: io.send,
      close: io.close,
    }
    state.agents.set(agent.agentId, agent)
    state.lastActivityAt = this.now()
    // Bookkeeping for every submission this agent may serve (same commit +
    // self-agent ownership); each `onAgentJoin` triggers the fair dispatch
    // loop so a mid-run join gets work at once. A self-agent must NOT notify
    // non-owner submissions — it isn't capacity for them.
    for (const sub of state.active.values()) {
      if (eligible(agent, sub)) sub.onAgentJoin(agent)
    }
    return agent
  }

  /** WS close for a registered agent: unregister + hand each submission its own tasks back. */
  drop(agent: RegisteredAgent): void {
    const state = this.sessions.get(sessionKey(agent.orgId, agent.workspaceId, agent.session))
    if (state === undefined || state.agents.get(agent.agentId) !== agent) return
    state.agents.delete(agent.agentId)
    state.lastActivityAt = this.now()
    // Reassign ONLY that submission's tasks to that submission — a shared
    // agent's death leaves other submissions' work on other agents untouched.
    for (const [subId, tasks] of agent.inFlight) {
      state.active.get(subId)?.onAgentLeave(agent, [...tasks])
    }
    // `inFlight` is the AUTHORITATIVE holder set — the scheduler gates a task's
    // stdout/stderr and its terminal outcome on "does this agent currently hold
    // it?". Handing the tasks back above transfers that claim, so the dropped
    // agent must release it, or it stays a co-holder of work it no longer owns.
    // That is not hypothetical: a reaped agent (a 30 s-silent box whose detached
    // run() is still going) kept passing the holder gate, so its output
    // interleaved with the replacement's into one task's relay AND stored log —
    // exactly the garble the gate was added to stop — and its `agent:done` could
    // land FIRST, making a reaped machine's verdict the run's verdict while the
    // live replacement's real result was discarded as a stale duplicate.
    agent.inFlight.clear()
  }

  /**
   * Route a post-hello TASK message to the submission it names. A task event
   * also counts as liveness (a busy-but-quiet agent is never reaped).
   * Heartbeats go through `heartbeat()` instead, not here. The submission's
   * own `onAgentMessage` re-triggers the fair dispatch loop when a slot frees.
   */
  dispatch(agent: RegisteredAgent, msg: unknown): void {
    const state = this.sessions.get(sessionKey(agent.orgId, agent.workspaceId, agent.session))
    if (state === undefined) return
    const now = this.now()
    agent.lastSeenAt = now
    state.lastActivityAt = now
    const subId = (msg as { submissionId?: string }).submissionId
    if (subId !== undefined) state.active.get(subId)?.onAgentMessage(agent, msg)
  }

  /** Record an `agent:heartbeat` — updates liveness and marks the agent as one
   *  the staleness sweep may reap (see `RegisteredAgent.sawHeartbeat`). */
  heartbeat(agent: RegisteredAgent): void {
    const state = this.sessions.get(sessionKey(agent.orgId, agent.workspaceId, agent.session))
    if (state === undefined) return
    const now = this.now()
    agent.lastSeenAt = now
    agent.sawHeartbeat = true
    state.lastActivityAt = now
  }

  /**
   * Pair a submission with its session. Concurrent submissions coexist — the
   * only guard is a duplicate `submissionId` (a client bug; ULID ids make it
   * practically impossible). Commit-mismatched agents are neither dropped nor
   * refused; they stay registered and are simply ineligible for this
   * submission (a misconfigured matrix surfaces as "0 commit-matching remote
   * agents", not a dropped socket).
   */
  beginSubmission(
    workspaceId: string,
    session: string,
    submission: ActiveSubmission,
    orgId: string = DEFAULT_ORG,
  ): SubmissionBinding | { error: string } {
    const state = this.sessionFor(orgId, workspaceId, session)
    if (state.active.has(submission.submissionId)) {
      return { error: `submission ${submission.submissionId} is already active in ${state.key}` }
    }
    state.active.set(submission.submissionId, submission)
    state.lastActivityAt = this.now()
    return {
      agents: () => [...state.agents.values()].filter((a) => eligible(a, submission)),
      requestDispatch: () => this.dispatchSession(state),
      // Only the last active submission drains — and only the agents that
      // were ELIGIBLE for it (checked BEFORE end() removes this one from the
      // map, so size 1 ⇒ this is last). Both guards protect standing pools:
      // one run's abort/orphan must never kill another submission's agents,
      // and a self-agent-only run (no commit match) must never drain the
      // different-commit standing helpers it couldn't even use.
      drainIfLast: () =>
        state.active.size <= 1
          ? [...state.agents.values()].filter((a) => eligible(a, submission))
          : [],
      end: () => {
        if (state.active.get(submission.submissionId) === submission) {
          state.active.delete(submission.submissionId)
          // Release any leaked slots (an aborted submission) so a later agent
          // isn't counted busy for a submission that no longer exists.
          for (const agent of state.agents.values()) {
            agent.inFlight.delete(submission.submissionId)
          }
          state.lastActivityAt = this.now()
        }
      },
    }
  }

  /**
   * The fair-share dispatcher: hand each active submission at most ONE
   * assignment per pass, rotating which submission goes first, and loop until
   * a pass makes no progress. Max-min fair — a small run is never starved by a
   * huge concurrent one, and idle slots flow to whoever still has ready work.
   * For a lone submission this degenerates to greedy dispatch, byte-for-byte.
   */
  private dispatchSession(state: SessionState): void {
    const subs = [...state.active.values()]
    if (subs.length === 0) return
    const agents = [...state.agents.values()]
    const start = state.rotation++ % subs.length
    const order = [...subs.slice(start), ...subs.slice(0, start)]
    for (;;) {
      let progressed = false
      for (const sub of order) if (assignOne(sub, agents)) progressed = true
      if (!progressed) break
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
        // Only reap agents that heartbeat — an old, heartbeat-less agent is
        // left to the WS-close path (no version-skew false reaps).
        if (agent.sawHeartbeat && agent.lastSeenAt < cutoff) {
          this.drop(agent)
          agent.close()
          reaped++
        }
      }
    }
    return reaped
  }

  /** Remove sessions with no agents, no submissions, and 15 min of silence. */
  gc(): void {
    const cutoff = this.now() - SESSION_GC_MS
    for (const [key, state] of this.sessions) {
      if (state.agents.size === 0 && state.active.size === 0 && state.lastActivityAt < cutoff) {
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
    commit?: string,
    orgId: string = DEFAULT_ORG,
  ): {
    agents: number
    remoteAgents: number
    capacity: number
    remoteCapacity: number
    ready: number
  } {
    const state = this.sessions.get(sessionKey(orgId, workspaceId, session))
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
      // "Remote" excludes the submitter self-agent; when a commit is given
      // an agent counts only if its checkout matches (a feature-branch dev
      // reads 0 helpers against a main-pinned pool → stays a local run).
      const commitOk = commit === undefined || agent.commitSha === commit
      if (!agent.labels.includes(SUBMITTER_LABEL) && commitOk) {
        remoteAgents++
        remoteCapacity += agent.capacity
      }
    }
    // Ready-but-unassigned tasks across all active submissions: non-zero only
    // when agent capacity is saturated — the signal an autoscaler scales UP on.
    let ready = 0
    for (const sub of state.active.values()) ready += sub.readyDepth?.() ?? 0
    return { agents, remoteAgents, capacity, remoteCapacity, ready }
  }

  private sessionFor(orgId: string, workspaceId: string, session: string): SessionState {
    const key = sessionKey(orgId, workspaceId, session)
    let state = this.sessions.get(key)
    if (state === undefined) {
      state = {
        key,
        orgId,
        workspaceId,
        session,
        agents: new Map(),
        active: new Map(),
        rotation: 0,
        lastActivityAt: this.now(),
      }
      this.sessions.set(key, state)
    }
    return state
  }
}
