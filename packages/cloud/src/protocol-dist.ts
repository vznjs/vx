// The distributed-execution wire contract, v1 (distributed-execution-2026-07
// §7). Core's `@vzn/vx` `ServerMessage`/`ClientMessage` carry only the
// run-submission family (`run` / `event` / `result` / `error`); the
// serve↔agent families plus the `dist:submit` submission message live here,
// in `@vzn/vx-cloud`. Cloud's WS handlers union the core types with these.
//
// Three deliberate shape rules from the design:
//   - assignment is a BARE task id — no command, no absolute projectDir
//     (paths from one machine are wrong on another; the agent resolves
//     everything from its own checkout);
//   - the outcome currency is core's `OutcomeView` verbatim (hash / cpu /
//     rss / durations ride along for free);
//   - `DIST_PROTOCOL_VERSION` gates every pairing: carried in `agent:hello`
//     and `dist:submit`, a mismatch refuses naming both versions.
//
// Also carries the JSON-RPC envelope adapters for the `agent.*`/`coord.*`/
// `dist.*` method namespaces — the base envelope (events.append /
// submit.run) stays in core; only the distributed mappings live here.

import {
  type Envelope,
  type Notification,
  type OutcomeView,
  type RunRequest,
  type TaskView,
  isNotification,
  makeNotification,
} from '@vzn/vx'

/**
 * Version sentinel for the distributed wire; bump on any shape change. v2
 * added `submissionId` to every assignment/outcome message + `dist:submit`
 * and an optional `ownerSubmissionId` to `agent:hello` — the standing-pool
 * multi-run scheduler (ci-platform-2026-07) needs a session to multiplex
 * several concurrent submissions across shared agents, so every task-scoped
 * message names its submission.
 */
export const DIST_PROTOCOL_VERSION = 2

/**
 * How often an agent sends `agent:heartbeat`. The serve reaps an agent that
 * misses several (see AGENT_STALE_MS in registry.ts) so a half-open TCP
 * connection (crashed box, network partition) is detected in seconds instead
 * of the OS keep-alive timeout, and its in-flight tasks reassign promptly.
 */
export const AGENT_HEARTBEAT_MS = 10_000

/** One task node of a submitted graph (`dist:submit.nodes`). */
export interface DistGraphNode {
  id: string
  /** Ids of tasks that must be terminal before this one dispatches. */
  deps: readonly string[]
  /** Display projection — what the relay's `task:start` events carry. */
  view: TaskView
  /**
   * The submitter-derived stable cache key, present only for tasks whose
   * key is provably independent of upstream OUTPUTS (`deriveStableKeys`).
   * The serve prunes these against its own artifact store before
   * dispatch; unstable tasks always dispatch and short-circuit on the
   * executing agent.
   */
  stableHash?: string
}

/** First message on an agent socket; anything else before it → close. */
export interface AgentHello {
  t: 'agent:hello'
  protocol: number
  agentId: string
  workspaceId: string
  session: string
  commitSha: string
  capacity: number
  labels?: readonly string[]
  /**
   * A submitter's in-process self-agent (`SUBMITTER_LABEL`) names the one
   * submission it belongs to here, so a same-commit peer submission sharing
   * the session can never conscript this machine for its own work (a self-
   * agent is eligible only for the submission that owns it). Unset on a
   * genuine standing helper agent, which serves any same-commit submission.
   */
  ownerSubmissionId?: string
}

/** serve → agent. `submissionId` names which multiplexed submission owns the task. */
export type DistServerMessage =
  | { t: 'task:assign'; taskId: string; submissionId: string }
  | { t: 'agent:refused'; reason: string }
  | { t: 'coord:drain' }

/**
 * agent → serve. Agent identity is implicit from the WS connection;
 * `submissionId` routes the task-scoped message back to the owning submission
 * (one agent may serve several concurrent submissions of the same commit).
 */
export type DistClientMessage =
  | AgentHello
  | { t: 'agent:start'; taskId: string; submissionId: string }
  | { t: 'agent:stdout'; taskId: string; submissionId: string; chunk: string }
  | { t: 'agent:stderr'; taskId: string; submissionId: string; chunk: string }
  | { t: 'agent:done'; taskId: string; submissionId: string; outcome: OutcomeView }
  | { t: 'agent:heartbeat' }
  | { t: 'agent:bye'; reason: 'idle-timeout' | 'shutdown' }

/**
 * submitter → serve, on the ordinary submission WS. Answered by the
 * EXISTING core `ServerMessage` stream (`event` / `result` / `error`), so
 * the submitter renders a distributed run through the same
 * `createWireRenderer` path delegation uses.
 */
export interface DistSubmitMessage {
  t: 'dist:submit'
  protocol: number
  session: string
  workspaceId: string
  /** Client-minted id (ULID) — the key a session multiplexes submissions on. */
  submissionId: string
  commitSha: string
  /** Advisory expected agent count (`VX_CLOUD_DISTRIBUTE=<n>`). */
  expectedAgents: number
  /** Zero REMOTE agents after this → loud warning, run proceeds. */
  agentTimeoutMs: number
  request: RunRequest
  nodes: readonly DistGraphNode[]
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope adapters for the distributed message namespaces.
// The base envelope (events.append / submit.run) lives in core's wire.ts.
// ---------------------------------------------------------------------------

/** Project a serve-side DistServerMessage to a `coord.*`/`agent.*` notification. */
export function distServerMessageToEnvelope(msg: DistServerMessage): Envelope {
  switch (msg.t) {
    case 'task:assign':
      return makeNotification('coord.assign', {
        taskId: msg.taskId,
        submissionId: msg.submissionId,
      })
    case 'agent:refused':
      return makeNotification('agent.refused', { reason: msg.reason })
    case 'coord:drain':
      return makeNotification('coord.drain', {})
  }
}

/** Project a `coord.*`/`agent.refused` notification back to a DistServerMessage. */
export function envelopeToDistServerMessage(env: Envelope): DistServerMessage | null {
  if (!isNotification(env)) return null
  if (env.method === 'coord.assign') {
    const p = env.params as { taskId: string; submissionId: string }
    return { t: 'task:assign', taskId: p.taskId, submissionId: p.submissionId }
  }
  if (env.method === 'agent.refused') {
    const p = env.params as { reason: string }
    return { t: 'agent:refused', reason: p.reason }
  }
  if (env.method === 'coord.drain') {
    return { t: 'coord:drain' }
  }
  return null
}

/** Project an agent ClientMessage to an `agent.*` notification envelope. */
export function distClientMessageToEnvelope(msg: DistClientMessage): Notification {
  switch (msg.t) {
    case 'agent:hello':
      return makeNotification('agent.hello', {
        protocol: msg.protocol,
        agentId: msg.agentId,
        workspaceId: msg.workspaceId,
        session: msg.session,
        commitSha: msg.commitSha,
        capacity: msg.capacity,
        labels: msg.labels ?? [],
        ...(msg.ownerSubmissionId !== undefined
          ? { ownerSubmissionId: msg.ownerSubmissionId }
          : {}),
      })
    case 'agent:start':
      return makeNotification('agent.start', { taskId: msg.taskId, submissionId: msg.submissionId })
    case 'agent:stdout':
      return makeNotification('agent.stdout', {
        taskId: msg.taskId,
        submissionId: msg.submissionId,
        chunk: msg.chunk,
      })
    case 'agent:stderr':
      return makeNotification('agent.stderr', {
        taskId: msg.taskId,
        submissionId: msg.submissionId,
        chunk: msg.chunk,
      })
    case 'agent:done':
      return makeNotification('agent.done', {
        taskId: msg.taskId,
        submissionId: msg.submissionId,
        outcome: msg.outcome,
      })
    case 'agent:heartbeat':
      return makeNotification('agent.heartbeat', {})
    case 'agent:bye':
      return makeNotification('agent.bye', { reason: msg.reason })
  }
}

/** Project an `agent.*` notification envelope back to an agent ClientMessage. */
export function envelopeToDistClientMessage(env: Envelope): DistClientMessage | null {
  if (!isNotification(env)) return null
  const m = env.method
  const p = env.params as Record<string, unknown>
  if (m === 'agent.hello') {
    const out: AgentHello = {
      t: 'agent:hello',
      protocol: p.protocol as number,
      agentId: p.agentId as string,
      workspaceId: p.workspaceId as string,
      session: p.session as string,
      commitSha: p.commitSha as string,
      capacity: p.capacity as number,
    }
    if (Array.isArray(p.labels) && p.labels.length > 0) out.labels = p.labels as string[]
    if (typeof p.ownerSubmissionId === 'string') out.ownerSubmissionId = p.ownerSubmissionId
    return out
  }
  if (m === 'agent.start')
    return { t: 'agent:start', taskId: p.taskId as string, submissionId: p.submissionId as string }
  if (m === 'agent.stdout')
    return {
      t: 'agent:stdout',
      taskId: p.taskId as string,
      submissionId: p.submissionId as string,
      chunk: p.chunk as string,
    }
  if (m === 'agent.stderr')
    return {
      t: 'agent:stderr',
      taskId: p.taskId as string,
      submissionId: p.submissionId as string,
      chunk: p.chunk as string,
    }
  if (m === 'agent.done') {
    return {
      t: 'agent:done',
      taskId: p.taskId as string,
      submissionId: p.submissionId as string,
      outcome: p.outcome as OutcomeView,
    }
  }
  if (m === 'agent.heartbeat') return { t: 'agent:heartbeat' }
  if (m === 'agent.bye') {
    return { t: 'agent:bye', reason: p.reason as 'idle-timeout' | 'shutdown' }
  }
  return null
}

/** Project a submission to a `dist.submit` notification envelope. */
export function distSubmitToEnvelope(msg: DistSubmitMessage): Notification {
  return makeNotification('dist.submit', {
    protocol: msg.protocol,
    session: msg.session,
    workspaceId: msg.workspaceId,
    submissionId: msg.submissionId,
    commitSha: msg.commitSha,
    expectedAgents: msg.expectedAgents,
    agentTimeoutMs: msg.agentTimeoutMs,
    request: msg.request,
    nodes: msg.nodes,
  })
}

/** Project a `dist.submit` notification envelope back to a submission. */
export function envelopeToDistSubmit(env: Envelope): DistSubmitMessage | null {
  if (!isNotification(env) || env.method !== 'dist.submit') return null
  const p = env.params as Omit<DistSubmitMessage, 't'>
  return { t: 'dist:submit', ...p }
}
