// The agent loop (distributed-execution-2026-07 §6.2 + §8.2) — shared by
// the `vx-cloud agent` verb and the submitting backend's in-process
// self-registration. Connect, hello, then per assignment run core's
// NORMAL cached pipeline as a scoped in-process `run()` of the exact task
// id WITH its dep closure:
//
//   - deps restore as warm hits from the shared cache (whichever agent
//     executed them uploaded before reporting done), so keys are exactly
//     the full-run keys (§6.3);
//   - the remote layer comes from the ENVIRONMENT (`VX_REMOTE_CACHE_*`
//     pointed at the serve), not new plumbing — hashing / probe / save /
//     upload / drain all ride existing core machinery;
//   - `run()` drains background uploads before resolving, so sending
//     `agent:done` after it resolves IS the await-PUT-before-done gate.
//
// Only events whose node id equals the assigned task id are forwarded
// (dep restores stay silent, exactly as they are locally).

import {
  run,
  projectOutcome,
  type CachePolicy,
  type Logger,
  type OutcomeView,
  type RunEvent,
  createEventBus,
} from '@vzn/vx'
import {
  AGENT_HEARTBEAT_MS,
  DIST_PROTOCOL_VERSION,
  type DistClientMessage,
  type DistServerMessage,
} from '../protocol-dist.js'

const silentLogger: Logger = {
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
}

export interface AgentLoopOptions {
  /** http(s) origin of the serve; the WS URL is derived from it. */
  origin: string
  token?: string
  agentId?: string
  workspaceId: string
  session: string
  commitSha: string
  capacity: number
  /** The agent's own checkout root — every assignment resolves against it. */
  checkoutRoot: string
  labels?: readonly string[]
  /** For a submitter self-agent: the id of the submission it exclusively
   *  serves (so a same-commit peer can't conscript this machine). */
  ownerSubmissionId?: string
  /** Self-terminate after this long with no assignments. Unset = never
   *  (the submitter's in-process loop lives for the submission). */
  idleTimeoutMs?: number
  /**
   * Run policy for the scoped runs. The submitter's self-agent threads the
   * request's values so its assignments execute under the submitted policy;
   * a standalone agent omits both (live eval, full cache — the §5.3 gates
   * guarantee the remote axes are on for any distributed run).
   */
  frozen?: boolean
  cache?: CachePolicy
  onStatus?: (line: string) => void
  /** Fires per assignment — the submitter skips materializing these ids. */
  onAssigned?: (taskId: string) => void
}

export interface AgentLoopResult {
  ok: boolean
  reason: 'drained' | 'idle-timeout' | 'refused' | 'stopped' | 'closed'
}

export interface AgentLoopHandle {
  done: Promise<AgentLoopResult>
  stop(): void
}

export function runAgentLoop(opts: AgentLoopOptions): AgentLoopHandle {
  const status = opts.onStatus ?? (() => undefined)
  const agentId = opts.agentId ?? Bun.randomUUIDv7()
  const wsUrl = `${opts.origin.replace(/\/+$/, '').replace(/^http/, 'ws')}/v1/agents`
  // ONE shared registry across this agent's concurrent scoped runs — the
  // same concurrent-run dedup guarantee the serve's delegated runs use.
  const inflightRuns = new Map<string, Promise<void>>()

  let inFlight = 0
  let drained = false
  let stopped = false
  let refusedReason: string | undefined
  let idleFired = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let resolveDone!: (r: AgentLoopResult) => void
  const done = new Promise<AgentLoopResult>((r) => {
    resolveDone = r
  })

  const ws =
    opts.token !== undefined
      ? new WebSocket(wsUrl, { headers: { authorization: `Bearer ${opts.token}` } })
      : new WebSocket(wsUrl)

  const send = (msg: DistClientMessage): void => {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      // socket closed mid-write; the close handler resolves the loop
    }
  }

  const sayBye = (reason: 'idle-timeout' | 'shutdown'): void => {
    send({ t: 'agent:bye', reason })
    try {
      ws.close()
    } catch {
      // already closed
    }
  }

  const armIdle = (): void => {
    if (opts.idleTimeoutMs === undefined) return
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (inFlight > 0 || drained || stopped) return
      idleFired = true
      status('idle timeout — shutting down')
      sayBye('idle-timeout')
    }, opts.idleTimeoutMs)
    idleTimer.unref?.()
  }

  ws.onopen = () => {
    send({
      t: 'agent:hello',
      protocol: DIST_PROTOCOL_VERSION,
      agentId,
      workspaceId: opts.workspaceId,
      session: opts.session,
      commitSha: opts.commitSha,
      capacity: opts.capacity,
      ...(opts.labels !== undefined && opts.labels.length > 0 ? { labels: opts.labels } : {}),
      ...(opts.ownerSubmissionId !== undefined
        ? { ownerSubmissionId: opts.ownerSubmissionId }
        : {}),
    })
    armIdle()
    // Liveness: a steady heartbeat lets the serve reap this agent within
    // seconds of a crash/partition (a half-open TCP socket never fires
    // `close`), so its in-flight tasks reassign instead of stalling.
    heartbeatTimer = setInterval(() => send({ t: 'agent:heartbeat' }), AGENT_HEARTBEAT_MS)
    heartbeatTimer.unref?.()
  }

  ws.onmessage = (ev) => {
    let msg: DistServerMessage
    try {
      msg = JSON.parse(String(ev.data)) as DistServerMessage
    } catch {
      return
    }
    if (msg.t === 'task:assign') {
      clearTimeout(idleTimer)
      inFlight++
      opts.onAssigned?.(msg.taskId)
      void executeAssigned(msg.submissionId, msg.taskId)
    } else if (msg.t === 'agent:refused') {
      refusedReason = msg.reason
      status(`refused: ${msg.reason}`)
    } else if (msg.t === 'coord:drain') {
      drained = true
      if (inFlight === 0) sayBye('shutdown')
    }
  }

  ws.onclose = () => {
    clearTimeout(idleTimer)
    clearInterval(heartbeatTimer)
    if (refusedReason !== undefined) resolveDone({ ok: false, reason: 'refused' })
    else if (stopped) resolveDone({ ok: true, reason: 'stopped' })
    else if (idleFired) resolveDone({ ok: true, reason: 'idle-timeout' })
    else if (drained) resolveDone({ ok: true, reason: 'drained' })
    // Unexpected close (serve died, network): infra failure, not a task
    // verdict — the main job owns the aggregate exit code.
    else resolveDone({ ok: false, reason: 'closed' })
  }
  ws.onerror = () => {
    // onclose always follows; classification happens there
  }

  async function executeAssigned(submissionId: string, taskId: string): Promise<void> {
    status(`▶ ${taskId}`)
    send({ t: 'agent:start', taskId, submissionId })
    const bus = createEventBus()
    bus.subscribe((event: RunEvent) => {
      if (event.kind === 'task:stdout' && event.node.id === taskId) {
        send({ t: 'agent:stdout', taskId, submissionId, chunk: event.chunk })
      } else if (event.kind === 'task:stderr' && event.node.id === taskId) {
        send({ t: 'agent:stderr', taskId, submissionId, chunk: event.chunk })
      }
    })
    let outcome: OutcomeView
    try {
      const summary = await run({
        cwd: opts.checkoutRoot,
        // Anchored 'pkg#task' — expandRequested handles it; the dep
        // closure rides along, which is what keeps the keys honest.
        tasks: [taskId],
        log: silentLogger,
        handleSignals: false,
        bus,
        inflight: inflightRuns,
        concurrency: opts.capacity,
        ...(opts.frozen !== undefined ? { frozen: opts.frozen } : {}),
        ...(opts.cache !== undefined ? { cache: opts.cache } : {}),
      })
      const own = summary.outcomes.find((o) => o.node.id === taskId)
      outcome =
        own !== undefined
          ? projectOutcome(own)
          : {
              taskId,
              status: summary.ok ? 'success' : 'failed',
              exitCode: summary.ok ? 0 : 1,
              durationMs: 0,
            }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      send({ t: 'agent:stderr', taskId, submissionId, chunk: `${message}\n` })
      outcome = { taskId, status: 'failed', exitCode: 1, durationMs: 0 }
    }
    // run() already drained its background uploads, so by the time this
    // `done` leaves the socket the artifact is in the store.
    send({ t: 'agent:done', taskId, submissionId, outcome })
    status(`${OK.has(outcome.status) ? '✓' : '✗'} ${taskId} (${outcome.status})`)
    inFlight--
    if (drained && inFlight === 0) sayBye('shutdown')
    else if (inFlight === 0) armIdle()
  }

  return {
    done,
    stop: () => {
      stopped = true
      clearTimeout(idleTimer)
      clearInterval(heartbeatTimer)
      try {
        ws.close()
      } catch {
        // already closed
      }
    },
  }
}

const OK = new Set(['success', 'cache-hit', 'cache-hit-remote'])
