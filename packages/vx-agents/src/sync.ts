// The synchronizer: a rendezvous between an ephemeral `vx run` and a fleet of
// long-lived workers.
//
// It is NOT a coordinator. vx decides what runs and in what order; this holds
// a queue so two processes that cannot reach each other can hand work across,
// and it decides ONE thing vx cannot — which worker gets an assignment, since
// only the fleet can see that a worker is already sitting on the right commit.
//
// State is in memory on purpose. Everything here is the shape of ONE run in
// flight; a synchronizer restart loses in-flight runs, which fail and are
// re-run, and loses nothing durable because artifacts live in the cache and
// the run record lives in the `vx run` process.

import { randomUUID } from 'node:crypto'
import {
  satisfies,
  type Assignment,
  type AssignmentResult,
  type DispatchRequest,
  type OpenRunRequest,
  type RegisterWorkerRequest,
  type Requirement,
  type RunEvent,
  type WorkerCapabilities,
} from './protocol.js'

/** How long `GET /v0/work` holds before answering "nothing yet". */
const WORK_POLL_MS = 25_000
/** A worker unheard from for this long is presumed gone. */
const WORKER_TTL_MS = 60_000

interface WorkerState {
  readonly id: string
  readonly name: string
  readonly token: string
  readonly capabilities: WorkerCapabilities
  commit: string | undefined
  lastSeen: number
  /** The run this worker is leased to; a worker serves one at a time. */
  lease: string | undefined
  inflight: Set<string>
}

interface AssignmentState extends Assignment {
  readonly requirement: Requirement
  workerId: string | undefined
  done: boolean
}

interface RunState {
  readonly id: string
  readonly token: string
  readonly commit: string
  readonly remote: string
  readonly queue: AssignmentState[]
  readonly assignments: Map<string, AssignmentState>
  readonly subscribers: Set<(event: RunEvent) => void>
}

export interface SyncServerOptions {
  readonly port?: number
  /** Shared secret both ends present. Absent = open, which is fine on a private network. */
  readonly authToken?: string
  /** How long `GET /v0/work` holds before answering "nothing yet". */
  readonly workPollMs?: number
}

export class SyncServer {
  private readonly workers = new Map<string, WorkerState>()
  private readonly runs = new Map<string, RunState>()
  /** Workers parked in a long poll, woken when work they can take arrives. */
  private readonly waiting = new Set<() => void>()

  constructor(private readonly opts: SyncServerOptions = {}) {}

  /** Start listening. Returns the Bun server so a test can read its port. */
  listen(): ReturnType<typeof Bun.serve> {
    return Bun.serve({
      port: this.opts.port ?? 8787,
      idleTimeout: 0,
      fetch: (req) => this.route(req),
    })
  }

  // ---------------------------------------------------------------- routing

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    if (this.opts.authToken !== undefined) {
      if (req.headers.get('authorization') !== `Bearer ${this.opts.authToken}`) {
        return new Response('unauthorized', { status: 401 })
      }
    }

    if (req.method === 'GET' && path === '/v0/health') return Response.json({ ok: true })
    if (req.method === 'POST' && path === '/v0/workers') return await this.registerWorker(req)
    if (req.method === 'POST' && path === '/v0/runs') return await this.openRun(req)
    if (req.method === 'GET' && path === '/v0/work') return await this.claimWork(url)

    const heartbeat = path.match(/^\/v0\/workers\/([^/]+)\/heartbeat$/)
    if (req.method === 'POST' && heartbeat) return await this.heartbeat(heartbeat[1]!, req)

    const dispatch = path.match(/^\/v0\/runs\/([^/]+)\/assignments$/)
    if (req.method === 'POST' && dispatch) return await this.dispatch(dispatch[1]!, req)

    const events = path.match(/^\/v0\/runs\/([^/]+)\/events$/)
    if (req.method === 'GET' && events) return this.events(events[1]!)

    const close = path.match(/^\/v0\/runs\/([^/]+)$/)
    if (req.method === 'DELETE' && close) return this.closeRun(close[1]!)

    const output = path.match(/^\/v0\/assignments\/([^/]+)\/output$/)
    if (req.method === 'POST' && output) return await this.output(output[1]!, req)

    const result = path.match(/^\/v0\/assignments\/([^/]+)\/result$/)
    if (req.method === 'POST' && result) return await this.result(result[1]!, req)

    return new Response('not found', { status: 404 })
  }

  // ---------------------------------------------------------------- workers

  private async registerWorker(req: Request): Promise<Response> {
    const body = (await req.json()) as RegisterWorkerRequest
    const id = randomUUID()
    this.workers.set(id, {
      id,
      name: body.name,
      token: randomUUID(),
      capabilities: body.capabilities,
      commit: body.commit,
      lastSeen: Date.now(),
      lease: undefined,
      inflight: new Set(),
    })
    return Response.json({ workerId: id, token: this.workers.get(id)!.token })
  }

  private async heartbeat(workerId: string, req: Request): Promise<Response> {
    const worker = this.workers.get(workerId)
    if (worker === undefined) return new Response('unknown worker', { status: 404 })
    const body = (await req.json()) as { commit?: string }
    worker.lastSeen = Date.now()
    if (body.commit !== undefined) worker.commit = body.commit
    return Response.json({ ok: true })
  }

  // ------------------------------------------------------------------- runs

  private async openRun(req: Request): Promise<Response> {
    const body = (await req.json()) as OpenRunRequest
    const id = randomUUID()
    this.runs.set(id, {
      id,
      token: randomUUID(),
      commit: body.commit,
      remote: body.remote,
      queue: [],
      assignments: new Map(),
      subscribers: new Set(),
    })
    return Response.json({ runId: id, token: this.runs.get(id)!.token })
  }

  private async dispatch(runId: string, req: Request): Promise<Response> {
    const run = this.runs.get(runId)
    if (run === undefined) return new Response('unknown run', { status: 404 })
    const body = (await req.json()) as DispatchRequest
    const assignment: AssignmentState = {
      assignmentId: randomUUID(),
      runId,
      taskId: body.taskId,
      project: body.project,
      task: body.task,
      forwardArgs: body.forwardArgs,
      commit: run.commit,
      remote: run.remote,
      requirement: body.requirement,
      workerId: undefined,
      done: false,
    }
    run.assignments.set(assignment.assignmentId, assignment)
    run.queue.push(assignment)
    this.wake()
    return Response.json({ assignmentId: assignment.assignmentId })
  }

  private events(runId: string): Response {
    const run = this.runs.get(runId)
    if (run === undefined) return new Response('unknown run', { status: 404 })
    let push: (event: RunEvent) => void
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        // A comment frame FIRST, before any event exists. Without it the
        // response headers are not flushed until the run's first event, so
        // `fetch` on the vx side blocks — and it blocks in exactly the
        // situation that matters: subscribing before dispatching anything.
        // It doubles as the keep-alive an idle SSE connection needs.
        controller.enqueue(encoder.encode(': connected\n\n'))
        push = (event) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        }
        run.subscribers.add(push)
      },
      cancel() {
        run.subscribers.delete(push)
      },
    })
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    })
  }

  private closeRun(runId: string): Response {
    const run = this.runs.get(runId)
    if (run === undefined) return new Response('unknown run', { status: 404 })
    // Releasing the leases is the whole point of closing: a run that ended
    // while holding four workers would starve every other run until they
    // timed out.
    for (const worker of this.workers.values()) {
      if (worker.lease === runId) worker.lease = undefined
    }
    this.runs.delete(runId)
    return Response.json({ ok: true })
  }

  // ------------------------------------------------------------ assignments

  private async claimWork(url: URL): Promise<Response> {
    const workerId = url.searchParams.get('worker') ?? ''
    const worker = this.workers.get(workerId)
    if (worker === undefined) return new Response('unknown worker', { status: 404 })
    worker.lastSeen = Date.now()

    const deadline = Date.now() + (this.opts.workPollMs ?? WORK_POLL_MS)
    for (;;) {
      const claimed = this.take(worker)
      if (claimed !== undefined) return Response.json(claimed)
      const remaining = deadline - Date.now()
      // 204 rather than an empty 200: a worker that got no work and a worker
      // that got a malformed empty assignment must not look the same.
      if (remaining <= 0) return new Response(null, { status: 204 })
      await this.park(remaining)
    }
  }

  /**
   * Pick an assignment for this worker.
   *
   * Affinity first: a worker already on the run's commit needs no fetch, no
   * reinstall, and may still have that task's outputs in its LOCAL cache. That
   * is the one decision vx cannot make, because vx cannot see the other runs.
   */
  private take(worker: WorkerState): Assignment | undefined {
    if (worker.inflight.size >= worker.capabilities.concurrency) return undefined
    const runs =
      worker.lease === undefined
        ? [...this.runs.values()]
        : [this.runs.get(worker.lease)].filter((r): r is RunState => r !== undefined)

    const eligible = runs.filter((run) =>
      run.queue.some((a) => satisfies(worker.capabilities, a.requirement)),
    )
    if (eligible.length === 0) return undefined
    const run =
      eligible.find((r) => r.commit === worker.commit) ??
      // Deterministic: the same worker asking twice with nothing changed must
      // not oscillate between runs.
      eligible.sort((a, b) => (a.id < b.id ? -1 : 1))[0]!

    const index = run.queue.findIndex((a) => satisfies(worker.capabilities, a.requirement))
    const assignment = run.queue.splice(index, 1)[0]!
    assignment.workerId = worker.id
    worker.lease = run.id
    worker.inflight.add(assignment.assignmentId)
    this.emit(run, { kind: 'claimed', assignmentId: assignment.assignmentId, workerId: worker.id })
    return assignment
  }

  private async output(assignmentId: string, req: Request): Promise<Response> {
    const found = this.find(assignmentId)
    if (found === undefined) return new Response('unknown assignment', { status: 404 })
    const body = (await req.json()) as { stream: 'out' | 'err'; chunk: string }
    this.emit(found.run, {
      kind: 'output',
      assignmentId,
      stream: body.stream,
      chunk: body.chunk,
    })
    return Response.json({ ok: true })
  }

  private async result(assignmentId: string, req: Request): Promise<Response> {
    const found = this.find(assignmentId)
    if (found === undefined) return new Response('unknown assignment', { status: 404 })
    const result = (await req.json()) as AssignmentResult
    found.assignment.done = true
    const worker = this.workers.get(result.workerId)
    worker?.inflight.delete(assignmentId)
    this.emit(found.run, { kind: 'result', assignmentId, result })
    this.wake()
    return Response.json({ ok: true })
  }

  // ---------------------------------------------------------------- helpers

  private find(assignmentId: string): { run: RunState; assignment: AssignmentState } | undefined {
    for (const run of this.runs.values()) {
      const assignment = run.assignments.get(assignmentId)
      if (assignment !== undefined) return { run, assignment }
    }
    return undefined
  }

  private emit(run: RunState, event: RunEvent): void {
    for (const subscriber of run.subscribers) {
      // A subscriber whose stream has closed must not take the run with it.
      try {
        subscriber(event)
      } catch {
        run.subscribers.delete(subscriber)
      }
    }
  }

  /** Sleep until woken by new work or the deadline, whichever comes first. */
  private async park(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      let done = false
      const wake = (): void => {
        if (done) return
        done = true
        this.waiting.delete(wake)
        resolve()
      }
      this.waiting.add(wake)
      setTimeout(wake, Math.min(ms, 1000))
    })
  }

  private wake(): void {
    for (const wake of [...this.waiting]) wake()
  }

  /** Workers unheard from past the TTL. Exposed so a test can drive the clock. */
  expired(now = Date.now()): string[] {
    return [...this.workers.values()]
      .filter((w) => now - w.lastSeen > WORKER_TTL_MS)
      .map((w) => w.id)
  }

  /** Drop expired workers and fail whatever they were running. */
  reap(now = Date.now()): void {
    for (const id of this.expired(now)) {
      const worker = this.workers.get(id)!
      for (const assignmentId of worker.inflight) {
        const found = this.find(assignmentId)
        if (found === undefined || found.assignment.done) continue
        // A silently vanished worker must not leave vx waiting forever: report
        // the failure so the scheduler can move on.
        this.emit(found.run, {
          kind: 'result',
          assignmentId,
          result: {
            exitCode: 1,
            durationMs: 0,
            workerId: id,
            error: `worker ${worker.name} stopped responding`,
          },
        })
      }
      this.workers.delete(id)
    }
  }
}
