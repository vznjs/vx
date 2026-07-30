// The agent loop (distributed-execution-2026-07 §6.2 + §8.2) — shared by
// the `vx-cloud agent` verb and the submitting backend's in-process
// self-registration. Connect, hello, then per assignment run core's
// NORMAL cached pipeline as a scoped in-process `run()` of the exact task
// id WITH its dep closure:
//
//   - deps restore as warm hits from the shared cache (whichever agent
//     executed them uploaded before reporting done), so keys are exactly
//     the full-run keys (§6.3);
//   - the remote layer is INJECTED (`opts.remoteCache` →
//     `RunOptions.remoteCache`, a native-wire client pointed at the
//     serve's artifact store) — hashing / probe / save / upload / drain
//     all ride existing core machinery;
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
  type RemoteCacheLayer,
  type RunEvent,
  createEventBus,
} from '@vzn/vx'
import {
  AGENT_HEARTBEAT_MS,
  DIST_PROTOCOL_VERSION,
  type AssignPolicy,
  type DistClientMessage,
  type DistServerMessage,
} from '../protocol-dist.js'

const silentLogger: Logger = {
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
}

/**
 * The minimal WebSocket surface the loop drives — enough to (re)create a socket
 * and wire the four handlers. A real `WebSocket` satisfies it structurally; a
 * test supplies a fake it can open/close on demand to exercise reconnect
 * without a live serve.
 */
export interface AgentSocket {
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  send(data: string): void
  close(): void
}

export type AgentSocketFactory = (url: string, token?: string) => AgentSocket

const defaultSocketFactory: AgentSocketFactory = (url, token) =>
  (token !== undefined
    ? new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
    : new WebSocket(url)) as unknown as AgentSocket

/** Max reconnect attempts before a standalone agent gives up (≈15 s of retries). */
export const DEFAULT_MAX_RECONNECTS = 5
/** First reconnect backoff; doubles each attempt, capped at RECONNECT_CAP_MS. */
export const RECONNECT_BASE_MS = 500
const RECONNECT_CAP_MS = 8_000
/**
 * How long a connection must STAY open before its reconnect budget is refreshed.
 * A bare `onopen` is NOT proof of a stable link — a flapping / crash-looping
 * serve that accepts the upgrade then immediately drops would reset the budget
 * on every cycle and reconnect forever (an unbounded hang, never settling
 * `done`). Only a connection that survives this dwell earns a fresh budget, so
 * a flap exhausts the budget and gives up.
 */
export const RECONNECT_STABLE_MS = 10_000

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
  /** The remote layer for the scoped runs — the serve's artifact store,
   *  injected as `RunOptions.remoteCache` (the §6.3 artifact transport). */
  remoteCache?: RemoteCacheLayer
  onStatus?: (line: string) => void
  /** Fires per assignment — the submitter skips materializing these ids. */
  onAssigned?: (taskId: string) => void
  /**
   * Socket constructor seam (defaults to `new WebSocket`). A test supplies a
   * fake to drive open/close and exercise reconnect without a live serve.
   */
  wsFactory?: AgentSocketFactory
  /**
   * Reconnect (bounded backoff) on an UNEXPECTED close — a transient network
   * blip / serve blip shouldn't kill a standing helper agent, whose capacity
   * the pool still wants. Defaults ON for a standalone agent and OFF for a
   * submitter self-agent (`ownerSubmissionId` set) whose lifecycle the submitter
   * owns via `stop()`. Refused / stopped / idle-timeout / drain closes never
   * reconnect (they are terminal by design).
   */
  reconnect?: boolean
  /** Reconnect attempt cap (default DEFAULT_MAX_RECONNECTS). */
  maxReconnects?: number
  /** First-attempt backoff ms (default RECONNECT_BASE_MS); doubles per attempt. */
  reconnectBaseMs?: number
  /** Dwell a connection must stay open to refresh the budget (default RECONNECT_STABLE_MS). */
  reconnectStableMs?: number
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
  const wsUrl = `${opts.origin.replace(/\/+$/, '').replace(/^http/, 'ws')}/v1/agents`
  const factory = opts.wsFactory ?? defaultSocketFactory
  // A standalone helper agent reconnects through a transient blip; the
  // submitter's self-agent (ownerSubmissionId set) does not — the submitter
  // owns its lifecycle via stop().
  const reconnectEnabled = opts.reconnect ?? opts.ownerSubmissionId === undefined
  const maxReconnects = opts.maxReconnects ?? DEFAULT_MAX_RECONNECTS
  // ONE shared registry across this agent's concurrent scoped runs — the
  // same concurrent-run dedup guarantee the serve's delegated runs use.
  const inflightRuns = new Map<string, Promise<void>>()

  let ws!: AgentSocket
  let currentAgentId = ''
  let firstConnect = true
  let reconnectAttempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let stableTimer: ReturnType<typeof setTimeout> | undefined
  let inFlight = 0
  let drained = false
  let stopped = false
  let refusedReason: string | undefined
  let idleFired = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let settled = false
  let resolveDone!: (r: AgentLoopResult) => void
  const done = new Promise<AgentLoopResult>((r) => {
    resolveDone = r
  })
  const settle = (r: AgentLoopResult): void => {
    if (settled) return
    settled = true
    resolveDone(r)
  }

  const send = (msg: DistClientMessage): void => {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      // socket closed mid-write; the close handler resolves or reconnects
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

  const connect = (): void => {
    // A FRESH agentId per reconnect: the serve reassigns the previous socket's
    // in-flight tasks when its close fires (`drop` → `onAgentLeave`), and `drop`
    // no-ops on an id mismatch — so reusing the id could let this fresh hello
    // overwrite the still-pending old entry and orphan its tasks. A new id keeps
    // the two registrations independent. Only the very first connection may use
    // a caller-pinned `opts.agentId`.
    currentAgentId = firstConnect && opts.agentId !== undefined ? opts.agentId : Bun.randomUUIDv7()
    firstConnect = false
    ws = factory(wsUrl, opts.token)

    ws.onopen = () => {
      // Refresh the backoff budget ONLY after the connection has STAYED open for
      // the dwell — a bare open is not a stable link. A flap (open then immediate
      // close) clears this timer in `onclose` before it fires, so the budget
      // isn't reset and the flap eventually exhausts it instead of hanging.
      clearTimeout(stableTimer)
      stableTimer = setTimeout(() => {
        reconnectAttempts = 0
      }, opts.reconnectStableMs ?? RECONNECT_STABLE_MS)
      stableTimer.unref?.()
      send({
        t: 'agent:hello',
        protocol: DIST_PROTOCOL_VERSION,
        agentId: currentAgentId,
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
      let parsed: unknown
      try {
        parsed = JSON.parse(String(ev.data))
      } catch {
        return
      }
      // A successful parse does NOT mean the frame is an object. `null` parses
      // fine, slips past the `catch` above — which exists precisely to make a
      // malformed frame harmless — and then `msg.t` throws a TypeError straight
      // out of this handler. That surfaces as an UNCAUGHT exception with a
      // stack trace on the agent's stderr, which reads as a crash even though
      // the loop carries on. Of every JSON value only `null` does this; numbers,
      // strings, arrays and booleans all answer `undefined` for `.t` and fall
      // through to the no-op the guard intends.
      if (typeof parsed !== 'object' || parsed === null) return
      const msg = parsed as DistServerMessage
      if (msg.t === 'task:assign') {
        clearTimeout(idleTimer)
        inFlight++
        opts.onAssigned?.(msg.taskId)
        void executeAssigned(msg.submissionId, msg.taskId, msg.policy)
      } else if (msg.t === 'agent:refused') {
        refusedReason = msg.reason
        status(`refused: ${msg.reason}`)
        // A refusal is TERMINAL — `onclose` already treats it as such and never
        // reconnects. But it only REACHES `onclose` if the serve closes the
        // socket, and this side cannot make it: a serve that refuses and then
        // holds the socket open leaves `done` pending. With `--idle-timeout 0`
        // (how a standing pool agent is run) that is FOREVER, and `agentCmd`
        // awaits `done`, so the job sits there until the CI timeout kills it.
        // Settle on the frame instead of on a close this side doesn't control;
        // `settle` is idempotent, so the close below resolving again is a no-op.
        settle({ ok: false, reason: 'refused' })
        try {
          ws.close()
        } catch {
          // already closed
        }
      } else if (msg.t === 'coord:drain') {
        drained = true
        if (inFlight === 0) sayBye('shutdown')
      }
    }

    ws.onclose = () => {
      clearTimeout(idleTimer)
      clearInterval(heartbeatTimer)
      // The connection didn't survive the dwell — don't refresh the budget.
      clearTimeout(stableTimer)
      // Terminal closes never reconnect — they are the agent's intended end.
      if (refusedReason !== undefined) return settle({ ok: false, reason: 'refused' })
      if (stopped) return settle({ ok: true, reason: 'stopped' })
      if (idleFired) return settle({ ok: true, reason: 'idle-timeout' })
      if (drained) return settle({ ok: true, reason: 'drained' })
      // Unexpected close (serve died, network blip). Reconnect with bounded
      // backoff so a transient outage doesn't kill a standing helper agent; the
      // serve already reassigned this socket's in-flight tasks, and a fresh
      // registration resumes taking new work. Give up after the budget.
      if (reconnectEnabled && reconnectAttempts < maxReconnects) {
        const base = opts.reconnectBaseMs ?? RECONNECT_BASE_MS
        const delay = Math.min(base * 2 ** reconnectAttempts, RECONNECT_CAP_MS)
        reconnectAttempts++
        status(`connection lost — reconnecting (attempt ${reconnectAttempts}/${maxReconnects})`)
        reconnectTimer = setTimeout(connect, delay)
        reconnectTimer.unref?.()
        return
      }
      settle({ ok: false, reason: 'closed' })
    }
    ws.onerror = () => {
      // onclose always follows; classification (settle vs reconnect) happens there
    }
  }

  async function executeAssigned(
    submissionId: string,
    taskId: string,
    policy?: AssignPolicy,
  ): Promise<void> {
    status(`▶ ${taskId}`)
    send({ t: 'agent:start', taskId, submissionId })
    // Honor the submission's run policy: --frozen / --timeout / --retry ride
    // per-assignment so a standalone agent (which serves several submissions)
    // applies each one's flags. `opts.frozen` is the fallback for an older serve
    // that sends a bare assignment; cache is NOT propagated (full cache is the
    // artifact transport — the agent's own local cache stays on).
    const frozen = policy?.frozen ?? opts.frozen
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
        ...(frozen !== undefined ? { frozen } : {}),
        ...(opts.cache !== undefined ? { cache: opts.cache } : {}),
        ...(policy?.retries !== undefined ? { retries: policy.retries } : {}),
        ...(policy?.timeout !== undefined ? { timeout: policy.timeout } : {}),
        ...(opts.remoteCache !== undefined ? { remoteCache: opts.remoteCache } : {}),
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

  connect()

  return {
    done,
    stop: () => {
      stopped = true
      clearTimeout(idleTimer)
      clearInterval(heartbeatTimer)
      clearTimeout(reconnectTimer)
      clearTimeout(stableTimer)
      try {
        ws.close()
      } catch {
        // already closed
      }
      // Settle now: if we were mid-backoff (no live socket) there is no onclose
      // coming; if a socket is live, its onclose settles too (idempotent).
      settle({ ok: true, reason: 'stopped' })
    },
  }
}

const OK = new Set(['success', 'cache-hit', 'cache-hit-remote'])
