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

import {
  FULL_CACHE_POLICY,
  assembleRunSummary,
  deriveCacheSource,
  isCacheHit,
  isPassStatus,
  type CachePolicy,
  type OutcomeView,
  type RunContextRecord,
  type RunSummaryRecord,
  type ServerMessage,
  type TaskTelemetry,
  type WireEvent,
} from '@vzn/vx'
import type { TaskIngestRecord } from '../db/analytics.js'
import { TaskLogBuffer } from '../task-log-capture.js'
import type {
  AssignPolicy,
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

/**
 * Where the controller records a distributed run — the seam onto the Postgres
 * analytics store, so a `VX_CLOUD_DISTRIBUTE` run appears under the dashboard's
 * Runs and fills in live, exactly like a local `cloud()` run. Optional (like
 * `store`/`send`/`durationHints`) — a scheduler with no recorder is
 * byte-identical to before. Both calls are fire-and-forget and MUST never throw
 * (recording is observe-only; it can never fail a run).
 */
export interface DistRunRecorder {
  /** One task's result the moment it finishes (live fill-in). */
  taskDone(rec: TaskIngestRecord): void
  /** The invocation header + end-of-run backstop (idempotent with `taskDone`). */
  runFinished(summary: RunSummaryRecord): void
}

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
  /**
   * taskId → historical mean execution ms, from the serve's ingest store.
   * When present the ready queue dispatches LONGEST-first (the LPT makespan
   * heuristic — a long pole should start as early as possible). Absent /
   * unknown tasks sort as 0, so a no-history workspace is byte-identical FIFO.
   */
  durationHints?: ReadonlyMap<string, number>
  /**
   * Records the run into the Postgres analytics store (per-task on `complete`,
   * the header + backstop on `checkFinish`). Absent → no recording, byte-
   * identical to before.
   */
  recorder?: DistRunRecorder
}

/**
 * The per-assignment run policy from a submission — the submitter's `--frozen` /
 * `--timeout` / `--retry`, so a standalone agent honors THIS run's flags. Cache
 * is deliberately excluded (full cache is the artifact transport). Returns
 * `undefined` when the submitter declared none, so the assignment stays a bare
 * id (byte-identical to before this field existed).
 */
function deriveAssignPolicy(submit: DistSubmitMessage): AssignPolicy | undefined {
  const req = submit.request
  const policy: AssignPolicy = {}
  if (req.frozen !== undefined) policy.frozen = req.frozen
  if (req.timeout !== undefined) policy.timeout = req.timeout
  if (req.retries !== undefined) policy.retries = req.retries
  return Object.keys(policy).length > 0 ? policy : undefined
}

/** Compact cache-policy flags for the invocation header (core's format). */
function compactCachePolicy(p: CachePolicy): string {
  const parts: string[] = []
  if (p.localRead) parts.push('lR')
  if (p.localWrite) parts.push('lW')
  if (p.remoteRead) parts.push('rR')
  if (p.remoteWrite) parts.push('rW')
  return parts.join(',')
}

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
  // Controller-clock task timeline — each agent's OutcomeView wallclock ns is
  // relative to THAT agent's own scoped run(), so cross-agent offsets aren't
  // comparable. The controller is the only shared clock: it stamps each task's
  // start (agent:start, or completion for a prune hit / skip) and end
  // (completion), and encodes them run-relative so `insertTaskRun` yields a
  // coherent shared epoch-ms timeline (the flamegraph works with no change).
  private readonly startedAtByTask = new Map<string, number>()
  private readonly endedAtByTask = new Map<string, number>()
  // Per-task log capture — the controller tees the `agent:stdout`/`agent:stderr`
  // chunks it already relays (the agent forwards its scoped run's task stream
  // regardless of display mode) into the SHARED bounded-tail buffer, so a
  // distributed run's logs land in `task_logs` and read back through the
  // dashboard exactly like a local run's. Only populated when a recorder is
  // present (no recorder = byte-identical to before, empty buffer).
  private readonly logs = new TaskLogBuffer()
  // The submission's run policy, carried on every `task:assign` so a standalone
  // agent (which multiplexes several submissions) honors THIS run's --frozen /
  // --timeout / --retry rather than live-evaluating with no defaults. Computed
  // once from the submitted RunRequest; `undefined` when the submitter declared
  // none (→ a bare assignment, byte-identical to before).
  private readonly assignPolicy: AssignPolicy | undefined

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
    this.assignPolicy = deriveAssignPolicy(args.submit)
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

  /**
   * A submitted graph that can never complete would hang the submission
   * forever — `checkFinish` only fires from `complete()`, so a node that never
   * becomes ready (a dependency cycle, or a dep on a task not in the
   * submission) leaves `outcomes.size < nodes.size` permanently, leaking the
   * session + the submitter socket. `dist:submit` is a raw wire message, so
   * validate the graph is a well-formed DAG up front. Returns an error string,
   * or null when schedulable. (An EMPTY graph is well-formed — it finishes
   * immediately via the terminal `checkFinish` in `start()`.)
   */
  private validateGraph(): string | null {
    for (const node of this.nodes.values()) {
      for (const dep of node.deps) {
        if (!this.nodes.has(dep)) return `task ${node.id} depends on unknown task ${dep}`
      }
    }
    // Kahn's algorithm over a copy of the dep counts: if fewer than all nodes
    // drain, the remainder form a cycle.
    const rem = new Map<string, number>()
    for (const [id, n] of this.nodes) rem.set(id, n.deps.length)
    const queue: string[] = []
    for (const [id, c] of rem) if (c === 0) queue.push(id)
    let processed = 0
    for (let head = 0; head < queue.length; head++) {
      processed++
      for (const d of this.dependents.get(queue[head]!) ?? []) {
        const c = (rem.get(d) ?? 0) - 1
        rem.set(d, c)
        if (c === 0) queue.push(d)
      }
    }
    return processed < this.nodes.size ? 'submitted task graph has a dependency cycle' : null
  }

  /** run:start → prune against the artifact store → initial dispatch. */
  async start(): Promise<void> {
    const invalid = this.validateGraph()
    if (invalid !== null) {
      this.abort(invalid)
      return
    }
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
    // Terminal check for a graph that completed entirely up front — an EMPTY
    // submission (nothing to do), or one every node of which was pruned as a
    // store hit. `checkFinish` no-ops while any node is still outstanding.
    this.checkFinish()
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
      if (!this.startedAtByTask.has(msg.taskId)) this.startedAtByTask.set(msg.taskId, Date.now())
      this.event({ kind: 'task:start', task: node.view })
      return
    }
    if (msg.t === 'agent:stdout' || msg.t === 'agent:stderr') {
      // Only the agent CURRENTLY assigned the task may stream it. A reassigned
      // task's stale stream — from a dropped agent's still-running detached
      // run(), now arriving on that machine's RECONNECTED socket (a different
      // agent that never held the task) — must not garble the relay or the
      // stored log with a second machine's interleaved output. The assign added
      // the task to the holder's inFlight before the agent could stream, so a
      // legit chunk always passes.
      if (!(agent.inFlight.get(this.submissionId)?.has(msg.taskId) ?? false)) return
      if (this.args.recorder !== undefined) this.logs.append(msg.taskId, msg.chunk)
      if (msg.t === 'agent:stdout') {
        this.event({ kind: 'task:stdout', taskId: msg.taskId, chunk: msg.chunk })
      } else {
        this.event({ kind: 'task:stderr', taskId: msg.taskId, chunk: msg.chunk })
      }
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

  /**
   * The next ready-but-unassigned task. With no duration hints this is the
   * queue head (FIFO — byte-identical to before); with hints it is the
   * LONGEST task (LPT), a strict `>` so ties keep queue order (a no-history
   * workspace, where every hint is 0, stays exactly FIFO).
   */
  nextReady(): string | undefined {
    if (this.finished || this.ready.length === 0) return undefined
    const hints = this.args.durationHints
    if (hints === undefined) return this.ready[0]
    let best = this.ready[0]!
    let bestMs = hints.get(best) ?? 0
    for (let i = 1; i < this.ready.length; i++) {
      const id = this.ready[i]!
      const ms = hints.get(id) ?? 0
      if (ms > bestMs) {
        best = id
        bestMs = ms
      }
    }
    return best
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
    agent.send({
      t: 'task:assign',
      taskId,
      submissionId: this.submissionId,
      ...(this.assignPolicy !== undefined ? { policy: this.assignPolicy } : {}),
    })
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
    const at = Date.now()
    // A synthesized completion (prune hit / failure-cascade skip) never saw an
    // agent:start — stamp both to `at` so its run-relative duration is ~0.
    if (!this.startedAtByTask.has(taskId)) this.startedAtByTask.set(taskId, at)
    this.endedAtByTask.set(taskId, at)
    this.recordTaskDone(taskId, outcome)
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
      return o !== undefined && !isPassStatus(o.status)
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
      else if (isCacheHit(o.status)) agentHits++
    }
    const ok = failed === 0
    const endedAt = Date.now()
    // Record the whole run into Postgres analytics — the invocation header plus
    // the end-of-run backstop that backfills any per-task row a live `taskDone`
    // dropped. Built through core's SHARED `assembleRunSummary` (the same
    // builder a local `run()` uses) so a distributed run and a local run
    // produce byte-identical summaries and land in the same ingest.
    this.recordRunFinished(endedAt, ok)
    // Plain-text footer tallies (§6.7) — core's meter-bar summary is not
    // public and exporting it for cosmetics isn't worth the surface.
    const elapsed = ((endedAt - this.startedAtMs) / 1000).toFixed(1)
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

  // --- analytics recording (observe-only; never affects scheduling) ----------

  /**
   * Project one completed task into `TaskTelemetry` on the CONTROLLER clock.
   * The wallclock ns are run-relative (`(stamp - startedAtMs) * 1e6`) so
   * `insertTaskRun`'s derivation yields a coherent shared epoch-ms timeline;
   * `deriveCacheSource` is core's single status→source mapping (never re-derived
   * here). Group + aborted tasks are not recorded (the local path's rule).
   */
  private taskTelemetryFor(taskId: string, outcome: OutcomeView): TaskTelemetry | undefined {
    const node = this.nodes.get(taskId)
    if (node === undefined || node.view.isGroup || outcome.status === 'aborted') return undefined
    const startMs = this.startedAtByTask.get(taskId) ?? this.startedAtMs
    const endMs = this.endedAtByTask.get(taskId) ?? startMs
    const t: TaskTelemetry = {
      taskId: node.view.id,
      project: node.view.project,
      task: node.view.task,
      status: outcome.status,
      cacheSource: deriveCacheSource(outcome.status),
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      wallclockStartNs: String((startMs - this.startedAtMs) * 1_000_000),
      wallclockEndNs: String((endMs - this.startedAtMs) * 1_000_000),
    }
    if (outcome.hash !== undefined) t.hash = outcome.hash
    if (outcome.cpuMs !== undefined) t.cpuMs = outcome.cpuMs
    if (outcome.peakRssBytes !== undefined) t.peakRssBytes = outcome.peakRssBytes
    return t
  }

  /** Live per-task fill-in: one `task_runs` row the moment a task completes. */
  private recordTaskDone(taskId: string, outcome: OutcomeView): void {
    const recorder = this.args.recorder
    if (recorder === undefined) return
    const task = this.taskTelemetryFor(taskId, outcome)
    if (task === undefined) return
    // Finalize the captured tail (retain for an executed miss, drop for a
    // hit/skip — the buffer's rule, identical to the local sink), then take it
    // for this task's row. A hit / no-output task takes nothing → no log field.
    this.logs.finish(taskId, task.status, task.cacheSource, task.hash)
    const tail = this.logs.takeEntry(taskId)
    const submit = this.args.submit
    const rec: TaskIngestRecord = {
      v: 1,
      runId: this.submissionId,
      workspaceId: submit.workspaceId,
      ...(submit.context?.workspaceName != null
        ? { workspaceName: submit.context.workspaceName }
        : {}),
      // The SAME run start both paths derive the started_at from, so the header
      // backstop's ON CONFLICT dedups this row.
      runStartedAt: this.startedAtMs,
      runEndedAt: this.endedAtByTask.get(taskId) ?? this.startedAtMs,
      task,
      ...(tail !== undefined
        ? {
            log: {
              content: tail.content,
              charsFull: tail.charsFull,
              truncatedHeadChars: tail.truncatedHeadChars,
            },
          }
        : {}),
    }
    recorder.taskDone(rec)
  }

  /** The invocation header + backstop, via the SHARED core summary builder. */
  private recordRunFinished(endedAt: number, ok: boolean): void {
    const recorder = this.args.recorder
    if (recorder === undefined) return
    const tasks: TaskTelemetry[] = []
    for (const [id, outcome] of this.outcomes) {
      const t = this.taskTelemetryFor(id, outcome)
      if (t !== undefined) tasks.push(t)
    }
    const summary = assembleRunSummary(this.runContextRecord(), tasks, {
      startedAt: this.startedAtMs,
      endedAt,
      totalDurationMs: endedAt - this.startedAtMs,
      exitOk: ok,
    })
    recorder.runFinished(summary)
  }

  /** The invocation header context from the submit + the submitter's machine
   *  context (absent on an older submitter → empty header fields). */
  private runContextRecord(): RunContextRecord {
    const submit = this.args.submit
    const req = submit.request
    const ctx = submit.context
    return {
      runId: this.submissionId,
      vxVersion: ctx?.vxVersion ?? '',
      command: req.command ?? `vx run ${req.tasks.join(' ')}`,
      requestedTasks: [...req.tasks],
      cachePolicy: compactCachePolicy(req.cache ?? FULL_CACHE_POLICY),
      concurrency: req.concurrency ?? 0,
      flow: req.flow ?? null,
      workspaceId: submit.workspaceId,
      workspaceName: ctx?.workspaceName ?? submit.workspaceId,
      commitSha: submit.commitSha,
      branch: submit.branch ?? null,
      defaultBranch: submit.defaultBranch ?? null,
      dirty: ctx?.dirty ?? null,
      ci: ctx?.ci ?? false,
      ciProvider: ctx?.ciProvider ?? null,
      host: ctx?.host ?? null,
      os: ctx?.os ?? '',
      arch: ctx?.arch ?? '',
      tags: req.tags ?? {},
    }
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
