// Per-submission distribution scheduler (distributed-execution-2026-07
// §4.2) — the old ephemeral coordinator's ready-queue/dispatch/complete/
// reassign guts, rehosted on the serve with the load-bearing changes:
//
//   - the graph is SUBMITTED, never self-prepared (the serve has no
//     checkout);
//   - a cache prune runs before dispatch: every submitted stable hash is
//     probed against the serve's OWN artifact store (one local stat per
//     task) — hits complete without dispatching anywhere. Sound because
//     the submitted stable hash IS the executing key (§6.3);
//   - assignment is a bare task id; the agent resolves everything from
//     its own checkout;
//   - agent events relay to the submitter as ordinary `ServerMessage`
//     WireEvents, so the submitter renders through the same
//     `createWireRenderer` path delegation uses.

import type { OutcomeView, ServerMessage, WireEvent } from '@vzn/vx'
import type {
  DistClientMessage,
  DistGraphNode,
  DistSubmitMessage,
  DistServerMessage,
} from '../protocol-dist.js'
import {
  SUBMITTER_LABEL,
  type ActiveSubmission,
  type RegisteredAgent,
  type SubmissionBinding,
} from './registry.js'

// Re-exported from its home in registry.ts (which owns agent labels) so the
// existing `from './scheduler.js'` importers (submit.ts, index.ts) are unchanged.
export { SUBMITTER_LABEL }

/** Default wait before warning that zero remote agents joined. */
export const DEFAULT_AGENT_TIMEOUT_MS = 5 * 60 * 1000

/** What the scheduler needs from the artifact store: local-disk stats. */
export interface ArtifactProbe {
  has(hash: string): Promise<boolean>
  storedDurationMs(hash: string): Promise<number | undefined>
}

export interface DistSchedulerArgs {
  submit: DistSubmitMessage
  store: ArtifactProbe
  /** Sends a ServerMessage to the submitter; must swallow its own failures. */
  send(msg: ServerMessage): void
}

const OK_STATUSES = new Set(['success', 'cache-hit', 'cache-hit-remote'])

export class DistScheduler implements ActiveSubmission {
  readonly submissionId: string
  readonly commitSha: string
  readonly done: Promise<{ ok: boolean }>

  private readonly nodes = new Map<string, DistGraphNode>()
  private readonly remaining = new Map<string, number>()
  private readonly dependents = new Map<string, string[]>()
  private readonly outcomes = new Map<string, OutcomeView>()
  private readonly readied = new Set<string>()
  private readonly startedEmitted = new Set<string>()
  /** taskId → agentId, for the dep-affinity dispatch preference. */
  private readonly executedBy = new Map<string, string>()
  private readonly ready: string[] = []
  private readonly startedAtMs = Date.now()

  private binding: SubmissionBinding | null = null
  private finished = false
  private submitterGone = false
  private remoteJoined = false
  private warnedNoRemote = false
  private prunedCount = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private resolveDone!: (r: { ok: boolean }) => void

  constructor(private readonly args: DistSchedulerArgs) {
    this.submissionId = args.submit.submissionId
    this.commitSha = args.submit.commitSha
    this.done = new Promise((r) => {
      this.resolveDone = r
    })
    for (const node of args.submit.nodes) {
      this.nodes.set(node.id, node)
      this.remaining.set(node.id, node.deps.length)
      for (const dep of node.deps) {
        const list = this.dependents.get(dep)
        if (list) list.push(node.id)
        else this.dependents.set(dep, [node.id])
      }
    }
  }

  /** Tasks ready but waiting for a free agent slot (the autoscaling signal). */
  readyDepth(): number {
    return this.ready.length
  }

  /** Wire the registry binding (must happen before start()). */
  attach(binding: SubmissionBinding): void {
    this.binding = binding
    for (const agent of binding.agents()) {
      if (!agent.labels.includes(SUBMITTER_LABEL)) this.remoteJoined = true
    }
  }

  /** run:start → prune against the artifact store → initial dispatch. */
  async start(): Promise<void> {
    const execTotal = [...this.nodes.values()].filter((n) => !n.view.isGroup).length
    this.event({ kind: 'run:start', info: { total: execTotal } })

    const timeoutMs = this.args.submit.agentTimeoutMs
    this.timer = setTimeout(() => {
      if (this.finished || this.remoteJoined) return
      this.warnedNoRemote = true
      this.event({
        kind: 'run:status',
        line: `vx: 0 remote agents joined session ${this.sessionKey()} after ${Math.round(timeoutMs / 1000)}s — executing on the submitter only`,
      })
    }, timeoutMs)
    this.timer.unref?.()

    // The prune: one local stat per submitted stable hash — the dominant
    // CI case (mostly-warm graph) never dispatches a single assignment.
    const probes = [...this.nodes.values()]
      .filter((n) => !n.view.isGroup && n.stableHash !== undefined)
      .map(async (n) => ({ node: n, hit: await this.args.store.has(n.stableHash!) }))
    const results = await Promise.all(probes)
    for (const { node, hit } of results) {
      if (!hit || this.finished) continue
      this.prunedCount++
      const durationMs = (await this.args.store.storedDurationMs(node.stableHash!)) ?? 0
      // A stable key is provably independent of upstream OUTPUTS, so a
      // store hit completes ahead of its deps (the restore-tier rule).
      this.complete(
        node.id,
        {
          taskId: node.id,
          status: 'cache-hit-remote',
          exitCode: 0,
          durationMs,
          hash: node.stableHash!,
          restored: false,
        },
        true,
      )
    }

    for (const node of this.nodes.values()) {
      if (this.finished) break
      if (this.outcomes.has(node.id)) continue
      if ((this.remaining.get(node.id) ?? 0) === 0) this.onReady(node.id)
    }
    this.binding?.requestDispatch()
  }

  // --- ActiveSubmission: bookkeeping ---------------------------------------

  onAgentJoin(agent: RegisteredAgent): void {
    if (!agent.labels.includes(SUBMITTER_LABEL)) this.remoteJoined = true
    this.binding?.requestDispatch()
  }

  onAgentLeave(agent: RegisteredAgent, inFlight: readonly string[]): void {
    // Re-queue the dead agent's tasks at the FRONT and re-dispatch. Safe:
    // an agent reports done only after its scoped run resolved (uploads
    // drained), so a did-upload-then-died task re-lands as a warm hit on
    // the next agent.
    for (const taskId of inFlight) {
      if (this.outcomes.has(taskId)) continue
      this.ready.unshift(taskId)
    }
    if (this.submitterGone && this.agents().length === 0 && !this.finished) {
      this.abort('all agents disconnected after the submitter died')
      return
    }
    this.binding?.requestDispatch()
  }

  onAgentMessage(agent: RegisteredAgent, raw: unknown): void {
    const msg = raw as DistClientMessage
    if (msg.t === 'agent:start') {
      const node = this.nodes.get(msg.taskId)
      if (node === undefined || this.startedEmitted.has(msg.taskId)) return
      this.startedEmitted.add(msg.taskId)
      this.event({ kind: 'task:start', task: node.view })
      return
    }
    if (msg.t === 'agent:stdout') {
      this.event({ kind: 'task:stdout', taskId: msg.taskId, chunk: msg.chunk })
      return
    }
    if (msg.t === 'agent:stderr') {
      this.event({ kind: 'task:stderr', taskId: msg.taskId, chunk: msg.chunk })
      return
    }
    if (msg.t === 'agent:done') {
      agent.inFlight.get(this.submissionId)?.delete(msg.taskId)
      this.executedBy.set(msg.taskId, agent.agentId)
      // A task reassigned after this agent's death may already be
      // terminal via the replacement — ignore the stale duplicate.
      if (this.outcomes.has(msg.taskId) || this.nodes.get(msg.taskId) === undefined) {
        this.binding?.requestDispatch()
        return
      }
      this.event({ kind: 'task:complete', outcome: msg.outcome })
      this.complete(msg.taskId, msg.outcome, false)
      this.binding?.requestDispatch()
    }
  }

  // --- ActiveSubmission: dispatch surface (driven by the registry's fair loop) ---

  /** The next ready-but-unassigned task (queue head), or undefined. */
  nextReady(): string | undefined {
    if (this.finished) return undefined
    return this.ready[0]
  }

  /** Agent ids that already executed a dep of `taskId` — dep-affinity locality. */
  affinityAgents(taskId: string): ReadonlySet<string> {
    const out = new Set<string>()
    const node = this.nodes.get(taskId)
    if (node === undefined) return out
    for (const dep of node.deps) {
      const a = this.executedBy.get(dep)
      if (a !== undefined) out.add(a)
    }
    return out
  }

  /** Splice `taskId` from ready, record it under this submission on `agent`, assign. */
  assign(taskId: string, agent: RegisteredAgent): void {
    const idx = this.ready.indexOf(taskId)
    if (idx >= 0) this.ready.splice(idx, 1)
    let set = agent.inFlight.get(this.submissionId)
    if (set === undefined) {
      set = new Set()
      agent.inFlight.set(this.submissionId, set)
    }
    set.add(taskId)
    agent.send({ t: 'task:assign', taskId, submissionId: this.submissionId })
  }

  /**
   * The submitter's WS closed. Before the result: finish the graph with
   * the remaining agents (every artifact still warms the store), then
   * drain them — a dead main job won't submit again.
   */
  onSubmitterGone(): void {
    if (this.finished) return
    this.submitterGone = true
    if (this.agents().length === 0) {
      this.abort('submitter disconnected with no agents left')
    }
  }

  // --- internals -------------------------------------------------------------

  private sessionKey(): string {
    return `${this.args.submit.workspaceId}/${this.args.submit.session}`
  }

  private agents(): RegisteredAgent[] {
    return this.binding?.agents() ?? []
  }

  private event(event: WireEvent): void {
    this.args.send({ t: 'event', event })
  }

  private complete(taskId: string, outcome: OutcomeView, emit: boolean): void {
    if (this.outcomes.has(taskId)) return
    this.outcomes.set(taskId, outcome)
    if (emit) {
      const node = this.nodes.get(taskId)
      // Synthesized completions (prune hits, failure-cascade skips) still
      // need a task:start — the wire renderer resolves nodes from it.
      if (node !== undefined && !node.view.isGroup && !this.startedEmitted.has(taskId)) {
        this.startedEmitted.add(taskId)
        this.event({ kind: 'task:start', task: node.view })
      }
      if (node !== undefined && !node.view.isGroup) {
        this.event({ kind: 'task:complete', outcome })
      }
    }
    for (const dep of this.dependents.get(taskId) ?? []) {
      const left = (this.remaining.get(dep) ?? 0) - 1
      this.remaining.set(dep, left)
      if (left === 0 && !this.outcomes.has(dep)) this.onReady(dep)
    }
    this.checkFinish()
  }

  private onReady(taskId: string): void {
    // Idempotent: the prune cascade and start()'s remaining-0 sweep can
    // both observe the same node.
    if (this.readied.has(taskId)) return
    this.readied.add(taskId)
    const node = this.nodes.get(taskId)!
    const failedDep = node.deps.find((d) => {
      const o = this.outcomes.get(d)
      return o !== undefined && !OK_STATUSES.has(o.status)
    })
    if (node.view.isGroup) {
      // Groups are never assigned: a synthesized rolled-up outcome, no
      // events (wireForwarder drops group events locally too).
      this.complete(
        taskId,
        failedDep !== undefined
          ? { taskId, status: 'skipped', exitCode: 1, durationMs: 0 }
          : { taskId, status: 'success', exitCode: 0, durationMs: 0 },
        false,
      )
      return
    }
    if (failedDep !== undefined) {
      this.complete(taskId, { taskId, status: 'skipped', exitCode: 1, durationMs: 0 }, true)
      return
    }
    this.ready.push(taskId)
  }

  private checkFinish(): void {
    if (this.finished || this.outcomes.size < this.nodes.size) return
    this.finished = true
    clearTimeout(this.timer)

    let success = 0
    let failed = 0
    let skipped = 0
    let agentHits = 0
    let executed = 0
    for (const [id, o] of this.outcomes) {
      if (this.nodes.get(id)?.view.isGroup) continue
      if (o.status === 'failed' || o.status === 'aborted') failed++
      else if (o.status === 'skipped') skipped++
      else success++
      if (o.status === 'success') executed++
      else if (o.status === 'cache-hit' || o.status === 'cache-hit-remote') agentHits++
    }
    const ok = failed === 0
    // Plain-text footer tallies (§6.7) — core's meter-bar summary is not
    // public and exporting it for cosmetics isn't worth the surface.
    const elapsed = ((Date.now() - this.startedAtMs) / 1000).toFixed(1)
    this.event({
      kind: 'run:status',
      line: ` tasks: ${failed} failed · ${success} success · ${skipped} skipped`,
    })
    this.event({
      kind: 'run:status',
      line: ` cache: ${this.prunedCount} pruned from store · ${agentHits - this.prunedCount} agent hits · ${executed} executed`,
    })
    if (this.warnedNoRemote) {
      this.event({
        kind: 'run:status',
        line: ` vx: 0 remote agents joined session ${this.sessionKey()} — the submitter executed everything`,
      })
    }
    this.event({ kind: 'run:status', line: ` time: ${elapsed}s` })
    this.event({ kind: 'run:end' })
    this.args.send({ t: 'result', result: { ok, outcomes: [...this.outcomes.values()] } })
    if (this.submitterGone) this.drainAgents()
    this.binding?.end()
    this.resolveDone({ ok })
  }

  private abort(reason: string): void {
    if (this.finished) return
    this.finished = true
    clearTimeout(this.timer)
    this.args.send({ t: 'error', message: `distributed run aborted: ${reason}` })
    this.drainAgents()
    this.binding?.end()
    this.resolveDone({ ok: false })
  }

  private drainAgents(): void {
    const drain: DistServerMessage = { t: 'coord:drain' }
    // Only drains the pool when this is the last active submission — a shared
    // agent must survive one submission's abort/orphan while another runs.
    for (const agent of this.binding?.drainIfLast() ?? []) agent.send(drain)
  }
}
