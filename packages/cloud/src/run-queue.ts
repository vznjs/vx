// Serve-side FIFO run queue (cloud-data-model-2026-07 §7.2). ONE run
// executes at a time — two concurrent runs with different hashes over
// overlapping scopes race on output cleaning (the 2026-06-27 decision that
// forbade a second cockpit run), so "trigger MULTIPLE" means QUEUE multiple
// and watch them flow queued → running → done. Routing every serve-executed
// run through the queue also closes the pre-existing exposure where two
// CLI-delegated runs executed concurrently and could race.
//
// In-memory like AgentRegistry: a serve restart drops queued jobs loudly —
// acceptable pre-alpha. The queue is also the seam a Phase-4 trigger
// (cron/webhook — owner decision required, §2) would feed.

import type { RunRequest } from '@vzn/vx'

export interface QueuedJob {
  jobId: string
  request: RunRequest
  state: 'queued' | 'running' | 'done'
  submittedAt: number
  startedAt?: number
  /** Known once the run's summary lands (the per-job runId sink). */
  runId?: string
  ok?: boolean
}

/** The `GET /v1/runs/queue` row shape — done jobs drop out. */
export interface JobView {
  jobId: string
  tasks: readonly string[]
  state: 'queued' | 'running'
  /** 0 = running; queued jobs count the jobs ahead of them. */
  position: number
  submittedAt: number
  startedAt?: number
}

export interface RunQueueOptions {
  /** Executes one job to completion (wraps the serve's executeRequest). */
  execute: (job: QueuedJob) => Promise<boolean>
  /** Queued-job overflow bound; a submit past it is refused. */
  maxQueued?: number
  /** Fired when positions changed (a job finished or was canceled). */
  onUpdate?: (jobs: readonly JobView[]) => void
}

export const DEFAULT_MAX_QUEUED = 32

export class RunQueue {
  private readonly execute: (job: QueuedJob) => Promise<boolean>
  private readonly maxQueued: number
  private readonly onUpdate: ((jobs: readonly JobView[]) => void) | undefined
  private running: QueuedJob | null = null
  private readonly waiting: QueuedJob[] = []

  constructor(opts: RunQueueOptions) {
    this.execute = opts.execute
    this.maxQueued = opts.maxQueued ?? DEFAULT_MAX_QUEUED
    this.onUpdate = opts.onUpdate
  }

  submit(request: RunRequest): { jobId: string; position: number } | { error: string } {
    if (this.waiting.length >= this.maxQueued) {
      return { error: `run queue is full (${this.maxQueued} queued) — try again later` }
    }
    const job: QueuedJob = {
      jobId: crypto.randomUUID(),
      request,
      state: 'queued',
      submittedAt: Date.now(),
    }
    if (this.running === null) {
      // Idle queue: the job is running the moment submit returns — the solo
      // case is equivalent to today's immediate execution.
      this.start(job)
      return { jobId: job.jobId, position: 0 }
    }
    this.waiting.push(job)
    return { jobId: job.jobId, position: this.waiting.length }
  }

  /** Queued jobs only; a RUNNING job is not killable (design §12). */
  cancel(jobId: string): boolean {
    const i = this.waiting.findIndex((j) => j.jobId === jobId)
    if (i === -1) return false
    this.waiting.splice(i, 1)
    this.onUpdate?.(this.jobs())
    return true
  }

  jobs(): JobView[] {
    const out: JobView[] = []
    if (this.running !== null) out.push(view(this.running, 0))
    for (const [i, job] of this.waiting.entries()) out.push(view(job, i + 1))
    return out
  }

  private start(job: QueuedJob): void {
    job.state = 'running'
    job.startedAt = Date.now()
    this.running = job
    // The execute callback fires one microtask later so a submitter can
    // register its event routing under the RETURNED jobId before the first
    // job-scoped callback (queue:start, the event stream) runs — submit()
    // can't hand the id out earlier. Still ahead of any I/O.
    queueMicrotask(() => {
      void this.execute(job)
        .catch(() => false)
        .then((ok) => this.finish(job, ok))
    })
  }

  private finish(job: QueuedJob, ok: boolean): void {
    job.state = 'done'
    job.ok = ok
    this.running = null
    const next = this.waiting.shift()
    if (next !== undefined) this.start(next)
    this.onUpdate?.(this.jobs())
  }
}

function view(job: QueuedJob, position: number): JobView {
  return {
    jobId: job.jobId,
    tasks: job.request.tasks,
    state: job.state === 'running' ? 'running' : 'queued',
    position,
    submittedAt: job.submittedAt,
    ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
  }
}
