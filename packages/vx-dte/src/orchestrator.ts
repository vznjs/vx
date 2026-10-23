// The orchestrator's half of a distributed run: the `vx run` the user
// started. It keeps a share of the tasks for this machine and hands the
// rest to the workers online, critical path first (the order core asks in):
// in batches that fill each worker's measured cores and memory by the tasks'
// recorded peaks, plus a small prefetch, preferring the worker that already
// holds a task's dependencies. No file travels through the relay: an
// worker restores a dependency's files from the cache by the key its order
// names and saves its own under the task's key, and this machine restores
// them by that key before the task ends, so the run saves and reports it
// as its own.

import { realpathSync } from 'node:fs'
import path from 'node:path'
import {
  ui,
  withForwardArgs,
  type CacheFacts,
  type ExecuteRequest,
  type ExecuteResult,
  type MachineReport,
  type SandboxConfig,
  type TaskArtifacts,
  type TaskNode,
} from '@vzn/vx'
import {
  HELD_EVERY,
  shares,
  type WorkerInfo,
  type DepOrder,
  type RunOrder,
  type RuntimeOrder,
  type ToWorker,
  type ToOrchestrator,
  type WiredResult,
} from './messages.js'
import { Usage, type UsageStats } from './usage.js'
import { RelayError, type Participant } from './wire.js'

/** What a task is expected to hold while it runs, from its history; `Infinity` (unmeasured): a whole worker. */
export interface Need {
  readonly cores: number
  readonly memory: number
  /** It filled a machine this big last time: only a bigger one takes it, if any worker is. */
  readonly above?: { readonly cores: number; readonly memory: number }
}

interface Job {
  readonly req: ExecuteRequest
  readonly need: Need
  /** The cores and memory it holds on its worker: its need, or the whole worker for an unmeasured one. */
  held?: Need
  readonly resolve: (r: ExecuteResult) => void
  readonly reject: (err: unknown) => void
  worker?: string
  /** The workers that failed it after beginning it, with why: two fail it. */
  faults?: string[]
  /** Its worker's lease on it ends then unless the worker says it still holds it. */
  leaseUntil?: number
  /** Sent beyond what its worker had free: it waits in that worker's queue. */
  prefetched?: boolean
  /** Asked back from its worker's queue for one that is free. */
  withdrawing?: boolean
}

interface Worker {
  readonly id: string
  /** What the run gives it: its machine, held to its declared size. */
  readonly cores: number
  readonly memory: number
  /** What its machine has, as it reported on joining. */
  readonly reported: { readonly cores: number; readonly memory: number }
  readonly label: string
  /** From its start to its join, when this run started it. */
  readonly warmUpMs: number | undefined
  /** The size it was started as, when this run started it. */
  readonly declared: Declared | undefined
  /** Tasks it finished. */
  ran: number
  readonly usage: Usage
  /** Sent to it and not finished: running there or in its queue. */
  readonly busy: Map<string, Job>
  /** Of `busy`, the ones it began. */
  readonly started: Set<string>
  usedCores: number
  usedMemory: number
  /** Tasks whose outputs it holds: it ran them, or was sent them. */
  readonly has: Set<string>
  /** Sends to it go out in order: a run's parts before the run. */
  chain: Promise<void>
  /** It was sent the run's sandbox configs. */
  sandboxes: boolean
  /** It failed a task it began: it gets no more. */
  faulty: boolean
}

/** What a worker was started as: its size's `cpu` and `memory` in bytes. */
export interface Declared {
  readonly size: string
  readonly cpu: number
  readonly memory: number
}

export interface OrchestratorOptions {
  readonly me: Participant
  readonly root: string
  /** The tree of the run's tracked files (`tree.ts`). */
  readonly tree: string
  readonly nodes: () => ReadonlyMap<string, TaskNode> | undefined
  readonly need: (taskId: string) => Need
  /** The run's cache, by key: what workers save to and this machine restores from. */
  readonly artifacts: TaskArtifacts
  /** What workers read the cache under (`ExecutorContext.cacheFacts`). */
  readonly cacheFacts: () => Promise<CacheFacts>
  /** The run id, which a task's run key is made of. */
  readonly run: string
  /** A task's cache key, once the run computed it (a hit's too); undefined when it has none. */
  readonly keyOf: (taskId: string) => string | undefined
  /** Worker `id` (its label) left the run, lost or let go: room for another. */
  readonly left?: (id: string) => void
  /** How much of the run waits on a task (`tailsMs`): the queue places the most first. */
  readonly tail?: (taskId: string) => number
}

/**
 * Lent tokens are asked again this long before they end: inside the
 * window a remote exchanges a new one (turboCache's is five minutes).
 */
const RELEND_MS = 4 * 60_000

/**
 * A batch's orders past this go in another: the relay takes a body of
 * 1 MiB at most, and sealing it grows it by a third.
 */
const BATCH_BYTES = 512 * 1024

/** `orders` in runs of at most `max` bytes of JSON; one bigger goes alone. */
function parts<T extends { order: unknown }>(orders: readonly T[], max: number): T[][] {
  const out: T[][] = []
  let part: T[] = []
  let bytes = 0
  for (const o of orders) {
    const size = JSON.stringify(o.order).length
    if (part.length > 0 && bytes + size > max) {
      out.push(part)
      part = []
      bytes = 0
    }
    part.push(o)
    bytes += size
  }
  if (part.length > 0) out.push(part)
  return out
}

/** A task's end when its run stopped it before it began anywhere. */
const stopped = (): ExecuteResult =>
  result({ exitCode: 130, signal: 'SIGTERM', durationMs: 0 }, { stdout: '', stderr: '' })

/** Cores a worker is sent beyond its own, so a finished task's successor is already there. */
const prefetch = (cores: number): number => Math.max(1, Math.ceil(cores / 4))

export class Orchestrator {
  private readonly workers = new Map<string, Worker>()
  private readonly queue: Job[] = []
  /** Where a worker saved each task it ran: its cache key or its run key. */
  private readonly savedAs = new Map<string, string>()
  /** Keys the run's requests named for their dependencies. */
  private readonly upstreamKeys = new Map<string, string>()
  /** When each worker this run started was asked for, by `WorkerSpawn.index`. */
  private readonly spawnedAt = new Map<string, { at: number; declared: Declared }>()
  private ended = false
  private endedAt = 0
  /** Workers that joined and left, for the footer. */
  private readonly gone: Worker[] = []
  /** Of `gone`, those the run let go (`retire`), not lost. */
  private readonly retired = new Set<Worker>()
  /** Workers asked for that never joined, with why. */
  private readonly unstarted = new Map<string, string>()
  /** A failed start was given another worker (`failed`). */
  private restarted = false
  private pumping = false
  private joined = 0
  private readonly startedAt = performance.now()
  /** Each time the run asked for workers: when, for how many cores in all, how many. */
  private readonly asks: {
    at: number
    cores: number
    workers: number
    tasks: number
    measured: number
  }[] = []
  private readonly stop = new AbortController()
  private readonly loop: Promise<void>
  private readonly realRoot: string
  /** What workers read the cache under, asked once and again before its lent tokens end. */
  private facts: Promise<CacheFacts> | undefined
  private relend: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly o: OrchestratorOptions) {
    // A root that is gone fails the run's own reads first.
    this.realRoot = (() => {
      try {
        return realpathSync(o.root)
      } catch {
        return o.root
      }
    })()
    this.loop = this.listen()
  }

  execute(req: ExecuteRequest): Promise<ExecuteResult> {
    if (this.lost !== undefined) return Promise.reject(new Error(this.lost))
    for (const u of req.inputs?.upstream ?? []) this.upstreamKeys.set(u.taskId, u.hash)
    return new Promise((resolve, reject) => {
      const job: Job = { req, need: this.o.need(req.taskId), resolve, reject }
      // A signal aborted already fires no `abort`.
      if (req.signal?.aborted === true) return resolve(stopped())
      req.signal?.addEventListener('abort', () => this.abort(job), { once: true })
      this.queue.push(job)
      this.pumpSoon()
    })
  }

  /** The run's cache facts; once they end, every worker is sent them again before then. */
  private cache(): Promise<CacheFacts> {
    if (this.facts !== undefined) return this.facts
    const asked = this.o.cacheFacts()
    this.facts = asked
    void asked.then(
      (f) => {
        if (f.expiresAt === undefined || this.ended) return
        this.relend = setTimeout(
          () => {
            this.facts = undefined
            void this.cache().then((cache) => {
              for (const a of this.workers.values()) this.post(a, { type: 'cache', cache })
            })
          },
          Math.max(0, f.expiresAt - Date.now() - RELEND_MS),
        )
        this.relend.unref()
      },
      () => {
        this.facts = undefined
      },
    )
    return asked
  }

  async close(): Promise<void> {
    clearTimeout(this.relend)
    this.ended = true
    this.endedAt = performance.now()
    this.stop.abort()
    await this.loop
    await this.o.me.leave()
  }

  private abort(job: Job): void {
    const at = this.queue.indexOf(job)
    if (at >= 0) {
      this.queue.splice(at, 1)
      job.resolve(stopped())
    } else if (job.worker !== undefined) {
      const a = this.workers.get(job.worker)
      if (a !== undefined) this.post(a, { type: 'cancel', task: job.req.taskId })
    }
  }

  /** Tasks core starts in one tick go out as one batch. */
  private pumpSoon(): void {
    if (this.pumping) return
    this.pumping = true
    setImmediate(() => {
      this.pumping = false
      this.pump()
    })
  }

  private pump(): void {
    const batches = new Map<Worker, Job[]>()
    const left: Job[] = []
    // Core asks in its critical-path order, but only as tasks get ready: a
    // long chain ready a moment late queued behind 46 shards ready at once,
    // and its 41 s build began 47 s in, the run's end (main, 2026-10-23).
    const tail = this.o.tail
    const queue = this.queue.splice(0)
    if (tail !== undefined) queue.sort((x, y) => tail(y.req.taskId) - tail(x.req.taskId))
    for (const job of queue) {
      const a = this.place(job)
      if (a === undefined) {
        left.push(job)
        continue
      }
      job.worker = a.id
      job.prefetched =
        a.busy.size > 0 && !shares({ cores: a.usedCores, memory: a.usedMemory }, job.need, a)
      a.busy.set(job.req.taskId, job)
      job.held = {
        cores: Math.min(job.need.cores, a.cores),
        memory: Math.min(job.need.memory, a.memory),
      }
      a.usedCores += job.held.cores
      a.usedMemory += job.held.memory
      const batch = batches.get(a)
      if (batch === undefined) batches.set(a, [job])
      else batch.push(job)
    }
    this.queue.push(...left)
    for (const [a, jobs] of batches) this.send(a, jobs)
    if (left.length === 0) this.steal()
  }

  /**
   * A worker with nothing to do takes back a task waiting in a busy one's
   * queue as its prefetch: that task may be the one the rest of the run
   * waits on (M, 2026-10-21: check.bun, ahead of 8 shards, sat behind a
   * long suite while workers that joined later stood idle). One per idle
   * worker, first sent first; the worker gives it back only if not begun.
   */
  private steal(): void {
    const online = [...this.workers.values()].filter((a) => !a.faulty)
    let idle = online.filter((a) => a.busy.size === 0).length
    for (const a of online) {
      for (const j of a.busy.values()) {
        if (idle === 0) return
        if (j.prefetched !== true || j.withdrawing === true || a.started.has(j.req.taskId)) continue
        j.withdrawing = true
        idle--
        this.post(a, { type: 'withdraw', task: j.req.taskId })
      }
    }
  }

  /**
   * The worker for `job`: one it fits on, else one with prefetch room left;
   * among those, the one holding most of its dependencies' outputs, then
   * the one with fewest cores free: spread one a piece, 12 workers of 4
   * cores each ran about 1 at 25% (main, 2026-10-23); packed, the workers
   * the rest no longer needs fall idle and leave. A task bigger than
   * every worker goes to an idle one, alone.
   */
  private place(job: Job): Worker | undefined {
    const up = upstream(this.o.nodes(), job.req.taskId)
    let best: Worker | undefined
    let bestScore: number[] = []
    const bigger = (a: Worker): boolean =>
      job.need.above === undefined ||
      a.cores > job.need.above.cores ||
      a.memory > job.need.above.memory
    // A bigger worker online takes it; one starting is waited for; else
    // the biggest there is.
    const workers = [...this.workers.values()].filter((a) => !a.faulty)
    if (job.need.above !== undefined && !workers.some(bigger)) {
      const above = job.need.above
      const joined = new Set([...workers, ...this.gone].map((x) => x.label))
      for (const [id, { declared }] of this.spawnedAt)
        if (
          !joined.has(id) &&
          !this.unstarted.has(id) &&
          (declared.cpu > above.cores || declared.memory > above.memory)
        )
          return undefined
    }
    const pool = workers.some(bigger) ? workers.filter(bigger) : workers
    for (const a of pool) {
      const fits =
        a.busy.size === 0 || shares({ cores: a.usedCores, memory: a.usedMemory }, job.need, a)
      if (!fits && a.usedCores + job.need.cores > a.cores + prefetch(a.cores)) continue
      let held = 0
      for (const id of up) if (a.has.has(id)) held++
      const score = [fits ? 1 : 0, held, a.usedCores - a.cores]
      if (best === undefined || greater(score, bestScore)) {
        best = a
        bestScore = score
      }
    }
    return best
  }

  private send(a: Worker, jobs: readonly Job[]): void {
    const nodes = this.o.nodes()
    const orders = jobs.map((job) => {
      const { req } = job
      const deps: DepOrder[] = []
      // Every one, held there or not: the worker restores each key once, and
      // one it was sent but gave back it never ran or restored.
      for (const id of upstream(nodes, req.taskId)) {
        const n = nodes?.get(id)
        const outs = n?.config.cache?.outputs
        const key = this.savedAs.get(id) ?? this.upstreamKeys.get(id) ?? this.o.keyOf(id)
        if (n === undefined || outs === undefined || key === undefined) continue
        a.has.add(id)
        deps.push({
          task: id,
          key,
          project: path.relative(this.o.root, n.projectDir),
          outputs: { files: [...outs.files], workspaceFiles: [...(outs.workspaceFiles ?? [])] },
        })
      }
      // A task sent here leaves its outputs here for its dependants.
      a.has.add(req.taskId)
      const node = nodes?.get(req.taskId)
      const env = defined(req.env)
      return {
        job,
        order: {
          task: req.taskId,
          ...(req.cacheKey === undefined ? {} : { key: req.cacheKey }),
          runKey: runKey(this.o.run, req.taskId),
          deps,
          nested: node === undefined ? [] : nestedIn(nodes!, node.projectDir, this.o.root),
          command: withForwardArgs(req.command, req.forwardArgs),
          cwd: path.relative(this.o.root, req.cwd),
          project: node === undefined ? '' : path.relative(this.o.root, node.projectDir),
          env,
          ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
          outputs: {
            files: [...req.outputs.files],
            workspaceFiles: [...req.outputs.workspaceFiles],
          },
          cores: job.held?.cores ?? 1,
          memory: job.held?.memory ?? 0,
          ...(req.sandbox === undefined || node?.config.exec?.sandbox === undefined
            ? {}
            : {
                sandbox: {
                  config: node.config.exec.sandbox,
                  ...(req.sandbox.keyed === undefined
                    ? {}
                    : { keyed: req.sandbox.keyed.map((d) => path.relative(this.o.root, d)) }),
                },
              }),
          ...runtimeOrders(req),
          ...(req.servers === undefined || req.servers.length === 0
            ? {}
            : {
                servers: req.servers.map((s) => ({
                  task: s.taskId,
                  command: s.command,
                  cwd: path.relative(this.o.root, s.cwd),
                  env: defined(s.env),
                  ...(s.readyWhen === undefined ? {} : { readyWhen: s.readyWhen }),
                  ...(s.timeoutMs === undefined ? {} : { timeoutMs: s.timeoutMs }),
                })),
              }),
        } as RunOrder,
      }
    })
    const sandboxed = orders.some((o) => o.order.sandbox !== undefined)
    const sandboxes = sandboxed && !a.sandboxes ? sandboxConfigs(nodes) : undefined
    if (sandboxed) a.sandboxes = true
    a.chain = a.chain
      .then(async () => {
        for (const [i, part] of parts(orders, BATCH_BYTES).entries()) {
          const batch = {
            type: 'batch',
            root: this.o.root,
            realRoot: this.realRoot,
            tasks: part.map((o) => o.order),
            ...(sandboxes === undefined || i > 0 ? {} : { sandboxes }),
          } satisfies ToWorker
          await this.o.me.send(a.id, batch)
          a.usage.messagesIn++
          a.usage.bytesIn += JSON.stringify(batch).length
          for (const { job } of part) this.lease(job)
        }
      })
      .catch((err: unknown) => {
        // The relay refused the send (the worker is gone): the loss notice
        // puts the tasks back.
        if (err instanceof RelayError && err.status === 404) return
        for (const { job } of orders) job.reject(err)
      })
  }

  /** Three of the worker's `held` from now. */
  private lease(job: Job): void {
    job.leaseUntil = performance.now() + 3 * HELD_EVERY * this.o.me.heartbeatMs
  }

  /**
   * Worker `a` let `job` down: lost, its lease ended, or it could not run
   * it. One it had begun counts, and two workers fail it; one still in its
   * queue goes back free.
   */
  private retry(a: Worker, job: Job, why: string): Job | undefined {
    a.busy.delete(job.req.taskId)
    // Its outputs are not there to place a dependant by.
    a.has.delete(job.req.taskId)
    a.usedCores -= job.held?.cores ?? 0
    a.usedMemory -= job.held?.memory ?? 0
    if (a.started.has(job.req.taskId)) a.usage.book(-(job.held?.cores ?? 0))
    delete job.worker
    delete job.held
    delete job.leaseUntil
    delete job.prefetched
    delete job.withdrawing
    const begun = a.started.delete(job.req.taskId)
    // Stopped, it runs nowhere again; the cancel sent its worker has no one to answer it.
    if (job.req.signal?.aborted === true) {
      job.resolve(stopped())
      return undefined
    }
    if (begun) {
      a.faulty = true
      job.faults = [...(job.faults ?? []), `${a.label} ${why}`]
      if (job.faults.length >= 2) {
        job.reject(new Error(`${job.req.taskId}: failed on 2 workers: ${job.faults.join(', ')}`))
        return undefined
      }
    }
    return job
  }

  /** Each task whose worker's lease on it ended goes back. */
  private expire(): void {
    const now = performance.now()
    const back: Job[] = []
    for (const a of this.workers.values())
      for (const j of [...a.busy.values()])
        if (j.leaseUntil !== undefined && j.leaseUntil < now) {
          const again = this.retry(a, j, 'lease expired')
          if (again !== undefined) back.push(again)
        }
    if (back.length === 0) return
    this.queue.unshift(...back)
    if (this.spawnedAt.size > 0) this.stranded(`a task's lease ended and no worker is left`)
    this.pumpSoon()
  }

  private post(a: Worker, m: ToWorker): void {
    a.chain = a.chain.then(() => this.o.me.send(a.id, m)).catch(() => undefined)
  }

  /** Worker `a` began `task`: from now its cores are booked, where a prefetch waiting in its queue held none. */
  private begun(a: Worker, task: string): void {
    const job = a.busy.get(task)
    if (job === undefined || a.started.has(task)) return
    a.started.add(task)
    a.usage.book(job.held?.cores ?? 0)
  }

  /** Worker `a` ran `task` and saved it under `key`: it is done there, and done here once restored. */
  private async finish(a: Worker, task: string, key: string, head: WiredResult): Promise<void> {
    const job = a.busy.get(task)
    if (job === undefined) return
    a.busy.delete(task)
    if (a.started.delete(task)) a.usage.book(-(job.held?.cores ?? 0))
    a.usedCores -= job.held?.cores ?? 0
    a.usedMemory -= job.held?.memory ?? 0
    a.ran++
    a.usage.record(head)
    this.savedAs.set(task, key)
    this.pumpSoon()
    const node = this.o.nodes()?.get(task)
    const log = await this.o.artifacts
      .restore(key, {
        id: task,
        projectDir: node?.projectDir ?? job.req.cwd,
        command: job.req.command,
        outputs: job.req.outputs,
      })
      .catch((err: unknown) => {
        job.reject(err)
        return undefined
      })
    if (log === undefined) return
    if (log === null) {
      job.reject(
        new Error(
          `${task}: ${a.label} saved it where this machine cannot read it: give the workers and this machine a remote cache they write, or one store`,
        ),
      )
      return
    }
    if (log.stdout !== '') job.req.onStdout(log.stdout)
    if (log.stderr !== '') job.req.onStderr(log.stderr)
    job.resolve({
      ...result(head, log),
      where: a.label,
      machine: { cores: a.reported.cores, memoryBytes: a.reported.memory },
    })
  }

  private onRelay(body: { type?: string; id?: string; info?: unknown }): void {
    if (body.type === 'joined') {
      const info = body.info as Partial<WorkerInfo> | null
      const id = body.id!
      const refuse = (reason: string): void => {
        void this.o.me
          .send(id, { type: 'refused', reason } satisfies ToWorker)
          .catch(() => undefined)
      }
      if (
        info?.v !== 1 ||
        !(info.id === undefined || typeof info.id === 'string') ||
        !(Number(info.cores) >= 1) ||
        !(Number(info.memory) >= 0)
      ) {
        return refuse('speaks another vx-dte protocol')
      }
      if (info.tree !== this.o.tree) {
        return refuse(`checked out tree ${info.tree}, the run is on ${this.o.tree}`)
      }
      // A worker this run started keeps the name it was started under;
      // one that joined on its own is numbered in the order it joined.
      const spawn = info.id === undefined ? undefined : this.spawnedAt.get(info.id)
      const asked = spawn?.at
      const taken = new Set([...this.workers.values(), ...this.gone].map((a) => a.label))
      let label = asked === undefined ? undefined : info.id
      while (label === undefined || taken.has(label)) label = `worker#${++this.joined}`
      // Workers of one host (local()) each report the host: the size it
      // was started as is its share (Growth, 2026-10-21: 16 wide on 4 cores).
      const cores = Math.min(Number(info.cores), spawn?.declared.cpu ?? Infinity)
      const memory = Math.min(Number(info.memory), spawn?.declared.memory ?? Infinity)
      this.workers.set(id, {
        id,
        warmUpMs: asked === undefined ? undefined : performance.now() - asked,
        declared: spawn?.declared,
        ran: 0,
        usage: new Usage(),
        cores,
        memory,
        reported: { cores: Number(info.cores), memory: Number(info.memory) },
        usedCores: 0,
        usedMemory: 0,
        label,
        busy: new Map(),
        started: new Set(),
        has: new Set(),
        // Its name first, before any batch.
        chain: this.cache()
          .then((cache) =>
            this.o.me.send(id, {
              type: 'welcome',
              name: label,
              cache,
              cores,
              memory,
            } satisfies ToWorker),
          )
          .catch(() => undefined),
        sandboxes: false,
        faulty: false,
      })
    } else if (body.type === 'lost') {
      const a = this.workers.get(body.id!)
      if (a === undefined) return
      this.lose(a)
    } else {
      return
    }
    this.pumpSoon()
  }

  /** Worker `a` is gone without a word: its tasks run again elsewhere. */
  private lose(a: Worker): void {
    this.workers.delete(a.id)
    a.usage.to = performance.now()
    this.gone.push(a)
    // Its tasks run again: first, as they were first to go.
    const back: Job[] = []
    for (const j of [...a.busy.values()]) {
      const again = this.retry(a, j, 'lost')
      if (again !== undefined) back.push(again)
    }
    this.queue.unshift(...back)
    this.o.left?.(a.label)
    // Workers that join on their own may yet join; ones this run starts
    // are all it gets.
    if (this.spawnedAt.size > 0) this.stranded(`${a.label} was lost and no worker is left`)
  }

  private async listen(): Promise<void> {
    while (!this.stop.signal.aborted) {
      let messages
      try {
        // The client asks again through faults shorter than three heartbeats.
        messages = await this.o.me.poll(this.stop.signal)
      } catch (err) {
        if (this.stop.signal.aborted) return
        // A relay unreachable longer has lost this run. Its tasks fail, not
        // run here: this machine may be far smaller than the workers. A rerun
        // resumes from what finished and saved.
        this.fail(`the relay is unreachable (${(err as Error).message})`)
        return
      }
      this.expire()
      for (const { from, body } of messages) {
        if (from === 'relay') {
          this.onRelay(body as { type?: string })
          continue
        }
        const a = this.workers.get(from)
        if (a === undefined) continue
        const m = body as ToOrchestrator
        if (m.type === 'start') {
          this.begun(a, m.task)
        } else if (m.type === 'held') {
          for (const t of [...m.running, ...m.queued]) {
            const j = a.busy.get(t)
            if (j?.leaseUntil !== undefined) this.lease(j)
          }
          for (const t of m.running) this.begun(a, t)
        } else if (m.type === 'withdrawn') {
          const j = a.busy.get(m.task)
          if (j === undefined || a.started.has(m.task)) continue
          if (this.retry(a, j, 'withdrawn') !== undefined) this.queue.unshift(j)
          this.pumpSoon()
        } else if (m.type === 'fault') {
          const j = a.busy.get(m.task)
          if (j === undefined) continue
          // It began it whether or not its `start` came first.
          this.begun(a, m.task)
          if (this.retry(a, j, m.reason) !== undefined) this.queue.unshift(j)
          if (a.faulty && this.spawnedAt.size > 0)
            this.stranded(`${a.label} could not run ${m.task} (${m.reason}) and no worker is left`)
          this.pumpSoon()
        } else if (m.type === 'end') {
          a.usage.messagesOut++
          a.usage.bytesOut += JSON.stringify(m).length
          // Not awaited: one task's restore holds no other message.
          void this.finish(a, m.task, m.key, m.result)
        }
      }
    }
  }

  /** The worker running a task; `null` while it waits, here or in a worker's queue, for one to begin it. */
  where(taskId: string): string | null | undefined {
    for (const a of this.workers.values())
      if (a.busy.has(taskId)) return a.started.has(taskId) ? a.label : null
    return this.queue.some((j) => j.req.taskId === taskId) ? null : undefined
  }

  /** The run asks for `workers` more, as `cores` is what its remaining work keeps busy. */
  asked(cores: number, workers: number, tasks: number, measured: number): void {
    this.asks.push({ at: performance.now() - this.startedAt, cores, workers, tasks, measured })
  }

  /** `demand` asked the adapter for worker `id` (`WorkerSpawn.id`). */
  spawned(id: string, declared: Declared): void {
    this.spawnedAt.set(id, { at: performance.now(), declared })
  }

  /**
   * The cores the run's workers have: what each online reports, and what
   * each still starting declares. `retire` counts the reported ones too;
   * a start counted by the declared size beside it started a worker for
   * every one that left (a local() worker reports its host).
   */
  cores(): number {
    const joined = new Set([...this.workers.values(), ...this.gone].map((a) => a.label))
    let n = 0
    for (const a of this.workers.values()) if (!a.faulty) n += a.cores
    for (const [id, { declared }] of this.spawnedAt)
      if (!joined.has(id) && !this.unstarted.has(id)) n += declared.cpu
    return n
  }

  /**
   * The shortest time a worker this run asked for took to join, once one
   * has: what a worker asked for now takes, at the least.
   */
  warmUpMs(): number | undefined {
    let least: number | undefined
    for (const a of [...this.workers.values(), ...this.gone])
      if (a.warmUpMs !== undefined && !(least! <= a.warmUpMs)) least = a.warmUpMs
    return least
  }

  /** The most cores a worker online has; 0 with none. */
  biggestCores(): number {
    let most = 0
    for (const a of this.workers.values()) most = Math.max(most, a.cores)
    return most
  }

  /**
   * Idle workers the rest of the run does not need leave (`exit`): those
   * holding no task, beyond the cores `wantCores` asks of workers, biggest
   * kept first, unless `needed` says a remaining task wants one that big.
   */
  retire(wantCores: number, needed: (a: { cores: number; memory: number }) => boolean): void {
    // One that faulted gets no more work: idle, it only holds its machine.
    for (const a of this.workers.values()) if (a.faulty && a.busy.size === 0) this.letGo(a)
    const online = [...this.workers.values()].filter((a) => !a.faulty)
    let cores = 0
    for (const a of online) if (a.busy.size > 0) cores += a.cores
    const idle = online.filter((a) => a.busy.size === 0).sort((x, y) => y.cores - x.cores)
    // An idle one a waiting prefetched task can move to stays for it.
    let movable = 0
    for (const a of online)
      for (const j of a.busy.values())
        if (j.prefetched === true && !a.started.has(j.req.taskId)) movable++
    for (const a of idle) {
      if (cores < wantCores || needed(a) || movable-- > 0) {
        cores += a.cores
        continue
      }
      this.letGo(a)
    }
  }

  private letGo(a: Worker): void {
    this.workers.delete(a.id)
    a.usage.to = performance.now()
    this.gone.push(a)
    this.retired.add(a)
    this.post(a, { type: 'exit' })
    this.o.left?.(a.label)
  }

  /**
   * Worker `id` will not join: its start failed or it exited first. One that
   * joined is lost now, not when the relay stops hearing it (20 s, its tasks
   * waiting).
   */
  failed(id: string, reason: string): void {
    if (this.ended) return
    const live = [...this.workers.values()].find((a) => a.label === id)
    if (live !== undefined) {
      this.lose(live)
      this.pumpSoon()
      return
    }
    if (this.unstarted.has(id)) return
    this.unstarted.set(id, reason)
    // A checkout or install can fail on the network; one more worker gets a
    // go. A second failed start is the setup's, and none more are started.
    const joined = [...this.workers.values(), ...this.gone].some((a) => a.label === id)
    if (!joined && !this.restarted) {
      this.restarted = true
      this.o.left?.(id)
    }
    this.stranded(`no worker could start: ${id} ${reason}`)
  }

  /** Nothing online that takes work, none still starting: no task can run. */
  private stranded(reason: string): void {
    const joined = new Set([...this.workers.values(), ...this.gone].map((a) => a.label))
    const starting = [...this.spawnedAt.keys()].some(
      (s) => !this.unstarted.has(s) && !joined.has(s),
    )
    const working = [...this.workers.values()].some((a) => !a.faulty)
    if (!working && !starting) this.fail(reason)
  }

  /** Every task sent here and not done fails with `reason`; later ones too. */
  private fail(reason: string): void {
    for (const a of this.workers.values())
      for (const j of a.busy.values()) j.reject(new Error(reason))
    for (const j of this.queue.splice(0)) j.reject(new Error(reason))
    this.workers.clear()
    this.lost = reason
  }

  /**
   * `left` when the run let it go as not needed, `lost` when it crashed or
   * went silent, `stopped` when the run's end stopped it, else `online`.
   */
  private state(a: Worker, gone: ReadonlySet<Worker>): string {
    if (this.retired.has(a)) return 'left'
    if (gone.has(a)) return 'lost'
    return this.ended ? 'stopped' : 'online'
  }

  /**
   * Each machine that joined, and this one when it ran tasks, with what it
   * did: the run summary's `machines`. Core asks once its tasks are over,
   * before its teardown ends this run: then is its end, so one still here
   * is `stopped`, online until now (small#2 read online 1ms, booked 433802
   * of 4: main, 2026-10-23).
   */
  machines(): MachineReport[] {
    const gone = new Set(this.gone)
    const until = this.ended ? this.endedAt : performance.now()
    const report = (
      name: string,
      status: string,
      u: Usage,
      cores: number,
      memoryBytes: number,
    ): MachineReport => {
      const st = u.stats(cores, until)
      return {
        name,
        status,
        cores,
        memoryBytes,
        done: u.done,
        failed: u.failed,
        onlineMs: st.onlineMs,
        busyMs: st.busyMs,
        cpuPeak: st.cpuPeak,
        cpuAvg: st.cpuAvg,
        memoryPeakBytes: st.memoryPeak,
        memoryAvgBytes: st.memoryAvg,
        utilization: st.utilization,
        bookedAvg: st.bookedAvg,
      }
    }
    return [...this.workers.values(), ...this.gone].map((a) => ({
      ...report(
        a.label,
        this.retired.has(a) ? 'left' : gone.has(a) ? 'lost' : 'stopped',
        a.usage,
        a.reported.cores,
        a.reported.memory,
      ),
      ...(a.warmUpMs === undefined ? {} : { warmUpMs: a.warmUpMs }),
    }))
  }

  /**
   * The `workers` rows, live and at the end: one per worker by `size#index`
   * with its status, the tasks it has done and the ones it runs now, then
   * this machine's; once over, each joined worker's warm-up and, under
   * each, the cores and memory its size declares and its machine reports.
   */
  footer(): [string, ui.Inline][] {
    if (this.spawnedAt.size === 0 && this.workers.size === 0 && this.gone.length === 0) return []
    const gone = new Set(this.gone)
    const all = [...this.workers.values(), ...this.gone]
    const joined = new Set(all.map((a) => a.label))
    const count = (u: Usage, running: number): string =>
      [
        `${u.done} done`,
        ...(u.failed > 0 ? [`${u.failed} failed`] : []),
        ...(u.aborted > 0 ? [`${u.aborted} aborted`] : []),
        ...(running > 0 ? [`${running} running`] : []),
      ].join(' · ')
    // Once over, under its row: what its size declares and what its machine
    // reports, green when they agree, red when not.
    const res = new Map<string, ui.Inline>()
    const resources = (label: string, cores: number, memory: number, d?: Declared): void => {
      const actual = `${cores}c/${compact(memory)}`
      res.set(
        label,
        d === undefined
          ? ui.dim(`${indent}actual ${actual}`)
          : [
              ui.dim(`${indent}declared ${d.cpu}c/${compact(d.memory)} · actual `),
              ui.tone(matches(cores, memory, d) ? 'ok' : 'error', actual),
            ],
      )
    }
    // Live, those that left are one line: a run that replaced many pushed
    // the rows that run past the screen.
    const left = this.ended ? [] : all.filter((a) => this.retired.has(a))
    const lines: [string, string, string][] = all
      .filter((a) => !left.includes(a))
      .map((a) => [
        a.label,
        this.state(a, gone),
        count(a.usage, gone.has(a) ? 0 : a.started.size) +
          (this.ended && a.warmUpMs !== undefined ? ` · warm-up ${seconds(a.warmUpMs)}` : ''),
      ])
    for (const id of this.spawnedAt.keys())
      if (!joined.has(id)) {
        const why = this.unstarted.get(id)
        lines.push(why === undefined ? [id, 'starting', ''] : [id, 'failed', why])
      }
    lines.sort((x, y) => x[0].localeCompare(y[0], 'en', { numeric: true }))
    if (left.length > 0)
      lines.push([
        `${left.length} worker${left.length === 1 ? '' : 's'}`,
        'left',
        `${left.reduce((n, a) => n + a.usage.done, 0)} done`,
      ])
    const width = Math.max(...lines.map(([l]) => l.length))
    const indent = ' '.repeat(width + 2)
    const status = Math.max(...lines.map(([, st]) => st.length))
    // Once over, what each did, under its line.
    const usage = new Map<string, readonly string[]>()
    let cpuMs = 0
    let coreMs = 0
    if (this.ended)
      for (const a of all) {
        resources(a.label, a.reported.cores, a.reported.memory, a.declared)
        const st = a.usage.stats(a.cores, this.endedAt)
        cpuMs += st.cpuMs
        coreMs += a.cores * st.onlineMs
        usage.set(a.label, describe(st, a.usage))
      }
    return [
      ...lines.flatMap(([l, st, t], i): [string, ui.Inline][] => [
        [
          i === 0 ? 'workers' : '',
          st === 'failed'
            ? [ui.place(l), `${' '.repeat(width - l.length)}  `, ui.tone('error', st), `  ${t}`]
            : t === ''
              ? [ui.place(l), `${' '.repeat(width - l.length)}  ${st}`]
              : [ui.place(l), `${' '.repeat(width - l.length)}  ${st.padEnd(status)}  ${t}`],
        ],
        ...(res.has(l) ? [['', res.get(l)!] as [string, ui.Inline]] : []),
        ...(usage.get(l) ?? []).map((d): [string, ui.Inline] => ['', ui.dim(`${indent}${d}`)]),
      ]),
      ...(this.ended && this.asks.length > 0
        ? [
            [
              '',
              ui.dim(
                `${'asked'.padEnd(width)}  ${this.asks
                  .map(
                    (x) =>
                      `${x.workers} at ${seconds(x.at)} for ${Math.ceil(x.cores)} cores, ${x.tasks} tasks (${x.measured} measured)`,
                  )
                  .join(' · ')}`,
              ),
            ] as [string, ui.Inline],
          ]
        : []),
      ...(coreMs > 0
        ? [
            ['', `${'total'.padEnd(width)}  cpu utilization ${percent(cpuMs / coreMs)}`] as [
              string,
              ui.Inline,
            ],
          ]
        : []),
    ]
  }

  /** Why the relay was given up on; then every task runs here. */
  lost: string | undefined
}

function greater(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return false
}

function result(r: WiredResult, log: { stdout: string; stderr: string }): ExecuteResult {
  const violations = (r.violations ?? []).map((v) => ({ ...v, timestamp: new Date(v.timestamp) }))
  return { ...r, ...log, violations, outputs: { kind: 'disk' } }
}

/** What a task that is not a cache hit to be is saved under: of this run and task, so no lookup ever finds it. */
export function runKey(run: string, task: string): string {
  return Bun.hash.xxHash3(`vx-dte\0${run}\0${task}`).toString(16).padStart(16, '0')
}

/** The projects inside `dir`, workspace-relative. */
function nestedIn(nodes: ReadonlyMap<string, TaskNode>, dir: string, root: string): string[] {
  const out = new Set<string>()
  for (const n of nodes.values())
    if (n.projectDir.startsWith(dir + path.sep)) out.add(path.relative(root, n.projectDir))
  return [...out].sort()
}

/** Each distinct `exec.sandbox` of the run, for a worker's sandbox runtime. */
function sandboxConfigs(nodes: ReadonlyMap<string, TaskNode> | undefined): SandboxConfig[] {
  const seen = new Map<string, SandboxConfig>()
  for (const n of nodes?.values() ?? []) {
    const s = n.config.exec?.sandbox
    if (s !== undefined) seen.set(JSON.stringify(s), s)
  }
  return [...seen.values()]
}

/** Every task `id` depends on, transitively. */
function upstream(nodes: ReadonlyMap<string, TaskNode> | undefined, id: string): Set<string> {
  const seen = new Set<string>()
  const walk = (t: string): void => {
    for (const d of nodes?.get(t)?.deps ?? []) {
      if (seen.has(d)) continue
      seen.add(d)
      walk(d)
    }
  }
  walk(id)
  return seen
}

/** A worker's run, spelled out: time, CPU, memory and the relay. */
function describe(st: UsageStats, u: Usage): string[] {
  return [
    `online ${seconds(st.onlineMs)} · busy ${seconds(st.busyMs)} · idle ${seconds(Math.max(0, st.onlineMs - st.busyMs))}`,
    `cpu peak ${st.cpuPeak.toFixed(1)} · avg ${st.cpuAvg.toFixed(1)} cores · booked ${st.bookedAvg.toFixed(1)} · cpu utilization ${percent(st.utilization)}`,
    // No task said what it held: `memory peak 0 B` would be a claim.
    ...(st.memoryPeak > 0
      ? [`memory peak ${bytes(st.memoryPeak)} · avg ${bytes(st.memoryAvg)}`]
      : []),
    `sent ${plural(u.messagesIn, 'message')} · ${bytes(u.bytesIn)}, received ${plural(u.messagesOut, 'message')} · ${bytes(u.bytesOut)}`,
  ]
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
const percent = (n: number): string => `${Math.round(n * 100)}%`
const bytes = (n: number): string =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)} GB`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)} MB`
      : n >= 1e3
        ? `${Math.round(n / 1e3)} KB`
        : `${n} B`

/** A machine is what its size says: the same cores, memory within a tenth. */
const matches = (cores: number, memory: number, d: Declared): boolean =>
  cores === d.cpu && Math.abs(memory - d.memory) <= d.memory * 0.1

/** Bytes as whole gigabytes, one decimal under 10: `16G`, `0.5G`. */
const compact = (n: number): string => {
  const g = n / 1e9
  return `${g >= 10 ? Math.round(g) : Number(g.toFixed(1))}G`
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

/** The probes a task's key folds: a worker that answers otherwise fails it (C-2). */
function runtimeOrders(req: ExecuteRequest): { runtime?: RuntimeOrder[] } {
  const inputs = req.inputs
  if (inputs === undefined) return {}
  const runtime: RuntimeOrder[] = [
    ...inputs.runtime.map((r) => ({ command: r.command, output: r.output })),
    ...inputs.workspaceRuntime.map((r) => ({
      command: r.command,
      output: r.output,
      workspace: true as const,
    })),
  ]
  return runtime.length === 0 ? {} : { runtime }
}

/** `env` without its unset names, as it travels. */
function defined(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v
  return out
}
