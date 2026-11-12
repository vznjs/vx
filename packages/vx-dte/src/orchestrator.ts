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
  type MachineReport,
  type SandboxConfig,
  type TaskArtifacts,
  type TaskNode,
  type WorkerAdvice,
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
import {
  advise,
  leaves,
  leftMs,
  simulate,
  UNKNOWN_MS,
  type Fleets,
  type PlanTask,
  type PlanWorker,
  type Size,
  spreadMs,
  type WarmUp,
} from './plan/index.js'
import { Usage, type UsageStats } from './usage.js'
import { type Need, Placing, Queue, type Soon } from './plan/index.js'
import { DEFAULT_STRATEGY, MIN_CORES, type Strategy } from './plan/index.js'
import { RelayError, unsent, type Participant } from './wire.js'
import { ORCHESTRATOR, Trace } from './trace.js'
import { leftUnder, names, outputFiles } from './outputs.js'

/** What a task is expected to hold while it runs, from its history; `Infinity`: a whole worker (one that filled its worker). */

/** What kept a run from its ideal, in ms along the chain that ended it (`driftOf`). */
interface Drift {
  /** Waiting for a worker to join, past the fastest warm-up. */
  readonly joining: number
  /** Waiting for room on a joined worker. */
  readonly room: number
  /** From its send to its worker beginning it: its inputs reaching it. */
  readonly sending: number
  /** The run's time after its last task. */
  readonly after: number
}

interface Job {
  readonly req: ExecuteRequest
  /** Read as it joined the queue, and again while it waits when history changes (`rerank`). */
  need: Need
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
  /** When it joined. */
  readonly joinedAt: number
  /** The size it was started as, when this run started it. */
  readonly declared: Declared | undefined
  /** Tasks it finished. */
  ran: number
  /** Their ids, for the summary of a worker that ran few: what held it. */
  readonly done: string[]
  readonly usage: Usage
  /** Sent to it and not finished: running there or in its queue. */
  readonly busy: Map<string, Job>
  /** Of `busy`, the ones it began: each one sent, as a worker runs what it takes at once. */
  readonly started: Set<string>
  /** Batches sent it: each batch's `n`. */
  batches: number
  usedCores: number
  usedMemory: number
  /** Its machine's use as its last frame said, and when this machine heard it. */
  load?: { cpu: number; memory: number; at: number }
  /** Cores its machine spends on no task of the run while it runs some, averaged over its frames (`heard`). */
  other?: number
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
  /** It failed a task it began: it gets no more. */
  faulty: boolean
}

/** How far each frame moves a worker's `other`: a frame read as a task starts lags it. */
const OTHER_WEIGHT = 0.25

/** What a worker was started as: its size's `cpu` and `memory` in bytes. */
export interface Declared {
  readonly size: string
  readonly cpu: number
  readonly memory: number
  /** Its size's platform: a worker reporting another is refused. None: planned as this machine's. */
  readonly platform?: string
  /** Where tasks match it when the run has several worker types: `<type>:<platform>`. */
  readonly place?: string
}

export interface OrchestratorOptions {
  readonly me: Participant
  readonly root: string
  /** The tree of the run's tracked files (`tree.ts`). */
  readonly tree: string
  readonly nodes: () => ReadonlyMap<string, TaskNode> | undefined
  readonly need: (taskId: string) => Need
  /** Each server's base, cores, as workers fit them: updated in place. */
  readonly bases?: Map<string, number>
  /** A size's cores its machines spent besides an earlier run's tasks (`othersOf`). */
  readonly learnedOther?: (size: string) => number | undefined
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
  /** Worker `id`, given up as late (`overdue`), joined after all and is taken. */
  readonly kept?: (id: string) => void
  /** A worker failed a task or dropped it: the run plans again, now, so a replacement starts. */
  readonly faulted?: () => void
  /** How much of the run waits on a task (`tailsMs`): the queue places the most first. */
  readonly tail?: (taskId: string) => number
  /** A task's time as history says it (ms): when a running one ends, and what a hold keeps from (`Hold`). */
  readonly ms?: (taskId: string) => number | undefined
  /**
   * Tasks about to be ready, given when each running one ends (ms from
   * now): the queue keeps room for them (`holdFor`), highest rank first.
   */
  readonly soon?: (ends: ReadonlyMap<string, number>) => readonly (Soon & { readonly id: string })[]
  /** With `soon`: the tasks about to be ready once task `id` is given (`Dispatching.next`). */
  readonly next?: (id: string, ends: ReadonlyMap<string, number>) => readonly Soon[]
  /** How waiting tasks are ordered and placed (`Strategy`). */
  readonly how?: Strategy
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
/** A worker that ran this many tasks or fewer names them in the summary. */
const FEW = 2
/** The unmeasured tasks the summary names; the rest it counts. */
const NAMED = 40
/** The footer's label of each `WorkerAdvice`. */
const ADVICE: Record<WorkerAdvice['of'], readonly [label: string, note: string]> = {
  declared: ['best', 'the fewest of its sizes'],
  more: ['more', "past its sizes' max"],
  any: ['any', 'of any cores, the least core time'],
}
/** A platform as shown: a worker type's place (`ubuntu:linux-x64`) without its type, which its size names. */
const bare = (platform: string): string => platform.slice(platform.indexOf(':') + 1)
/** `3 × small (4c/16G linux)`. */
const fleetText = (w: WorkerAdvice['workers'][number]): string =>
  `${w.count} × ${w.size === undefined ? '' : `${w.size} `}(${w.cores}c/${compact(w.memoryBytes)}${w.platform === undefined ? '' : ` ${w.platform}`})`
/** Core-time of history the run's tasks finish before their use reshapes bookings: a few tasks' worth. */
const LEARN_MS = 60_000
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

export class Orchestrator {
  private readonly workers = new Map<string, Worker>()
  /** The run tree's files, workspace-relative, listed when a task first asks. */
  private inTree?: Promise<Tree | undefined>
  /** Waiting tasks, by id, in the order a pump reads them (`Queue`). */
  private readonly waiting = new Map<string, Job>()
  /** Handed by core and not yet waiting: held for a machine as the waiting are. */
  private readonly handed = new Set<string>()
  private readonly queue: Queue
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
  /** A task waited here on a worker: one ended with none joined needed one. */
  private waited = false
  /** Why each worker this run refused was refused, in order. */
  private readonly refused: string[] = []
  /** Started, then not needed before they joined (`release`), or given up as late. */
  private readonly cancelled = new Set<string>()
  /** When each cancelled one was: held from its ask until then (`heldMs`). */
  private readonly cancelledAt = new Map<string, number>()
  /** When each worker a plan drained stops taking tasks (`drain`). */
  private readonly drainAt = new Map<string, number>()
  /** Whether a plan's whole input was marked (`planned`). */
  private inputMarked = false
  /** Where and when the last plan gave each task (`place`). */
  private readonly placing = new Placing()
  /** The pump at the next planned start (`Placing.next`). */
  private due: { at: number; timer: ReturnType<typeof setTimeout> } | undefined
  /** Of `cancelled`, those given up past their join limit, not let go: taken if they join. */
  private readonly late = new Set<string>()
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
  /** Each task a worker ran: when it joined the queue, was sent, began and ended, and when its worker joined. */
  private readonly timeline = new Map<
    string,
    { queued: number; sent: number; began: number; end: number; joined: number }
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
  /** The plugins any of the run's lends lent a token. */
  private readonly lenders = new Set<string>()
  /** Each graph's upstreams as orders name them (`dep`). */
  private readonly deps = new WeakMap<ReadonlyMap<string, TaskNode>, Map<string, DepFiles | null>>()

  constructor(private readonly o: OrchestratorOptions) {
    this.sent = o.sent ?? new Map()
    this.queue = new Queue(o.how ?? DEFAULT_STRATEGY, o.tail, (id) => this.waiting.get(id)!.need)
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
        resolve,
        reject,
      }
      // A retry runs elsewhere: the worker, or what ran beside it, may be the flake.
      const last = (req.attempt ?? 1) > 1 ? this.ranOn.get(req.taskId) : undefined
      if (last !== undefined) job.avoid = last
      this.handed.delete(req.taskId)
      // A signal aborted already fires no `abort`.
      if (req.signal?.aborted === true) return resolve(stopped())
      req.signal?.addEventListener('abort', () => this.abort(job), { once: true })
      this.enqueue([job])
      this.pumpSoon()
    })
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
      this.queue.delete(job.req.taskId)
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
    this.queue.rerank()
    this.pumpSoon()
  }

  /** `jobs` wait, in order, behind the waiting tasks or, `front`, before them. */
  private enqueue(jobs: readonly Job[], front = false): void {
    for (const j of jobs) this.waiting.set(j.req.taskId, j)
    if (jobs.length > 0) this.waited = true
    this.queue.add(
      jobs.map((j) => j.req.taskId),
      front,
    )
  }

  private pump(): void {
    const batches = new Map<Worker, Job[]>()
    // Core asks in its critical-path order, but only as tasks get ready: a
    // long chain ready a moment late queued behind 46 shards ready at once,
    // and its 41 s build began 47 s in, the run's end (main, 2026-10-23).
    const workers = [...this.workers.values()].filter((a) => !a.faulty)
    const byId = this.waiting
    const now = performance.now()
    const ms = this.o.ms
    // When each running task ends, as history says: where a hold finds room.
    const endsIn = new Map<string, number>()
    const bins = workers.map((a) => {
      let running = 0
      const ends: [number, number, number][] = []
      for (const j of a.busy.values()) {
        if (j.held === undefined) continue
        running++
        if (ms === undefined) continue
        const at = Math.max(
          1,
          leftMs((ms(j.req.taskId) ?? UNKNOWN_MS) - (now - (j.startedAt ?? j.sentAt ?? now))),
        )
        endsIn.set(j.req.taskId, at)
        ends.push([at, j.held.cores, j.held.memory])
      }
      return {
        ...(ms === undefined ? {} : { ends }),
        id: a.id,
        cores: a.cores,
        memory: a.memory,
        used: this.used(a),
        running,
        has: a.has,
        platform: a.platform,
        serving: new Set(a.serving.keys()),
        a,
      }
    })
    const nodes = this.o.nodes()
    // An exact plan keeps the room itself.
    const soon =
      this.o.soon === undefined || ms === undefined || this.placing.exact
        ? undefined
        : this.o
            .soon(endsIn)
            .filter((s) => !byId.has(s.id) && !endsIn.has(s.id))
            // As many as the run has workers, and a few: room kept for more is room no task gets.
            .slice(0, 4 * bins.length + 8)
    // The draining last, for what no other takes now: a run never waits on a drain.
    const to = new Map<string, (typeof bins)[number]>()
    const draining = (b: (typeof bins)[number]): boolean =>
      (this.drainAt.get(b.id) ?? Infinity) <= now
    for (const of of [bins.filter((b) => !draining(b)), bins.filter(draining)]) {
      if (of.length === 0) continue
      for (const [id, b] of this.queue.pass(of, {
        ...(soon === undefined ? {} : { soon, ms: (id: string) => ms!(id) ?? UNKNOWN_MS }),
        ...(soon === undefined || this.o.next === undefined
          ? {}
          : { next: (id: string) => this.o.next!(id, endsIn) }),
        want: (id) => this.placing.want(id),
        book: (need) => this.booking(need),
        deps: (id) => (byId.get(id)!.deps ??= nodes?.get(id)?.deps),
        gate: (id) => {
          const job = byId.get(id)!
          const up =
            job.up ??
            (nodes?.has(id) === true ? (job.up = upstream(nodes, id)) : upstream(nodes, id))
          const pin = this.pin(job, up)
          // It ended: the queue lets it go.
          if (pin === 'done') byId.delete(id)
          if (typeof pin !== 'object' || pin.only !== undefined || pin.avoid !== undefined)
            return pin
          return this.placing.gate(id, now)
        },
        waits: (above, platform) => this.bigger(above, platform),
      }))
        to.set(id, b)
    }
    const placed = [...to.keys()].map((id) => byId.get(id)!)
    for (const id of to.keys()) byId.delete(id)
    for (const job of placed) {
      const a = to.get(job.req.taskId)!.a
      job.worker = a.id
      job.sentAt = performance.now()
      a.usage.sent(job.sentAt)
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
    this.wake(now)
  }

  /** A pump when the next task the plan starts late may go. */
  private wake(now: number): void {
    const at = this.placing.next(now)
    if (at === this.due?.at) return
    if (this.due !== undefined) clearTimeout(this.due.timer)
    this.due = undefined
    if (at === undefined) return
    const timer = setTimeout(() => {
      this.due = undefined
      this.pumpSoon()
    }, at - now)
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
      this.enqueue(
        [
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
        ],
        true,
      )
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
    let cores = l.cpu
    let memory = l.memory
    for (const j of a.busy.values())
      if (j.held !== undefined && (j.sentAt ?? 0) > l.at) {
        cores += j.held.cores
        memory += j.held.memory
      }
    return { cores: Math.max(booked.cores, cores), memory: Math.max(booked.memory, memory) }
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
    return a.other ?? this.sizeOther(a) ?? 0
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
    const tasks = Number(load.tasks)
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
    const joined = new Set([...this.workers.values(), ...this.gone].map((x) => x.label))
    for (const [id, { declared }] of this.spawnedAt)
      if (
        !joined.has(id) &&
        !this.unstarted.has(id) &&
        !this.cancelled.has(id) &&
        (platform === undefined ||
          (declared.place ?? declared.platform ?? hostPlatform()) === platform) &&
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
                ...(req.sandbox.dependencyReads === undefined
                  ? {}
                  : {
                      reads: req.sandbox.dependencyReads.map((d) => path.relative(this.o.root, d)),
                    }),
                ...(req.sandbox.dependencyReported === undefined
                  ? {}
                  : {
                      reported: req.sandbox.dependencyReported.map((d) =>
                        path.relative(this.o.root, d),
                      ),
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
          for (const { job } of part) job.batch = n
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
          if (a.busy.get(job.req.taskId) === job && this.retry(a, job, 'not sent') !== undefined)
            job.reject(err)
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
          this.enqueue([again], true)
          this.pumpSoon()
        }
        return
      }
    }
    const endAt = endedAt ?? performance.now()
    this.traceTask(a, job, head, endAt)
    a.busy.delete(task)
    this.unhold(a, job)
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
    this.timeline.set(task, {
      queued: Math.min(job.queuedAt ?? sent, sent),
      sent,
      began: Math.max(sent, Math.min(endAt, job.startedAt ?? sent)),
      end: endAt,
      joined: a.joinedAt,
    })
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
    const read = () =>
      job.req.remoteOnly === true || deferred ? this.o.artifacts.output(key) : restore()
    // A failed download reads as a miss: asked once more, since one stalled
    // download failed a CI run whose upload had landed (main, 2026-10-28).
    const log = await (
      job.req.remoteOnly === true || deferred ? Promise.resolve() : this.clear(job, node)
    )
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
    // An upstream's file the task removed there is gone here too: a restore
    // lays files, never removes one, and this disk is what core saves from.
    if (head.removed !== undefined && job.req.remoteOnly !== true && !deferred) {
      const ours = names(
        path.relative(this.o.root, node?.projectDir ?? job.req.cwd),
        job.req.outputs,
      )
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
      where: a.label,
      machine: {
        cores: a.reported.cores,
        memoryBytes: a.reported.memory,
        ...(share < 1 ? { cpuShare: share } : {}),
      },
    })
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
      // One given up only for joining late is work the run can use: main
      // db1702f told three smalls GitHub queued 60 s to exit and ended at
      // 232 s against an ideal of 141 s. The plan lets it go if not.
      if (info.id !== undefined && this.late.delete(info.id)) {
        this.cancelled.delete(info.id)
        this.unstarted.delete(info.id)
        this.o.kept?.(info.id)
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
      this.placing.joined(id, info.id, size)
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
    // Its results' `end`s never come.
    for (const k of this.parts.keys()) if (k.startsWith(`${a.id}\0`)) this.parts.delete(k)
    // Its tasks run again: first, as they were first to go.
    const back: Job[] = []
    for (const j of [...a.busy.values()]) {
      const again = this.retry(a, j, 'lost')
      if (again !== undefined) back.push(again)
    }
    this.enqueue(back, true)
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
        const said = body as ToOrchestrator
        const frame = said.type === 'together' ? said.messages : [said]
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
              this.enqueue(back, true)
              this.o.faulted?.()
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
            // Its worker still says it holds it while it saves.
            j.startedAt = here(m.startedAt) ?? j.startedAt ?? now
            j.ranAt = here(m.ranAt) ?? now
            this.pumpSoon()
          } else if (m.type === 'fault') {
            const j = a.busy.get(m.task)
            if (j === undefined) continue
            // It began it whether or not its `start` came first.
            this.begun(a, m.task)
            if (this.retry(a, j, m.reason) !== undefined) this.enqueue([j], true)
            if (a.faulty) this.o.faulted?.()
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
              const began = here(m.startedAt)
              const ran = here(m.ranAt)
              if (began !== undefined) j.startedAt = began
              if (ran !== undefined) j.ranAt = ran
            }
            void this.finish(a, m.task, m.key, result as WiredResult, here(m.endedAt))
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
     * memory, platform, servers) and each size's warm-up, so it can be played back. Main
     * d8a795c planned 38 s with one Mac for a Mac lane of 88 s, and
     * nothing in the profile said what it thought each task took.
     */
    work?: readonly PlanTask[]
    warmUps?: ReadonlyMap<string, number>
    /** Each size as planned: its cores less what runs there outside tasks. */
    sizes?: readonly { readonly name: string; readonly cpu: number }[]
    /** Why it played the work rather than packed it (`Plan.unpacked`). */
    unpacked?: string
    /**
     * What `plan()` was given, whole: marked as `input` when the packing
     * ended past the play or left a task out. A packing that ended at 130 s
     * where the play ended at 55 s asked 4 workers mid-run (main 18a8446,
     * 2026-11-12), and the marks above, rounded and without each running
     * task's id, packed it at 54 s when played back. The run's first is
     * marked too: where it placed what ran last is the tail's why.
     */
    input?: {
      readonly tasks: readonly PlanTask[]
      readonly sizes: readonly Size[]
      readonly warmUps: ReadonlyMap<string, number>
      readonly spreads: ReadonlyMap<string, number>
      readonly limitMs: number | undefined
    }
  }): void {
    const work = p.work?.map(
      (t) =>
        `${t.id} ${t.ms === undefined ? '?' : Math.round(t.ms / 100) / 10}s ${Math.round(t.cores * 100) / 100}c${t.memory > 0 ? ` ${Math.round(t.memory / 1e8) / 10}G` : ''}${t.platform === undefined ? '' : ` ${bare(t.platform)}`}${(t.servers ?? []).map((sv) => ` +${sv.id} ${Math.round(sv.cores * 100) / 100}c`).join('')}`,
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
      ...(p.sizes === undefined
        ? {}
        : { sizes: p.sizes.map((s) => `${s.name} ${Math.round(s.cpu * 100) / 100}c`).join(' · ') }),
      ...(p.unpacked === undefined ? {} : { unpacked: p.unpacked }),
      ...(p.input === undefined || (this.inputMarked && !/^(ends|left out) /.test(p.unpacked ?? ''))
        ? {}
        : {
            input: JSON.stringify({ ...p.input, workers: p.workers }, (_k, v: unknown) =>
              v instanceof Map ? Object.fromEntries(v) : v === Infinity ? 'Infinity' : v,
            ),
          }),
      ...(p.warmUps === undefined
        ? {}
        : {
            warmUps: [...p.warmUps]
              .map(([s, ms]) => `${s} ${Math.round(ms / 100) / 10}s`)
              .join(' · '),
          }),
    })
    if (p.input !== undefined) this.inputMarked = true
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
        this.cancelledAt.set(id, performance.now())
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
   * How much later each next worker of a size joined than the one before,
   * this run (`spreadMs`): each size two of which joined.
   */
  spreadsMs(): Map<string, number> {
    const ups = new Map<string, number[]>()
    for (const a of [...this.workers.values(), ...this.gone]) {
      const size = a.declared?.size
      if (a.warmUpMs === undefined || size === undefined) continue
      const of = ups.get(size)
      if (of === undefined) ups.set(size, [a.warmUpMs])
      else of.push(a.warmUpMs)
    }
    return new Map([...ups].flatMap(([size, ms]) => (ms.length < 2 ? [] : [[size, spreadMs(ms)]])))
  }

  /** Each size's cores its machines spent besides the run's tasks, on average: what the plan leaves it. */
  othersOf(): Map<string, number> {
    const sum = new Map<string, [number, number]>()
    for (const a of [...this.workers.values(), ...this.gone]) {
      const size = a.declared?.size
      if (size === undefined || a.other === undefined || a.cores !== a.reported.cores) continue
      const [s, n] = sum.get(size) ?? [0, 0]
      sum.set(size, [s + a.other, n + 1])
    }
    return new Map([...sum].map(([size, [s, n]]) => [size, s / n]))
  }

  /**
   * The workers the plan places on (`plan/`): each online, what it
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
    const holds = new Map<string, Map<string, number>>()
    for (const [task, k] of this.kept) {
      const on = holds.get(k.worker)
      if (on === undefined) holds.set(k.worker, new Map([[task, ms(task) ?? 0]]))
      else on.set(task, ms(task) ?? 0)
    }
    for (const a of this.workers.values()) {
      if (a.faulty) continue
      const jobs = [...a.busy.values()].filter((j) => j.startedAt !== undefined)
      for (const j of jobs) running.add(j.req.taskId)
      // Its tasks use more than their history said (a suite given more
      // workers): the plan holds them at what the load says, this run.
      const over =
        a.usedCores > 0 ? Math.max(1, (this.used(a).cores - this.otherOf(a)) / a.usedCores) : 1
      workers.push({
        id: a.id,
        cores: a.cores - this.otherOf(a),
        memory: a.memory,
        platform: a.platform,
        ...(a.serving.size === 0 ? {} : { serving: new Map(a.serving) }),
        ...(a.declared === undefined ? {} : { size: a.declared.size }),
        at: 0,
        ...(this.drainAt.has(a.id) ? { drainIn: Math.max(0, this.drainAt.get(a.id)! - now) } : {}),
        ...(holds.has(a.id) ? { holds: holds.get(a.id)! } : {}),
        idle: a.busy.size === 0,
        // An unmeasured one counts as it did waiting (`ask`), not as the
        // one core it holds: started, it freed a core the plan then found
        // spare, and the worker asked for it was cancelled (cold main
        // bcc84f1: 11 of 25, 2026-10-23).
        running: jobs.map((j) => ({
          id: j.req.taskId,
          cores: Math.min(a.cores, Math.max((j.held?.cores ?? 0) * over, j.need.ask?.cores ?? 0)),
          memory: Math.max(j.held?.memory ?? 0, Math.min(a.memory, j.need.ask?.memory ?? 0)),
          // Below 0: past its time, which the plan weighs (`decide`).
          endsIn: (ms(j.req.taskId) ?? 0) - (now - j.startedAt!),
        })),
      })
    }
    const joined = new Set([...this.workers.values(), ...this.gone].map((a) => a.label))
    const warm = (size: string | undefined): number =>
      typeof warmUpMs === 'number' ? warmUpMs : warmUpMs(size)
    for (const [id, { at, declared }] of this.spawnedAt)
      if (!joined.has(id) && !this.unstarted.has(id) && !this.cancelled.has(id))
        workers.push({
          id,
          cores: declared.cpu,
          memory: declared.memory,
          // A size naming none is planned as this machine's, as `dte()`
          // planned it: on no platform, no task naming one fit it, and the
          // next plan cancelled it.
          platform: declared.place ?? declared.platform ?? hostPlatform(),
          size: declared.size,
          at: Math.max(0, warm(declared.size) - (now - at)),
          ...(now - at > warm(declared.size) ? { overdue: true as const } : {}),
          idle: false,
          running: [],
          // One its adapter could not stop joins whatever the plan says.
          ...(this.unstoppable.has(id) ? {} : { starting: true as const }),
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
   * Workers `drain` names take no task from `inMs` on, from now, while
   * another takes it: the plan moved the rest of their work to a smaller
   * one, and each leaves once idle (`Plan.drain`).
   */
  drain(drain: readonly { readonly id: string; readonly inMs: number }[]): void {
    const now = performance.now()
    for (const d of drain) this.drainAt.set(d.id, now + d.inMs)
  }

  /**
   * Where and when the last plan gave each task (`Plan.placed`,
   * `Plan.after`, `Plan.fresh`, `Plan.exact`): each goes there first
   * where it fits, or only there when the plan is exact.
   */
  place(p: Parameters<Placing['set']>[0]): void {
    this.placing.set(p, performance.now())
    this.pumpSoon()
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
      if (this.cancelled.has(id) && !this.late.has(id) && !this.turnedAway.has(id)) {
        this.cancelled.delete(id)
        this.unstoppable.add(id)
        out.push(id)
      }
    return out
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
    const now = performance.now()
    for (const a of this.workers.values()) {
      for (const j of a.busy.values()) j.reject(new Error(reason))
      // Lost, keeping what it ran: dropped, the footer read it as never joined.
      a.usage.to = now
      this.trace.left(a.label, 'lost', now)
      this.gone.push(a)
    }
    for (const [id, j] of this.waiting) {
      this.queue.delete(id)
      j.reject(new Error(reason))
    }
    this.waiting.clear()
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
    const r = this.replay(depsOf)
    if (r === undefined) return undefined
    const pool: PlanWorker[] = (
      sizes.length > 0
        ? sizes.flatMap((s) =>
            Array.from({ length: Math.min(s.max, this.took.size) }, () => ({
              cores: s.cpu,
              memory: s.memory,
              platform: s.platform,
            })),
          )
        : [...this.workers.values(), ...this.gone].map((a) => ({
            cores: a.cores,
            memory: a.memory,
            platform: a.platform,
          }))
    ).map((w, i) => ({
      ...w,
      id: `ideal#${i}`,
      at: r.warm(w.platform),
      running: [],
      idle: false,
    }))
    const end = simulate(r.tasks, pool)
    if (!Number.isFinite(end)) return undefined
    return r.from + end
  }

  /**
   * The least CPU its ideal could hold (2026-11-11: "Allocated cpu but
   * not used counts as used"): on each platform, its tasks' cores for as
   * long as each held its worker, on workers of the size that holds the
   * least, each holding its cores less what its machine spends besides
   * the run's tasks (`othersOf`), as few as end that work by the ideal end
   * (`idealMs`), each held through its warm-up. One warm-up for the run
   * was a floor no run reached: a run that ends at its chain starts as
   * many workers as its width needs, and each warms up (main 5c2463f:
   * 14.9 core-min where the least of 4 smalls and a Mac held 26,
   * 2026-11-12).
   */
  leastHeldMs(
    depsOf: (id: string) => readonly string[],
    sizes: readonly Size[],
    end = this.idealMs(depsOf, sizes),
  ): number | undefined {
    const r = this.replay(depsOf)
    if (r === undefined) return undefined
    const work = new Map<string | undefined, number>()
    for (const t of r.tasks)
      work.set(t.platform, (work.get(t.platform) ?? 0) + t.cores * (t.ms ?? 0))
    const all = [...this.workers.values(), ...this.gone]
    const others = this.othersOf()
    const offered =
      sizes.length > 0
        ? sizes.filter((s) => s.max > 0)
        : all.map((a) => ({ name: '', cpu: a.cores, platform: a.platform }))
    const within = end === undefined ? Infinity : end - r.from
    let ms = 0
    for (const [platform, w] of work) {
      let least = Infinity
      for (const s of offered) {
        if (platform !== undefined && s.platform !== undefined && s.platform !== platform) continue
        const usable = Math.max(s.cpu / 2, s.cpu - (others.get(s.name) ?? 0))
        const warm = r.warm(s.platform ?? platform)
        const each = usable * Math.max(0, within - warm)
        const n = each > 0 && Number.isFinite(each) ? Math.max(1, Math.ceil(w / each)) : 1
        least = Math.min(least, (w * s.cpu) / usable + n * s.cpu * warm)
      }
      ms += Number.isFinite(least) ? least : w
    }
    return ms
  }

  /**
   * The CPU the run's workers held: each its cores from when the run asked
   * for it (or it joined, one that joined on its own) until it left, was
   * cancelled or the run ended, idle or not.
   */
  heldMs(): number {
    const until = this.ended ? this.endedAt : performance.now()
    let ms = 0
    const joined = new Set<string>()
    for (const a of [...this.workers.values(), ...this.gone]) {
      joined.add(a.label)
      const from = this.spawnedAt.get(a.label)?.at ?? a.usage.from
      ms += a.cores * Math.max(0, (a.usage.to ?? until) - from)
    }
    for (const [id, { at, declared }] of this.spawnedAt)
      if (!joined.has(id) && !this.unstarted.has(id))
        ms += declared.cpu * Math.max(0, (this.cancelledAt.get(id) ?? until) - at)
    return ms
  }

  /**
   * What kept the run from its ideal (2026-11-11: "Could the summary tell
   * us what caused the drift from ideal"): along the chain that ended it,
   * from its last task back through the dependency each waited on last,
   * the time each waited past when its ideal could start it (as
   * `idealMs`, its platform's fastest warm-up from when the run knew its
   * work) for its worker to join, then for room on it; the time its
   * inputs took to reach it once sent; and the run's time after its last
   * task. `undefined` with no task run on a worker.
   */
  driftOf(depsOf: (id: string) => readonly string[]): Drift | undefined {
    const r = this.replay(depsOf)
    if (r === undefined) return undefined
    const deps = new Map(r.tasks.map((t) => [t.id, t.deps]))
    const platform = new Map(r.tasks.map((t) => [t.id, t.platform]))
    let id: string | undefined
    for (const [t, l] of this.timeline)
      if (id === undefined || l.end > this.timeline.get(id)!.end) id = t
    if (id === undefined) return undefined
    const until = this.ended ? this.endedAt : performance.now()
    const out = {
      joining: 0,
      room: 0,
      sending: 0,
      after: Math.max(0, until - this.timeline.get(id)!.end),
    }
    for (const seen = new Set<string>(); id !== undefined && !seen.has(id);) {
      seen.add(id)
      const l = this.timeline.get(id)!
      const earliest = Math.max(l.queued, this.startedAt + r.from + r.warm(platform.get(id)))
      const lost = Math.max(0, l.sent - earliest)
      const joining = Math.min(lost, Math.max(0, l.joined - earliest))
      out.joining += joining
      out.room += lost - joining
      out.sending += l.began - l.sent
      let next: string | undefined
      for (const d of deps.get(id) ?? []) {
        const e = this.timeline.get(d)?.end
        if (e !== undefined && (next === undefined || e > this.timeline.get(next)!.end)) next = d
      }
      id = next
    }
    return out
  }

  /**
   * The workers that would have run this run best (`advise`), from the
   * same replay as `idealMs`: on `sizes`, past their `max`, and of any
   * cores. With no sizes (workers that join on their own), the shapes
   * that joined stand for them, as many as joined.
   */
  advice(depsOf: (id: string) => readonly string[], sizes: readonly Size[]): WorkerAdvice[] {
    // The footer and the summary each ask once the run ended: played once.
    if (this.ended && this.advised !== undefined) return this.advised
    const out = this.advise(depsOf, sizes)
    if (this.ended) this.advised = out
    return out
  }

  private advised: WorkerAdvice[] | undefined

  private advise(
    depsOf: (id: string) => readonly string[],
    sizes: readonly Size[],
  ): WorkerAdvice[] {
    const r = this.replay(depsOf)
    if (r === undefined) return []
    const shapes: Size[] =
      sizes.length > 0
        ? [...sizes]
        : [
            ...[...this.workers.values(), ...this.gone]
              .reduce((by, a) => {
                const name = `${a.cores}c/${a.platform ?? ''}`
                const had = by.get(name)
                by.set(name, {
                  name,
                  max: (had?.max ?? 0) + 1,
                  cpu: a.cores,
                  memory: a.memory,
                  platform: a.platform,
                })
                return by
              }, new Map<string, Size>())
              .values(),
          ]
    const a = advise(r.tasks, shapes, r.warm)
    const wire = (of: WorkerAdvice['of'], f: Fleets | undefined): WorkerAdvice[] =>
      f === undefined
        ? []
        : [
            {
              of,
              endMs: Math.round(r.from + f.endMs),
              workers: f.fleet.map((w) => ({
                count: w.count,
                cores: w.cores,
                memoryBytes: w.memory,
                ...(w.platform === undefined ? {} : { platform: bare(w.platform) }),
                ...(w.size === undefined || sizes.length === 0 ? {} : { size: w.size }),
              })),
            },
          ]
    return [...wire('declared', a.declared), ...wire('more', a.more), ...wire('any', a.any)]
  }

  /**
   * Each task a worker ran, as long as it held its worker and with the
   * cores it used meanwhile, waiting on its deps through those no worker
   * ran (groups, hits); each platform's fastest real warm-up; and when
   * the run first knew its work.
   */
  private replay(depsOf: (id: string) => readonly string[]):
    | {
        tasks: PlanTask[]
        warm: (platform: string | undefined) => number
        from: number
      }
    | undefined {
    if (this.took.size === 0) return undefined
    const all = [...this.workers.values(), ...this.gone]
    const warm = new Map<string | undefined, number>()
    for (const a of all)
      if (a.warmUpMs !== undefined && !(warm.get(a.platform)! <= a.warmUpMs))
        warm.set(a.platform, a.warmUpMs)
    const least = this.warmUpMs() ?? 0
    const seen = new Map<string, string[]>()
    const ran = (id: string): string[] => {
      const known = seen.get(id)
      if (known !== undefined) return known
      seen.set(id, [])
      // Each once, as `planTasks`: a diamond of groups held a task once per path.
      const out = [...new Set(depsOf(id).flatMap((d) => (this.took.has(d) ? [d] : ran(d))))]
      seen.set(id, out)
      return out
    }
    return {
      tasks: [...this.took].map(([id, t]) => ({ id, ...t, deps: ran(id) })),
      warm: (platform) => warm.get(platform) ?? least,
      from: this.probe?.at ?? this.asks[0]?.at ?? 0,
    }
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
   * and `ideal`, the run's `idealMs`, asked once it ended, with what kept
   * the run from it (`drift`).
   */
  footer(
    ideal?: () => number | undefined,
    advice?: () => readonly WorkerAdvice[],
    drift?: () => Drift | undefined,
    least?: () => number | undefined,
  ): [string, ui.Inline][] {
    // Over with none, it says so: core's own `N workers` (this machine's
    // pool) read as the run's when no task needed one (2026-10-25), and
    // says when one did and none joined (2026-11-06), and why any it
    // refused was (2026-11-07).
    if (this.spawnedAt.size === 0 && this.workers.size === 0 && this.gone.length === 0)
      return this.ended
        ? [
            [
              'workers',
              this.refused.length > 0
                ? ui.tone(
                    'warn',
                    `none joined: ${this.refused.length} refused (${this.refused[0]})`,
                  )
                : this.waited
                  ? ui.tone('warn', 'none joined: a task waited on one')
                  : ui.dim('none started: no task needed one'),
            ],
          ]
        : []
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
    let tasksMs = 0
    let workerMs: number | undefined
    let coreMs = 0
    if (this.ended)
      for (const a of all) {
        resources(a.label, a.reported.cores, a.reported.memory, a.declared)
        const st = a.usage.stats(a.cores, this.endedAt)
        cpuMs += st.workCoreMs
        tasksMs += st.tasksUtilization * a.cores * st.workMs
        if (st.workerUtilization !== undefined)
          workerMs = (workerMs ?? 0) + st.workerUtilization * a.cores * st.workMs
        coreMs += a.cores * st.workMs
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
                        `${'ideal'.padEnd(width)}  ${seconds(ms)}: each task as long as it took, placed perfectly${((h) => (h === undefined ? '' : `, holding ${coreTime(h)} at least`))(least?.())}`,
                      ),
                    ] as [string, ui.Inline],
                    ...driftRow(this.endedAt - this.startedAt - ms, drift?.(), width),
                  ])(ideal?.()),
            // What to declare next time (2026-11-05: "So I can add more
            // or change their specs").
            ...(advice?.() ?? []).map(
              (a) =>
                [
                  '',
                  ui.dim(
                    `${ADVICE[a.of][0].padEnd(width)}  ${a.workers.map(fleetText).join(' + ')}: ${seconds(a.endMs)}, ${ADVICE[a.of][1]}`,
                  ),
                ] as [string, ui.Inline],
            ),
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
              `${'total'.padEnd(width)}  ${utilization(cpuMs / coreMs, tasksMs / coreMs, workerMs === undefined ? undefined : workerMs / coreMs)}${this.needMs < LEARN_MS ? '' : ` · tasks used ${percent(this.usedMs / this.needMs)} of their history`} · held ${coreTime(this.heldMs())}`,
            ] as [string, ui.Inline],
          ]
        : []),
    ]
  }

  /** Why the relay was given up on; then every task runs here. */
  lost: string | undefined
}

/** Core-time as read: `42.0 core-s`, `12.5 core-min`, `3.2 core-h`. */
function coreTime(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} core-s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} core-min`
  return `${(ms / 3_600_000).toFixed(1)} core-h`
}

/**
 * The footer's `drift` row: how far past its ideal the run ended, and the
 * parts of it `driftOf` names, each of a tenth of a second or more.
 */
function driftRow(past: number, d: Drift | undefined, width: number): [string, ui.Inline][] {
  if (d === undefined || past < 100) return []
  const parts = (
    [
      ['workers joining', d.joining],
      ['waiting for room', d.room],
      ['sending inputs', d.sending],
      ['after the last task', d.after],
    ] as const
  )
    .filter(([, ms]) => ms >= 100)
    .map(([what, ms]) => `${what} ${seconds(ms)}`)
  return [
    [
      '',
      ui.dim(
        `${'drift'.padEnd(width)}  +${seconds(past)} past ideal${parts.length > 0 ? `: ${parts.join(' · ')}` : ''}`,
      ),
    ],
  ]
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

/** Core-time busy over core-time had, from first send to last end: its machine, its tasks, its worker. */
function utilization(machine: number, tasks: number, worker: number | undefined): string {
  return `cpu utilization machine ${percent(machine)} · tasks ${percent(tasks)}${worker === undefined ? '' : ` · worker ${percent(worker)}`}`
}

/** A worker's run, spelled out: time, CPU, memory and the relay. */
function describe(st: UsageStats, u: Usage): string[] {
  return [
    `online ${seconds(st.onlineMs)} · busy ${seconds(st.busyMs)} · idle ${seconds(Math.max(0, st.onlineMs - st.busyMs))}`,
    `cpu peak ${st.cpuPeak.toFixed(1)} · used avg ${st.cpuAvg.toFixed(1)} cores${st.machineAvg === undefined ? '' : ` · machine avg ${st.machineAvg.toFixed(1)}`} · booked avg ${st.bookedAvg.toFixed(1)}`,
    utilization(st.utilization, st.tasksUtilization, st.workerUtilization),
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
