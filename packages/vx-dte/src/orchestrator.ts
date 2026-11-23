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
import { realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  hostPlatform,
  ui,
  UserError,
  withForwardArgs,
  type CacheFacts,
  type CapturedChunk,
  type ExecuteRequest,
  type ExecuteResult,
  type SandboxConfig,
  type TaskArtifacts,
  type TaskNode,
} from '@vzn/vx'
import {
  bytesOf,
  CHANGED_NAMED,
  HOST_ENV,
  PART_LISTS,
  type PartList,
  type WorkerInfo,
  type DepOrder,
  type RunOrder,
  type RuntimeOrder,
  type SentOrder,
  type WiredDep,
  type ToWorker,
  type Load,
  type ToOrchestrator,
  type WiredResult,
} from './messages.js'
import { Usage } from './usage.js'
import { leaves, MIN_CORES, Planner, wholeCores, type Need } from './plan/index.js'
import { RelayError, unsent, type Participant } from './wire.js'
import { ORCHESTRATOR, Trace } from './trace.js'
import { leftUnder, names, outputFiles } from './outputs.js'
import { type Declared, LEARN_MS, type RecordedWorker, RunReport } from './report.js'

interface Job {
  readonly req: ExecuteRequest
  /** Read as it joined the queue, and again while it waits when history changes (`rerank`). */
  need: Need
  /** The cores and memory it holds on its worker: its need, or the whole worker for one that filled its worker. */
  held?: Need
  /** Flexible, given fewer cores than it wants (`flexed`): how many times its history it takes. */
  slower?: number
  readonly resolve: (r: ExecuteResult) => void
  readonly reject: (err: unknown) => void
  worker?: string
  /** When it last joined the run's queue. */
  queuedAt?: number
  /** The cores its worker booked for it. */
  booked?: number
  /** The workers that failed it after beginning it, with why: two fail it. */
  faults?: string[]
  /** Its worker's `end` came: a report naming it no more is not a loss. */
  ended?: true
  /** When it was sent to its worker. */
  sentAt?: number
  /** The batch that sent it, by its worker's count: a report of that batch or later names it. */
  batch?: number
  /** When its worker began it: its send, then the time its worker says. */
  startedAt?: number
  /** When its worker said its command ended: it saves since. */
  ranAt?: number
  /** Where its worker says that time went, ms (`end.spent`): the profile shows it. */
  spent?: { check: number; save: number; upload: number }
  /** When it first waited on the worker holding an upstream's files (`kept`). */
  pinnedAt?: number
  /** Its upstreams already ran again for it: it waits on their worker however long. */
  fellBack?: true
  /** An uncached task run again for a dependant (`kept`): its result is the run's alone. */
  again?: { readonly only?: string; readonly avoid?: string }
  /** Dependency keys it ran again for, sent again from this machine (`resend`). */
  reread?: Set<string>
  /** Its upstreams, once the graph named it: walked again at every pump, 8000 queued spent 5 ms a pump on it (2026-10-25). */
  up?: Set<string>
  /** Its direct dependencies, as placing reads them (`Ask.up`). */
  deps?: readonly string[] | undefined
  /** A retry: the worker its last attempt ran on, which it goes elsewhere than while another can take it. */
  avoid?: string
}

/** An upstream's files, as an order names them (`DepOrder`). */
type DepFiles = Pick<DepOrder, 'project' | 'outputs'>

/** The longest a task waits on the worker holding its upstream's files before they are made again (2026-10-23: 10 s on any wait). */
const PIN_WAIT_MS = 10_000

/** No task began or ended this long: the run says what it waits on, each time again. */
const STALL_MS = 60_000

interface Worker extends RecordedWorker {
  readonly id: string
  /** Tasks it finished. */
  ran: number
  /** Sent to it and not finished: running there or in its queue. */
  readonly busy: Map<string, Job>
  /** Batches sent it: each batch's `n`. */
  batches: number
  usedCores: number
  usedMemory: number
  /** Its machine's use as its last frame said, and when this machine heard it. */
  load?: { cpu: number; memory: number; at: number; tasks?: number }
  /** Tasks whose outputs it holds: it ran them, or was sent them. */
  readonly has: Set<string>
  /**
   * The persistent tasks it runs, each with the base it books there
   * (`Need.servers`): booked once, by the first task placed there that
   * needs it, and given back when the run says none needs it.
   */
  readonly serving: Map<string, number>
  /** Each dependency it was sent whole, by the key it was sent under: the next order names it alone. */
  readonly sentDeps: Map<string, string>
  /** Sends to it go out in order: a run's parts before the run. */
  chain: Promise<void>
  /** It was sent the run's sandbox configs. */
  sandboxes: boolean
}

/** How far each frame moves a worker's `other`: a frame read as a task starts lags it. */
const OTHER_WEIGHT = 0.25

export interface OrchestratorOptions {
  readonly me: Participant
  readonly root: string
  /** The tree of the run's tracked files (`tree.ts`). */
  readonly tree: string
  readonly nodes: () => ReadonlyMap<string, TaskNode> | undefined
  readonly need: (taskId: string) => Need
  /** Each server's base, cores, as workers fit them: updated in place. */
  readonly bases?: Map<string, number>
  /** Each server's start, ms, as workers measure it: updated in place. */
  readonly starts?: Map<string, number>
  /** A size's cores its machines spent besides an earlier run's tasks (`othersOf`). */
  readonly learnedOther?: (size: string) => number | undefined
  /** A size's warm-up as the plan expects it before any of it joins: an earlier run's, else the default. */
  readonly warmUp?: (size: string) => number | undefined
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
  /** A worker failed a task or dropped it: the run plans again, now, so a replacement starts. */
  readonly faulted?: () => void
  /**
   * The run's planner, once it can plan (history read, a task missed):
   * undefined, tasks wait. Absent, one that asks for no worker places
   * every task on those that join, by `need`'s cores.
   */
  readonly planner?: () => Planner | undefined
  /** Start a worker of size `size` the planner asked for: its id. */
  readonly spawn?: (size: string) => string
  /** Workers the planner let go, by id. */
  readonly left?: (ids: readonly string[]) => void
  /** Workers asked and not joined the planner let go, by id: its adapter stops them (`leftRunning` the ones it cannot). */
  readonly cancel?: (ids: readonly string[]) => void
  /** The platform a task naming none runs on (`homeOf`). */
  readonly home?: string | undefined
  /** A joined worker's place, by its size and the platform it reported: absent, the platform. */
  readonly joinedPlace?: (
    size: string | undefined,
    platform: string | undefined,
  ) => string | undefined
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
/** The most a worker's bookings may add up to, in its cores, when tasks use less than their history. */
const OVERBOOK = 1.5
/** Failed starts the run replaces before it calls its setup broken. */
const RESTARTS = 3

/** `orders` in runs of at most `max` bytes of JSON; one bigger goes alone. */
function parts<T extends { bytes: number }>(orders: readonly T[], max: number): T[][] {
  const out: T[][] = []
  let part: T[] = []
  let bytes = 0
  for (const o of orders) {
    const size = o.bytes
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

export class Orchestrator extends RunReport<Worker> {
  /** The run tree's files, workspace-relative, listed when a task first asks. */
  private inTree?: Promise<Tree | undefined>
  /** Waiting tasks, by id. */
  private readonly waiting = new Map<string, Job>()
  /** Handed by core and not yet waiting: held for a machine as the waiting are. */
  private readonly handed = new Set<string>()
  /** Where a worker saved each task it ran: its cache key or its run key. */
  private readonly savedAs = new Map<string, string>()
  /** The worker each task last ran on, which its retry goes elsewhere than. */
  private readonly ranOn = new Map<string, string>()
  /** Keys the run's requests named for their dependencies. */
  private readonly upstreamKeys = new Map<string, string>()
  /** How many times each task was sent: its run key is one per send. */
  private readonly sent: Map<string, number>
  /** Each hit's key, once on a remote a worker reads (`TaskArtifacts.share`). */
  private readonly shared = new Map<string, Promise<boolean>>()
  /** Keys a worker could not read, sent again over the remotes' copy: once each, whether one reached a remote. */
  private readonly resent = new Map<string, Promise<boolean>>()
  /** Tasks whose files are still coming to this machine after they ended (`trail`); settled, never rejected. */
  private readonly homing = new Map<string, Promise<void>>()
  /** A long result's lists, by worker and task, until its `end` comes. */
  private readonly parts = new Map<string, Partial<Record<PartList, unknown[]>>>()
  /** The pump at the next planned start (`Placing.next`). */
  private due: { at: number; timer: ReturnType<typeof setTimeout> } | undefined
  /** The planner the run's events reach (`planner`). */
  private bound: Planner | undefined
  /** Of `cancelled`, those that joined anyway and were told to exit. */
  private readonly turnedAway = new Set<string>()
  /** Let go before they joined, and left running by their adapter (`leftRunning`): no plan lets them go again. */
  private readonly unstoppable = new Set<string>()
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
  /** The run in time, for `--profile` (`profile`). */
  readonly trace = new Trace()
  /** When a task last began, ended or faulted, or the run last said it waits. */
  private movedAt = performance.now()
  private readonly stop = new AbortController()
  private readonly loop: Promise<void>
  private readonly realRoot: string
  /** What workers read the cache under, asked once and again before its lent tokens end. */
  private facts: Promise<CacheFacts> | undefined
  private relend: ReturnType<typeof setTimeout> | undefined
  /** The plugins any of the run's lends lent a token. */
  private readonly lenders = new Set<string>()
  /** Each graph's upstreams as orders name them (`dep`). */
  private readonly deps = new WeakMap<ReadonlyMap<string, TaskNode>, Map<string, DepFiles | null>>()
  /** Each graph's dependants of each task, walked once (`skipped`). */
  private readonly dependants = new WeakMap<ReadonlyMap<string, TaskNode>, Map<string, string[]>>()
  /** Each graph's tasks' uncached upstreams, whose files lie on one worker only (`pinUp`). */
  private readonly afterUncached = new WeakMap<
    ReadonlyMap<string, TaskNode>,
    Map<string, readonly string[]>
  >()

  constructor(private readonly o: OrchestratorOptions) {
    super()
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
    this.loop = this.listen()
  }

  async execute(req: ExecuteRequest): Promise<ExecuteResult> {
    if (this.lost !== undefined) throw new Error(this.lost)
    this.handed.add(req.taskId)
    try {
      return await this.take(req)
    } finally {
      this.handed.delete(req.taskId)
    }
  }

  private async take(req: ExecuteRequest): Promise<ExecuteResult> {
    // Walked once here, for every later read: walked again on the way in,
    // sharing, placing and sending, a run of 8000 tasks spent 17 s of this
    // machine's CPU on it (2026-11-05).
    const nodes = this.o.nodes()
    const up = upstream(nodes, req.taskId)
    // A worker runs a task in its project's directory of the run's tree: a
    // project with no tracked file is not there, and every worker
    // failed to spawn it, exit 127 (2026-11-07).
    const dir = path.relative(this.o.root, req.cwd)
    if (dir !== '' && !dir.startsWith('..')) {
      this.inTree ??= listTree(this.o.root, this.o.tree)
      const tree = await this.inTree
      if (tree !== undefined && !holds(tree, dir))
        throw new UserError(
          `${req.taskId} runs in ${dir}, where git tracks no file, so no worker has it: git add its project (and commit it for workers on CI)`,
        )
    }
    // A worker runs the run's tree: a file its key includes that the tree
    // lacks (untracked) is not there, and the output it saved under that
    // key was a stale hit for the next run (2026-10-24).
    if (req.inputs !== undefined && req.inputs.files.length > 0) {
      this.inTree ??= listTree(this.o.root, this.o.tree)
      const tree = await this.inTree
      // A dependency's output is there before the task runs: a cached one's
      // restored, an uncached one's left where it ran, which its dependants
      // follow. A key that reads an upstream's bytes (`inputs.tasks` leaving
      // it out) was refused (2026-10-25), an uncached one's too (2026-11-10).
      let restored: ((file: string) => boolean)[] | undefined
      const made = (file: string): boolean =>
        (restored ??= [...up].flatMap((id) => {
          const n = nodes?.get(id)
          const outs = n?.config.outputs
          return n === undefined || outs === undefined
            ? []
            : [
                names(path.relative(this.o.root, n.projectDir), {
                  files: outs.files,
                  workspaceFiles: outs.workspaceFiles ?? [],
                }),
              ]
        })).some((m) => m(file))
      const stray =
        tree === undefined
          ? undefined
          : req.inputs.files.find((f) => !tree.files.has(f.path) && !made(f.path))
      if (stray !== undefined) {
        // A committed submodule's files are not the tree's: its gitlink is.
        const link = tree?.links.find((l) => stray.path.startsWith(`${l}/`))
        throw new UserError(
          link === undefined
            ? `${req.taskId} keys ${stray.path}, which git does not track, so no worker has it: git add it (and commit it for workers on CI), or leave it out of the task's inputs`
            : `${req.taskId} keys ${stray.path}, in submodule ${link}, whose files workers do not check out: leave it out of the task's inputs`,
        )
      }
      // A worker runs the commit's bytes and modes (`unfilter`): a file on
      // disk otherwise (CRLF a git filter wrote, an expanded ident, an LFS
      // file's content) is not what it builds on, and the output saved
      // under the key of this disk's bytes was a stale hit (2026-11-08).
      const off =
        tree === undefined
          ? undefined
          : req.inputs.files.find((f) => {
              const has = tree.files.get(f.path)
              return has !== undefined && has !== f.digest && !made(f.path)
            })
      if (off !== undefined)
        throw new UserError(
          `${req.taskId} keys ${off.path}, which is on disk other than the commit workers check out holds it (a git filter's text, eol, ident or LFS bytes, or core.autocrlf): leave it out of the task's inputs, or run the task without dte`,
        )
    }
    for (const u of req.inputs?.upstream ?? []) this.upstreamKeys.set(u.taskId, u.hash)
    await this.share(up, nodes)
    return new Promise((resolve, reject) => {
      const need = this.o.need(req.taskId)
      const job: Job = {
        req,
        ...(nodes?.has(req.taskId) === true ? { up } : {}),
        need: { ...need, platform: req.platform ?? this.o.home },
        queuedAt: performance.now(),
        // Failed or stopped, it hands over none of its dependants: the plan
        // asked a worker for them, idle on arrival.
        resolve: (r) => {
          if (r.exitCode !== 0) this.skipped(req.taskId)
          resolve(r)
        },
        reject: (err) => {
          this.skipped(req.taskId)
          reject(err)
        },
      }
      // A retry runs elsewhere: the worker, or what ran beside it, may be the flake.
      const last = (req.attempt ?? 1) > 1 ? this.ranOn.get(req.taskId) : undefined
      if (last !== undefined) job.avoid = last
      this.handed.delete(req.taskId)
      // A signal aborted already fires no `abort`.
      if (req.signal?.aborted === true) return job.resolve(stopped())
      req.signal?.addEventListener('abort', () => this.abort(job), { once: true })
      this.enqueue([job])
      this.pumpSoon()
    })
  }

  /**
   * `id` failed or stopped: core skips its dependants, so the plan counts
   * them no more. A retry of `id`, or a dependant core hands over after
   * all, is queued again (`enqueue`).
   */
  private skipped(id: string): void {
    const p = this.bound
    const nodes = this.o.nodes()
    if (p === undefined || nodes === undefined) return
    let down = this.dependants.get(nodes)
    if (down === undefined) {
      down = new Map()
      for (const [t, n] of nodes)
        for (const d of n.deps) {
          const list = down.get(d)
          if (list === undefined) down.set(d, [t])
          else list.push(t)
        }
      this.dependants.set(nodes, down)
    }
    const now = this.clock()
    const seen = new Set<string>()
    const stack = [...(down.get(id) ?? [])]
    while (stack.length > 0) {
      const t = stack.pop()!
      if (seen.has(t)) continue
      seen.add(t)
      if (this.waiting.has(t) || this.handed.has(t) || this.where(t) !== undefined) continue
      p.drop(t, now)
      stack.push(...(down.get(t) ?? []))
    }
  }

  /** The run's cache facts; once they end, every worker is sent them again before then. */
  private cache(): Promise<CacheFacts> {
    this.facts ??= this.lend(undefined)
    return this.facts
  }

  /**
   * The run's cache facts, asked now. A remote whose lend failed this time
   * (core lends it nothing) keeps the token `held` lent it until that ends,
   * and is asked again `RELEND_FLOOR_MS` on: sent without it, workers lost
   * the remote while its token held, and for the rest of the run when it
   * was the one remote whose token ends (no relend came again).
   */
  private lend(held: CacheFacts | undefined): Promise<CacheFacts> {
    let short = false
    const asked = this.o.cacheFacts().then((fresh) => {
      for (const p of Object.keys(fresh.lent)) this.lenders.add(p)
      short = [...this.lenders].some((p) => !(p in fresh.lent))
      const live =
        held !== undefined && (held.expiresAt === undefined || held.expiresAt > Date.now())
      if (!short || !live) return fresh
      const lent = { ...fresh.lent }
      for (const [p, t] of Object.entries(held.lent)) if (!(p in lent)) lent[p] = t
      const expiresAt = Math.min(fresh.expiresAt ?? Infinity, held.expiresAt ?? Infinity)
      return { ...fresh, lent, ...(expiresAt === Infinity ? {} : { expiresAt }) }
    })
    void asked.then(
      (f) => {
        if ((f.expiresAt === undefined && !short) || this.ended) return
        const left = (f.expiresAt ?? Infinity) - Date.now()
        this.relend = setTimeout(
          () => {
            const next = this.lend(f)
            this.facts = next
            void next.then(
              (cache) => {
                if (JSON.stringify(cache) === JSON.stringify(f)) return
                for (const a of this.workers.values()) this.post(a, { type: 'cache', cache })
              },
              // quiet: the workers keep what they hold, and the next ask asks again
              () => {},
            )
          },
          short ? RELEND_FLOOR_MS : left > RELEND_MS ? left - RELEND_MS : RELEND_FLOOR_MS,
        )
        this.relend.unref()
      },
      () => {
        if (this.facts === asked) this.facts = undefined
      },
    )
    return asked
  }

  async close(): Promise<void> {
    clearTimeout(this.relend)
    if (this.due !== undefined) clearTimeout(this.due.timer)
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

  /** No task left in the run uses server `task`: each worker that started it stops it. */
  unneeded(task: string): void {
    for (const a of this.workers.values()) {
      const base = a.serving.get(task)
      if (base === undefined) continue
      a.serving.delete(task)
      a.usedCores -= base
      this.post(a, { type: 'unserve', task })
    }
  }

  private abort(job: Job): void {
    if (this.waiting.get(job.req.taskId) === job) {
      this.waiting.delete(job.req.taskId)
      this.bound?.drop(job.req.taskId, this.clock())
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

  /**
   * History changed (`need`, `tail`): the waiting book and rank by it. On
   * CI the default branch's timings land a moment after the roots joined
   * the queue, each booked as unmeasured and ranked as an unknown task:
   * shards ready later went first, and test.wire waited 129 s (2026-11-07).
   */
  rerank(): void {
    for (const [id, job] of this.waiting)
      job.need = { ...this.o.need(id), platform: job.need.platform }
    this.bound?.learn()
    this.pumpSoon()
  }

  /** `jobs` wait to be placed: new, or back to run again. */
  private enqueue(jobs: readonly Job[]): void {
    for (const j of jobs) {
      this.waiting.set(j.req.taskId, j)
      this.bound?.again(j.req.taskId, j.need.platform)
    }
    if (jobs.length > 0) this.waited = true
  }

  /** The run's clock for the planner: ms since it began. */
  private clock(): number {
    return performance.now() - this.startedAt
  }

  /**
   * The planner, told what happened before it was made: workers asked or
   * joined, and the tasks already handed over.
   */
  private planner(): Planner | undefined {
    const p = this.o.planner === undefined ? this.joinedOnly() : this.o.planner()
    if (p === undefined || p === this.bound) return p
    this.bound = p
    const t = this.clock()
    for (const [id, { declared }] of this.spawnedAt)
      if (!this.cancelled.has(id) && !this.unstarted.has(id))
        p.adopt(id, declared.size, placeOf(declared), declared.cpu, t)
    for (const a of this.workers.values()) this.adopted(p, a, t)
    for (const id of this.waiting.keys()) p.ready(id)
    return p
  }

  private own: Planner | undefined

  /** The planner of a run with no `planner`: the workers that join, every task expected. */
  private joinedOnly(): Planner | undefined {
    if (this.own !== undefined) return this.own
    const nodes = this.o.nodes()
    if (nodes === undefined) return undefined
    return (this.own = new Planner({
      nodes,
      platform: (n) => n.platform ?? this.o.home ?? '',
      sizes: [],
      known: (id) => {
        const c = this.o.need(id).cores
        return { ms: undefined, cores: Number.isFinite(c) ? c : undefined }
      },
      expected: new Set(nodes.keys()),
    }))
  }

  /** Worker `a` joined: the planner counts it, of its size, else of its platform. */
  private adopted(p: Planner, a: Worker, t: number): void {
    p.adopt(a.label, a.declared?.size, a.platform ?? this.o.home ?? '', a.cores, t)
    p.joined(a.label, t)
  }

  private pump(): void {
    const p = this.planner()
    if (p === undefined) return
    const byId = this.waiting
    const nodes = this.o.nodes()
    const now = performance.now()
    // Where each waiting task may go as its upstreams' files lie (`pin`).
    const pins = new Map<string, { only?: string; avoid?: string }>()
    for (const [id, job] of [...byId]) {
      const up =
        job.up ?? (nodes?.has(id) === true ? (job.up = upstream(nodes, id)) : upstream(nodes, id))
      // Made again for a dependant: on the worker it was made for while that one is online,
      // or a run alternates between two workers' copies for good.
      const again = job.again?.only
      const pin =
        again !== undefined && this.workers.get(again)?.faulty === false
          ? job.again!
          : this.pin(job, up)
      if (pin === 'done') {
        // It ended: the planner lets it go.
        byId.delete(id)
        p.drop(id, this.clock())
      } else if (pin === 'wait') p.hold(id)
      else {
        p.ready(id)
        if (pin.only !== undefined || pin.avoid !== undefined) pins.set(id, pin)
      }
    }
    const byLabel = new Map<string, Worker>()
    for (const a of this.workers.values()) byLabel.set(a.label, a)
    // A task that filled its worker goes only to a bigger one, while its platform has or may ask one.
    const roomier = (need: Need, cores: number, memory: number): boolean =>
      need.above === undefined || cores > need.above.cores || memory > need.above.memory
    const biggers = new Map<string, boolean>()
    const bigger = (need: Need): boolean => {
      const key = `${need.platform}\0${need.above!.cores}\0${need.above!.memory}`
      let b = biggers.get(key)
      if (b !== undefined) return b
      const mine = (platform: string | undefined): boolean =>
        need.platform === undefined || platform === need.platform
      b =
        p.sizes.some((z) => z.max > 0 && mine(z.platform) && roomier(need, z.cores, z.memory)) ||
        [...this.workers.values()].some(
          (a) => !a.faulty && mine(a.platform) && roomier(need, a.cores, a.memory),
        ) ||
        [...this.spawnedAt].some(
          ([id, { declared }]) =>
            !this.cancelled.has(id) &&
            !this.unstarted.has(id) &&
            mine(declared.place ?? declared.platform) &&
            roomier(need, declared.cpu, declared.memory),
        )
      biggers.set(key, b)
      return b
    }
    const pending = new Map<Worker, { cores: number; servers: Set<string> }>()
    const d = p.decide(this.clock(), (size) => this.o.spawn!(size.name), {
      on: (task, worker, at) => {
        const a = byLabel.get(worker)
        const job = byId.get(task)
        // One made again during this pass (`remake`) has its own pin.
        const pin = pins.get(task) ?? job?.again
        // Not handed over yet: what it needs is unknown, so any worker may take it once it is,
        // but one not joined only if no uncached upstream's files will pin it elsewhere.
        if (job === undefined)
          return a === undefined ? !at && !this.pinnedAhead(nodes, task) : !a.faulty
        // Not joined yet: it may wait for it, unless pinned to a worker online.
        if (a === undefined) {
          if (at || pin?.only !== undefined) return false
          const declared = this.spawnedAt.get(worker)?.declared
          return (
            declared === undefined ||
            roomier(job.need, declared.cpu, declared.memory) ||
            !bigger(job.need)
          )
        }
        if (a.faulty) return false
        if (!roomier(job.need, a.cores, a.memory) && bigger(job.need)) return false
        if (pin?.only !== undefined && pin.only !== a.id) return false
        if (pin?.avoid !== undefined && pin.avoid === a.id) return false
        if (job.need.platform !== undefined && a.platform !== job.need.platform) return false
        const memory = Math.min(job.need.memory, a.memory)
        return !at || a.memory - this.used(a).memory >= memory
      },
      // A worker the CI has not started blocks no ask: no worker is promised, so each the plan needs is asked (2026-11-19).
      size: (task, size) => {
        // Pinned to a worker online: no new one may take it.
        if ((pins.get(task) ?? byId.get(task)?.again)?.only !== undefined) return false
        const need = byId.get(task)?.need
        if (need === undefined) return !this.pinnedAhead(nodes, task)
        return roomier(need, size.cores, size.memory) || !bigger(need)
      },
      // A server base a start brings is booked once on its worker: a worker it fills takes no more this pass.
      admit: (task, worker) => {
        const a = byLabel.get(worker)
        const job = byId.get(task)
        if (a === undefined || job === undefined) return true
        let p = pending.get(a)
        if (p === undefined) pending.set(a, (p = { cores: 0, servers: new Set() }))
        let base = 0
        for (const sv of job.need.servers ?? [])
          if (!a.serving.has(sv.id) && !p.servers.has(sv.id)) base += sv.cores
        const c = Math.min(this.booking(job.need).cores, a.cores) + base
        if (base > 0 || p.servers.size > 0) {
          const load = this.used(a).cores + p.cores
          if (!(load < a.cores - 1e-9 && load + Math.min(c, a.cores) < a.cores + 1 - 1e-9))
            return false
        }
        p.cores += c
        for (const sv of job.need.servers ?? []) p.servers.add(sv.id)
        return true
      },
      // What it uses now: its tasks' measured use and what it books besides (`used`).
      load: (worker) => {
        const a = byLabel.get(worker)
        return a === undefined ? 0 : this.used(a).cores
      },
      // It holds files no cache has that a task to come reads.
      stay: (worker) => {
        const a = byLabel.get(worker)
        if (a === undefined) return false
        for (const k of this.kept.values()) if (k.worker === a.id) return true
        return false
      },
    })
    // the plan's end, said once a decide asks: each ask said 0 s (main a2c25b0, 2026-11-19)
    if (d.ask.length > 0) this.asked(d.ask.length, p.ids.length, p.measured(), d.end - this.clock())
    const batches = new Map<Worker, Job[]>()
    for (const [id, label] of d.start) {
      const job = byId.get(id)
      const a = byLabel.get(label)
      if (job === undefined || a === undefined) {
        p.again(id)
        continue
      }
      byId.delete(id)
      job.worker = a.id
      job.sentAt = performance.now()
      a.usage.sent(job.sentAt)
      a.busy.set(id, job)
      job.held = {
        cores: Math.min(this.booking(job.need).cores, a.cores),
        memory: Math.min(job.need.memory, a.memory),
      }
      job.booked = job.held.cores
      this.trace.slice({
        track: ORCHESTRATOR,
        name: id,
        cat: 'queue',
        from: job.queuedAt ?? job.sentAt,
        to: job.sentAt,
        args: { to: a.label },
      })
      a.usedCores += job.held.cores
      a.usedMemory += job.held.memory
      // A server it starts there books its base once, while it runs.
      for (const sv of job.need.servers ?? [])
        if (!a.serving.has(sv.id)) {
          a.serving.set(sv.id, sv.cores)
          a.usedCores += sv.cores
        }
      const batch = batches.get(a)
      if (batch === undefined) batches.set(a, [job])
      else batch.push(job)
    }
    for (const [a, jobs] of batches) this.send(a, jobs)
    // Idle workers no forecast task needs leave.
    const leave: string[] = []
    const unjoined: string[] = []
    for (const label of d.leave) {
      const a = byLabel.get(label)
      if (a !== undefined) {
        if (a.busy.size === 0) {
          this.letGo(a)
          leave.push(label)
        }
      } else if (this.spawnedAt.has(label)) unjoined.push(label)
    }
    if (leave.length > 0) this.o.left?.(leave)
    // Asked and not joined, its work gone: cancelled, for its adapter to stop.
    if (unjoined.length > 0) {
      const cancelled = this.release(unjoined)
      if (cancelled.length > 0) this.o.cancel?.(cancelled)
    }
    this.wake(now, d.due === Infinity ? undefined : this.startedAt + d.due)
  }

  /** A pump at `at`, when the planner asked to decide again. */
  private wake(now: number, at: number | undefined): void {
    if (at === this.due?.at) return
    if (this.due !== undefined) clearTimeout(this.due.timer)
    this.due = undefined
    if (at === undefined) return
    const timer = setTimeout(
      () => {
        this.due = undefined
        this.pumpSoon()
      },
      Math.max(0, at - now),
    )
    timer.unref?.()
    this.due = { at, timer }
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
    const where = this.pinUp(job, up)
    const avoid = job.avoid
    if (typeof where !== 'object' || avoid === undefined) return where
    if (where.only !== undefined || where.avoid !== undefined) return where
    // With no other worker that can take it, it runs where it failed rather than wait.
    const platform = job.need.platform
    for (const w of this.workers.values())
      if (w.id !== avoid && !w.faulty && (platform === undefined || w.platform === platform))
        return { avoid }
    return where
  }

  /**
   * Whether `id`, not yet handed over, reads files an uncached upstream
   * left on a worker (`kept`): a new worker would make them again. Asked
   * ahead for one, the lull of the local e2e started a worker that ran
   * nothing. An upstream yet to run pins nothing: it may run where its
   * dependant goes (main 4035f14 planned Infinity before any join).
   */
  private pinnedAhead(nodes: ReadonlyMap<string, TaskNode> | undefined, id: string): boolean {
    if (nodes === undefined || this.kept.size === 0) return false
    let memo = this.afterUncached.get(nodes)
    if (memo === undefined) this.afterUncached.set(nodes, (memo = new Map()))
    let ups = memo.get(id)
    if (ups === undefined) {
      ups = [...upstream(nodes, id)].filter((d) => {
        const n = nodes.get(d)
        const exec = n?.config.exec
        return exec?.command !== undefined && exec.persistent === undefined && leaves(n!)
      })
      memo.set(id, ups)
    }
    for (const d of ups) if (this.kept.has(d)) return true
    return false
  }

  /** Where `job` may go as its upstreams' files lie (`pin`, before a retry's own rule). */
  private pinUp(
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

  /**
   * `ids`, uncached tasks that ran, run again where `where` says, for a
   * dependant: on its place, which the plan refused when one names another
   * worker type or platform (`apart`).
   */
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
      this.enqueue([
        {
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
              r.exitCode === 0
                ? undefined
                : `${id} ran again for it and failed (exit ${r.exitCode})`,
            ),
          reject: (err) =>
            done(
              `${id} ran again for it and failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
        },
      ])
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
    const booked = { cores: a.usedCores + this.otherOf(a), memory: a.usedMemory }
    const l = a.load
    if (l === undefined || a.cores !== a.reported.cores) return booked
    // Its tasks' own use where it says it, beside the other cores booked:
    // the machine's whole reading counted those twice, so a small at 3.7
    // of 4 cores under 3 shards never took the fourth the plan gave it,
    // and a Mac whose shard's CPU goes unread ran one where the plan
    // placed two (main 12a2f64: 63 s waiting for room, 2026-11-12).
    let cores = l.tasks === undefined ? l.cpu : l.tasks + this.otherOf(a)
    let memory = l.memory
    for (const j of a.busy.values())
      if (j.held !== undefined && (j.sentAt ?? 0) > l.at) {
        cores += j.held.cores
        memory += j.held.memory
      }
    return { cores: Math.max(booked.cores, cores), memory: Math.max(booked.memory, memory) }
  }

  /** The labels of every worker that joined, online or gone. */
  private joinedLabels(): Set<string> {
    return new Set([...this.workers.values(), ...this.gone].map((a) => a.label))
  }

  /** Whether asked worker `id` is still starting: not joined, failed or cancelled. */
  private starting(id: string, joined: Set<string>): boolean {
    return !joined.has(id) && !this.unstarted.has(id) && !this.cancelled.has(id)
  }

  /**
   * What `a`'s machine spends besides the run's tasks, where its machine is
   * the size it was given (a bigger one's spare cores take it): as it said,
   * or before its first frame, as its size's did. Booked on all 4 cores until
   * it said, a small just joined took six shards the plan gave three; its
   * machine ran busy for 50 s and they ran 1.7 times their history (main
   * f2ddcb6, 2026-11-12).
   */
  private otherOf(a: Worker): number {
    if (a.cores !== a.reported.cores) return 0
    return wholeCores(a.other ?? this.sizeOther(a) ?? 0)
  }

  /** What machines of `a`'s size spent besides the run's tasks: this run's, else an earlier run's. */
  private sizeOther(a: Worker): number | undefined {
    const size = a.declared?.size
    if (size === undefined) return undefined
    const o = this.othersOf().get(size) ?? this.o.learnedOther?.(size)
    return o === undefined ? undefined : Math.min(a.cores / 2, o)
  }

  /** Whether a task of `a`'s holds its cores: its command still runs, or has yet to. */
  private holding(a: Worker): boolean {
    for (const j of a.busy.values()) if (j.held !== undefined) return true
    return false
  }

  /**
   * What a task books: a measured one its need times the share of their
   * history the run's tasks used, once they used `LEARN_MS` of it, and
   * never under `1 / OVERBOOK` of its need nor `MIN_CORES`. An unmeasured one (`ask`)
   * books what it books.
   */
  booking(need: Need): Need {
    if (need.cores === Infinity || need.ask !== undefined || this.needMs < LEARN_MS) return need
    const used = Math.min(1, Math.max(1 / OVERBOOK, this.usedMs / this.needMs))
    return { ...need, cores: Math.max(Math.min(need.cores, MIN_CORES), need.cores * used) }
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
    const self = Number(load.self)
    if (Number.isFinite(avg) && avg >= 0)
      a.usage.machine(avg, Number.isFinite(self) && self >= 0 ? self : undefined, a.load.at)
    // Its servers' bases as it fits them (`server-fit.ts`): what the next
    // task needing one books, and the next run.
    if (typeof load.servers === 'object' && load.servers !== null)
      for (const [id, cores] of Object.entries(load.servers))
        if (typeof cores === 'number' && Number.isFinite(cores) && cores >= 0 && cores <= a.cores)
          this.o.bases?.set(id, cores)
    if (typeof load.starts === 'object' && load.starts !== null)
      for (const [id, ms] of Object.entries(load.starts))
        if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) this.o.starts?.set(id, ms)
    const tasks = Number(load.tasks)
    if (Number.isFinite(tasks) && tasks >= 0) a.load.tasks = tasks
    // What the machine spends besides the run's tasks: GitHub's runner
    // agent alone took 0.2 to 0.6 of a 4-core small's cores, and its
    // machine 0.6 to 1.1 past its tasks, so shards booked on all 4 ran
    // 30% past their history (main 36e410f, 2026-11-10).
    if (Number.isFinite(tasks) && a.busy.size > 0) {
      const o = Math.min(a.cores / 2, Math.max(0, a.load.cpu - tasks))
      // Moved from its size's, not set by its first frame: that frame, its
      // tasks' setup counted and their commands not yet, read 2 of a small's
      // 4 cores, and every small after it was booked and planned at 2
      // (2026-11-12).
      const was = a.other ?? this.sizeOther(a)
      a.other = was === undefined ? o : was + (o - was) * OTHER_WEIGHT
    }
    this.trace.load(a.label, a.load.cpu, a.load.at, Number.isFinite(tasks) ? tasks : undefined)
  }

  /** Whether a worker of `platform` bigger than `above` is starting: a task that filled that size waits for it. */
  private bigger(
    above: { readonly cores: number; readonly memory: number },
    platform: string | undefined,
  ): boolean {
    const joined = this.joinedLabels()
    for (const [id, { declared }] of this.spawnedAt)
      if (
        this.starting(id, joined) &&
        (platform === undefined || placeOf(declared) === platform) &&
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
  private async share(
    up: ReadonlySet<string>,
    nodes: ReadonlyMap<string, TaskNode> | undefined,
  ): Promise<void> {
    const keys: string[] = []
    for (const d of up) {
      if (this.savedAs.has(d) || this.dep(nodes, d) === undefined) continue
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

  /**
   * True when one of `keys` `job` did not run again for already reached a
   * remote. Each key is sent once and each job runs again once for it:
   * two dependants failing on one key together, the second found it sent
   * and failed, though the copy it could not read was replaced.
   */
  private async resend(job: Job, keys: readonly string[]): Promise<boolean> {
    const fresh = keys.filter((k) => typeof k === 'string' && job.reread?.has(k) !== true)
    if (fresh.length === 0) return false
    // Sent from this machine's copy: one still on its way is not here yet.
    await Promise.all(this.homing.values())
    job.reread = new Set([...(job.reread ?? []), ...fresh])
    const got = await Promise.all(
      fresh.map((k) => {
        let sent = this.resent.get(k)
        if (sent === undefined) {
          // quiet: a key no remote took fails the task, by name
          sent = this.o.artifacts.resend(k).catch(() => false)
          this.resent.set(k, sent)
        }
        return sent
      }),
    )
    return got.includes(true)
  }

  /**
   * Upstream `id` as an order names it, once per graph: its project and
   * outputs. Undefined: it is not in the graph, or leaves no files.
   */
  private dep(nodes: ReadonlyMap<string, TaskNode> | undefined, id: string): DepFiles | undefined {
    if (nodes === undefined) return undefined
    let of = this.deps.get(nodes)
    if (of === undefined) this.deps.set(nodes, (of = new Map()))
    let d = of.get(id)
    if (d === undefined) {
      const n = nodes.get(id)
      const outs = n?.config.cache === true ? n.config.outputs : undefined
      d =
        n === undefined || outs === undefined
          ? null
          : {
              project: path.relative(this.o.root, n.projectDir),
              outputs: { files: [...outs.files], workspaceFiles: [...(outs.workspaceFiles ?? [])] },
            }
      of.set(id, d)
    }
    return d ?? undefined
  }

  private send(a: Worker, jobs: readonly Job[]): void {
    const nodes = this.o.nodes()
    const orders = jobs.map((job): { job: Job; order: RunOrder } => {
      const { req } = job
      const deps: DepOrder[] = []
      // Every one, held there or not: the worker restores each key once, and
      // one it was sent but gave back it never ran or restored.
      for (const id of job.up ?? upstream(nodes, req.taskId)) {
        const d = this.dep(nodes, id)
        const key = this.savedAs.get(id) ?? this.upstreamKeys.get(id) ?? this.o.keyOf(id)
        if (d === undefined || key === undefined) continue
        a.has.add(id)
        deps.push({ task: id, key, project: d.project, outputs: d.outputs })
      }
      // A task sent here leaves its outputs here for its dependants.
      a.has.add(req.taskId)
      const node = nodes?.get(req.taskId)
      const keyed = hostKeyed(req)
      const env = defined(req.env, req.envDefine, keyed)
      const unset = keyed.filter((k) => req.env[k] === undefined && !(k in req.envDefine))
      const order = {
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
        ...(unset.length === 0 ? {} : { unset }),
        ...('PATH' in req.envDefine || req.inputs?.env.some((e) => e.name === 'PATH') === true
          ? { path: true as const }
          : {}),
        ...(node?.config.exec?.env?.secret === undefined
          ? {}
          : { secret: [...node.config.exec.env.secret] }),
        ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
        ...(req.download === 'trailing' ? { trail: true as const } : {}),
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
                ...(req.sandbox.readableDeps === undefined || req.sandbox.readableDeps.length === 0
                  ? {}
                  : {
                      readable: req.sandbox.readableDeps.map((d) => ({
                        task: d.taskId,
                        project: path.relative(this.o.root, d.projectDir),
                        files: [...d.outputs.files],
                        ...(d.outputs.workspaceFiles.length === 0
                          ? {}
                          : { workspaceFiles: [...d.outputs.workspaceFiles] }),
                      })),
                    }),
              },
            }),
        ...runtimeOrders(req),
        ...(req.servers === undefined || req.servers.length === 0
          ? {}
          : {
              servers: req.servers.map((s) => {
                // Its own `env.define`: a defined HOME or PATH ran as the worker's.
                const define = nodes?.get(s.taskId)?.config.exec?.env?.define ?? {}
                return {
                  task: s.taskId,
                  command: s.command,
                  cwd: path.relative(this.o.root, s.cwd),
                  env: defined(s.env, define),
                  ...('PATH' in define ? { path: true as const } : {}),
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
                }
              }),
            }),
      } as RunOrder
      return { job, order }
    })
    const sandboxed = orders.some(
      (o) => o.order.sandbox !== undefined || o.order.servers?.some((s) => s.sandbox !== undefined),
    )
    const sandboxes = sandboxed && !a.sandboxes ? sandboxConfigs(nodes) : undefined
    if (sandboxed) a.sandboxes = true
    const pending = new Set(jobs)
    a.chain = a.chain
      .then(async () => {
        // A dependency the worker was sent under the same key goes by name
        // alone: each order named every upstream whole, and 8000 tasks of a
        // deep graph sent 219 MB (2026-11-05). Read here, as sends go in
        // order: one sent before it fails is not counted as sent.
        const fresh = new Map<string, string>()
        const wired = orders.map(({ job, order }) => {
          const intro: [string, string][] = []
          const deps = order.deps.map((d): WiredDep => {
            if ((fresh.get(d.task) ?? a.sentDeps.get(d.task)) === d.key) return d.task
            fresh.set(d.task, d.key)
            intro.push([d.task, d.key])
            return d
          })
          const sent: SentOrder = { ...order, deps }
          // Measured once: a giant repo's were measured three times each (2026-11-05).
          return { job, order: sent, intro, bytes: bytesOf(sent) }
        })
        for (const [i, part] of parts(wired, BATCH_BYTES).entries()) {
          // An order too long for a frame (a task of thousands of
          // dependencies was refused, 413) sends its deps ahead.
          const tasks: SentOrder[] = []
          let bytes = 0
          for (const { order, bytes: size } of part) {
            if (size <= BATCH_BYTES) {
              tasks.push(order)
              bytes += size
              continue
            }
            for (const deps of chunks(order.deps, BATCH_BYTES)) {
              const ahead = { type: 'deps', task: order.task, deps } satisfies ToWorker
              await this.o.me.send(a.id, ahead)
              a.usage.messagesIn++
              a.usage.bytesIn += bytesOf(ahead)
            }
            const alone = { ...order, deps: [] }
            tasks.push(alone)
            bytes += bytesOf(alone)
          }
          const n = ++a.batches
          // One its worker's loss put back may be another's by now, under that one's batch.
          for (const { job } of part) if (a.busy.get(job.req.taskId) === job) job.batch = n
          const batch = {
            type: 'batch',
            n,
            root: this.o.root,
            realRoot: this.realRoot,
            tasks,
            ...(sandboxes === undefined || i > 0 ? {} : { sandboxes }),
          } satisfies ToWorker
          await this.o.me.send(a.id, batch)
          a.usage.messagesIn++
          // Its orders' bytes, a comma between each, in the batch's own.
          a.usage.bytesIn += bytesOf({ ...batch, tasks: [] }) + bytes + tasks.length - 1
          for (const { intro } of part) for (const [t, k] of intro) a.sentDeps.set(t, k)
          for (const { order } of part)
            for (const sv of order.servers ?? [])
              if (!a.serving.has(sv.task)) a.serving.set(sv.task, 0)
          for (const { job } of part) {
            pending.delete(job)
            // Sent, it runs: its worker takes only what it has room for.
            this.begun(a, job.req.taskId)
          }
          this.pumpSoon()
        }
      })
      .catch((err: unknown) => {
        // The relay refused the send (the worker is gone): the loss notice
        // puts the tasks back.
        if (err instanceof RelayError && err.status === 404) return
        // One its worker never got leaves its booking there: held with no
        // lease to end it, the worker's cores were gone for the run. One
        // sent before runs there, and ends as any; one its worker's loss
        // put back is the queue's.
        for (const job of pending)
          if (a.busy.get(job.req.taskId) === job && this.retry(a, job, 'not sent') !== undefined) {
            job.reject(err)
            // Failed here: it runs nowhere, so its worker's cores are free in the plan too.
            this.bound?.drop(job.req.taskId, this.clock())
          }
        this.pumpSoon()
      })
  }

  /**
   * Worker `a` let `job` down: lost, its report named it no more, or it could not run
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
    delete job.sentAt
    delete job.ended
    delete job.ranAt
    delete job.batch
    const begun = a.started.delete(job.req.taskId)
    // Stopped, it runs nowhere again; the cancel sent its worker has no one to answer it.
    if (job.req.signal?.aborted === true) {
      job.resolve(stopped())
      this.bound?.drop(job.req.taskId, this.clock())
      return undefined
    }
    if (begun) {
      a.faulty = true
      job.faults = [...(job.faults ?? []), `${a.label} ${why}`]
      if (job.faults.length >= 2) {
        job.reject(new Error(`${job.req.taskId}: failed on 2 workers: ${job.faults.join(', ')}`))
        this.bound?.drop(job.req.taskId, this.clock())
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

  private post(a: Worker, m: ToWorker): void {
    a.chain = a.chain.then(() => this.o.me.send(a.id, m)).catch(this.unsent(m.type, a.label))
  }

  private unsent(what: string, to: string): (err: unknown) => void {
    return unsent(this.warn, what, to)
  }

  private readonly warn = (m: string): void =>
    (this.o.warn ?? ((l) => ui.say('warn', l)))(`[vx] ${m}`)

  /** Worker `a` began `task`: from now its cores are booked. */
  private begun(a: Worker, task: string): void {
    const job = a.busy.get(task)
    if (job === undefined || a.started.has(task)) return
    a.started.add(task)
    job.startedAt = performance.now()
    a.usage.book(job.held?.cores ?? 0)
  }

  /** Worker `a` ran `task` and saved it under `key`: it is done there, and done here once restored. */
  private async finish(
    a: Worker,
    task: string,
    key: string,
    head: WiredResult,
    endedAt: number | undefined,
    sentLog?: CapturedChunk[],
  ): Promise<void> {
    const job = a.busy.get(task)
    if (job === undefined) return
    // A dependency's remote copy did not read back there (a truncated
    // upload): sent again from this machine, the task runs again. Taken as
    // the task's failure, it failed every run, the remote saying it held the
    // key (2026-10-25).
    if (head.unread !== undefined) {
      const sent = await this.resend(job, head.unread)
      // Its worker was lost meanwhile: the task went back to the queue.
      if (a.busy.get(task) !== job) return
      if (sent) {
        // Its cores back while it still counts as begun, which `unhold` reads;
        // then not begun, so `retry` holds no fault against its worker.
        this.unhold(a, job)
        a.started.delete(task)
        const again = this.retry(a, job, `could not read ${head.unread.join(', ')}`)
        if (again !== undefined) {
          this.enqueue([again])
          this.pumpSoon()
        }
        return
      }
    }
    const endAt = endedAt ?? performance.now()
    this.traceTask(a, job, head, endAt)
    a.busy.delete(task)
    const room = job.held?.cores ?? 1
    this.unhold(a, job)
    // its command's own time, what its `ran` could not say (`Engine.finished`); a failure's says nothing of the run's speed
    this.bound?.finished(
      task,
      endAt - this.startedAt,
      head.exitCode === 0 ? head.durationMs : undefined,
    )
    a.started.delete(task)
    a.ran++
    a.done.push(task)
    a.usage.record(head, job.sentAt)
    const share = shareOf(head.cpuShare)
    // At least as long as it ran: begun here once its batch's send resolved,
    // which can be after its worker began it, it was seen for less, and its
    // CPU over that read as more cores than it had (#5036: 1.001 each, so
    // two that ran side by side on 2 cores replayed one after the other).
    const held = Math.max(
      1,
      head.durationMs,
      job.startedAt === undefined ? 0 : endAt - job.startedAt,
    )
    const sent = job.sentAt ?? endAt
    // Made again for a dependant: its first run stays the task's own, or
    // the wait from its dependencies' end to this second ask read as
    // files coming home (main 643d38d: 118.8 s of them, for a build made
    // again in 18 s).
    if (job.again !== undefined) {
      const runs = this.madeAgain.get(task)
      const run: [number, number] = [Math.min(job.queuedAt ?? sent, sent), endAt]
      if (runs === undefined) this.madeAgain.set(task, [run])
      else runs.push(run)
    } else
      this.timeline.set(task, {
        queued: Math.min(job.queuedAt ?? sent, sent),
        sent,
        began: Math.max(sent, Math.min(endAt, job.startedAt ?? sent)),
        end: endAt,
        joined: a.joinedAt,
      })
    this.took.set(task, {
      ms: held,
      // The cores it held, or used if more, over the time it held: its
      // free cores over its crowded length counted the crowd twice
      // (6a7224f: ideal 127.8 s, real 111.0 s). Never the average it used
      // alone: at their 0.5-core average the ideal placed 7 test shards a
      // 4-core worker, as long as each took at 4 a worker, where 8 a
      // worker ran 146-199 s each for 50-100 s (main c2adbdd); so full
      // runs read 50-60 s past an ideal no placing reaches (2026-11-13).
      cores: Math.min(a.cores, head.cpuMs === undefined ? room : Math.max(room, head.cpuMs / held)),
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
    this.ranOn.set(task, a.id)
    const node = this.o.nodes()?.get(task)
    if (head.exitCode === 0 && node !== undefined && leaves(node))
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
    const eager = job.req.remoteOnly !== true && !deferred
    // An upstream's files still on their way land first: laid after this
    // task's, they would lie over what it wrote on them.
    const upstream = (): Promise<unknown> =>
      Promise.all((node?.deps ?? []).map((d) => this.homing.get(d)))
    const where = {
      where: a.label,
      machine: {
        cores: a.reported.cores,
        memoryBytes: a.reported.memory,
        ...(share < 1 ? { cpuShare: share } : {}),
      },
    }
    // Done once it ran there, its output in hand: its files come meanwhile,
    // and the run waits for them at its end. Waited for here, the task that
    // needed them on a worker started 2.6 s late behind a 91 MB docs build
    // (main f04866b).
    if (eager && job.req.download === 'trailing' && head.exitCode === 0 && sentLog !== undefined) {
      const landed = (async () => {
        await upstream()
        await this.clear(job, node)
        const got = (await restore()) ?? (await restore())
        this.trace.slice({
          track: ORCHESTRATOR,
          name: task,
          cat: 'restore',
          from: endAt,
          to: performance.now(),
        })
        if (got === null)
          throw new Error(`no cache this machine reads gave its entry ${key}, asked twice`)
        await this.unlay(task, head, job, node)
      })()
      const settled: Promise<void> = landed
        .catch(() => {
          // quiet: `landed` is the run's to hear
        })
        .then(() => {
          if (this.homing.get(task) === settled) this.homing.delete(task)
        })
      this.homing.set(task, settled)
      for (const c of sentLog) (c.err ? job.req.onStderr : job.req.onStdout)(c.text)
      job.resolve({ ...result(head, sentLog), outputs: { kind: 'trailing', landed }, ...where })
      return
    }
    // It declares no output and its log came with its end: nothing is left
    // to bring, and core saves its entry here from what it has, as after a
    // restore. Read back first, every test shard and lint ended a download
    // later than its worker said (main 0c7607b: 0.5 s after shard-16, the
    // run's last task).
    if (
      eager &&
      head.exitCode === 0 &&
      sentLog !== undefined &&
      job.req.outputs.files.length === 0 &&
      (job.req.outputs.workspaceFiles ?? []).length === 0
    ) {
      for (const c of sentLog) (c.err ? job.req.onStderr : job.req.onStdout)(c.text)
      job.resolve({ ...result(head, sentLog), ...where })
      return
    }
    const read = () => (eager ? restore() : this.o.artifacts.output(key))
    // A failed download reads as a miss: asked once more, since one stalled
    // download failed a CI run whose upload had landed (main, 2026-10-28).
    const log = await (eager ? upstream().then(() => this.clear(job, node)) : Promise.resolve())
      .then(read)
      .then((got) => got ?? read())
      .catch((err: unknown) => {
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
          `${task}: ${a.label} ran it, and no cache this machine reads gave its entry, asked twice: a download failed (warned above), or the workers and this machine share no remote cache the workers write`,
        ),
      )
      return
    }
    if (eager) await this.unlay(task, head, job, node)
    // In the order the task wrote it: replayed a stream at a time, an error
    // line came after the stdout that followed it (2026-10-25).
    for (const c of log) (c.err ? job.req.onStderr : job.req.onStdout)(c.text)
    job.resolve({
      ...result(head, log),
      ...(deferred
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
      ...where,
    })
  }

  /**
   * Removes here what `task` removed where it ran, once its files are laid.
   */
  private async unlay(
    task: string,
    head: WiredResult,
    job: Job,
    node: TaskNode | undefined,
  ): Promise<void> {
    // An upstream's file the task removed there is gone here too: a restore
    // lays files, never removes one, and this disk is what core saves from.
    if (head.removed === undefined) return
    const ours = names(path.relative(this.o.root, node?.projectDir ?? job.req.cwd), job.req.outputs)
    // A link on the path (`dist/in -> ../../other`) would lead the rm
    // into another project or off the workspace: the path is removed only
    // where it is, as a restore lays a file only there (archive.ts).
    const real = new Map<string, Promise<string | undefined>>()
    for (const f of head.removed) {
      if (typeof f !== 'string' || f.split('/').includes('..') || !ours(f)) continue
      const dir = path.dirname(f)
      let at = real.get(dir)
      if (at === undefined)
        real.set(
          dir,
          (at = realpath(path.join(this.o.root, dir)).catch(
            // quiet: a dir that is gone holds nothing to remove
            () => undefined,
          )),
        )
      const where = await at
      if (where === undefined) continue
      if (where === path.join(this.realRoot, dir))
        await rm(path.join(this.o.root, f), { force: true })
      else
        this.warn(
          `dte: ${task}: kept ${f}, which the worker removed: a link on its path leads elsewhere`,
        )
    }
  }

  /**
   * Clears what its worker cleared before `job`'s task ran: an earlier
   * run's files under its outputs, not committed ones, nested projects' or
   * its dependencies'. A restore lays files and removes none, so a file
   * the task no longer writes, or deleted (an uncached `rm -rf dist`, which
   * core cleans nothing for), stayed beside its new ones (2026-11-10).
   */
  private async clear(job: Job, node: TaskNode | undefined): Promise<void> {
    if (job.req.outputs.files.length + job.req.outputs.workspaceFiles.length === 0) return
    this.inTree ??= listTree(this.o.root, this.o.tree)
    const tree = await this.inTree
    // No list of the committed files: none is told from the rest.
    if (tree === undefined) return
    const nodes = this.o.nodes()
    const held = [...(job.up ?? upstream(nodes, job.req.taskId))].flatMap((id) => {
      const d = this.dep(nodes, id)
      return d === undefined ? [] : [names(d.project, d.outputs)]
    })
    const project = path.relative(this.o.root, node?.projectDir ?? job.req.cwd)
    const nested = node === undefined ? [] : nestedIn(nodes!, node.projectDir, this.o.root)
    const under = await outputFiles(this.o.root, project, job.req.outputs)
    for (const f of leftUnder(under, tree.files, nested, held).cleared)
      await rm(path.join(this.o.root, f), { force: true })
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
        ...(job.spent === undefined
          ? {}
          : { checkMs: job.spent.check, saveMs: job.spent.save, uploadMs: job.spent.upload }),
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

  /**
   * Why a worker's tree is not the run's: a project of the run its tree
   * lacks first, the likely cause (a worktree without it, whose install
   * rewrote bun.lock), then the tracked files the worker changed. Two
   * hashes alone sent every worker away with no lead (2026-11-11).
   */
  private async otherTree(tree: unknown, changed: unknown): Promise<string> {
    const why = [`checked out tree ${String(tree)}, the run is on ${this.o.tree}`]
    const nodes = this.o.nodes()
    if (nodes !== undefined) {
      this.inTree ??= listTree(this.o.root, this.o.tree)
      const listed = await this.inTree
      for (const n of listed === undefined ? [] : nodes.values()) {
        const dir = path.relative(this.o.root, n.projectDir)
        if (dir === '' || dir.startsWith('..') || holds(listed!, dir)) continue
        why.push(
          `${dir} is untracked, so no worker has it: git add its project (and commit it for workers on CI)`,
        )
        break
      }
    }
    if (
      Array.isArray(changed) &&
      changed.length > 0 &&
      changed.every((f) => typeof f === 'string')
    ) {
      const named = changed.slice(0, CHANGED_NAMED).join(', ')
      why.push(
        `it changed tracked ${named}${changed.length > CHANGED_NAMED ? ' and more' : ''} after checkout, as a prepare step (an install) can`,
      )
    }
    return why.length === 1 ? why[0]! : `${why[0]}: ${why.slice(1).join('; ')}`
  }

  private onRelay(body: { type?: string; id?: string; info?: unknown }): void {
    if (body.type === 'joined') {
      const info = body.info as Partial<WorkerInfo> | null
      const id = body.id!
      // Only the worker heard why: the run sat silent and its footer said
      // none joined (2026-11-07).
      const refuse = (reason: string): void => {
        this.refused.push(reason)
        this.warn(`dte: refused worker ${typeof info?.id === 'string' ? info.id : id}: ${reason}`)
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
        void this.otherTree(info.tree, info.changed).then(refuse)
        return
      }
      const platform = typeof info.platform === 'string' ? info.platform : undefined
      const sized = info.id === undefined ? undefined : this.spawnedAt.get(info.id)?.declared
      if (sized?.platform !== undefined && platform !== sized.platform) {
        return refuse(
          `runs on ${platform ?? 'no platform it names'}, and its size ${sized.size} says ${sized.platform}`,
        )
      }
      if (info.id !== undefined && this.cancelled.has(info.id)) {
        this.turnedAway.add(info.id)
        void this.o.me
          .send(id, { type: 'exit' } satisfies ToWorker)
          .catch(this.unsent('exit', info.id))
        return
      }
      // A worker this run started keeps the name it was started under;
      // one that joined on its own is numbered in the order it joined.
      const spawn = info.id === undefined ? undefined : this.spawnedAt.get(info.id)
      const asked = spawn?.at
      const taken = this.joinedLabels()
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
      this.workers.set(id, {
        id,
        warmUpMs,
        joinedAt: performance.now(),
        declared: spawn?.declared,
        ran: 0,
        done: [],
        usage: new Usage(),
        cores,
        memory,
        reported: { cores: Number(info.cores), memory: Number(info.memory) },
        platform: this.o.joinedPlace?.(spawn?.declared.size, platform) ?? platform,
        usedCores: 0,
        usedMemory: 0,
        label,
        busy: new Map(),
        started: new Set(),
        batches: 0,
        has: new Set(),
        serving: new Map(),
        sentDeps: new Map(),
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
      if (this.bound !== undefined) this.adopted(this.bound, this.workers.get(id)!, this.clock())
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
    this.bound?.lost(a.label, this.clock())
    a.usage.to = performance.now()
    this.trace.left(a.label, 'lost', a.usage.to)
    this.gone.push(a)
    // Its results' `end`s never come.
    for (const k of this.parts.keys()) if (k.startsWith(`${a.id}\0`)) this.parts.delete(k)
    // Its tasks run again: first, as they were first to go.
    const back: Job[] = []
    for (const j of [...a.busy.values()]) {
      const again = this.retry(a, j, 'lost')
      if (again !== undefined) back.push(again)
    }
    this.enqueue(back)
    this.o.lost?.(a.label)
    // Now, not a tick later: a worker it asks for in its place keeps the run from stranding.
    this.pump()
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
        const frame = wiredFrame(body)
        if (frame === undefined) {
          this.warn(`dte: dropped a message from ${a.label} that is not its protocol`)
          continue
        }
        // A worker's times, read against its clock as this frame left it:
        // no two machines' clocks agree.
        const now = performance.now()
        let at: number | undefined
        for (const m of frame) if ('load' in m && m.load?.at !== undefined) at = Number(m.load.at)
        const here = (t: unknown): number | undefined =>
          at === undefined || typeof t !== 'number' || !Number.isFinite(at - t)
            ? undefined
            : Math.min(now, now - (at - t))
        for (const m of frame) {
          if ('load' in m && m.load !== undefined) this.heard(a, m.load)
          if (m.type !== 'report') this.movedAt = performance.now()
          if (m.type === 'report') {
            // Every task of the batches it read that has not ended is in its
            // report: one missing it no longer runs, and goes back at once.
            const running = new Set(m.running)
            const read = Number(m.batch) || 0
            const back: Job[] = []
            for (const [t, j] of [...a.busy])
              if (
                a.started.has(t) &&
                j.ended !== true &&
                (j.batch ?? 0) <= read &&
                !running.has(t)
              ) {
                const again = this.retry(a, j, 'not in its report')
                if (again !== undefined) back.push(again)
              }
            if (back.length > 0) {
              this.enqueue(back)
              this.o.faulted?.()
              // Now, as a loss does: a worker the plan asks in its place keeps the run from stranding.
              this.pump()
              if (this.spawnedAt.size > 0)
                this.stranded(`${a.label} no longer runs a task it began and no worker is left`)
            }
            this.pumpSoon()
          } else if (m.type === 'ran') {
            // Its command ended: its cores are the next task's while it saves.
            const j = a.busy.get(m.task)
            if (j === undefined) continue
            this.begun(a, m.task)
            this.unhold(a, j)
            this.bound?.finished(m.task, this.clock())
            // Its worker still says it holds it while it saves.
            j.startedAt = here(m.startedAt) ?? j.startedAt ?? now
            j.ranAt = here(m.ranAt) ?? now
            this.pumpSoon()
          } else if (m.type === 'fault') {
            const j = a.busy.get(m.task)
            if (j === undefined) continue
            // It began it whether or not its `start` came first.
            this.begun(a, m.task)
            if (this.retry(a, j, m.reason) !== undefined) this.enqueue([j])
            if (a.faulty) this.o.faulted?.()
            // Now, as a loss does: a worker the plan asks in its place keeps the run from stranding.
            this.pump()
            if (a.faulty && this.spawnedAt.size > 0)
              this.stranded(
                `${a.label} could not run ${m.task} (${m.reason}) and no worker is left`,
              )
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
            const j = a.busy.get(m.task)
            if (j !== undefined) {
              j.ended = true
              const sp = m.spent
              if (
                typeof sp === 'object' &&
                sp !== null &&
                [sp.check, sp.save, sp.upload].every((n) => Number.isFinite(n) && n >= 0)
              )
                j.spent = { check: sp.check, save: sp.save, upload: sp.upload }
              const began = here(m.startedAt)
              const ran = here(m.ranAt)
              if (began !== undefined) j.startedAt = began
              if (ran !== undefined) j.ranAt = ran
            }
            void this.finish(
              a,
              m.task,
              m.key,
              result as WiredResult,
              here(m.endedAt),
              wiredLog(m.log),
            )
          }
        }
      }
      this.stall()
    }
  }

  /** The worker running a task; `null` while it waits, here or in a worker's queue, for one to begin it. */
  where(taskId: string): string | null | undefined {
    for (const a of this.workers.values())
      if (a.busy.has(taskId)) return a.started.has(taskId) ? a.label : null
    return this.waiting.has(taskId) || this.handed.has(taskId) ? null : undefined
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
   * The planner made, in the profile: what history said of each task and
   * each size's warm-up (`input`), from which `scripts/fixture.ts` replays
   * the run in the sim.
   */
  planning(input: {
    readonly tasks: readonly {
      id: string
      ms?: number
      afterMs?: number
      cores: number
      memory: number
    }[]
    readonly warmUps: Readonly<Record<string, number>>
    /** Each size's join spread an earlier run learned (`measures.ts` `spreadId`). */
    readonly spreads?: Readonly<Record<string, number>>
    /** Each size's pace an earlier run learned (`measures.ts` `paceId`). */
    readonly paces?: Readonly<Record<string, number>>
    /** Each size's spread of took / history an earlier run learned (`measures.ts` `paceSpreadId`). */
    readonly paceSpreads?: Readonly<Record<string, number>>
  }): void {
    this.trace.mark(ORCHESTRATOR, 'plan', {
      tasks: input.tasks.length,
      input: JSON.stringify(input),
    })
  }

  /** Planning goes on: something outside the orchestrator changed (history, the run's work). */
  poke(): void {
    this.pumpSoon()
  }

  /** `demand` asked the adapter for worker `id` (`WorkerSpawn.id`). */
  spawned(id: string, declared: Declared): void {
    // No join limit and no ask in its place: a worker asked is waited on
    // until its job ends (`failed`) or the run does. Given up and asked
    // again, a queued job took a runner only to be told to exit (2026-11-19).
    this.spawnedAt.set(id, { at: performance.now(), declared })
  }

  /**
   * Workers `ids` leave (`exit`) if still idle, and each faulty idle one:
   * none comes back. Of `ids`, each started and not joined is cancelled:
   * the ones returned, for the adapter to stop; one that joins anyway is
   * told to exit at once.
   */
  release(ids: Iterable<string>): string[] {
    for (const a of this.workers.values()) if (a.faulty && a.busy.size === 0) this.letGo(a)
    const joined = this.joinedLabels()
    const cancelled: string[] = []
    for (const id of ids) {
      const a = this.workers.get(id)
      if (a !== undefined) {
        if (a.busy.size === 0) this.letGo(a)
      } else if (
        this.spawnedAt.has(id) &&
        !joined.has(id) &&
        !this.unstarted.has(id) &&
        !this.unstoppable.has(id)
      ) {
        this.cancelled.add(id)
        this.cancelledAt.set(id, performance.now())
        cancelled.push(id)
        this.trace.unstarted(id, this.spawnedAt.get(id)!.at, 'cancelled: not needed')
      }
    }
    return cancelled
  }

  /**
   * Of `ids`, let go before they joined, those its adapter could not stop
   * (`DteAdapter.cancel`): each counts as starting again and is taken when
   * it joins. The ones returned; one told to exit already is gone.
   */
  leftRunning(ids: Iterable<string>): string[] {
    const out: string[] = []
    for (const id of ids)
      if (this.cancelled.has(id) && !this.turnedAway.has(id)) {
        this.cancelled.delete(id)
        this.unstoppable.add(id)
        out.push(id)
        // the planner counts it again: its setup is paid
        const declared = this.spawnedAt.get(id)?.declared
        if (declared !== undefined)
          this.bound?.adopt(id, declared.size, placeOf(declared), declared.cpu, this.clock())
      }
    if (out.length > 0) this.pumpSoon()
    return out
  }

  private letGo(a: Worker): void {
    this.workers.delete(a.id)
    this.bound?.lost(a.label, this.clock())
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
  failed(id: string, reason: string): void {
    if (this.ended || this.cancelled.has(id)) return
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
      this.bound?.lost(id, this.clock())
      this.o.lost?.(id)
      this.pump()
    }
    this.stranded(`no worker could start: ${id} ${reason}`)
  }

  /** Nothing online that takes work, none still starting: no task can run. */
  private stranded(reason: string): void {
    const joined = this.joinedLabels()
    const starting = [...this.spawnedAt.keys()].some((s) => this.starting(s, joined))
    const working = [...this.workers.values()].some((a) => !a.faulty)
    if (!working && !starting) this.fail(reason)
  }

  /** Every task sent here and not done fails with `reason`; later ones too. */
  private fail(reason: string): void {
    const now = performance.now()
    for (const a of this.workers.values()) {
      for (const j of a.busy.values()) j.reject(new Error(reason))
      // Lost, keeping what it ran: dropped, the footer read it as never joined.
      a.usage.to = now
      this.trace.left(a.label, 'lost', now)
      this.gone.push(a)
    }
    for (const j of this.waiting.values()) j.reject(new Error(reason))
    this.waiting.clear()
    this.workers.clear()
    this.lost = reason
  }

  /** Why the relay was given up on; then every task runs here. */
  lost: string | undefined
}

/**
 * A worker's frame as messages the loop reads without throwing, or undefined:
 * the relay carries it, and a null body or a `part` list that was no array
 * threw out of the loop and ended the run on a TypeError.
 */
function wiredFrame(body: unknown): ToOrchestrator[] | undefined {
  const record = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
  if (!record(body)) return undefined
  const frame = body['type'] === 'together' ? body['messages'] : [body]
  if (!Array.isArray(frame)) return undefined
  for (const m of frame as unknown[]) {
    if (!record(m) || typeof m['type'] !== 'string') return undefined
    if (m['load'] !== undefined && !record(m['load'])) return undefined
    if (m['type'] === 'report') {
      if (!Array.isArray(m['running'])) return undefined
    } else if (['ran', 'fault', 'part', 'end'].includes(m['type'])) {
      if (typeof m['task'] !== 'string') return undefined
      const lists = m['type'] === 'end' ? m['result'] : m
      if (!record(lists)) return undefined
      if (PART_LISTS.some((l) => lists[l] !== undefined && !Array.isArray(lists[l])))
        return undefined
    }
  }
  return frame as ToOrchestrator[]
}

/** An `end`'s `log` as chunks, or undefined when it is not one: a worker's word, checked. */
function wiredLog(log: unknown): CapturedChunk[] | undefined {
  if (!Array.isArray(log)) return undefined
  const out: CapturedChunk[] = []
  for (const c of log as unknown[]) {
    if (typeof c !== 'object' || c === null) return undefined
    const { text, err } = c as { text?: unknown; err?: unknown }
    if (typeof text !== 'string' || typeof err !== 'boolean') return undefined
    out.push({ text, err })
  }
  return out
}

function result(r: WiredResult, log: readonly CapturedChunk[]): ExecuteResult {
  const { cpuShare: _, removed: __, unread: ___, ...rest } = r
  const violations = (r.violations ?? []).map((v) => ({ ...v, timestamp: new Date(v.timestamp) }))
  const of = (err: boolean) =>
    log
      .filter((c) => c.err === err)
      .map((c) => c.text)
      .join('')
  return { ...rest, stdout: of(false), stderr: of(true), violations, outputs: { kind: 'disk' } }
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
    of = {
      dirs: [...new Set([...nodes.values()].map((n) => n.projectDir))].sort(),
      by: new Map(),
    }
    nested.set(nodes, of)
  }
  let out = of.by.get(dir)
  if (out === undefined) {
    // Sorted, the ones under `dir` lie together: each project read every
    // project, 16 million reads for 4000 (2026-11-05).
    const under = dir + path.sep
    let lo = 0
    let hi = of.dirs.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (of.dirs[mid]! < under) lo = mid + 1
      else hi = mid
    }
    const found: string[] = []
    for (let i = lo; i < of.dirs.length && of.dirs[i]!.startsWith(under); i++)
      found.push(path.relative(root, of.dirs[i]!))
    out = found.sort()
    of.by.set(dir, out)
  }
  return [...out]
}
const nested = new WeakMap<
  ReadonlyMap<string, TaskNode>,
  { dirs: string[]; by: Map<string, readonly string[]> }
>()

/** A tree's files, each path with its identity as core keys it, and its submodules' (gitlinks); `dirs` once asked. */
type Tree = { files: Map<string, string>; links: string[]; dirs?: Set<string> }

/** Whether `tree` has a file under `dir`, or `dir` in a submodule (checked out or not, its own say). */
function holds(tree: Tree, dir: string): boolean {
  if (tree.dirs === undefined) {
    const dirs = (tree.dirs = new Set<string>())
    const above = (f: string): void => {
      for (let d = path.posix.dirname(f); d !== '.' && !dirs.has(d); d = path.posix.dirname(d))
        dirs.add(d)
    }
    for (const f of tree.files.keys()) above(f)
    for (const l of tree.links) above(l)
  }
  return tree.dirs.has(dir) || tree.links.some((l) => dir === l || dir.startsWith(`${l}/`))
}

/** `tree`'s files and submodules under `root`, relative to it; undefined when git cannot list it. */
async function listTree(root: string, tree: string): Promise<Tree | undefined> {
  let p
  try {
    p = Bun.spawn(['git', 'ls-tree', '-r', '-z', tree], {
      cwd: root,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    })
  } catch {
    // quiet: no git, or no root, is git unable to say.
    return undefined
  }
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  if (code !== 0) return undefined
  const files = new Map<string, string>()
  const links: string[] = []
  for (const e of out.split('\0')) {
    const tab = e.indexOf('\t')
    if (tab === -1) continue
    const name = e.slice(tab + 1)
    // `<mode> <type> <oid>`: core's identity is the OID, the mode before it unless a plain file's.
    const [mode, , oid] = e.slice(0, tab).split(' ')
    if (mode === '160000') links.push(name)
    else files.set(name, mode === '100644' ? oid! : `${mode}:${oid}`)
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
 * A task and an upstream of it that `leaves` files, which `bound` says
 * cannot run where the task does (its `exec.worker` or `exec.platforms`):
 * the task reads those files where the upstream ran, or runs it again
 * where it runs itself. Undefined when none.
 */
export function apart(
  nodes: ReadonlyMap<string, TaskNode>,
  bound: (upstream: TaskNode, dependant: TaskNode) => boolean,
): { upstream: string; dependant: string } | undefined {
  const runs = (n: TaskNode): boolean =>
    n.config.exec?.command !== undefined && n.config.exec.persistent === undefined
  const named = [...nodes.values()].filter(
    (n) =>
      runs(n) &&
      leaves(n) &&
      (n.config.exec?.worker !== undefined || n.config.exec?.platforms !== undefined),
  )
  if (named.length === 0) return undefined
  const below = new Map<string, string[]>()
  for (const n of nodes.values())
    for (const d of n.deps) {
      const of = below.get(d)
      if (of === undefined) below.set(d, [n.id])
      else of.push(n.id)
    }
  for (const u of named) {
    const seen = new Set<string>()
    const walk = [...(below.get(u.id) ?? [])]
    for (let id = walk.pop(); id !== undefined; id = walk.pop()) {
      if (seen.has(id)) continue
      seen.add(id)
      const d = nodes.get(id)
      if (d === undefined) continue
      if (runs(d) && bound(u, d)) return { upstream: u.id, dependant: id }
      walk.push(...(below.get(id) ?? []))
    }
  }
  return undefined
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

/** A size naming no platform is this machine's, as `dte()` planned it. */
const placeOf = (d: Declared): string => d.place ?? d.platform ?? hostPlatform()
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
 * worker's (`HOST_ENV`) unless `define` sets it or the task keys it
 * (`keyed`). A defined `HOME` ran with the worker's own, saved under a key
 * that folded the defined one (2026-10-24); a keyed `XDG_CONFIG_HOME` did
 * the same (2026-11-07).
 */
function defined(
  env: NodeJS.ProcessEnv,
  define: Readonly<Record<string, string>>,
  keyed: readonly string[] = [],
): Record<string, string> {
  // No prototype: on `{}`, a name `__proto__` hit the setter and was not sent.
  const out: Record<string, string> = Object.create(null)
  for (const [k, v] of Object.entries(env))
    if (v !== undefined && (!HOST_ENV.includes(k) || k in define || keyed.includes(k))) out[k] = v
  return out
}

/** The `HOST_ENV` names the task's `inputs.env` keys: their value is this machine's, as keyed. */
function hostKeyed(req: ExecuteRequest): string[] {
  return (req.inputs?.env ?? []).map((e) => e.name).filter((k) => HOST_ENV.includes(k))
}
