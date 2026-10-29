// The orchestrator's half of a distributed run: the `vx run` the user
// started. It runs no task itself (only hits restore here) and hands
// every task to the workers online, critical path first (the order core asks in):
// each task to a worker it fits now, by the load that worker last reported
// and what was sent since, preferring the worker that already holds the
// task's dependencies; none waits in a worker's queue. No file travels through the relay: an
// worker restores a dependency's files from the cache by the key its order
// names and saves its own under the task's key, and this machine restores
// them by that key before the task ends, so the run saves and reports it
// as its own.

import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import {
  ui,
  UserError,
  withForwardArgs,
  type CacheFacts,
  type CapturedChunk,
  type ExecuteRequest,
  type ExecuteResult,
  type MachineReport,
  type SandboxConfig,
  type TaskArtifacts,
  type TaskNode,
} from '@vzn/vx'
import {
  bytesOf,
  HELD_EVERY,
  HOST_ENV,
  PART_LISTS,
  type PartList,
  type WorkerInfo,
  type DepOrder,
  type RunOrder,
  type RuntimeOrder,
  type ToWorker,
  type Load,
  type ToOrchestrator,
  type WiredResult,
} from './messages.js'
import { simulate, type PlanTask, type PlanWorker, type Size, type WarmUp } from './planner.js'
import { Usage, type UsageStats } from './usage.js'
import { assign, ordered, type Need } from './dispatch.js'
import { DEFAULT_STRATEGY, type Strategy } from './strategy.js'
import { RelayError, unsent, type Participant } from './wire.js'
import { ORCHESTRATOR, Trace } from './trace.js'
import { names } from './outputs.js'

/** What a task is expected to hold while it runs, from its history; `Infinity`: a whole worker (one that filled its worker). */

interface Job {
  readonly req: ExecuteRequest
  readonly need: Need
  /** The cores and memory it holds on its worker: its need, or the whole worker for one that filled its worker. */
  held?: Need
  readonly resolve: (r: ExecuteResult) => void
  readonly reject: (err: unknown) => void
  worker?: string
  /** When it last joined the run's queue. */
  queuedAt?: number
  /** The cores its worker booked for it. */
  booked?: number
  /** The workers that failed it after beginning it, with why: two fail it. */
  faults?: string[]
  /** Its worker's lease on it ends then unless the worker says it still holds it. */
  leaseUntil?: number
  /** When it was sent to its worker. */
  sentAt?: number
  /** When its worker began it. */
  startedAt?: number
  /** When its worker said its command ended: it saves since. */
  ranAt?: number
  /** When it first waited on the worker holding an upstream's files (`kept`). */
  pinnedAt?: number
  /** Its upstreams already ran again for it: it waits on their worker however long. */
  fellBack?: true
  /** An uncached task run again for a dependant (`kept`): its result is the run's alone. */
  again?: { readonly only?: string; readonly avoid?: string }
  /** Its upstreams, once the graph named it: walked again at every pump, 8000 queued spent 5 ms a pump on it (2026-10-25). */
  up?: Set<string>
}

/** The longest a task waits on the worker holding its upstream's files before they are made again (2026-10-23: 10 s on any wait). */
const PIN_WAIT_MS = 10_000

/** No task began or ended this long: the run says what it waits on, each time again. */
const STALL_MS = 60_000

interface Worker {
  readonly id: string
  /** What the run gives it: its machine, held to its declared size. */
  readonly cores: number
  readonly memory: number
  /** What its machine has, as it reported on joining. */
  readonly reported: { readonly cores: number; readonly memory: number }
  /** Its machine's platform, as it reported on joining. */
  readonly platform: string | undefined
  readonly label: string
  /** From its start to its join, when this run started it. */
  readonly warmUpMs: number | undefined
  /** The size it was started as, when this run started it. */
  readonly declared: Declared | undefined
  /** Tasks it finished. */
  ran: number
  /** Their ids, for the summary of a worker that ran few: what held it. */
  readonly done: string[]
  readonly usage: Usage
  /** Sent to it and not finished: running there or in its queue. */
  readonly busy: Map<string, Job>
  /** Of `busy`, the ones it began. */
  readonly started: Set<string>
  usedCores: number
  usedMemory: number
  /** Its machine's use as its last frame said, and when this machine heard it. */
  load?: { cpu: number; memory: number; at: number }
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
  /** Its size's platform: a worker reporting another is refused. */
  readonly platform?: string
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
  /**
   * Sends of each task under `run`, kept by whoever outlives this run:
   * `vx watch` runs again under one run id, and a send counted from 0
   * again took the last run's run key (2026-10-24).
   */
  readonly sent?: Map<string, number>
  /** A task's cache key, once the run computed it (a hit's too); undefined when it has none. */
  readonly keyOf: (taskId: string) => string | undefined
  /** Worker `id` (its label) was lost, or never started: room for another. */
  readonly lost?: (id: string) => void
  /** A worker joined: the run plans again. */
  readonly joined?: () => void
  /** Worker `id` did not join within twice its size's first join: given up, for its adapter to stop. */
  readonly overdue?: (id: string) => void
  /** A worker failed a task or its lease: the run plans again, now, so a replacement starts. */
  readonly faulted?: () => void
  /** How much of the run waits on a task (`tailsMs`): the queue places the most first. */
  readonly tail?: (taskId: string) => number
  /** How waiting tasks are ordered and placed (`Strategy`). */
  readonly how?: Strategy
  /** The platform a task naming none runs on (`homeOf`). */
  readonly home?: string | undefined
  /** No task began or ended for `stallMs`: what the run waits on, one line a task. */
  readonly stalled?: (waiting: string) => void
  /** A fault the run works around (a message the relay would not take); default stderr. */
  readonly warn?: (message: string) => void
  /** Default `STALL_MS`. */
  readonly stallMs?: number
  /** How long a task waits on the worker holding its upstream's files (`PIN_WAIT_MS`). */
  readonly pinWaitMs?: number
}

/**
 * Lent tokens are asked again this long before they end: inside the
 * window a remote exchanges a new one (turboCache's is five minutes).
 */
const RELEND_MS = 4 * 60_000
/**
 * A lent token already inside that window is lent again no sooner: one
 * lent as it ended relent at once, in a loop (vx-cache, 2026-10-25).
 */
const RELEND_FLOOR_MS = 30_000

/**
 * A batch's orders past this go in another: the relay takes a body of
 * 1 MiB at most, and sealing it grows it by a third.
 */
const BATCH_BYTES = 512 * 1024
/** A worker that ran this many tasks or fewer names them in the summary. */
const FEW = 2
/** The unmeasured tasks the summary names; the rest it counts. */
const NAMED = 40
/** Core-time of history the run's tasks finish before their use reshapes bookings: a few tasks' worth. */
const LEARN_MS = 60_000
/** The most a worker's bookings may add up to, in its cores, when tasks use less than their history. */
const OVERBOOK = 1.5
/** Failed starts the run replaces before it calls its setup broken. */
const RESTARTS = 3

/** `orders` in runs of at most `max` bytes of JSON; one bigger goes alone. */
function parts<T extends { order: unknown }>(orders: readonly T[], max: number): T[][] {
  const out: T[][] = []
  let part: T[] = []
  let bytes = 0
  for (const o of orders) {
    const size = bytesOf(o.order)
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

/** `items` in runs of at most `max` bytes of JSON. */
function chunks<T>(items: readonly T[], max: number): T[][] {
  const out: T[][] = []
  let piece: T[] = []
  let bytes = 0
  for (const item of items) {
    const size = bytesOf(item) + 1
    if (piece.length > 0 && bytes + size > max) {
      out.push(piece)
      piece = []
      bytes = 0
    }
    piece.push(item)
    bytes += size
  }
  if (piece.length > 0) out.push(piece)
  return out
}

/** A task's end when its run stopped it before it began anywhere. */
const stopped = (): ExecuteResult => result({ exitCode: 130, signal: 'SIGTERM', durationMs: 0 }, [])

export class Orchestrator {
  private readonly workers = new Map<string, Worker>()
  /** The run tree's files, workspace-relative, listed when a task first asks. */
  private inTree?: Promise<Tree | undefined>
  private readonly queue: Job[] = []
  /** Where a worker saved each task it ran: its cache key or its run key. */
  private readonly savedAs = new Map<string, string>()
  /** Keys the run's requests named for their dependencies. */
  private readonly upstreamKeys = new Map<string, string>()
  /** How many times each task was sent: its run key is one per send. */
  private readonly sent: Map<string, number>
  /** Each hit's key, once on a remote a worker reads (`TaskArtifacts.share`). */
  private readonly shared = new Map<string, Promise<boolean>>()
  /** Keys a worker could not read, sent again over the remotes' copy: once each. */
  private readonly resent = new Set<string>()
  /** When each worker this run started was asked for, by `WorkerSpawn.index`. */
  private readonly spawnedAt = new Map<string, { at: number; declared: Declared }>()
  private ended = false
  /**
   * How long a worker of a size may take to join: twice the first of its
   * size that did (2026-10-23: "we learn that from first we get, and
   * double its time"). Unknown until one joins, so no wait before.
   */
  private readonly joinLimitMs = new Map<string, number>()
  private endedAt = 0
  /** A long result's lists, by worker and task, until its `end` comes. */
  private readonly parts = new Map<string, Partial<Record<PartList, unknown[]>>>()
  /** Workers that joined and left, for the footer. */
  private readonly gone: Worker[] = []
  /** Of `gone`, those the run let go (`release`), not lost. */
  private readonly retired = new Set<Worker>()
  /** Workers asked for that never joined, with why. */
  private readonly unstarted = new Map<string, string>()
  /** Started, then not needed before they joined (`release`), or given up as late. */
  private readonly cancelled = new Set<string>()
  /** Of `cancelled`, those given up past their join limit, not let go: taken if they join. */
  private readonly late = new Set<string>()
  /** A failed start was given another worker (`failed`). */
  private restarts = 0
  /**
   * Each uncached task a worker ran: its files are there alone, so its
   * dependants go there (2026-10-25). An uncached task declares no
   * outputs, and a dependant elsewhere did not find them (#4407).
   */
  private readonly kept = new Map<string, { worker: string; req: ExecuteRequest; need: Need }>()
  /** Of `kept`, those running again for a dependant. */
  private readonly remaking = new Set<string>()
  /** Of `kept`, those that failed running again: their dependants fail, saying why. */
  private readonly unmade = new Map<string, string>()
  /** The tasks core's probe found in no cache (`demand`): a worker uploads theirs asking nothing first. */
  missed: ReadonlySet<string> = new Set()
  private pumping = false
  private joined = 0
  private readonly startedAt = performance.now()
  /** The run in time, for `--profile` (`profile`). */
  readonly trace = new Trace()
  /** When a task last began, ended or faulted, or the run last said it waits. */
  private movedAt = performance.now()
  /** When core's cache probe answered, how many placed tasks it left to run, and how many it found in no cache. */
  private probe?: { at: number; left: number; misses: number }
  /** Each task a worker ran: how long it held the worker, the cores it used meanwhile, its memory, the platform. */
  private readonly took = new Map<
    string,
    { ms: number; cores: number; memory: number; platform: string | undefined }
  >()
  /** Each time the run asked for workers: when, how many, for which work, ending when. */
  private readonly asks: {
    at: number
    workers: number
    tasks: number
    measured: number
    endsInMs: number
  }[] = []
  /**
   * The tasks the first ask had no measure of, each booking a guess:
   * named, so a run that packed badly says which (main 68b851d, 2026-10-23:
   * 41 of 119, small#7 holding 3.9 cores for a task using 0.3).
   */
  private unmeasured: readonly string[] = []
  /**
   * Core-time measured tasks used here, and what their history said they
   * would: tasks booked at their history used 82% of it on every Linux
   * worker of cold run 3 (66% of the cores against the sim's 86%,
   * 2026-10-23). A measured task books its need times what they used.
   */
  private usedMs = 0
  private needMs = 0
  private readonly stop = new AbortController()
  private readonly loop: Promise<void>
  private readonly realRoot: string
  /** What workers read the cache under, asked once and again before its lent tokens end. */
  private facts: Promise<CacheFacts> | undefined
  private relend: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly o: OrchestratorOptions) {
    this.sent = o.sent ?? new Map()
    // A root that is gone fails the run's own reads first.
    this.realRoot = (() => {
      try {
        return realpathSync(o.root)
        // quiet: a root that is gone fails the run's own reads first
      } catch {
        return o.root
      }
    })()
    // Leases ran on while either side was away, as a relay restarted: what
    // a worker holds is still its own, not run again elsewhere
    // (2026-10-25: "make sure on rejoin we don't repeat work").
    o.me.resumed((peer) => {
      for (const a of this.workers.values())
        if (peer === undefined || a.id === peer)
          for (const j of a.busy.values()) if (j.leaseUntil !== undefined) this.lease(j)
    })
    this.loop = this.listen()
  }

  async execute(req: ExecuteRequest): Promise<ExecuteResult> {
    if (this.lost !== undefined) throw new Error(this.lost)
    // A worker runs the run's tree: a file its key includes that the tree
    // lacks (untracked) is not there, and the output it saved under that
    // key was a stale hit for the next run (2026-10-24).
    if (req.inputs !== undefined && req.inputs.files.length > 0) {
      this.inTree ??= listTree(this.o.root, this.o.tree)
      const tree = await this.inTree
      // A dependency's output is restored there before the task runs: a
      // key that reads an upstream's bytes (`inputs.tasks` leaving it out)
      // was refused (2026-10-25).
      const nodes = this.o.nodes()
      const restored = [...upstream(nodes, req.taskId)].flatMap((id) => {
        const n = nodes?.get(id)
        const outs = n?.config.cache?.outputs
        return n === undefined || outs === undefined
          ? []
          : [
              names(path.relative(this.o.root, n.projectDir), {
                files: outs.files,
                workspaceFiles: outs.workspaceFiles ?? [],
              }),
            ]
      })
      const stray =
        tree === undefined
          ? undefined
          : req.inputs.files.find(
              (f) => !tree.files.has(f.path) && !restored.some((made) => made(f.path)),
            )
      if (stray !== undefined) {
        // A committed submodule's files are not the tree's: its gitlink is.
        const link = tree?.links.find((l) => stray.path.startsWith(`${l}/`))
        throw new UserError(
          link === undefined
            ? `${req.taskId} keys ${stray.path}, which is not in the commit workers check out: commit it, or leave it out of the task's inputs`
            : `${req.taskId} keys ${stray.path}, in submodule ${link}, whose files workers do not check out: leave it out of the task's inputs`,
        )
      }
    }
    for (const u of req.inputs?.upstream ?? []) this.upstreamKeys.set(u.taskId, u.hash)
    await this.share(req.taskId)
    return new Promise((resolve, reject) => {
      const need = this.o.need(req.taskId)
      const job: Job = {
        req,
        need: { ...need, platform: req.platform ?? this.o.home },
        queuedAt: performance.now(),
        resolve,
        reject,
      }
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
          f.expiresAt - Date.now() > RELEND_MS
            ? f.expiresAt - Date.now() - RELEND_MS
            : RELEND_FLOOR_MS,
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
    for (const a of this.workers.values()) this.trace.left(a.label, 'stopped', this.endedAt)
  }

  /** The run's trace events (`TaskExecutor.profile`), once it had workers. */
  profile(): Record<string, unknown>[] {
    if (this.spawnedAt.size + this.workers.size + this.gone.length === 0) return []
    return this.trace.events(this.ended ? this.endedAt : performance.now())
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
    const how = this.o.how ?? DEFAULT_STRATEGY
    const waiting = this.queue.splice(0)
    const workers = [...this.workers.values()].filter((a) => !a.faulty)
    const byId = new Map(waiting.map((j) => [j.req.taskId, j]))
    const queue =
      tail === undefined
        ? waiting
        : ordered(
            waiting.map((j) => j.req.taskId),
            how.order,
            tail,
            (id) => byId.get(id)!.need,
            Math.max(1, ...workers.map((a) => a.cores)),
          ).map((id) => byId.get(id)!)
    const bins = workers.map((a) => {
      let running = 0
      for (const j of a.busy.values()) if (j.held !== undefined) running++
      return {
        id: a.id,
        cores: a.cores,
        memory: a.memory,
        used: this.used(a),
        running,
        has: a.has,
        platform: a.platform,
        a,
      }
    })
    const nodes = this.o.nodes()
    const asks = []
    const placed: Job[] = []
    // The least any ask needs: once no worker takes it, the pass ends. Each
    // pump read every queued task, 8000 of them a pump (2026-10-25).
    const floor = { cores: Infinity, memory: Infinity }
    for (const job of queue) {
      const up =
        job.up ??
        (nodes?.has(job.req.taskId) === true
          ? (job.up = upstream(nodes, job.req.taskId))
          : upstream(nodes, job.req.taskId))
      const pin = this.pin(job, up)
      if (pin === 'done') continue
      if (pin === 'wait') {
        left.push(job)
        continue
      }
      placed.push(job)
      const need = this.booking(job.need)
      floor.cores = Math.min(floor.cores, need.cores)
      floor.memory = Math.min(floor.memory, need.memory)
      asks.push({ id: job.req.taskId, need, up, ...pin })
    }
    const to = assign(asks, bins, (above) => this.bigger(above), how.place, {
      floor,
      kinds: Infinity,
    })
    for (const job of placed) {
      const a = to.get(job.req.taskId)?.a
      if (a === undefined) {
        left.push(job)
        continue
      }
      job.worker = a.id
      job.sentAt = performance.now()
      a.busy.set(job.req.taskId, job)
      job.held = {
        cores: Math.min(this.booking(job.need).cores, a.cores),
        memory: Math.min(job.need.memory, a.memory),
      }
      job.booked = job.held.cores
      this.trace.slice({
        track: ORCHESTRATOR,
        name: job.req.taskId,
        cat: 'queue',
        from: job.queuedAt ?? job.sentAt,
        to: job.sentAt,
        args: { to: a.label },
      })
      a.usedCores += job.held.cores
      a.usedMemory += job.held.memory
      const batch = batches.get(a)
      if (batch === undefined) batches.set(a, [job])
      else batch.push(job)
    }
    this.queue.push(...left)
    for (const [a, jobs] of batches) this.send(a, jobs)
  }

  /**
   * Where `job` may go, as its upstreams' files no cache holds lie (`kept`):
   * on the worker holding them, waiting there up to `PIN_WAIT_MS`. Past
   * that, with that worker gone, or with them on more than one, each
   * upstream not on the worker holding most runs again where the job may
   * go, and the job waits for it. `'wait'`: not yet; `'done'`: it failed.
   */
  private pin(
    job: Job,
    up: ReadonlySet<string>,
  ): 'wait' | 'done' | { only?: string; avoid?: string } {
    if (job.again !== undefined) {
      const { only } = job.again
      const waited = performance.now() - (job.pinnedAt ?? performance.now())
      const there = only === undefined || this.workers.get(only)?.faulty === false
      return there && waited < this.pinWaitMs ? job.again : {}
    }
    // Nothing kept or made again: no upstream can pin it.
    if (this.kept.size === 0 && this.remaking.size === 0 && this.unmade.size === 0) return {}
    const held = new Map<string, string[]>()
    for (const id of up) {
      const why = this.unmade.get(id)
      if (why !== undefined) {
        job.resolve(result({ exitCode: 1, durationMs: 0 }, [{ text: `${why}\n`, err: true }]))
        return 'done'
      }
      if (this.remaking.has(id)) return 'wait'
      const k = this.kept.get(id)
      if (k === undefined) continue
      const on = held.get(k.worker)
      if (on === undefined) held.set(k.worker, [id])
      else on.push(id)
    }
    if (held.size === 0) return {}
    const now = performance.now()
    if (job.pinnedAt === undefined) {
      job.pinnedAt = now
      setTimeout(() => this.pumpSoon(), this.pinWaitMs + 50).unref?.()
    }
    // A worker of another platform cannot take it: they run again on one that can.
    const platform = job.need.platform
    const live = [...held].filter(([w]) => {
      const a = this.workers.get(w)
      return a?.faulty === false && (platform === undefined || a.platform === platform)
    })
    live.sort((x, y) => y[1].length - x[1].length)
    const target = live[0]?.[0]
    if (target !== undefined && held.size === 1) {
      if (job.fellBack === true || now - job.pinnedAt < this.pinWaitMs) return { only: target }
      // Its worker stayed full: they run again on another, and it follows.
      this.remake(held.get(target)!, { avoid: target })
    } else
      for (const [w, ids] of held)
        if (w !== target) this.remake(ids, target === undefined ? { platform } : { only: target })
    job.fellBack = true
    delete job.pinnedAt
    return 'wait'
  }

  private get pinWaitMs(): number {
    return this.o.pinWaitMs ?? PIN_WAIT_MS
  }

  /** `ids`, uncached tasks that ran, run again where `where` says, for a dependant. */
  private remake(
    ids: readonly string[],
    where: { only?: string; avoid?: string; platform?: string | undefined },
  ): void {
    for (const id of ids) {
      const k = this.kept.get(id)
      if (k === undefined || this.remaking.has(id)) continue
      this.remaking.add(id)
      this.kept.delete(id)
      const done = (why: string | undefined): void => {
        this.remaking.delete(id)
        if (why !== undefined) this.unmade.set(id, why)
        this.pumpSoon()
      }
      this.pumpSoon()
      this.queue.unshift({
        req: k.req,
        need: where.platform === undefined ? k.need : { ...k.need, platform: where.platform },
        queuedAt: performance.now(),
        pinnedAt: performance.now(),
        again: {
          ...(where.only === undefined ? {} : { only: where.only }),
          ...(where.avoid === undefined ? {} : { avoid: where.avoid }),
        },
        resolve: (r) =>
          done(
            r.exitCode === 0 ? undefined : `${id} ran again for it and failed (exit ${r.exitCode})`,
          ),
        reject: (err) =>
          done(
            `${id} ran again for it and failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
      })
      if (where.only !== undefined || where.avoid !== undefined)
        setTimeout(() => this.pumpSoon(), this.pinWaitMs + 50).unref?.()
    }
  }

  /**
   * What worker `a` has in use: what the run booked there, or more when
   * its last load and what was sent since say more. Never less: load lags
   * a task's start, so placing below the booking sent small#3 38 test
   * shards on 4 cores at once, 28 failed (main bf77a58, 2026-10-23).
   */
  private used(a: Worker): { cores: number; memory: number } {
    const booked = { cores: a.usedCores, memory: a.usedMemory }
    const l = a.load
    if (l === undefined || a.cores !== a.reported.cores) return booked
    let cores = l.cpu
    let memory = l.memory
    for (const j of a.busy.values())
      if (j.held !== undefined && (j.sentAt ?? 0) > l.at) {
        cores += j.held.cores
        memory += j.held.memory
      }
    return { cores: Math.max(booked.cores, cores), memory: Math.max(booked.memory, memory) }
  }

  /** Whether a task of `a`'s holds its cores: its command still runs, or has yet to. */
  private holding(a: Worker): boolean {
    for (const j of a.busy.values()) if (j.held !== undefined) return true
    return false
  }

  /**
   * What a task books: a measured one its need times the share of their
   * history the run's tasks used, once they used `LEARN_MS` of it, and
   * never under `1 / OVERBOOK` of its need. An unmeasured one (`ask`)
   * books what it books.
   */
  booking(need: Need): Need {
    if (need.cores === Infinity || need.ask !== undefined || this.needMs < LEARN_MS) return need
    const used = Math.min(1, Math.max(1 / OVERBOOK, this.usedMs / this.needMs))
    return { ...need, cores: need.cores * used }
  }

  /**
   * `job`'s cores and memory go back to its worker, once: its command
   * ended, or it left. Its worker's last load counted it busy, and its
   * save: kept, a Mac read 2.9 cores busy with one 1.1-core task left and
   * the next task waited for the next frame (main 2975e38, 2026-10-24).
   */
  private unhold(a: Worker, job: Job): void {
    delete a.load
    if (job.held === undefined) return
    a.usedCores -= job.held.cores
    a.usedMemory -= job.held.memory
    if (a.started.has(job.req.taskId)) a.usage.book(-job.held.cores)
    delete job.held
  }

  /** What a frame of `a`'s says its machine uses now. */
  private heard(a: Worker, load: Load | undefined): void {
    if (load === undefined) return
    a.load = { cpu: Number(load.cpu) || 0, memory: Number(load.memory) || 0, at: performance.now() }
    const avg = Number(load.avg)
    if (Number.isFinite(avg) && avg >= 0) a.usage.machineAvg = avg
    const tasks = Number(load.tasks)
    this.trace.load(a.label, a.load.cpu, a.load.at, Number.isFinite(tasks) ? tasks : undefined)
  }

  /** Whether a worker bigger than `above` is starting: a task that filled that size waits for it. */
  private bigger(above: { readonly cores: number; readonly memory: number }): boolean {
    const joined = new Set([...this.workers.values(), ...this.gone].map((x) => x.label))
    for (const [id, { declared }] of this.spawnedAt)
      if (
        !joined.has(id) &&
        !this.unstarted.has(id) &&
        !this.cancelled.has(id) &&
        (declared.cpu > above.cores || declared.memory > above.memory)
      )
        return true
    return false
  }

  /**
   * This send's number for `task`. A remote keeps the first bytes put
   * under a key, as this machine's store keeps the ones it restored: a
   * retry saved under its first attempt's run key restored that failure's
   * files and output under a green result (2026-10-24).
   */
  private sends(task: string): number {
    const n = this.sent.get(task) ?? 0
    this.sent.set(task, n + 1)
    return n
  }

  /**
   * Each dependency of `id` this machine restored, a hit no worker ran, put
   * on a remote the workers read: a worker reads the remotes alone, and a
   * hit only this cache held (the remote evicted it, or this machine does
   * not write it) failed the dependant there (2026-10-24).
   */
  private async share(id: string): Promise<void> {
    const nodes = this.o.nodes()
    const keys: string[] = []
    for (const d of upstream(nodes, id)) {
      if (this.savedAs.has(d) || nodes?.get(d)?.config.cache?.outputs === undefined) continue
      const key = this.upstreamKeys.get(d) ?? this.o.keyOf(d)
      if (key !== undefined) keys.push(key)
    }
    await Promise.all(
      keys.map((k) => {
        let got = this.shared.get(k)
        if (got === undefined) {
          // quiet: a key no remote took fails on the worker, by name
          got = this.o.artifacts.share(k).catch(() => false)
          this.shared.set(k, got)
        }
        return got
      }),
    )
  }

  /** True when one of `keys` not sent again before reached a remote. */
  private async resend(keys: readonly string[]): Promise<boolean> {
    const fresh = keys.filter((k) => typeof k === 'string' && !this.resent.has(k))
    for (const k of fresh) this.resent.add(k)
    // quiet: a key no remote took fails the task, by name
    const got = await Promise.all(fresh.map((k) => this.o.artifacts.resend(k).catch(() => false)))
    return got.includes(true)
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
      const env = defined(req.env, req.envDefine)
      return {
        job,
        order: {
          task: req.taskId,
          // Unsaved: under the run's own key, as an uncached task's.
          ...(req.cacheKey === undefined || req.unsaved === true ? {} : { key: req.cacheKey }),
          runKey: runKey(this.o.run, req.taskId, this.sends(req.taskId)),
          // A held key keeps its entry, and restored here it replaced the
          // forced run's fresh bytes with the ones it bypassed (2026-10-25).
          ...(req.refresh === true ? { fresh: true as const } : {}),
          // A HEAD per upload was the workers' only remote probe: the run
          // already knows the key is in no cache (2026-10-25).
          ...(req.refresh !== true && this.missed.has(req.taskId) ? { absent: true as const } : {}),
          deps,
          nested: node === undefined ? [] : nestedIn(nodes!, node.projectDir, this.o.root),
          command: withForwardArgs(req.command, req.forwardArgs),
          cwd: path.relative(this.o.root, req.cwd),
          project: node === undefined ? '' : path.relative(this.o.root, node.projectDir),
          env,
          ...(node?.config.exec?.env?.secret === undefined
            ? {}
            : { secret: [...node.config.exec.env.secret] }),
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
                  env: defined(s.env, {}),
                  ...(s.readyWhen === undefined ? {} : { readyWhen: s.readyWhen }),
                  ...(s.timeoutMs === undefined ? {} : { timeoutMs: s.timeoutMs }),
                  ...(s.sandbox === undefined
                    ? {}
                    : {
                        sandbox: {
                          config: s.sandbox.config,
                          nested: s.sandbox.nested.map((d) => path.relative(this.o.root, d)),
                        },
                      }),
                })),
              }),
        } as RunOrder,
      }
    })
    const sandboxed = orders.some(
      (o) => o.order.sandbox !== undefined || o.order.servers?.some((s) => s.sandbox !== undefined),
    )
    const sandboxes = sandboxed && !a.sandboxes ? sandboxConfigs(nodes) : undefined
    if (sandboxed) a.sandboxes = true
    a.chain = a.chain
      .then(async () => {
        for (const [i, part] of parts(orders, BATCH_BYTES).entries()) {
          // An order too long for a frame (a task of thousands of
          // dependencies was refused, 413) sends its deps ahead.
          const tasks: RunOrder[] = []
          for (const { order } of part) {
            if (bytesOf(order) <= BATCH_BYTES) {
              tasks.push(order)
              continue
            }
            for (const deps of chunks(order.deps, BATCH_BYTES)) {
              const ahead = { type: 'deps', task: order.task, deps } satisfies ToWorker
              await this.o.me.send(a.id, ahead)
              a.usage.messagesIn++
              a.usage.bytesIn += bytesOf(ahead)
            }
            tasks.push({ ...order, deps: [] })
          }
          const batch = {
            type: 'batch',
            root: this.o.root,
            realRoot: this.realRoot,
            tasks,
            ...(sandboxes === undefined || i > 0 ? {} : { sandboxes }),
          } satisfies ToWorker
          await this.o.me.send(a.id, batch)
          a.usage.messagesIn++
          a.usage.bytesIn += bytesOf(batch)
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
    const now = performance.now()
    this.trace.slice({
      track: a.label,
      name: job.req.taskId,
      cat: 'task',
      from: job.sentAt ?? now,
      to: now,
      args: { failed: why },
    })
    job.queuedAt = now
    a.busy.delete(job.req.taskId)
    // Its outputs are not there to place a dependant by.
    a.has.delete(job.req.taskId)
    this.unhold(a, job)
    delete job.worker
    delete job.leaseUntil
    delete job.sentAt
    delete job.ranAt
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

  /**
   * Nothing began or ended for `STALL_MS`: each task a worker holds, and
   * whether it runs or saves. Main 32f73ed sat 13 min saying nothing
   * (2026-10-23).
   */
  private stall(): void {
    const now = performance.now()
    if (now - this.movedAt < (this.o.stallMs ?? STALL_MS)) return
    const lines: string[] = []
    for (const a of this.workers.values())
      for (const j of a.busy.values()) {
        const s = (t: number | undefined) => `${Math.round((now - (t ?? now)) / 1000)} s`
        lines.push(
          j.ranAt !== undefined
            ? `${j.req.taskId} on ${a.label}: saving its outputs for ${s(j.ranAt)}`
            : a.started.has(j.req.taskId)
              ? `${j.req.taskId} on ${a.label}: running for ${s(j.startedAt)}`
              : `${j.req.taskId} sent to ${a.label} ${s(j.sentAt)} ago, not begun`,
        )
      }
    if (lines.length === 0) return
    this.movedAt = now
    this.trace.mark(ORCHESTRATOR, 'stalled', { waiting: lines })
    this.o.stalled?.(lines.join('\n'))
  }

  /** Each task whose worker's lease on it ended goes back. */
  private expire(): void {
    // With no socket no `held` arrives: the leases wait for it (`resumed`).
    if (!this.o.me.online) return
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
    this.o.faulted?.()
    if (this.spawnedAt.size > 0) this.stranded(`a task's lease ended and no worker is left`)
    this.pumpSoon()
  }

  private post(a: Worker, m: ToWorker): void {
    a.chain = a.chain.then(() => this.o.me.send(a.id, m)).catch(this.unsent(m.type, a.label))
  }

  private unsent(what: string, to: string): (err: unknown) => void {
    return unsent(this.o.warn ?? ((m) => void process.stderr.write(`[vx] ${m}\n`)), what, to)
  }

  /** Worker `a` began `task`: from now its cores are booked. */
  private begun(a: Worker, task: string): void {
    const job = a.busy.get(task)
    if (job === undefined || a.started.has(task)) return
    a.started.add(task)
    job.startedAt = performance.now()
    a.usage.book(job.held?.cores ?? 0)
  }

  /** Worker `a` ran `task` and saved it under `key`: it is done there, and done here once restored. */
  private async finish(a: Worker, task: string, key: string, head: WiredResult): Promise<void> {
    const job = a.busy.get(task)
    if (job === undefined) return
    // A dependency's remote copy did not read back there (a truncated
    // upload): sent again from this machine, the task runs again. Taken as
    // the task's failure, it failed every run, the remote saying it held the
    // key (2026-10-25).
    if (head.unread !== undefined && (await this.resend(head.unread)) && a.busy.get(task) === job) {
      // Its cores back while it still counts as begun, which `unhold` reads;
      // then not begun, so `retry` holds no fault against its worker.
      this.unhold(a, job)
      a.started.delete(task)
      const again = this.retry(a, job, `could not read ${head.unread.join(', ')}`)
      if (again !== undefined) {
        this.queue.unshift(again)
        this.pumpSoon()
      }
      return
    }
    const endAt = performance.now()
    this.traceTask(a, job, head, endAt)
    a.busy.delete(task)
    this.unhold(a, job)
    a.started.delete(task)
    a.ran++
    a.done.push(task)
    a.usage.record(head, job.sentAt)
    const share = shareOf(head.cpuShare)
    const held = Math.max(1, job.startedAt === undefined ? head.durationMs : endAt - job.startedAt)
    this.took.set(task, {
      ms: held,
      cores:
        head.cpuMs === undefined
          ? (job.held?.cores ?? 1)
          : // The cores it used over the time it held: its free cores over
            // its crowded length counted the crowd twice (6a7224f: ideal
            // 127.8 s, real 111.0 s).
            Math.min(a.cores, head.cpuMs / held),
      memory: head.peakRssBytes ?? job.held?.memory ?? 0,
      platform: a.platform,
    })
    if (
      job.need.cores !== Infinity &&
      job.need.ask === undefined &&
      head.cpuMs !== undefined &&
      head.exitCode === 0
    ) {
      const ms = Math.max(1, head.durationMs)
      // What it would have used with a core free: on a crowded worker its
      // share only, and booking the next tasks by that packed them tighter.
      this.usedMs += Math.min(head.cpuMs / share, a.cores * ms)
      this.needMs += Math.min(job.need.cores, a.cores) * ms
    }
    this.savedAs.set(task, key)
    const node = this.o.nodes()?.get(task)
    // No remote took its upload (too big, a 429): its files are there
    // alone, as an uncached task's are, and its output came with its `end`.
    const unshared = head.unshared === true
    if (head.exitCode === 0 && (unshared || (node !== undefined && leaves(node))))
      this.kept.set(task, { worker: a.id, req: job.req, need: job.need })
    this.pumpSoon()
    if (job.again !== undefined) return job.resolve(result(head, []))
    const restore = () =>
      this.o.artifacts.restore(key, {
        id: task,
        projectDir: node?.projectDir ?? job.req.cwd,
        command: job.req.command,
        outputs: job.req.outputs,
      })
    // A remote-only task's files stay off this disk: an install's
    // node_modules laid over this machine's own (schema: `'only'`). A
    // deferred one's land only if a task here needs them: under
    // `--cache-download=none` every file of the run came home (2026-10-24).
    const deferred = job.req.remoteOnly !== true && job.req.download === 'deferred'
    const read = () =>
      job.req.remoteOnly === true || deferred ? this.o.artifacts.output(key) : restore()
    const log = await (
      unshared
        ? Promise.resolve(wiredLog(head.output))
        : // A failed download reads as a miss: asked once more, since one
          // stalled download failed a CI run whose upload had landed
          // (main, 2026-10-28).
          read().then((got) => got ?? read())
    ).catch((err: unknown) => {
      job.reject(err)
      return undefined
    })
    this.trace.slice({
      track: ORCHESTRATOR,
      name: task,
      cat: 'restore',
      from: endAt,
      to: performance.now(),
    })
    if (log === undefined) return
    if (log === null) {
      job.reject(
        new Error(
          `${task}: ${a.label} ran it, and no cache this machine reads gave its entry, asked twice: a download failed (warned above), ${a.label}'s upload failed (its log says why), or the workers and this machine share no remote cache the workers write`,
        ),
      )
      return
    }
    // An upstream's file the task removed there is gone here too: a restore
    // lays files, never removes one, and this disk is what core saves from.
    if (head.removed !== undefined && job.req.remoteOnly !== true && !deferred && !unshared) {
      const ours = names(
        path.relative(this.o.root, node?.projectDir ?? job.req.cwd),
        job.req.outputs,
      )
      for (const f of head.removed)
        if (typeof f === 'string' && !f.split('/').includes('..') && ours(f))
          await rm(path.join(this.o.root, f), { force: true })
    }
    // In the order the task wrote it: replayed a stream at a time, an error
    // line came after the stdout that followed it (2026-10-25).
    for (const c of log) (c.err ? job.req.onStderr : job.req.onStdout)(c.text)
    job.resolve({
      ...result(head, log),
      ...(unshared
        ? {
            outputs: {
              kind: 'deferred' as const,
              materialize: () =>
                Promise.reject(
                  new UserError(
                    `${task}: its files are on ${a.label} alone: no remote cache took its upload (its log says why)`,
                  ),
                ),
            },
          }
        : deferred
          ? {
              outputs: {
                kind: 'deferred' as const,
                materialize: async () => {
                  if ((await restore()) === null)
                    throw new Error(`${task}'s entry ${key} is in no cache this machine reads`)
                },
              },
            }
          : {}),
      where: a.label,
      machine: {
        cores: a.reported.cores,
        memoryBytes: a.reported.memory,
        ...(share < 1 ? { cpuShare: share } : {}),
      },
    })
  }

  /**
   * Task `job` ended on `a` at `endAt`: one slice from its send, in its
   * parts (sent, restoring its dependencies, its command, saving), and
   * the cores it booked there and used.
   */
  private traceTask(a: Worker, job: Job, head: WiredResult, endAt: number): void {
    const sent = job.sentAt ?? endAt
    const began = Math.max(sent, job.startedAt ?? sent)
    const ran = Math.min(endAt, Math.max(began, job.ranAt ?? endAt))
    const command = Math.max(began, ran - Math.max(0, head.durationMs))
    this.trace.slice({
      track: a.label,
      name: job.req.taskId,
      cat: 'task',
      from: sent,
      to: endAt,
      args: {
        exitCode: head.exitCode,
        durationMs: Math.round(head.durationMs),
        ...(head.cpuMs === undefined ? {} : { cpuMs: Math.round(head.cpuMs) }),
        ...(head.peakRssBytes === undefined ? {} : { peakRssBytes: head.peakRssBytes }),
        bookedCores: job.booked ?? 0,
        ...(head.cpuShare === undefined ? {} : { cpuShare: head.cpuShare }),
      },
      parts: [
        { name: 'sent', from: sent, to: began },
        { name: 'restore deps', from: began, to: command },
        { name: 'command', from: command, to: ran },
        { name: 'save', from: ran, to: endAt },
      ],
    })
    this.trace.use({ track: a.label, from: began, to: ran, booked: job.booked ?? 0, used: 0 })
    if (head.cpuMs !== undefined && ran > command)
      this.trace.use({
        track: a.label,
        from: command,
        to: ran,
        booked: 0,
        used: head.cpuMs / Math.max(1, head.durationMs),
      })
  }

  private onRelay(body: { type?: string; id?: string; info?: unknown }): void {
    if (body.type === 'joined') {
      const info = body.info as Partial<WorkerInfo> | null
      const id = body.id!
      const refuse = (reason: string): void => {
        void this.o.me
          .send(id, { type: 'refused', reason } satisfies ToWorker)
          .catch(this.unsent('refused', id))
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
      const platform = typeof info.platform === 'string' ? info.platform : undefined
      const sized = info.id === undefined ? undefined : this.spawnedAt.get(info.id)?.declared
      if (sized?.platform !== undefined && platform !== sized.platform) {
        return refuse(
          `runs on ${platform ?? 'no platform it names'}, and its size ${sized.size} says ${sized.platform}`,
        )
      }
      // One given up only for joining late is work the run can use: main
      // db1702f told three smalls GitHub queued 60 s to exit and ended at
      // 232 s against an ideal of 141 s. The plan lets it go if not.
      if (info.id !== undefined && this.late.delete(info.id)) {
        this.cancelled.delete(info.id)
        this.unstarted.delete(info.id)
      }
      if (info.id !== undefined && this.cancelled.has(info.id)) {
        void this.o.me
          .send(id, { type: 'exit' } satisfies ToWorker)
          .catch(this.unsent('exit', info.id))
        return
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
      const warmUpMs = asked === undefined ? undefined : performance.now() - asked
      this.trace.joined(
        label,
        performance.now(),
        asked,
        typeof info.booted === 'number' ? info.booted : undefined,
      )
      const size = spawn?.declared.size
      if (warmUpMs !== undefined && size !== undefined && !this.joinLimitMs.has(size)) {
        this.joinLimitMs.set(size, 2 * warmUpMs)
        for (const [s, { at, declared }] of this.spawnedAt)
          if (s !== info.id && declared.size === size) this.deadline(s, at, size)
      }
      this.workers.set(id, {
        id,
        warmUpMs,
        declared: spawn?.declared,
        ran: 0,
        done: [],
        usage: new Usage(),
        cores,
        memory,
        reported: { cores: Number(info.cores), memory: Number(info.memory) },
        platform,
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
            } satisfies ToWorker),
          )
          .catch(this.unsent('welcome', label)),
        sandboxes: false,
        faulty: false,
      })
      this.o.joined?.()
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
    this.trace.left(a.label, 'lost', a.usage.to)
    this.gone.push(a)
    // Its tasks run again: first, as they were first to go.
    const back: Job[] = []
    for (const j of [...a.busy.values()]) {
      const again = this.retry(a, j, 'lost')
      if (again !== undefined) back.push(again)
    }
    this.queue.unshift(...back)
    this.o.lost?.(a.label)
    // Workers that join on their own may yet join; ones this run starts
    // are all it gets.
    if (this.spawnedAt.size > 0) this.stranded(`${a.label} was lost and no worker is left`)
  }

  private async listen(): Promise<void> {
    while (!this.stop.signal.aborted) {
      let messages
      try {
        // The client asks again through faults shorter than 10 s.
        messages = await this.o.me.poll(this.stop.signal)
      } catch (err) {
        if (this.stop.signal.aborted) return
        // A relay unreachable longer has lost this run. Its tasks fail, not
        // run here: this machine may be far smaller than the workers. A rerun
        // resumes from what finished and saved.
        this.fail(`the relay is unreachable (${(err as Error).message})`)
        return
      }
      for (const { from, body } of messages) {
        if (from === 'relay') {
          this.onRelay(body as { type?: string })
          continue
        }
        const a = this.workers.get(from)
        if (a === undefined) continue
        const m = body as ToOrchestrator
        if ('load' in m) this.heard(a, m.load)
        if (m.type !== 'held') this.movedAt = performance.now()
        if (m.type === 'start') {
          this.begun(a, m.task)
          this.pumpSoon()
        } else if (m.type === 'held') {
          for (const t of m.running) {
            const j = a.busy.get(t)
            if (j?.leaseUntil !== undefined) this.lease(j)
            this.begun(a, t)
          }
          this.pumpSoon()
        } else if (m.type === 'ran') {
          // Its command ended: its cores are the next task's while it saves.
          const j = a.busy.get(m.task)
          if (j === undefined) continue
          this.begun(a, m.task)
          this.unhold(a, j)
          // Its worker still says it holds it while it saves.
          j.ranAt = performance.now()
          this.pumpSoon()
        } else if (m.type === 'fault') {
          const j = a.busy.get(m.task)
          if (j === undefined) continue
          // It began it whether or not its `start` came first.
          this.begun(a, m.task)
          if (this.retry(a, j, m.reason) !== undefined) this.queue.unshift(j)
          if (a.faulty) this.o.faulted?.()
          if (a.faulty && this.spawnedAt.size > 0)
            this.stranded(`${a.label} could not run ${m.task} (${m.reason}) and no worker is left`)
          this.pumpSoon()
        } else if (m.type === 'part') {
          a.usage.messagesOut++
          a.usage.bytesOut += bytesOf(m)
          const k = `${from}\0${m.task}`
          const held = this.parts.get(k) ?? {}
          for (const list of PART_LISTS) {
            const items = m[list] as readonly unknown[] | undefined
            if (items !== undefined) held[list] = [...(held[list] ?? []), ...items]
          }
          this.parts.set(k, held)
        } else if (m.type === 'end') {
          a.usage.messagesOut++
          a.usage.bytesOut += bytesOf(m)
          const k = `${from}\0${m.task}`
          const held = this.parts.get(k)
          this.parts.delete(k)
          const result: Record<string, unknown> = { ...m.result }
          for (const list of PART_LISTS) {
            const items = m.result[list] as readonly unknown[] | undefined
            if (held?.[list] !== undefined) result[list] = [...held[list], ...(items ?? [])]
          }
          // Not awaited: one task's restore holds no other message.
          void this.finish(a, m.task, m.key, result as WiredResult)
        }
      }
      // After the batch: a `held` in it renews its lease first. Expired
      // before, a stalled loop's waiting `held` came too late and the task
      // ran again on another worker (2026-10-27).
      this.expire()
      this.stall()
    }
  }

  /** The worker running a task; `null` while it waits, here or in a worker's queue, for one to begin it. */
  where(taskId: string): string | null | undefined {
    for (const a of this.workers.values())
      if (a.busy.has(taskId)) return a.started.has(taskId) ? a.label : null
    return this.queue.some((j) => j.req.taskId === taskId) ? null : undefined
  }

  /**
   * Core's cache probe answered: `left` placed tasks no cache holds or none
   * answered for, `misses` of them found in none. Said in the footer: main
   * d0cdc2c asked 15 workers for 119 tasks, 91 restored, and no line said
   * what the probe had answered (2026-10-23).
   */
  probed(left: number, misses: number): void {
    if (this.probe !== undefined) return
    this.probe = { at: performance.now() - this.startedAt, left, misses }
    this.trace.mark(ORCHESTRATOR, 'cache probe', { remaining: left, misses })
  }

  /** The run asks for `workers` more for `tasks` it knows miss, its plan ending in `endsInMs`. */
  asked(
    workers: number,
    tasks: number,
    measured: number,
    endsInMs: number,
    unmeasured: readonly string[] = [],
  ): void {
    if (this.asks.length === 0) this.unmeasured = unmeasured
    this.asks.push({ at: performance.now() - this.startedAt, workers, tasks, measured, endsInMs })
    this.trace.mark(ORCHESTRATOR, `ask ${workers} worker${workers === 1 ? '' : 's'}`, {
      tasks,
      measured,
      planEndsInMs: Math.round(endsInMs),
    })
  }

  /**
   * A plan that started or let go of workers, in the profile: what it saw
   * of each worker (cores busy / ms left per task, or when it joins) and
   * of the work, so a worker asked and cancelled a second later can be
   * read back (PR #4214's run: 7, 2026-10-23).
   */
  planned(p: {
    start: readonly string[]
    release: readonly string[]
    tasks: number
    endsInMs: number
    boundMs: number
    workers: readonly PlanWorker[]
    /**
     * A plan that starts workers: the work it played (seconds, cores,
     * platform) and each size's warm-up, so it can be played back. Main
     * d8a795c planned 38 s with one Mac for a Mac lane of 88 s, and
     * nothing in the profile said what it thought each task took.
     */
    work?: readonly PlanTask[]
    warmUps?: ReadonlyMap<string, number>
  }): void {
    const work = p.work?.map(
      (t) =>
        `${t.id} ${t.ms === undefined ? '?' : Math.round(t.ms / 100) / 10}s ${Math.round(t.cores * 100) / 100}c${t.platform === undefined ? '' : ` ${t.platform}`}`,
    )
    const workers = p.workers.map((w) =>
      w.starting === true
        ? `${w.id} joins ${Math.round(w.at)}`
        : `${w.id} ${w.running.map((r) => `${Math.round(r.cores * 10) / 10}c/${Math.round(r.endsIn)}`).join(' ') || 'idle'}`,
    )
    this.trace.mark(ORCHESTRATOR, 'plan', {
      start: p.start.join(' '),
      release: p.release.join(' '),
      tasks: p.tasks,
      endsInMs: Math.round(p.endsInMs),
      boundMs: Math.round(p.boundMs),
      workers: workers.join(' · '),
      ...(work === undefined ? {} : { work: work.join(' · ') }),
      ...(p.warmUps === undefined
        ? {}
        : {
            warmUps: [...p.warmUps]
              .map(([s, ms]) => `${s} ${Math.round(ms / 100) / 10}s`)
              .join(' · '),
          }),
    })
  }

  /** `demand` asked the adapter for worker `id` (`WorkerSpawn.id`). */
  spawned(id: string, declared: Declared): void {
    // A worker whose start broke where no adapter sees it counted as
    // starting for good: main's run sat 18 min (ee3fc6e, 2026-10-23). Its
    // job ending says so (`failed`); one that never ends is given up past
    // its size's join limit.
    const at = performance.now()
    this.spawnedAt.set(id, { at, declared })
    this.deadline(id, at, declared.size)
  }

  /** Worker `id`, started at `at`, is given up once its size's join limit passes unjoined. */
  private deadline(id: string, at: number, size: string): void {
    const ms = this.joinLimitMs.get(size)
    if (ms === undefined) return
    setTimeout(
      () => {
        if (this.ended || this.cancelled.has(id) || this.unstarted.has(id)) return
        if ([...this.workers.values(), ...this.gone].some((a) => a.label === id)) return
        this.cancelled.add(id)
        this.late.add(id)
        this.o.overdue?.(id)
        this.failed(id, `did not join within ${Math.round(ms / 1000)} s`, true)
      },
      Math.max(0, at + ms - performance.now()),
    ).unref()
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

  /** Each task a worker ran, how long it held the worker, by `forecast`'s ms (`slowdown`). */
  finished(
    forecast: (id: string) => number | undefined,
  ): { took: number; forecast: number | undefined }[] {
    return [...this.took].map(([id, t]) => ({ took: t.ms, forecast: forecast(id) }))
  }

  /** `warmUpMs` of each size a worker this run started joined as. */
  warmUpsMs(): Map<string, number> {
    const out = new Map<string, number>()
    for (const a of [...this.workers.values(), ...this.gone]) {
      const size = a.declared?.size
      if (a.warmUpMs === undefined || size === undefined) continue
      if (!(out.get(size)! <= a.warmUpMs)) out.set(size, a.warmUpMs)
    }
    return out
  }

  /**
   * The workers the plan places on (`planner.ts`): each online, what it
   * runs and how long that has left by `ms`, and each still starting,
   * joining after its size's `warmUpMs` from its ask. With them, the tasks they run.
   */
  planState(
    ms: (taskId: string) => number | undefined,
    warmUpMs: WarmUp,
  ): { workers: PlanWorker[]; running: Set<string> } {
    const now = performance.now()
    const running = new Set<string>()
    const workers: PlanWorker[] = []
    for (const a of this.workers.values()) {
      if (a.faulty) continue
      const jobs = [...a.busy.values()].filter((j) => j.startedAt !== undefined)
      for (const j of jobs) running.add(j.req.taskId)
      // Its tasks use more than their history said (a suite given more
      // workers): the plan holds them at what the load says, this run.
      const over = a.usedCores > 0 ? Math.max(1, this.used(a).cores / a.usedCores) : 1
      workers.push({
        id: a.id,
        cores: a.cores,
        memory: a.memory,
        platform: a.platform,
        ...(a.declared === undefined ? {} : { size: a.declared.size }),
        at: 0,
        idle: a.busy.size === 0,
        // An unmeasured one counts as it did waiting (`ask`), not as the
        // one core it holds: started, it freed a core the plan then found
        // spare, and the worker asked for it was cancelled (cold main
        // bcc84f1: 11 of 25, 2026-10-23).
        running: jobs.map((j) => ({
          id: j.req.taskId,
          cores: Math.min(a.cores, Math.max((j.held?.cores ?? 0) * over, j.need.ask?.cores ?? 0)),
          memory: Math.max(j.held?.memory ?? 0, Math.min(a.memory, j.need.ask?.memory ?? 0)),
          endsIn: Math.max(0, (ms(j.req.taskId) ?? 0) - (now - j.startedAt!)),
        })),
      })
    }
    const joined = new Set([...this.workers.values(), ...this.gone].map((a) => a.label))
    for (const [id, { at, declared }] of this.spawnedAt)
      if (!joined.has(id) && !this.unstarted.has(id) && !this.cancelled.has(id))
        workers.push({
          id,
          cores: declared.cpu,
          memory: declared.memory,
          platform: declared.platform,
          size: declared.size,
          at: Math.max(
            0,
            (typeof warmUpMs === 'number' ? warmUpMs : warmUpMs(declared.size)) - (now - at),
          ),
          idle: false,
          running: [],
          starting: true,
        })
    return { workers, running }
  }

  /**
   * Sizes the CI has not started a worker of past its warm-up, `warmUpMs`
   * from its ask: one given up as late counts while one of its size is
   * online. A worker asked now queues behind it: PR 2f0e2a4's run asked 7
   * more while GitHub queued its first 11 for 30-85 s; none got a runner
   * before its join limit cancelled it (2026-10-24).
   */
  queued(warmUpMs: (size: string) => number): Set<string> {
    const now = performance.now()
    const online = new Set([...this.workers.values()].map((a) => a.declared?.size))
    const joined = new Set([...this.workers.values(), ...this.gone].map((a) => a.label))
    const out = new Set<string>()
    for (const [id, { at, declared }] of this.spawnedAt) {
      if (joined.has(id)) continue
      if (
        this.late.has(id)
          ? online.has(declared.size)
          : !this.cancelled.has(id) && !this.unstarted.has(id) && now - at > warmUpMs(declared.size)
      )
        out.add(declared.size)
    }
    return out
  }

  /**
   * Workers `ids` leave (`exit`) if still idle, and each faulty idle one:
   * none comes back. Of `ids`, each started and not joined is cancelled:
   * the ones returned, for the adapter to stop; one that joins anyway is
   * told to exit at once.
   */
  release(ids: Iterable<string>): string[] {
    for (const a of this.workers.values()) if (a.faulty && a.busy.size === 0) this.letGo(a)
    const joined = new Set([...this.workers.values(), ...this.gone].map((a) => a.label))
    const cancelled: string[] = []
    for (const id of ids) {
      const a = this.workers.get(id)
      if (a !== undefined) {
        if (a.busy.size === 0) this.letGo(a)
      } else if (this.spawnedAt.has(id) && !joined.has(id) && !this.unstarted.has(id)) {
        this.cancelled.add(id)
        cancelled.push(id)
        this.trace.unstarted(id, this.spawnedAt.get(id)!.at, 'cancelled: not needed')
      }
    }
    return cancelled
  }

  private letGo(a: Worker): void {
    this.workers.delete(a.id)
    a.usage.to = performance.now()
    this.trace.left(a.label, 'left', a.usage.to)
    this.gone.push(a)
    this.retired.add(a)
    this.post(a, { type: 'exit' })
  }

  /**
   * Worker `id` will not join: its start failed or it exited first. One that
   * joined is lost now, not when the relay stops hearing it (20 s, its tasks
   * waiting).
   */
  failed(id: string, reason: string, overdue = false): void {
    // Its job ended: one given up as late no longer joins after all.
    if (!overdue) this.late.delete(id)
    if (this.ended || (this.cancelled.has(id) && !overdue)) return
    const live = [...this.workers.values()].find((a) => a.label === id)
    if (live !== undefined) {
      this.lose(live)
      this.pumpSoon()
      return
    }
    // Gone already: its job ending says nothing new.
    if (this.gone.some((a) => a.label === id) || this.unstarted.has(id)) return
    this.unstarted.set(id, reason)
    const asked = this.spawnedAt.get(id)?.at
    if (asked !== undefined) this.trace.unstarted(id, asked, reason)
    // A checkout, an install or a join can fail on the network; a few more
    // workers get a go. Failing that often, the setup is broken: none more.
    if (this.restarts < RESTARTS) {
      this.restarts++
      this.o.lost?.(id)
    }
    this.stranded(`no worker could start: ${id} ${reason}`)
  }

  /** Nothing online that takes work, none still starting: no task can run. */
  private stranded(reason: string): void {
    const joined = new Set([...this.workers.values(), ...this.gone].map((a) => a.label))
    const starting = [...this.spawnedAt.keys()].some(
      (s) => !this.unstarted.has(s) && !this.cancelled.has(s) && !joined.has(s),
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
   * The run's end had it placed its tasks perfectly (2026-10-23: "how
   * close the run was"): each task a worker ran, as long as it held its
   * worker and with the cores it used meanwhile, played on as
   * many workers as the sizes allow, each joining after its platform's
   * fastest real warm-up, from when the run first knew its work. A task
   * waits on its deps through those no worker ran (groups, hits).
   */
  idealMs(depsOf: (id: string) => readonly string[], sizes: readonly Size[]): number | undefined {
    if (this.took.size === 0) return undefined
    const all = [...this.workers.values(), ...this.gone]
    const warm = new Map<string | undefined, number>()
    for (const a of all)
      if (a.warmUpMs !== undefined && !(warm.get(a.platform)! <= a.warmUpMs))
        warm.set(a.platform, a.warmUpMs)
    const least = this.warmUpMs() ?? 0
    const pool: PlanWorker[] = (
      sizes.length > 0
        ? sizes.flatMap((s) =>
            Array.from({ length: Math.min(s.max, this.took.size) }, () => ({
              cores: s.cpu,
              memory: s.memory,
              platform: s.platform,
            })),
          )
        : all.map((a) => ({ cores: a.cores, memory: a.memory, platform: a.platform }))
    ).map((w, i) => ({
      ...w,
      id: `ideal#${i}`,
      at: warm.get(w.platform) ?? least,
      running: [],
      idle: false,
    }))
    const seen = new Map<string, string[]>()
    const ran = (id: string): string[] => {
      const known = seen.get(id)
      if (known !== undefined) return known
      seen.set(id, [])
      const out = depsOf(id).flatMap((d) => (this.took.has(d) ? [d] : ran(d)))
      seen.set(id, out)
      return out
    }
    const tasks: PlanTask[] = [...this.took].map(([id, t]) => ({ id, ...t, deps: ran(id) }))
    const end = simulate(tasks, pool)
    if (!Number.isFinite(end)) return undefined
    return (this.probe?.at ?? this.asks[0]?.at ?? 0) + end
  }

  /**
   * Each machine that joined, and this one when it ran tasks, with what it
   * did: the run summary's `machines`. Core asks once its tasks are over,
   * before its teardown ends this run: then is its end, so one still here
   * was online until now (small#2 read online 1ms, booked 433802 of 4:
   * main, 2026-10-23). Each is `ok`, or `failed` when lost or faulty.
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
      // Whether it failed or ran its part, not why it left (2026-10-23).
      ...report(
        a.label,
        (gone.has(a) && !this.retired.has(a)) || a.faulty ? 'failed' : 'ok',
        a.usage,
        a.reported.cores,
        a.reported.memory,
      ),
      ...(a.warmUpMs === undefined ? {} : { warmUpMs: a.warmUpMs }),
      startMs: Math.max(0, a.usage.from - (a.warmUpMs ?? 0) - this.startedAt),
    }))
  }

  /**
   * The `workers` rows, live and at the end: one per worker by `size#index`
   * with its status, the tasks it has done and the ones it runs now, then
   * this machine's; once over, each joined worker's warm-up and, under
   * each, the cores and memory its size declares and its machine reports;
   * and `ideal`, the run's `idealMs`, asked once it ended.
   */
  footer(ideal?: () => number | undefined): [string, ui.Inline][] {
    // Over with none, it says so: core's own `N workers` (this machine's
    // pool) read as the run's when no task needed one (2026-10-25).
    if (this.spawnedAt.size === 0 && this.workers.size === 0 && this.gone.length === 0)
      return this.ended ? [['workers', ui.dim('none started: no task needed one')]] : []
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
          (this.ended && a.warmUpMs !== undefined ? ` · warm-up ${seconds(a.warmUpMs)}` : '') +
          (this.ended && a.done.length > 0 && a.done.length <= FEW
            ? ` · ${a.done.join(', ')}`
            : ''),
      ])
    for (const id of this.spawnedAt.keys())
      if (!joined.has(id) && (!this.cancelled.has(id) || this.late.has(id))) {
        const why = this.unstarted.get(id)
        // Over, the run waits on none: one still starting then never joined.
        lines.push(
          why !== undefined
            ? [id, 'failed', why]
            : this.ended
              ? [id, 'not joined', 'the run ended first']
              : [id, 'starting', ''],
        )
      }
    lines.sort((x, y) => x[0].localeCompare(y[0], 'en', { numeric: true }))
    const cancelled = [...this.cancelled].filter(
      (id) => !joined.has(id) && !this.late.has(id),
    ).length
    if (cancelled > 0)
      lines.push([`${cancelled} worker${cancelled === 1 ? '' : 's'}`, 'cancelled', 'not needed'])
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
      ...(this.ended && this.probe !== undefined
        ? [
            [
              '',
              ui.dim(
                `${'probe'.padEnd(width)}  at ${seconds(this.probe.at)}: ${plural(this.probe.left, 'task')} left to run, ${plural(this.probe.misses, 'known miss')}`,
              ),
            ] as [string, ui.Inline],
          ]
        : []),
      ...(this.ended && this.asks.length > 0
        ? [
            [
              '',
              ui.dim(
                `${'asked'.padEnd(width)}  ${this.asks
                  .map(
                    (x) =>
                      `${x.workers} at ${seconds(x.at)} for ${plural(x.tasks, 'task')} (${x.measured} measured), plan ${seconds(x.endsInMs)}`,
                  )
                  .join(' · ')}`,
              ),
            ] as [string, ui.Inline],
            // Beside core's time row, how close the run came (2026-10-23).
            ...((ms) =>
              ms === undefined
                ? []
                : [
                    [
                      '',
                      ui.dim(
                        `${'ideal'.padEnd(width)}  ${seconds(ms)}: each task as long as it took, placed perfectly`,
                      ),
                    ] as [string, ui.Inline],
                  ])(ideal?.()),
            ...(this.unmeasured.length === 0
              ? []
              : [
                  [
                    '',
                    ui.dim(
                      `${'unmeasured'.padEnd(width)}  ${this.unmeasured.slice(0, NAMED).join(', ')}${this.unmeasured.length > NAMED ? ` and ${this.unmeasured.length - NAMED} more` : ''}`,
                    ),
                  ] as [string, ui.Inline],
                ]),
          ]
        : []),
      ...(coreMs > 0
        ? [
            [
              '',
              `${'total'.padEnd(width)}  cpu utilization ${percent(cpuMs / coreMs)}${this.needMs < LEARN_MS ? '' : ` · tasks used ${percent(this.usedMs / this.needMs)} of their history`}`,
            ] as [string, ui.Inline],
          ]
        : []),
    ]
  }

  /** Why the relay was given up on; then every task runs here. */
  lost: string | undefined
}

function result(r: WiredResult, log: readonly CapturedChunk[]): ExecuteResult {
  const { cpuShare: _, removed: __, unread: ___, unshared: ____, output: _____, ...rest } = r
  const violations = (r.violations ?? []).map((v) => ({ ...v, timestamp: new Date(v.timestamp) }))
  const of = (err: boolean) =>
    log
      .filter((c) => c.err === err)
      .map((c) => c.text)
      .join('')
  return { ...rest, stdout: of(false), stderr: of(true), violations, outputs: { kind: 'disk' } }
}

/** A worker's `output`, read at the boundary: its chunks of text. */
function wiredLog(output: unknown): CapturedChunk[] {
  return Array.isArray(output)
    ? output
        .filter(
          (c): c is CapturedChunk =>
            typeof c === 'object' && c !== null && typeof c.text === 'string',
        )
        .map((c) => ({ text: c.text, err: c.err === true }))
    : []
}

/**
 * A worker's `cpuShare`, read at the boundary: in (0, 1], else 1. A twentieth
 * at least: a share that small is a misread, and dividing by it would book
 * a task a whole machine.
 */
function shareOf(share: unknown): number {
  return typeof share === 'number' && share > 0 && share <= 1 ? Math.max(0.05, share) : 1
}

/** What a task that is not a cache hit to be is saved under: of this run, task and send, so no lookup ever finds it. */
export function runKey(run: string, task: string, send = 0): string {
  const id = send === 0 ? `vx-dte\0${run}\0${task}` : `vx-dte\0${run}\0${task}\0${send}`
  return Bun.hash.xxHash3(id).toString(16).padStart(16, '0')
}

/**
 * The projects inside `dir`, root-relative, once per graph and project:
 * read for each order, a run of 9000 tasks walked every task 9000 times
 * (2026-10-25).
 */
export function nestedIn(
  nodes: ReadonlyMap<string, TaskNode>,
  dir: string,
  root: string,
): string[] {
  let of = nested.get(nodes)
  if (of === undefined) {
    of = { dirs: [...new Set([...nodes.values()].map((n) => n.projectDir))], by: new Map() }
    nested.set(nodes, of)
  }
  let out = of.by.get(dir)
  if (out === undefined) {
    out = of.dirs
      .filter((d) => d.startsWith(dir + path.sep))
      .map((d) => path.relative(root, d))
      .sort()
    of.by.set(dir, out)
  }
  return [...out]
}
const nested = new WeakMap<
  ReadonlyMap<string, TaskNode>,
  { dirs: string[]; by: Map<string, readonly string[]> }
>()

/** A tree's file paths, and its submodules' (gitlinks). */
type Tree = { files: Set<string>; links: string[] }

/** `tree`'s files and submodules under `root`, relative to it; undefined when git cannot list it. */
async function listTree(root: string, tree: string): Promise<Tree | undefined> {
  const p = Bun.spawn(['git', 'ls-tree', '-r', '-z', tree], {
    cwd: root,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  if (code !== 0) return undefined
  const files = new Set<string>()
  const links: string[] = []
  for (const e of out.split('\0')) {
    const tab = e.indexOf('\t')
    if (tab === -1) continue
    const name = e.slice(tab + 1)
    if (e.startsWith('160000 ')) links.push(name)
    else files.add(name)
  }
  return { files, links }
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

/**
 * An uncached task that may leave files its dependants read: no cache
 * carries them. A sandboxed one writes only where its grants say; with
 * none (a gate like a lint or a version check) it leaves nothing, and
 * pinning every dependant to its worker held a run's shards on one.
 */
function leaves(node: TaskNode): boolean {
  if (node.config.cache !== undefined) return false
  const sandbox = node.config.exec?.sandbox
  return sandbox === undefined || (sandbox.allow?.write?.length ?? 0) > 0
}

/**
 * Every task `id` depends on, transitively, each after its own
 * dependencies: the order a worker restores them in. Dependant first, an
 * additive task's rewrite of its upstream's file was undone by the
 * upstream's restore, and its dependants read the old bytes (2026-10-25).
 */
function upstream(nodes: ReadonlyMap<string, TaskNode> | undefined, id: string): Set<string> {
  const seen = new Set<string>()
  const out = new Set<string>()
  const walk = (t: string): void => {
    for (const d of nodes?.get(t)?.deps ?? []) {
      if (seen.has(d)) continue
      seen.add(d)
      walk(d)
      out.add(d)
    }
  }
  walk(id)
  return out
}

/** A worker's run, spelled out: time, CPU, memory and the relay. */
function describe(st: UsageStats, u: Usage): string[] {
  return [
    `online ${seconds(st.onlineMs)} · busy ${seconds(st.busyMs)} · idle ${seconds(Math.max(0, st.onlineMs - st.busyMs))}`,
    `cpu peak ${st.cpuPeak.toFixed(1)} · used avg ${st.cpuAvg.toFixed(1)} cores${st.machineAvg === undefined ? '' : ` · machine avg ${st.machineAvg.toFixed(1)}`} · booked avg ${st.bookedAvg.toFixed(1)} · cpu utilization ${percent(st.utilization)}`,
    // No task said what it held: `memory peak 0 B` would be a claim.
    ...(st.memoryPeak > 0
      ? [`memory peak ${bytes(st.memoryPeak)} · avg ${bytes(st.memoryAvg)}`]
      : []),
    `sent ${plural(u.messagesIn, 'message')} · ${bytes(u.bytesIn)}, received ${plural(u.messagesOut, 'message')} · ${bytes(u.bytesOut)}`,
  ]
}

const plural = (n: number, w: string): string =>
  `${n} ${w}${n === 1 ? '' : w.endsWith('s') ? 'es' : 's'}`
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

/**
 * `env` as it travels: no unset name, and no name whose value is the
 * worker's (`HOST_ENV`) unless `define` sets it. A defined `HOME` ran
 * with the worker's own, saved under a key that folded the defined one
 * (2026-10-24).
 */
function defined(
  env: NodeJS.ProcessEnv,
  define: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env))
    if (v !== undefined && (!HOST_ENV.includes(k) || k in define)) out[k] = v
  return out
}
